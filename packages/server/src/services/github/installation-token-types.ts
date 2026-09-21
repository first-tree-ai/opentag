export type GitHubInstallationTokenErrorCode =
  | "GITHUB_APP_CONFIG_INVALID"
  | "GITHUB_REQUEST_INVALID"
  | "GITHUB_API_ABORTED"
  | "GITHUB_API_TIMEOUT"
  | "GITHUB_API_NETWORK_ERROR"
  | "GITHUB_API_REDIRECT_REJECTED"
  | "GITHUB_API_RESPONSE_TOO_LARGE"
  | "GITHUB_API_RESPONSE_INVALID"
  | "GITHUB_API_HTTP_ERROR"
  | "GITHUB_API_RATE_LIMITED"
  | "GITHUB_APP_AUTH_FAILED"
  | "GITHUB_TOKEN_VALIDATION_FAILED";

export class GitHubInstallationTokenError extends Error {
  readonly code: GitHubInstallationTokenErrorCode;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: GitHubInstallationTokenErrorCode,
    message: string,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "GitHubInstallationTokenError";
    this.code = code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export type GitHubInstallationPermissionLevel = "read" | "write";

export type GitHubInstallationTokenPermissions = {
  contents: GitHubInstallationPermissionLevel;
  pull_requests?: GitHubInstallationPermissionLevel;
  checks?: "read";
  actions?: "read";
};

export type MintGitHubInstallationTokenInput = {
  installationId: string;
  repositoryId: string;
  permissions: GitHubInstallationTokenPermissions;
  signal?: AbortSignal;
};

export type MintedGitHubInstallationToken = {
  token: string;
  expiresAt: Date;
};

export type GitHubInstallationTokenClientOptions = {
  appId: string;
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
};
