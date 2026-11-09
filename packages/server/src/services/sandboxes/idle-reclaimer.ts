import type { BackgroundFailureSupervisor } from "../../observability/background-failure-supervisor.js";
import type { SandboxRunnerService } from "./sandbox-runner-service.js";

/**
 * E7 periodic idle sweep. Business inactivity authorizes the initial claim; durable retry pacing
 * in the service prevents claimed or releasing rows from repeating I/O on every sweep. Each
 * process runs at most one pass at a time, and conditional reservations fence competing workers.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

export interface SandboxIdleReclaimerOptions {
  service: Pick<SandboxRunnerService, "reclaimIdleSandboxes">;
  intervalMs?: number;
  supervisor?: BackgroundFailureSupervisor;
  onDiagnostic?: (code: string) => void;
}

export class SandboxIdleReclaimer {
  readonly #service: SandboxIdleReclaimerOptions["service"];
  readonly #intervalMs: number;
  readonly #supervisor?: BackgroundFailureSupervisor;
  readonly #onDiagnostic: (code: string) => void;
  #timer?: ReturnType<typeof setInterval>;
  #running?: Promise<unknown>;
  #cancellation?: AbortController;

  constructor(options: SandboxIdleReclaimerOptions) {
    const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error("SandboxIdleReclaimer requires a positive intervalMs");
    }
    this.#service = options.service;
    this.#intervalMs = intervalMs;
    this.#supervisor = options.supervisor;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.sweep(), this.#intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#cancellation?.abort();
    // The sweep's observer below reports failures. Drain before the Server closes its database.
    await this.#running?.catch(() => undefined);
  }

  /** One serialized pass; exposed so startup/tests can run it deterministically. */
  async runOnce(
    signal?: AbortSignal,
  ): Promise<{ claimed: number; released: number; recovered: number; failed: number }> {
    return this.#service.reclaimIdleSandboxes(signal);
  }

  sweep(): void {
    if (this.#running) return;
    const cancellation = new AbortController();
    this.#cancellation = cancellation;
    const operation = this.runOnce(cancellation.signal).finally(() => {
      this.#running = undefined;
      this.#cancellation = undefined;
    });
    this.#running = operation;
    if (this.#supervisor) {
      this.#supervisor.track(operation, {
        code: "SANDBOX_IDLE_RECLAIM_FAILED",
        category: "internal",
        retryability: "backoff",
        phase: "worker",
        operation: "sandbox-idle-reclaimer.sweep",
      });
      return;
    }
    void operation.catch(() => this.#onDiagnostic("SANDBOX_IDLE_RECLAIM_FAILED"));
  }
}
