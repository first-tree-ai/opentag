import type {
  GitHubAgentScope,
  GitHubRepositoryAccess,
  GitHubRepositoryRole,
  RuntimeExecutionSource,
} from "@opentag/shared";

export interface RuntimeGitHubAdmissionBinding {
  repositoryId: string;
  fullName: string;
  role: GitHubRepositoryRole;
  access: GitHubRepositoryAccess;
  /**
   * The entire exact Agent scope (role, access, ref, publish mode, task delegation). The broker
   * hashes this complete object — including delegation/ref/publish — so any scope change
   * invalidates in-flight GitHub capabilities.
   */
  scope?: GitHubAgentScope;
}

/**
 * A fresh, exact admission snapshot for GitHub execution: the active current connection's Agent
 * bindings plus proof of the connected user's repository admission at the observed authorization
 * version. Produced only by the injected parent adapter (UAT admission); the broker treats any
 * absent result as denial and never derives GitHub grants from IM identity.
 */
export interface RuntimeGitHubAdmissionResult {
  connectionId: string;
  authorizationVersion: string;
  credentialGeneration: string;
  bindings: readonly RuntimeGitHubAdmissionBinding[];
}

export interface RuntimeGitHubAdmission {
  admit(input: {
    accountId: string;
    agentId: string;
    sessionId: string;
    /**
     * The accepted execution source (delivery / session-message / validation). The parent
     * delegation policy resolves the owning IM sender or source Agent from it and denies when it
     * is absent; the Server never admits GitHub execution from a bare session identity.
     */
    source?: RuntimeExecutionSource;
    signal?: AbortSignal;
  }): Promise<RuntimeGitHubAdmissionResult | undefined>;
}

/** Default port: no authoritative GitHub admission is wired, so every GitHub acquire is denied. */
export class UnavailableRuntimeGitHubAdmission implements RuntimeGitHubAdmission {
  async admit(): Promise<undefined> {
    return undefined;
  }
}
