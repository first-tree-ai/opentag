import type {
  GitHubInstallationTokenClient,
  MintGitHubInstallationTokenInput,
} from "../github/installation-token-client.js";
import { GitPublicationError } from "./git-packets.js";

/** IATs are never serialized. Revocation covers in-flight mint completion and all execution exits. */
export class GitHubIatLeases {
  readonly #active = new Map<string, Set<{ token?: string; revoked: boolean }>>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #revoking = new Set<Promise<void>>();
  #closed = false;
  constructor(
    readonly client: Pick<GitHubInstallationTokenClient, "mint" | "revoke">,
    readonly onRevokeFailure: () => void = () => {
      process.stderr.write("GitHub installation token revocation failed\n");
    },
  ) {}
  async acquire(
    executionId: string,
    input: MintGitHubInstallationTokenInput,
  ): Promise<{ token: string; release(): Promise<void> }> {
    if (this.#closed || this.#active.size >= 256) throw new GitPublicationError("resource_limit");
    const entries = this.#active.get(executionId) ?? new Set();
    if (entries.size >= 8) throw new GitPublicationError("resource_limit");
    const entry: { token?: string; revoked: boolean } = { revoked: false };
    entries.add(entry);
    this.#active.set(executionId, entries);
    const release = async () => {
      entry.revoked = true;
      entries.delete(entry);
      if (entries.size === 0 && this.#active.get(executionId) === entries) this.#active.delete(executionId);
      const token = entry.token;
      entry.token = undefined;
      if (token) await this.#revoke(token);
    };
    const operation = (async () => {
      try {
        const minted = await this.client.mint(input);
        entry.token = minted.token;
        if (entry.revoked || this.#closed || input.signal?.aborted) {
          await release();
          throw new GitPublicationError("scope_denied");
        }
        return { token: minted.token, release };
      } catch (error) {
        await release();
        throw error;
      }
    })();
    this.#pending.add(operation);
    try {
      return await operation;
    } finally {
      this.#pending.delete(operation);
    }
  }

  async revokeExecution(executionId: string): Promise<void> {
    const entries = this.#active.get(executionId);
    this.#active.delete(executionId);
    await Promise.all(
      [...(entries ?? [])].map(async (entry) => {
        entry.revoked = true;
        const token = entry.token;
        entry.token = undefined;
        if (token) await this.#revoke(token);
      }),
    );
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#active.keys()].map((id) => this.revokeExecution(id)));
    await Promise.allSettled([...this.#pending]);
    await Promise.all([...this.#revoking]);
  }
  async #revoke(token: string): Promise<void> {
    const operation = this.client.revoke(token).catch(() => this.onRevokeFailure());
    this.#revoking.add(operation);
    try {
      await operation;
    } finally {
      this.#revoking.delete(operation);
    }
  }
}
