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
