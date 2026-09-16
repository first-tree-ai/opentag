import { z } from "zod";
import {
  GITHUB_CONNECTION_ERROR_CODES,
  GitHubConnectionStatusSchema,
  GitHubDecimalIdSchema,
  GitHubOAuthFlowIntentSchema,
  GitHubOAuthReturnSurfaceSchema,
  GitHubRepositoryFullNameSchema,
} from "./github-integration.js";

/**
 * GitHub management API contract: the Account-facing DTOs of the deployment-level GitHub App
 * integration — availability, connection overview, authorization start, repository discovery, and
 * the OAuth callback outcome the fixed local return surfaces receive.
 *
 * Every schema here is strict and browser-compatible. None of them ever carries secrets: no
 * credential ciphertext or key IDs, no OAuth state/session values, no PKCE material, and no GitHub
 * tokens. The numeric-ID and version-string rules of `github-integration.ts` apply throughout.
 */

/** The OAuth callback returns only to fixed local surfaces, carrying this bounded outcome. */
export const GITHUB_OAUTH_OUTCOME_PARAM = "github_oauth";
export const GITHUB_OAUTH_ERROR_PARAM = "github_oauth_error";
export const GITHUB_OAUTH_OUTCOME_SUCCESS = "success";
export const GITHUB_OAUTH_OUTCOME_ERROR = "error";

/** A bounded public error code is the only failure detail a return surface ever receives. */
export const GitHubOAuthOutcomeSearchSchema = z
  .object({
    [GITHUB_OAUTH_OUTCOME_PARAM]: z.enum([GITHUB_OAUTH_OUTCOME_SUCCESS, GITHUB_OAUTH_OUTCOME_ERROR]),
    [GITHUB_OAUTH_ERROR_PARAM]: z.string().min(1).max(120).optional(),
  })
  .strict();

/**
 * Public management error codes a caller may branch on. Everything else the integration reports is
 * one of the `GITHUB_CONNECTION_ERROR_CODES` persisted on the connection status DTO.
 */
export const GITHUB_MANAGEMENT_ERROR_CODES = {
  /** The deployment has no GitHub App configured; the UI must explain, never demo. */
  INTEGRATION_UNAVAILABLE: GITHUB_CONNECTION_ERROR_CODES.INTEGRATION_UNAVAILABLE,
  UPSTREAM_UNAVAILABLE: GITHUB_CONNECTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
  UPSTREAM_ERROR: GITHUB_CONNECTION_ERROR_CODES.UPSTREAM_ERROR,
  RATE_LIMITED: GITHUB_CONNECTION_ERROR_CODES.RATE_LIMITED,
  /** The GitHub App does not issue expiring user tokens; the deployment must enable them. */
  TOKEN_LIFETIME_UNSUPPORTED: GITHUB_CONNECTION_ERROR_CODES.TOKEN_LIFETIME_UNSUPPORTED,
  /** The connected user's live admission no longer covers a requested binding. */
  ADMISSION_INSTALLATION_MISSING: GITHUB_CONNECTION_ERROR_CODES.ADMISSION_INSTALLATION_MISSING,
  ADMISSION_REPOSITORY_MISSING: GITHUB_CONNECTION_ERROR_CODES.ADMISSION_REPOSITORY_MISSING,
  ADMISSION_PERMISSION_INSUFFICIENT: GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PERMISSION_INSUFFICIENT,
  /** GitHub returned an identity for the configured App that does not match — upstream integrity. */
  APP_IDENTITY_MISMATCH: GITHUB_CONNECTION_ERROR_CODES.APP_IDENTITY_MISMATCH,
  /** The user denied the authorization on GitHub. */
  OAUTH_DENIED: GITHUB_CONNECTION_ERROR_CODES.OAUTH_DENIED,
  /** The callback arrived without an authenticated Account session. */
  OAUTH_AUTHENTICATION_REQUIRED: "GITHUB_OAUTH_AUTHENTICATION_REQUIRED",
} as const;
export type GitHubManagementErrorCode =
  (typeof GITHUB_MANAGEMENT_ERROR_CODES)[keyof typeof GITHUB_MANAGEMENT_ERROR_CODES];

/**
 * Whether this deployment offers the GitHub integration, with the configured App's public numeric
 * ID. Unavailable integrations return this metadata on every management route so the UI can explain
 * the state; `appId` is null while unconfigured.
 */
export const GitHubIntegrationAvailabilitySchema = z
  .object({
    available: z.boolean(),
    githubHost: z.literal("github.com"),
    appId: GitHubDecimalIdSchema.nullable(),
  })
  .strict();
export type GitHubIntegrationAvailability = z.infer<typeof GitHubIntegrationAvailabilitySchema>;

/** The Account's integration overview: deployment availability plus its current connection, if any. */
export const GitHubIntegrationOverviewSchema = z
  .object({
    availability: GitHubIntegrationAvailabilitySchema,
    connection: GitHubConnectionStatusSchema.nullable(),
  })
  .strict();
export type GitHubIntegrationOverview = z.infer<typeof GitHubIntegrationOverviewSchema>;

/**
 * Starts (or restarts) the OAuth round trip. `create` opens a new connection — or restarts the
 * in-flight flow of a still-pending one; `reauthorize`/`replace` act on the current connection. The
 * server never accepts an App override: the configured deployment App is the only one a flow uses.
 */
export const StartGitHubAuthorizationRequestSchema = z
  .object({
    intent: GitHubOAuthFlowIntentSchema,
    returnSurface: GitHubOAuthReturnSurfaceSchema.default("account-integrations"),
    agentId: z.string().uuid().nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
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
  });
export type StartGitHubAuthorizationRequest = z.infer<typeof StartGitHubAuthorizationRequestSchema>;

/**
 * The started authorization: the exact GitHub authorize URL the browser navigates to, the
 * connection the flow belongs to, and when the one-time state expires. The URL is always on
 * github.com and already carries the state and PKCE challenge; neither is returned separately.
 */
export const StartGitHubAuthorizationResponseSchema = z
  .object({
    connectionId: z.string().uuid(),
    authorizationUrl: z.string().url().max(2048),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type StartGitHubAuthorizationResponse = z.infer<typeof StartGitHubAuthorizationResponseSchema>;

/** Installation metadata as far as repository discovery and the UI need it. */
export const GitHubDiscoveredInstallationSchema = z
  .object({
    installationId: GitHubDecimalIdSchema,
    accountLogin: z.string().min(1).max(100),
    accountType: z.enum(["User", "Organization"]),
    repositorySelection: z.enum(["all", "selected"]),
    suspended: z.boolean(),
  })
  .strict();
export type GitHubDiscoveredInstallation = z.infer<typeof GitHubDiscoveredInstallationSchema>;

/**
 * One repository the connected user can reach through the configured App's installations. The
 * stable numeric IDs route authorization; `fullName` and `defaultBranch` are display/default
 * metadata only. `permissions` is GitHub's verdict for this exact user on this exact repository.
 */
export const GitHubDiscoveredRepositorySchema = z
  .object({
    installationId: GitHubDecimalIdSchema,
    repositoryId: GitHubDecimalIdSchema,
    fullName: GitHubRepositoryFullNameSchema,
    private: z.boolean(),
    defaultBranch: z.string().min(1).max(255).nullable(),
    permissions: z
      .object({
        pull: z.boolean(),
        push: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type GitHubDiscoveredRepository = z.infer<typeof GitHubDiscoveredRepositorySchema>;

export const GITHUB_REPOSITORY_DISCOVERY_MAX_INSTALLATIONS = 500;
export const GITHUB_REPOSITORY_DISCOVERY_PAGE_SIZE = 100;

/**
 * One page of the repository discovery stream. `installations` repeats the current installation
 * list on every page so a late reader can render install state without a second call; `nextCursor`
 * is an opaque server-owned continuation — callers treat it as unreadable and never construct one.
 */
export const GitHubRepositoryDiscoveryPageSchema = z
  .object({
    installations: z.array(GitHubDiscoveredInstallationSchema).max(GITHUB_REPOSITORY_DISCOVERY_MAX_INSTALLATIONS),
    repositories: z.array(GitHubDiscoveredRepositorySchema).max(GITHUB_REPOSITORY_DISCOVERY_PAGE_SIZE),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type GitHubRepositoryDiscoveryPage = z.infer<typeof GitHubRepositoryDiscoveryPageSchema>;

/** The discovery query: an optional opaque continuation cursor. */
export const GitHubRepositoryDiscoveryQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type GitHubRepositoryDiscoveryQuery = z.infer<typeof GitHubRepositoryDiscoveryQuerySchema>;
