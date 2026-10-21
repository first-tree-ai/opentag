import type { GitHubManagementService } from "../github/github-management-service.js";
import { GitPublicationError } from "./git-packets.js";

type CredentialRequest = Parameters<GitHubManagementService["getExecutionUserCredential"]>[0] & {
  signal?: AbortSignal;
};

export class GitHubExecutionCredentials {
  readonly #active = new Map<string, Set<() => Promise<void>>>();
  #closed = false;

  constructor(private readonly management: Pick<GitHubManagementService, "getExecutionUserCredential">) {}

  async acquire(executionId: string, input: CredentialRequest): Promise<{ token: string; release(): Promise<void> }> {
    const entries = this.#active.get(executionId) ?? new Set<() => Promise<void>>();
    if (this.#closed || input.signal?.aborted) throw new GitPublicationError("scope_denied");
    if ((!this.#active.has(executionId) && this.#active.size >= 256) || entries.size >= 8)
      throw new GitPublicationError("resource_limit");
    let released = false;
    const release = async () => {
      released = true;
      input.signal?.removeEventListener("abort", onAbort);
      entries.delete(release);
      if (entries.size === 0 && this.#active.get(executionId) === entries) this.#active.delete(executionId);
    };
    const onAbort = () => {
      void release();
    };
    entries.add(release);
    this.#active.set(executionId, entries);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const credential = await this.management.getExecutionUserCredential(input);
      if (!credential || released || this.#closed || input.signal?.aborted)
        throw new GitPublicationError("scope_denied");
      return { token: credential.accessToken, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async closeExecution(executionId: string): Promise<void> {
    await Promise.all([...(this.#active.get(executionId) ?? [])].map((release) => release()));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#active.keys()].map((id) => this.closeExecution(id)));
  }
}
