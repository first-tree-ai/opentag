import { randomUUID } from "node:crypto";
import { RUNTIME_VALIDATION_RUN_TTL_MS, type RuntimeCredentialProvider } from "@opentag/shared";

export interface RuntimeValidationRun {
  validationRunId: string;
  provider: RuntimeCredentialProvider;
  bindingId: string;
  agentId: string;
  computerId: string;
  instanceId: string;
  expiresAt: number;
}

export interface RuntimeValidationRunRegistryOptions {
  now?: () => number;
  ttlMs?: number;
  maxRuns?: number;
}

export class RuntimeValidationRunRegistryCapacityError extends Error {
  constructor() {
    super("The runtime validation run registry is full");
    this.name = "RuntimeValidationRunRegistryCapacityError";
  }
}

/**
 * Server-issued validation runs: the only authority for `source.kind === "validation"` executions.
 * A run is issued by the Server when it starts a CLI readiness validation and is consumed exactly
 * once by an execution open. Validation executions only ever reach read-only identity operations.
 */
export class RuntimeValidationRunRegistry {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxRuns: number;
  readonly #runs = new Map<string, RuntimeValidationRun>();

  constructor(options: RuntimeValidationRunRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? RUNTIME_VALIDATION_RUN_TTL_MS;
    this.#maxRuns = options.maxRuns ?? 256;
  }

  get size(): number {
    return this.#runs.size;
  }

  issue(input: {
    provider: RuntimeCredentialProvider;
    bindingId: string;
    agentId: string;
    computerId: string;
    instanceId: string;
  }): RuntimeValidationRun {
    this.sweep(this.#now());
    if (this.#runs.size >= this.#maxRuns) throw new RuntimeValidationRunRegistryCapacityError();
    const run: RuntimeValidationRun = {
      validationRunId: randomUUID(),
      provider: input.provider,
      bindingId: input.bindingId,
      agentId: input.agentId,
      computerId: input.computerId,
      instanceId: input.instanceId,
      expiresAt: this.#now() + this.#ttlMs,
    };
    this.#runs.set(run.validationRunId, run);
    return run;
  }

  /** Consumes the run exactly once; expired, unknown, or mismatched runs return undefined. */
  consume(
    validationRunId: string,
    expected: { computerId: string; instanceId: string; agentId: string },
    now = this.#now(),
  ): RuntimeValidationRun | undefined {
    const run = this.#runs.get(validationRunId);
    if (!run) return undefined;
    this.#runs.delete(validationRunId);
    if (run.expiresAt <= now) return undefined;
    if (
      run.computerId !== expected.computerId ||
      run.instanceId !== expected.instanceId ||
      run.agentId !== expected.agentId
    ) {
      return undefined;
    }
    return run;
  }

  sweep(now = this.#now()): number {
    let removed = 0;
    for (const [id, run] of [...this.#runs.entries()]) {
      if (run.expiresAt > now) continue;
      this.#runs.delete(id);
      removed += 1;
    }
    return removed;
  }
}
