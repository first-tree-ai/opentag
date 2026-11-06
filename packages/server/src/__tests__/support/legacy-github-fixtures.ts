/** Historical JSON test fixtures only. Production does not interpret these grants. */
export interface GitHubAgentScope {
  agentId: string;
  role: "code" | "context_tree";
  access: "read" | "write";
  publish?: "direct" | "pull_request";
  branch?: string;
  taskDelegation?: { imSenders: { bindingId: string; senderId: string }[]; sessionAgents: string[] };
}
export interface GitHubRepositoryBinding {
  bindingId: string;
  installationId: string;
  repositoryId: string;
  fullNameDisplay: string;
  agentScopes: GitHubAgentScope[];
}

/** Historical Account connection payload, used only to exercise old fixture inputs. */
export interface GitHubConnectionStatus {
  id: string;
  accountId: string;
  githubHost: string;
  oauthClientId: string;
  githubUserId: string | null;
  githubLogin: string | null;
  status: "pending" | "active" | "reauthorization_required" | "revoked" | "superseded";
  authorizationVersion: string;
  credentialGeneration: string;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  recheckRequired: boolean;
  nextRecheckAt: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
