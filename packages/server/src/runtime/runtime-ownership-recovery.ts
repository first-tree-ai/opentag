import type { RuntimeOwnershipLease } from "./runtime-ownership-lease.js";

interface RuntimeOwnershipFencePort {
  fence(): void;
  resume(): void;
}

export interface RuntimeOwnershipRecoveryOptions {
  acquire(): Promise<RuntimeOwnershipLease>;
  fence: RuntimeOwnershipFencePort;
  getLease(): RuntimeOwnershipLease | undefined;
  onFailed(error: unknown): Promise<void>;
  onRecovered(lease: RuntimeOwnershipLease): void;
  setLease(lease: RuntimeOwnershipLease | undefined): void;
}

/** Runs the post-loss fence and serializes one bounded recovery attempt. */
export class RuntimeOwnershipRecovery {
  readonly #options: RuntimeOwnershipRecoveryOptions;
  #configured = false;
  #pending = false;
  #stopping = false;
  #recoveryPromise: Promise<void> | undefined;

  constructor(options: RuntimeOwnershipRecoveryOptions) {
    this.#options = options;
  }

  onLost(): void {
    this.#options.fence.fence();
    if (this.#stopping) return;
    if (!this.#configured) {
      this.#pending = true;
      return;
    }
    this.#schedule();
  }

  async configure(): Promise<void> {
    this.#configured = true;
    if (!this.#pending) return;
    this.#pending = false;
    await this.#recover();
    if (this.#stopping) throw new Error("Runtime ownership recovery stopped during startup");
  }

  stop(): void {
    this.#stopping = true;
  }

  #schedule(): void {
    if (this.#recoveryPromise) return;
    this.#recoveryPromise = this.#recover().finally(() => {
      this.#recoveryPromise = undefined;
    });
    void this.#recoveryPromise.catch(() => undefined);
  }

  async #recover(): Promise<void> {
    const lostLease = this.#options.getLease();
    this.#options.setLease(undefined);
    await lostLease?.release().catch(() => undefined);
    try {
      const recoveredLease = await this.#options.acquire();
      if (this.#stopping) {
        await recoveredLease.release().catch(() => undefined);
        return;
      }
      this.#options.setLease(recoveredLease);
      this.#options.fence.resume();
      this.#options.onRecovered(recoveredLease);
    } catch (error) {
      await this.#options.onFailed(error);
    }
  }
}
