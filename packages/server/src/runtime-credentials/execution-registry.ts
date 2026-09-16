import { randomUUID } from "node:crypto";
import { RUNTIME_EXECUTION_MAX_LIFETIME_MS, type RuntimeCredentialRevokedCode } from "@opentag/shared";
import { type RuntimeExecutionCloseEvent, type RuntimeExecutionRecord, runtimeConnectionKey } from "./types.js";

export interface RuntimeExecutionRegistryOptions {
  now?: () => number;
  maxLifetimeMs?: number;
  maxExecutions?: number;
  maxPerConnection?: number;
}

export class RuntimeExecutionRegistryCapacityError extends Error {
  constructor() {
    super("The runtime execution registry is full");
    this.name = "RuntimeExecutionRegistryCapacityError";
  }
}

type CloseListener = (event: RuntimeExecutionCloseEvent) => void;

/**
 * Owner-scoped execution records. An execution is valid only while its control connection is the
 * currently registered one; validity is enforced per request by the broker/owner fence, and this
 * registry emits close events so data connections and streams abort. Lifetime is never inferred
 * from a missing report: every record carries a bounded expiry.
 */
export class RuntimeExecutionRegistry {
  readonly #now: () => number;
  readonly #maxLifetimeMs: number;
  readonly #maxExecutions: number;
  readonly #maxPerConnection: number;
  readonly #executions = new Map<string, RuntimeExecutionRecord>();
  readonly #byConnection = new Map<string, Set<string>>();
  readonly #listeners = new Set<CloseListener>();

  constructor(options: RuntimeExecutionRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? RUNTIME_EXECUTION_MAX_LIFETIME_MS;
    this.#maxExecutions = options.maxExecutions ?? 1024;
    this.#maxPerConnection = options.maxPerConnection ?? 64;
  }

  get size(): number {
    return this.#executions.size;
  }

  onClose(listener: CloseListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  open(
    input: Omit<RuntimeExecutionRecord, "executionId" | "createdAt" | "expiresAt"> & { maxLifetimeMs?: number },
  ): RuntimeExecutionRecord {
    this.sweep();
    const connectionKey = runtimeConnectionKey(input.computerId, input.instanceId, input.connectionId);
    const perConnection = this.#byConnection.get(connectionKey) ?? new Set<string>();
    if (perConnection.size >= this.#maxPerConnection || this.#executions.size >= this.#maxExecutions) {
      throw new RuntimeExecutionRegistryCapacityError();
    }
    const now = this.#now();
    const { maxLifetimeMs, ...fields } = input;
    const record: RuntimeExecutionRecord = {
      ...fields,
      executionId: randomUUID(),
      createdAt: now,
      expiresAt: now + (maxLifetimeMs ?? this.#maxLifetimeMs),
    };
    this.#executions.set(record.executionId, record);
    perConnection.add(record.executionId);
    this.#byConnection.set(connectionKey, perConnection);
    return record;
  }

  get(executionId: string, now = this.#now()): RuntimeExecutionRecord | undefined {
    const record = this.#executions.get(executionId);
    if (!record || record.expiresAt <= now) return undefined;
    return record;
  }

  /** Replaces a live record (used to attach the described providers right after open). */
  update(record: RuntimeExecutionRecord): void {
    if (this.#executions.has(record.executionId)) this.#executions.set(record.executionId, record);
  }

  /** Close is idempotent per execution: a stale close can never cancel a successor execution. */
  close(executionId: string, code: RuntimeCredentialRevokedCode): RuntimeExecutionRecord | undefined {
    const record = this.#executions.get(executionId);
    if (!record) return undefined;
    this.#executions.delete(executionId);
    const connectionKey = runtimeConnectionKey(record.computerId, record.instanceId, record.connectionId);
    const perConnection = this.#byConnection.get(connectionKey);
    perConnection?.delete(executionId);
    if (perConnection && perConnection.size === 0) this.#byConnection.delete(connectionKey);
    this.#emit({ executionId, record, code });
    return record;
  }

  /** Drops every execution bound to one exact control connection (replacement/close). */
  closeConnection(
    computerId: string,
    instanceId: string,
    connectionId: string,
    code: RuntimeCredentialRevokedCode,
  ): string[] {
    const connectionKey = runtimeConnectionKey(computerId, instanceId, connectionId);
    const ids = [...(this.#byConnection.get(connectionKey) ?? [])];
    for (const executionId of ids) this.close(executionId, code);
    return ids;
  }

  closeAll(code: RuntimeCredentialRevokedCode): number {
    const ids = [...this.#executions.keys()];
    for (const executionId of ids) this.close(executionId, code);
    return ids.length;
  }

  /** Closes expired records; does not extend or infer anything about live ones. */
  sweep(now = this.#now()): string[] {
    const expired: string[] = [];
    for (const record of this.#executions.values()) {
      if (record.expiresAt <= now) expired.push(record.executionId);
    }
    for (const executionId of expired) this.close(executionId, "execution_closed");
    return expired;
  }

  executions(): readonly RuntimeExecutionRecord[] {
    return [...this.#executions.values()];
  }

  #emit(event: RuntimeExecutionCloseEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must never break execution teardown.
      }
    }
  }
}
