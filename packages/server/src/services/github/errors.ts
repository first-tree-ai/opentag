import type { ErrorCategory } from "@opentag/shared";

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
} as const;

export type GitHubConnectionErrorCode =
  (typeof GITHUB_CONNECTION_ERROR_CODES)[keyof typeof GITHUB_CONNECTION_ERROR_CODES];

/**
 * A controlled failure of the GitHub connection persistence services. Messages never carry secret
 * material — no ciphertext, OAuth state, session values, or token payloads.
 */
export class GitHubConnectionServiceError extends Error {
  constructor(
    readonly code: GitHubConnectionErrorCode,
    readonly statusCode: number,
    message: string,
    readonly category: ErrorCategory = "deterministic",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitHubConnectionServiceError";
  }
}

/** Whether a thrown error (or any error in its cause chain) is a PostgreSQL unique violation on one constraint. */
export function isGitHubConnectionUniqueViolation(error: unknown, constraintName: string): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === constraintName
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/** Error codes persisted on the row are bounded controlled strings, never free-form payloads. */
const PERSISTED_ERROR_CODES = new Set<string>([
  ...Object.values(GITHUB_CONNECTION_ERROR_CODES),
  "GITHUB_REFRESH_OUTCOME_UNKNOWN",
  "GITHUB_UPSTREAM_UNAVAILABLE",
  "GITHUB_CREDENTIAL_INVALID",
  "GITHUB_PERMISSION_REVOKED",
  "GITHUB_RATE_LIMITED",
  "GITHUB_UPSTREAM_ERROR",
]);

export function boundedGitHubErrorCode(errorCode: string): string {
  // Unknown provider text must not enter the status DTO. Invalidation still succeeds.
  return PERSISTED_ERROR_CODES.has(errorCode) ? errorCode : "GITHUB_UPSTREAM_ERROR";
}
