import { dirname, resolve } from "node:path";
import { ensurePrivateDirectory, readDurableJson, writeDurableJson } from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

export type DurableWorkKind = "session-message" | "turn-report";
export type DurableWorkStatus = "accepted" | "running" | "succeeded" | "retryable" | "failed" | "dead-letter";
export type DurableRetryability = "retryable" | "terminal";

export interface DurableFailure {
  readonly category: string;
  readonly code: string;
  readonly message: string;
  readonly phase: string;
  readonly requestId: string;
  readonly retryability: DurableRetryability;
}

export class RuntimeDurabilityFailure extends Error implements DurableFailure {
  readonly category: string;
  readonly code: string;
  readonly phase: string;
  readonly requestId: string;
  readonly retryability: DurableRetryability;

  constructor(failure: DurableFailure) {
    super(failure.message);
    this.name = "RuntimeDurabilityFailure";
    this.category = failure.category;
    this.code = failure.code;
    this.phase = failure.phase;
    this.requestId = failure.requestId;
    this.retryability = failure.retryability;
  }
}

export interface DurableWorkRecord<T = unknown> {
  readonly attempts: number;
  readonly acceptedAt: number;
  readonly key: string;
  readonly kind: DurableWorkKind;
  readonly lastError?: DurableFailure;
  readonly nextAttemptAt?: number;
  readonly payload: T;
  readonly status: DurableWorkStatus;
  readonly updatedAt: number;
}

export interface RuntimeDurabilityStore {
  list<T = unknown>(kind: DurableWorkKind): Promise<DurableWorkRecord<T>[]>;
  write<T>(record: DurableWorkRecord<T>): Promise<void>;
}

export class MemoryRuntimeDurabilityStore implements RuntimeDurabilityStore {
  readonly #records = new Map<string, DurableWorkRecord>();

  async list<T = unknown>(kind: DurableWorkKind): Promise<DurableWorkRecord<T>[]> {
    return [...this.#records.values()]
      .filter((record) => record.kind === kind)
      .map((record) => ({ ...record }) as DurableWorkRecord<T>);
  }

  async write<T>(record: DurableWorkRecord<T>): Promise<void> {
    this.#records.set(`${record.kind}:${record.key}`, { ...record });
  }
}

export class FileRuntimeDurabilityStore implements RuntimeDurabilityStore {
  readonly #directory: string;
  readonly #tails = new Map<DurableWorkKind, Promise<void>>();

  constructor(home: string) {
    this.#directory = resolve(resolveOpenTagHomeLayout(home).runtime, "durability");
  }

  async list<T = unknown>(kind: DurableWorkKind): Promise<DurableWorkRecord<T>[]> {
    const path = durabilityPath(this.#directory, kind);
    const records = await readDurableJson(path, (value) => parseRecords(value, kind));
    return (records ?? []) as DurableWorkRecord<T>[];
  }

  async write<T>(record: DurableWorkRecord<T>): Promise<void> {
    await this.#withKindLock(record.kind, async () => {
      await ensurePrivateDirectory(dirname(this.#directory), this.#directory);
      const path = durabilityPath(this.#directory, record.kind);
      const records = (await readDurableJson(path, (value) => parseRecords(value, record.kind))) ?? [];
      const next = records.filter((candidate) => candidate.key !== record.key);
      next.push(record as DurableWorkRecord);
      await writeDurableJson(path, next);
    });
  }

  async #withKindLock<T>(kind: DurableWorkKind, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(kind) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    this.#tails.set(kind, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(kind) === tail) this.#tails.delete(kind);
    }
  }
}

export interface RuntimeRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxAgeMs: number;
  readonly maxAttempts: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RUNTIME_RETRY_POLICY: RuntimeRetryPolicy = {
  baseDelayMs: 1_000,
  maxAgeMs: 15 * 60 * 1_000,
  maxAttempts: 5,
  maxDelayMs: 30 * 1_000,
};

export interface RuntimeRetryScheduler {
  schedule(delayMs: number, task: () => void): { cancel(): void };
}

export const defaultRuntimeRetryScheduler: RuntimeRetryScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export function retryDelay(policy: RuntimeRetryPolicy, attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

export function retryExhausted(
  policy: RuntimeRetryPolicy,
  record: Pick<DurableWorkRecord, "acceptedAt" | "attempts">,
  now: number,
): boolean {
  return record.attempts >= policy.maxAttempts || now - record.acceptedAt >= policy.maxAgeMs;
}

export interface RuntimeDurabilityMetricsSnapshot {
  readonly deadLetters: number;
  readonly retries: number;
  readonly transitions: Readonly<Record<string, number>>;
}

export class RuntimeDurabilityMetrics {
  #deadLetters = 0;
  #retries = 0;
  readonly #transitions = new Map<string, number>();

  transition(kind: DurableWorkKind, from: DurableWorkStatus | undefined, to: DurableWorkStatus): void {
    const key = `${kind}:${from ?? "new"}->${to}`;
    this.#transitions.set(key, (this.#transitions.get(key) ?? 0) + 1);
    if (to === "retryable") this.#retries += 1;
    if (to === "dead-letter") this.#deadLetters += 1;
  }

  snapshot(): RuntimeDurabilityMetricsSnapshot {
    return {
      deadLetters: this.#deadLetters,
      retries: this.#retries,
      transitions: Object.fromEntries(this.#transitions),
    };
  }
}

function durabilityPath(directory: string, kind: DurableWorkKind): string {
  return resolve(directory, `${kind}.json`);
}

function parseRecords(value: unknown, kind: DurableWorkKind): DurableWorkRecord[] {
  if (!Array.isArray(value)) throw new Error("Runtime durability records must be an array");
  return value.filter((record): record is DurableWorkRecord => {
    if (!record || typeof record !== "object") return false;
    const candidate = record as Partial<DurableWorkRecord>;
    return candidate.kind === kind && typeof candidate.key === "string" && typeof candidate.payload === "object";
  });
}
