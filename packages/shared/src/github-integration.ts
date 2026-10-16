import { z } from "zod";

/** Account connection and OAuth contracts. Runtime repository rights are resolved per request. */

/** Largest signed PostgreSQL bigint; decimal ID and version strings must stay within it. */
const PG_BIGINT_MAX = 9223372036854775807n;

/**
 * UUIDs compare case-insensitively at the PostgreSQL boundary, so the contract normalizes them to
 * lowercase. Uniqueness rules (binding IDs, Agent/repository/role grants) then cannot be bypassed by
 * letter-case aliases of the same UUID.
 */
const UuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

function fitsPgBigInt(value: string): boolean {
  try {
    return BigInt(value) <= PG_BIGINT_MAX;
  } catch {
    return false;
  }
}

/** A positive GitHub numeric ID (user/installation/repository/App) as a decimal string. */
export const GitHubDecimalIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, "A GitHub numeric ID is a positive decimal string")
  .refine(fitsPgBigInt, {
    message: "A GitHub numeric ID must fit the signed PostgreSQL bigint range",
  });

/** A nonnegative row version counter (authorization version / credential generation) as a decimal string. */
export const GitHubVersionStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/, "A row version is a nonnegative decimal string")
  .refine(fitsPgBigInt, {
    message: "A row version must fit the signed PostgreSQL bigint range",
  });

export const GitHubConnectionStateSchema = z.enum([
  "pending",
  "active",
  "reauthorization_required",
  "revoked",
  "superseded",
]);

/**
 * Every controlled failure the GitHub connection/management services report. The Account HTTP error
 * envelope accepts exactly these codes, so a management failure always reaches the UI as a bounded
 * code instead of collapsing into a generic 500. The set is also the base allowlist for the
 * `lastErrorCode` persisted on a connection row; upstream classifications the worker records add a
 * few explicit entries beside it.
 */
export const GITHUB_CONNECTION_ERROR_CODES = {
  ADMISSION_PROOF_INVALID: "GITHUB_ADMISSION_PROOF_INVALID",
  ADMISSION_PROOF_STALE: "GITHUB_ADMISSION_PROOF_STALE",
  AGENT_OWNERSHIP_INVALID: "GITHUB_AGENT_OWNERSHIP_INVALID",
  AUTHORIZATION_VERSION_CONFLICT: "GITHUB_AUTHORIZATION_VERSION_CONFLICT",
  CONNECTION_CONFLICT: "GITHUB_CONNECTION_CONFLICT",
  CONNECTION_NOT_FOUND: "GITHUB_CONNECTION_NOT_FOUND",
  CONNECTION_STATE_INVALID: "GITHUB_CONNECTION_STATE_INVALID",
  CREDENTIAL_INPUT_INVALID: "GITHUB_CREDENTIAL_INPUT_INVALID",
  IDENTITY_MISMATCH: "GITHUB_IDENTITY_MISMATCH",
  INPUT_INVALID: "GITHUB_INPUT_INVALID",
  OAUTH_FLOW_EXPIRED: "GITHUB_OAUTH_FLOW_EXPIRED",
  OAUTH_FLOW_INVALID: "GITHUB_OAUTH_FLOW_INVALID",
  OAUTH_SESSION_MISMATCH: "GITHUB_OAUTH_SESSION_MISMATCH",
  /* Management-plane request errors: deployment availability and bounded upstream classifications. */
  INTEGRATION_UNAVAILABLE: "GITHUB_INTEGRATION_UNAVAILABLE",
  UPSTREAM_UNAVAILABLE: "GITHUB_UPSTREAM_UNAVAILABLE",
  UPSTREAM_ERROR: "GITHUB_UPSTREAM_ERROR",
  RATE_LIMITED: "GITHUB_RATE_LIMITED",
  TOKEN_LIFETIME_UNSUPPORTED: "GITHUB_TOKEN_LIFETIME_UNSUPPORTED",
  ADMISSION_INSTALLATION_MISSING: "GITHUB_ADMISSION_INSTALLATION_MISSING",
  ADMISSION_REPOSITORY_MISSING: "GITHUB_ADMISSION_REPOSITORY_MISSING",
  ADMISSION_PERMISSION_INSUFFICIENT: "GITHUB_ADMISSION_PERMISSION_INSUFFICIENT",
  APP_IDENTITY_MISMATCH: "GITHUB_APP_IDENTITY_MISMATCH",
  OAUTH_DENIED: "GITHUB_OAUTH_DENIED",
  /** A task delegation names an IM binding that is not a current binding of the connection's Account. */
  DELEGATED_IM_BINDING_INVALID: "GITHUB_DELEGATED_IM_BINDING_INVALID",
} as const;
export type GitHubConnectionErrorCode =
  (typeof GITHUB_CONNECTION_ERROR_CODES)[keyof typeof GITHUB_CONNECTION_ERROR_CODES];

// biome-ignore lint/suspicious/noControlCharactersInRegex: Git refnames forbid control characters; the range is the rule.
const GIT_REF_FORBIDDEN_CHARACTERS = /[\u0000-\u0020~^:?*[\\\u007f]/;

/**
 * Full git-check-ref-format validation for a qualified ref — not a prefix check. Rejects empty
 * components, dot-leading components, `.lock` suffixes, `..`, `//`, `@{`, a lone `@`, control
 * characters, and every other byte Git forbids in a refname.
 */
export function isValidGitRefName(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false;
  if (GIT_REF_FORBIDDEN_CHARACTERS.test(ref)) return false;
  if (ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return false;
  if (ref === "@") return false;
  return ref
    .split("/")
    .every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"));
}

/** A Context Tree branch is always a fully qualified branch ref such as `refs/heads/master`. */
export const GitBranchRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((ref) => ref.startsWith("refs/heads/") && isValidGitRefName(ref), {
    message: "A Tree branch must be a fully qualified valid Git branch ref (refs/heads/<branch>)",
  });

/** Display-only repository name (`owner/repository`); routing uses the stable numeric IDs. */
export const GitHubRepositoryFullNameSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "A repository display name has the owner/repository shape");

/** Fixed surfaces a GitHub OAuth round trip may return to. */
export const GITHUB_OAUTH_RETURN_SURFACES = ["account-integrations", "agent-integrations"] as const;
export const GitHubOAuthReturnSurfaceSchema = z.enum(GITHUB_OAUTH_RETURN_SURFACES);

export const GitHubOAuthFlowIntentSchema = z.enum(["create", "reauthorize", "replace"]);
export const GitHubOAuthFlowPhaseSchema = z.enum(["awaiting_callback", "claimed"]);

/** A hex SHA-256 binding of an OAuth flow to the Account login session that started it. */
export const GitHubLoginSessionHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "A session hash is hex SHA-256");

/**
 * `agentId` deep-links an `agent-integrations` round trip back to the exact Agent that started it;
 * it is rejected on the account surface and required on the Agent surface.
 */
const agentReturnRefinement = (
  value: { returnSurface: GitHubOAuthReturnSurface; agentId: string | null },
  context: z.RefinementCtx,
): void => {
  if (value.returnSurface === "account-integrations" && value.agentId !== null) {
    context.addIssue({
      code: "custom",
      path: ["agentId"],
      message: "Only an agent-integrations flow names its return Agent",
    });
  }
  if (value.returnSurface === "agent-integrations" && value.agentId === null) {
    context.addIssue({
      code: "custom",
      path: ["agentId"],
      message: "An agent-integrations flow requires its return Agent",
    });
  }
};

/**
 * The nonsecret OAuth flow context persisted on the connection row. One connection carries at most
 * one in-flight authorization; beginning a new flow explicitly voids the previous one. Secret
 * material (the PKCE verifier) never appears here — it lives only in the separate encrypted slot.
 *
 * `agentId` is the exact Agent an `agent-integrations` round trip returns to; it is null on the
 * account surface and defaults to null so contexts persisted before the deep link existed still
 * parse. It is never caller-substituted afterwards: the callback redirect reads it only from this
 * verified context.
 */
export const GitHubOAuthContextSchema = z
  .object({
    flowId: UuidSchema,
    intent: GitHubOAuthFlowIntentSchema,
    phase: GitHubOAuthFlowPhaseSchema,
    loginSessionHash: GitHubLoginSessionHashSchema,
    returnSurface: GitHubOAuthReturnSurfaceSchema,
    agentId: UuidSchema.nullable().default(null),
    expiresAt: z.string().datetime(),
    claimedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((flow, context) => {
    if ((flow.phase === "claimed") !== (flow.claimedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["claimedAt"],
        message: "A claimed flow records its claim time; an awaiting flow has none",
      });
    }
    agentReturnRefinement(flow, context);
  });

/**
 * The nonsecret status of a connection as returned to the owning Account: identity, state, binding
 * configuration, version counters, and maintenance metadata. It never contains credential ciphertext,
 * key IDs, OAuth state/session hashes, or refresh claim internals.
 */
export const GitHubConnectionStatusSchema = z
  .object({
    id: UuidSchema,
    accountId: UuidSchema,
    githubHost: z.string().min(1).max(255),
    appId: GitHubDecimalIdSchema,
    githubUserId: GitHubDecimalIdSchema.nullable(),
    githubLogin: z.string().min(1).max(100).nullable(),
    status: GitHubConnectionStateSchema,
    authorizationVersion: GitHubVersionStringSchema,
    credentialGeneration: GitHubVersionStringSchema,
    accessExpiresAt: z.string().datetime().nullable(),
    refreshExpiresAt: z.string().datetime().nullable(),
    recheckRequired: z.boolean(),
    nextRecheckAt: z.string().datetime().nullable(),
    lastVerifiedAt: z.string().datetime().nullable(),
    lastErrorCode: z.string().min(1).max(120).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * The first integration stage supports github.com only; the column and DTOs stay host-namespaced so
 * a future GitHub Enterprise stage can widen this literal without a data migration.
 */
export const CreateGitHubConnectionRequestSchema = z
  .object({
    githubHost: z.literal("github.com").default("github.com"),
    appId: GitHubDecimalIdSchema,
    returnSurface: GitHubOAuthReturnSurfaceSchema.default("account-integrations"),
    agentId: UuidSchema.nullable().default(null),
  })
  .strict()
  .superRefine(agentReturnRefinement);

export const BeginGitHubAuthorizationRequestSchema = z
  .object({
    intent: z.enum(["reauthorize", "replace"]),
    returnSurface: GitHubOAuthReturnSurfaceSchema.default("account-integrations"),
    agentId: UuidSchema.nullable().default(null),
  })
  .strict()
  .superRefine(agentReturnRefinement);

export type GitHubDecimalId = z.infer<typeof GitHubDecimalIdSchema>;
export type GitHubVersionString = z.infer<typeof GitHubVersionStringSchema>;
export type GitHubConnectionState = z.infer<typeof GitHubConnectionStateSchema>;
export type GitBranchRef = z.infer<typeof GitBranchRefSchema>;
export type GitHubRepositoryFullName = z.infer<typeof GitHubRepositoryFullNameSchema>;
export type GitHubOAuthReturnSurface = z.infer<typeof GitHubOAuthReturnSurfaceSchema>;
export type GitHubOAuthFlowIntent = z.infer<typeof GitHubOAuthFlowIntentSchema>;
export type GitHubOAuthFlowPhase = z.infer<typeof GitHubOAuthFlowPhaseSchema>;
export type GitHubLoginSessionHash = z.infer<typeof GitHubLoginSessionHashSchema>;
export type GitHubOAuthContext = z.infer<typeof GitHubOAuthContextSchema>;
export type GitHubConnectionStatus = z.infer<typeof GitHubConnectionStatusSchema>;
export type CreateGitHubConnectionRequest = z.infer<typeof CreateGitHubConnectionRequestSchema>;
export type BeginGitHubAuthorizationRequest = z.infer<typeof BeginGitHubAuthorizationRequestSchema>;
