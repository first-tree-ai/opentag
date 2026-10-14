/** Server-only, request-derived scope. Never persisted as repository authorization. */
export interface GitHubUserTokenInput {
  accountId: string;
  connectionId: string;
  authorizationRevision: string;
  installationId: string;
  repositoryId: string;
  fullName: string;
  permissions: GitHubRepositoryTokenPermissions;
  signal?: AbortSignal;
}

export interface GitHubRepositoryTokenPermissions {
  contents: "read" | "write";
  pull_requests?: "read" | "write";
  checks?: "read";
  actions?: "read";
}

export interface GitHubExecutionUserCredential {
  accessToken: string;
  githubUserId: string;
  accessExpiresAt: Date;
  credentialGeneration: bigint;
}
