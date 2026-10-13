import type { RuntimeExecutionSource } from "@opentag/shared";

/** Source-checked Account authority. Repository rights are checked lazily for each operation. */
export interface RuntimeGitHubAdmissionResult {
  connectionId: string;
  authorizationVersion: string;
  credentialGeneration: string;
}
export interface RuntimeGitHubAdmission {
  admit(input: {
    accountId: string;
    agentId: string;
    sessionId: string;
    source?: RuntimeExecutionSource;
    signal?: AbortSignal;
  }): Promise<RuntimeGitHubAdmissionResult | undefined>;
}
export class UnavailableRuntimeGitHubAdmission implements RuntimeGitHubAdmission {
  async admit(): Promise<undefined> {
    return undefined;
  }
}
