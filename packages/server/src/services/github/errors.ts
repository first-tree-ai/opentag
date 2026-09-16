import { type ErrorCategory, GITHUB_CONNECTION_ERROR_CODES, type GitHubConnectionErrorCode } from "@opentag/shared";

/*
 * The controlled GitHub failure vocabulary lives in @opentag/shared so the Account HTTP error
 * envelope accepts exactly the codes these services report; this module re-exports it and adds the
 * persistence-side bounds.
 */
export { GITHUB_CONNECTION_ERROR_CODES, type GitHubConnectionErrorCode };

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
  "GITHUB_ACCESS_TOKEN_EXPIRED",
]);

export function boundedGitHubErrorCode(errorCode: string): string {
  // Unknown provider text must not enter the status DTO. Invalidation still succeeds.
  return PERSISTED_ERROR_CODES.has(errorCode) ? errorCode : "GITHUB_UPSTREAM_ERROR";
}
