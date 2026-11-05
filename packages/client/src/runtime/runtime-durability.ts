import { dirname, resolve } from "node:path";
import {
  type ErrorRetryability,
  redactSensitive,
  type StructuredError,
  StructuredErrorCategorySchema,
  StructuredErrorPhaseSchema,
  StructuredErrorSchema,
} from "@opentag/shared";
import { ensurePrivateDirectory, readDurableJson, writeDurableJson } from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

/**
 * `session-message-outcome` holds Run outcome reports for creator notices. It is a Local-only kind:
 * the reporter always uses a local store, never the Server durable-work API.
 */
export type DurableWorkKind = "session-message" | "session-message-outcome" | "turn-report";
export type DurableWorkStatus = "accepted" | "running" | "succeeded" | "retryable" | "failed" | "dead-letter";
/** The durable state machine stores taxonomy retry policy, not a second retry enum. */
export type DurableRetryability = ErrorRetryability;
export type DurableFailure = StructuredError;

export class RuntimeDurabilityFailure extends Error {
  readonly category: StructuredError["category"];
  readonly code: string;
  readonly phase: StructuredError["phase"];
  readonly requestId: string;
  readonly retryability: DurableRetryability;
  readonly structuredError: DurableFailure;

  constructor(failure: DurableFailure) {
    const structured = StructuredErrorSchema.parse(failure);
    super(structured.message, structured.cause ? { cause: structured.cause } : undefined);
    this.name = "RuntimeDurabilityFailure";
    this.category = structured.category;
    this.code = structured.code;
    this.phase = structured.phase;
    this.requestId = structured.requestId ?? "unknown";
    this.retryability = structured.retryability;
    this.structuredError = structured;
  }
}

/**
 * Convert an operation failure into the shared, bounded taxonomy used by the durable state machines.
 * Legacy `retryable`/`terminal` values are accepted while old on-disk records drain.
 */
export function durableFailureFromUnknown(
  requestId: string,
  phase: string,
  error: unknown,
  fallbackCode: string,
): DurableFailure {
  const source = structuredFailureCandidate(error);
  const sourcePhase = typeof source.phase === "string" ? source.phase : phase;
  const normalizedPhase = normalizePhase(sourcePhase);
  const normalizedRetryability = normalizeRetryability(source.retryability);
  const normalizedCategory = normalizeCategory(source.category, normalizedPhase);
  const code = typeof source.code === "string" && source.code.length > 0 ? source.code : fallbackCode;
  const message = boundedFailureMessage(
    typeof source.message === "string"
      ? source.message
      : error instanceof Error
        ? error.message
        : "Runtime operation failed",
  );
  const candidate = {
    code,
    category: normalizedCategory,
    retryability: normalizedRetryability,
    phase: normalizedPhase,
    requestId: boundedRequestId(
      typeof source.requestId === "string" && source.requestId.length > 0 ? source.requestId : requestId,
    ),
    message,
    ...(source.cause && typeof source.cause === "object" ? { cause: source.cause } : {}),
  };
  const parsed = StructuredErrorSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return StructuredErrorSchema.parse({
    code: fallbackCode,
    category: "internal",
    retryability: "backoff",
    phase: "unknown",
    requestId: boundedRequestId(requestId),
    message: "Runtime operation failed",
  });
}

function structuredFailureCandidate(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    if (candidate.structuredError && typeof candidate.structuredError === "object") {
      return candidate.structuredError as Record<string, unknown>;
    }
    return candidate;
  }
  return {};
}

function normalizeRetryability(value: unknown): ErrorRetryability {
  if (value === "never" || value === "immediate" || value === "backoff" || value === "after_auth") return value;
  if (value === "terminal") return "never";
  return "backoff";
}

function normalizePhase(value: string): StructuredError["phase"] {
  if (StructuredErrorPhaseSchema.safeParse(value).success) return value as StructuredError["phase"];
  const aliases: Record<string, StructuredError["phase"]> = {
    credential: "authentication",
    confirmation: "request",
    persist: "persistence",
    prompt: "provider",
    runtime: "transport",
    server: "transport",
  };
  return aliases[value] ?? "unknown";
}

function normalizeCategory(value: unknown, phase: StructuredError["phase"]): StructuredError["category"] {
  if (StructuredErrorCategorySchema.safeParse(value).success) return value as StructuredError["category"];
  if (value === "credential") return "auth";
  if (value === "provider" || value === "server") return "dependency";
  if (value === "transport" || value === "runtime") return "unavailable";
  if (phase === "authentication") return "auth";
  if (phase === "provider") return "dependency";
  if (phase === "transport") return "unavailable";
  if (phase === "persistence") return "dependency";
  return "internal";
}

function boundedRequestId(value: string): string {
  return value.slice(0, 256) || "unknown";
}

function boundedFailureMessage(value: unknown): string {
  const redacted = redactSensitive(value);
  return (
    (typeof redacted === "string" ? redacted : "Runtime operation failed").slice(0, 256) || "Runtime operation failed"
  );
}

export interface DurableWorkRecord<T = unknown> {
  readonly attempts: number;
  readonly acceptedAt: number;
  readonly key: string;
  readonly kind: DurableWorkKind;
  readonly lastError?: DurableFailure;
  readonly nextAttemptAt?: number;
  /**
   * Session-message only: the creator-notice intent written in the SAME record write as the
   * terminal `failed`/`dead-letter` transition. `pending` means the Run outcome has not yet been
   * handed to the durable outcome reporter; hydration re-derives the report from the terminal
   * record. `published` means the reporter owns it. Absent on records written before the marker
   * existed, which are deliberately not backfilled.
   */
  readonly outcomeReport?: "pending" | "published";
  /**
   * Session-message only: the recoverable interruption that the record's one automatic retry
   * continues from. Its presence makes the next Run start with the continuation notice.
   */
  /** Session-message only: actual run time of its own Runs, against the Run's duration limit. */
  readonly ranMs?: number;
  /** Session-message only: actual run time of its latest retry; long enough, and `attempts` resets. */
  readonly retryRanMs?: number;
  /** Session-message only: the Run this message was steered into, whose retry count it shares. */
  readonly joinedRunId?: string;
  readonly interruption?: { readonly reason: string; readonly at: string };
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
      // Replace an existing record in place: list order is the durable FIFO that hydration restores.
      const index = records.findIndex((candidate) => candidate.key === record.key);
      const next = [...records];
      if (index === -1) next.push(record as DurableWorkRecord);
      else next[index] = record as DurableWorkRecord;
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
      /* v8 ignore else -- the tail map still holds this task while it unwinds. */
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
