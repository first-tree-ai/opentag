import { z } from "zod";

/**
 * GitHub integration contract: repository bindings, connection status, and the nonsecret OAuth flow
 * context persisted on a connection row.
 *
 * One OpenTag Account holds at most one current connection per (GitHub host, GitHub App) pair, and the
 * connection carries the bounded repository/Agent binding configuration. These schemas are the source
 * of truth for that JSON: they are strict (unknown fields are rejected), browser-compatible, and they
 * never carry secrets — credential ciphertext, key IDs, OAuth state hashes, and session-bound values
 * live only on the server.
 *
 * Numeric boundaries: GitHub numeric IDs and row version counters cross JSON boundaries as decimal
 * strings (never JS numbers, which lose precision past 2^53) and stay inside the signed PostgreSQL
 * bigint range.
 */

export const GITHUB_REPOSITORY_BINDINGS_SCHEMA_VERSION = 1;
export const GITHUB_REPOSITORY_BINDINGS_MAX_REPOSITORIES = 100;
export const GITHUB_REPOSITORY_BINDINGS_MAX_AGENT_SCOPES = 1000;
export const GITHUB_REPOSITORY_BINDINGS_MAX_BYTES = 256 * 1024;

/** Largest signed PostgreSQL bigint; decimal ID and version strings must stay within it. */
const PG_BIGINT_MAX = 9223372036854775807n;

/**
 * UUIDs compare case-insensitively at the PostgreSQL boundary, so the contract normalizes them to
 * lowercase. Uniqueness rules (binding IDs, one Tree per Agent) then cannot be bypassed by
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

export const GITHUB_AGENT_SCOPE_MAX_DELEGATED_IM_SENDERS = 100;
export const GITHUB_AGENT_SCOPE_MAX_DELEGATED_SESSION_AGENTS = 100;

/**
 * A provider-stable messaging identity (the provider's `author_external_id`, for example a Feishu
 * open_id or a Slack member ID) as the owner typed it into the delegation list. The bounded safe
 * shape keeps only the identifier itself: no display names, no conversation IDs, no free text.
 * An identifier outside this shape simply cannot be delegated — the runtime comparison is exact.
 */
export const GitHubDelegatedImSenderIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,254}$/,
    "A messaging sender identity starts alphanumeric and uses only letters, digits, or _ . : @ + -",
  );

/** One delegated messaging identity: the exact Account-owned IM binding plus the provider sender ID. */
export const GitHubDelegatedImSenderSchema = z
  .object({
    bindingId: UuidSchema,
    senderId: GitHubDelegatedImSenderIdSchema,
  })
  .strict();

/**
 * The owner's explicit task delegation for one Agent scope. There is deliberately no wildcard: an
 * omitted delegation, or one whose lists are both empty, denies every GitHub execution for the
 * scope. Messaging entries name the exact Account-owned IM binding and provider sender identity
 * the owner trusts; `sessionAgents` names the exact collaborating Agents whose sessions may pass a
 * task down. Duplicates are rejected so a list cannot silently grow aliases.
 */
export const GitHubAgentScopeTaskDelegationSchema = z
  .object({
    imSenders: z.array(GitHubDelegatedImSenderSchema).max(GITHUB_AGENT_SCOPE_MAX_DELEGATED_IM_SENDERS),
    sessionAgents: z.array(UuidSchema).max(GITHUB_AGENT_SCOPE_MAX_DELEGATED_SESSION_AGENTS),
  })
  .strict()
  .superRefine((delegation, context) => {
    const senders = new Set<string>();
    delegation.imSenders.forEach((sender, index) => {
      const pair = `${sender.bindingId}/${sender.senderId}`;
      if (senders.has(pair)) {
        context.addIssue({
          code: "custom",
          path: ["imSenders", index],
          message: "A delegated messaging identity appears at most once",
        });
      }
      senders.add(pair);
    });
    const agents = new Set<string>();
    delegation.sessionAgents.forEach((agentId, index) => {
      if (agents.has(agentId)) {
        context.addIssue({
          code: "custom",
          path: ["sessionAgents", index],
          message: "A delegated session Agent appears at most once",
        });
      }
      agents.add(agentId);
    });
  });

/**
 * A task identity the runtime resolves from trusted data and compares against a scope's delegation:
 * the exact IM binding + provider sender of the accepted delivery, and/or the collaborating source
 * Agent recorded on the session message. Both are optional because a task may carry either, both,
 * or neither — and a task carrying neither is never delegated.
 */
export interface GitHubTaskDelegationCandidate {
  imSender?: { bindingId: string; senderId: string } | undefined;
  sourceAgentId?: string | undefined;
}

/**
 * The single resolution rule for owner task delegation: a scope allows execution only when its
 * explicit delegation lists contain the candidate's exact IM sender or the exact source Agent.
 * A missing delegation, an omitted candidate identity, and an empty list all deny. Only the
 * runtime supplies the candidate, and it must resolve both values from trusted persisted facts.
 */
export function githubAgentScopeAllowsTaskDelegation(
  scope: Pick<GitHubAgentScope, "taskDelegation">,
  candidate: GitHubTaskDelegationCandidate,
): boolean {
  const delegation = scope.taskDelegation;
  if (!delegation) return false;
  const sender = candidate.imSender;
  if (
    sender !== undefined &&
    delegation.imSenders.some(
      (entry) => entry.bindingId === sender.bindingId.toLowerCase() && entry.senderId === sender.senderId,
    )
  ) {
    return true;
  }
  const sourceAgentId = candidate.sourceAgentId?.toLowerCase();
  return sourceAgentId !== undefined && delegation.sessionAgents.includes(sourceAgentId);
}

export const GitHubRepositoryRoleSchema = z.enum(["code", "context_tree"]);
export const GitHubRepositoryAccessSchema = z.enum(["read", "write"]);
export const GitHubRepositoryPublishModeSchema = z.enum(["direct", "pull_request"]);

/**
 * One Agent's use of one bound repository.
 *
 * Read representation: a read-only scope is exactly `{ access: "read" }` with **no** `publish`
 * property — never `publish: null` and never a placeholder mode — so a read scope can never request
 * a write publish mode. `access: "write"` always names an explicit `publish` mode. `branch` exists
 * exactly for the `context_tree` role: it is required there (a Tree publishes to one branch) and
 * rejected for `code` scopes.
 *
 * `taskDelegation` is optional and defaults to absent, which preserves every binding configuration
 * written before delegation existed — and denies GitHub execution for that scope just as an empty
 * delegation does. It is never defaulted to a permissive value.
 */
export const GitHubAgentScopeSchema = z
  .object({
    agentId: UuidSchema,
    role: GitHubRepositoryRoleSchema,
    access: GitHubRepositoryAccessSchema,
    publish: GitHubRepositoryPublishModeSchema.optional(),
    branch: GitBranchRefSchema.optional(),
    taskDelegation: GitHubAgentScopeTaskDelegationSchema.optional(),
  })
  .strict()
  .superRefine((scope, context) => {
    if (scope.access === "read" && scope.publish !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["publish"],
        message: "A read scope cannot request a write publish mode",
      });
    }
    if (scope.access === "write" && scope.publish === undefined) {
      context.addIssue({
        code: "custom",
        path: ["publish"],
        message: "A write scope requires an explicit publish mode",
      });
    }
    if (scope.role === "context_tree" && scope.branch === undefined) {
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "A context_tree scope requires its Tree branch",
      });
    }
    if (scope.role === "code" && scope.branch !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "A code scope does not take a Tree branch",
      });
    }
  });

/** Display-only repository name (`owner/repository`); routing uses the stable numeric IDs. */
export const GitHubRepositoryFullNameSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "A repository display name has the owner/repository shape");

export const GitHubRepositoryBindingSchema = z
  .object({
    /** Stable client-assigned ID for this binding; unique across the connection's bindings. */
    bindingId: UuidSchema,
    installationId: GitHubDecimalIdSchema,
    repositoryId: GitHubDecimalIdSchema,
    fullNameDisplay: GitHubRepositoryFullNameSchema,
    agentScopes: z.array(GitHubAgentScopeSchema).min(1),
  })
  .strict();

/**
 * The bounded binding configuration persisted on a connection row: at most 100 repositories, at most
 * 1000 Agent scopes in total, and at most 256 KiB of UTF-8 JSON. Violations fail validation; nothing
 * is silently truncated.
 */
export const GitHubRepositoryBindingsSchema = z
  .array(GitHubRepositoryBindingSchema)
  .max(GITHUB_REPOSITORY_BINDINGS_MAX_REPOSITORIES)
  .superRefine((bindings, context) => {
    const bindingIds = new Set<string>();
    const repositoryPairs = new Set<string>();
    const treeOwners = new Set<string>();
    const grantedRoles = new Set<string>();
    let agentScopeCount = 0;
    bindings.forEach((binding, bindingIndex) => {
      if (bindingIds.has(binding.bindingId)) {
        context.addIssue({
          code: "custom",
          path: [bindingIndex, "bindingId"],
          message: "Binding IDs are unique and stable within a connection",
        });
      }
      bindingIds.add(binding.bindingId);
      const repositoryPair = `${binding.installationId}/${binding.repositoryId}`;
      if (repositoryPairs.has(repositoryPair)) {
        context.addIssue({
          code: "custom",
          path: [bindingIndex, "repositoryId"],
          message: "One installation/repository pair appears at most once",
        });
      }
      repositoryPairs.add(repositoryPair);
      binding.agentScopes.forEach((scope, scopeIndex) => {
        agentScopeCount += 1;
        const grantedRole = `${scope.agentId}/${binding.repositoryId}/${scope.role}`;
        if (grantedRoles.has(grantedRole)) {
          context.addIssue({
            code: "custom",
            path: [bindingIndex, "agentScopes", scopeIndex, "role"],
            message: "The same Agent/repo/role grant is not duplicated",
          });
        }
        grantedRoles.add(grantedRole);
        if (scope.role === "context_tree") {
          if (treeOwners.has(scope.agentId)) {
            context.addIssue({
              code: "custom",
              path: [bindingIndex, "agentScopes", scopeIndex, "agentId"],
              message: "One Agent keeps at most one current Context Tree",
            });
          }
          treeOwners.add(scope.agentId);
        }
      });
    });
    if (agentScopeCount > GITHUB_REPOSITORY_BINDINGS_MAX_AGENT_SCOPES) {
      context.addIssue({
        code: "custom",
        path: [],
        message: `A connection holds at most ${GITHUB_REPOSITORY_BINDINGS_MAX_AGENT_SCOPES} Agent scopes`,
      });
    }
    const byteLength = new TextEncoder().encode(JSON.stringify(bindings)).length;
    if (byteLength > GITHUB_REPOSITORY_BINDINGS_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        path: [],
        message: `Repository bindings must fit ${GITHUB_REPOSITORY_BINDINGS_MAX_BYTES} UTF-8 bytes`,
      });
    }
  });

/**
 * The canonical serialized form of a binding configuration: schema-normalized (key order, defaults)
 * JSON. Internal callers bind admission proofs to a hash of this exact string.
 */
export function canonicalizeGitHubRepositoryBindings(bindings: GitHubRepositoryBinding[]): string {
  return JSON.stringify(GitHubRepositoryBindingsSchema.parse(bindings));
}

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
    bindingsSchemaVersion: z.number().int().min(1),
    bindings: GitHubRepositoryBindingsSchema,
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

/** A bindings update is fenced against the exact authorization version the caller observed. */
export const UpdateGitHubConnectionBindingsRequestSchema = z
  .object({
    expectedAuthorizationVersion: GitHubVersionStringSchema,
    bindings: GitHubRepositoryBindingsSchema,
  })
  .strict();

export type GitHubDecimalId = z.infer<typeof GitHubDecimalIdSchema>;
export type GitHubVersionString = z.infer<typeof GitHubVersionStringSchema>;
export type GitHubConnectionState = z.infer<typeof GitHubConnectionStateSchema>;
export type GitBranchRef = z.infer<typeof GitBranchRefSchema>;
export type GitHubRepositoryRole = z.infer<typeof GitHubRepositoryRoleSchema>;
export type GitHubRepositoryAccess = z.infer<typeof GitHubRepositoryAccessSchema>;
export type GitHubRepositoryPublishMode = z.infer<typeof GitHubRepositoryPublishModeSchema>;
export type GitHubAgentScope = z.infer<typeof GitHubAgentScopeSchema>;
export type GitHubAgentScopeTaskDelegation = z.infer<typeof GitHubAgentScopeTaskDelegationSchema>;
export type GitHubDelegatedImSender = z.infer<typeof GitHubDelegatedImSenderSchema>;
export type GitHubRepositoryFullName = z.infer<typeof GitHubRepositoryFullNameSchema>;
export type GitHubRepositoryBinding = z.infer<typeof GitHubRepositoryBindingSchema>;
export type GitHubRepositoryBindings = z.infer<typeof GitHubRepositoryBindingsSchema>;
export type GitHubOAuthReturnSurface = z.infer<typeof GitHubOAuthReturnSurfaceSchema>;
export type GitHubOAuthFlowIntent = z.infer<typeof GitHubOAuthFlowIntentSchema>;
export type GitHubOAuthFlowPhase = z.infer<typeof GitHubOAuthFlowPhaseSchema>;
export type GitHubLoginSessionHash = z.infer<typeof GitHubLoginSessionHashSchema>;
export type GitHubOAuthContext = z.infer<typeof GitHubOAuthContextSchema>;
export type GitHubConnectionStatus = z.infer<typeof GitHubConnectionStatusSchema>;
export type CreateGitHubConnectionRequest = z.infer<typeof CreateGitHubConnectionRequestSchema>;
export type BeginGitHubAuthorizationRequest = z.infer<typeof BeginGitHubAuthorizationRequestSchema>;
export type UpdateGitHubConnectionBindingsRequest = z.infer<typeof UpdateGitHubConnectionBindingsRequestSchema>;
