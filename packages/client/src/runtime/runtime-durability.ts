import { link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type ErrorRetryability,
  redactSensitive,
  type StructuredError,
  StructuredErrorCategorySchema,
  StructuredErrorPhaseSchema,
  StructuredErrorSchema,
} from "@opentag/shared";
import {
  ensurePrivateDirectory,
  RuntimeStorageError,
  readDurableJson,
  readSecureFile,
  syncDurableDirectory,
  writeDurableJson,
} from "../storage/durable-file.js";
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
  /**
   * Session-message only: this message is durably in the conversation of the provider session named by
   * this binding, so resuming that session must not inject it again.
   */
  readonly steerInConversation?: string;
  /** Session-message only: the provider conversation this message's own Run last ran in. */
  readonly runConversation?: string;
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

/** A finished record older than this leaves the file, for the kinds that `PRUNED_KINDS` names. */
export const FINISHED_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const FINISHED_STATUSES: ReadonlySet<DurableWorkStatus> = new Set(["succeeded", "failed", "dead-letter"]);

/**
 * `session-message` is not pruned: a finished record is the inbox's only deduplication evidence. A
 * message whose acceptance reply was lost stays `unknown` on the Server, which may send it again under
 * the same ID at any age; without the record, that replay would run the message a second time.
 */
const PRUNED_KINDS: ReadonlySet<DurableWorkKind> = new Set(["turn-report", "session-message-outcome"]);

/** Kept while its outcome may still need handing over, or while it is recent enough to answer a replay. */
function retained(record: DurableWorkRecord, nowMs: number): boolean {
  if (!PRUNED_KINDS.has(record.kind)) return true;
  if (!FINISHED_STATUSES.has(record.status) || record.outcomeReport === "pending") return true;
  return nowMs - record.updatedAt < FINISHED_RECORD_RETENTION_MS;
}

/** A durable file that could not be read, moved aside so the store can start empty for its kind. */
export interface DurableFileQuarantine {
  readonly kind: DurableWorkKind;
  /** Where the unreadable file now is; nothing reads it again. */
  readonly quarantinedPath: string;
  /** Records of this kind the file still named: an estimate, since the file could not be parsed. */
  readonly lostRecords: number;
  readonly error: RuntimeStorageError;
}

/** The quarantine as a reportable failure: the kind and the loss, never the file path or its content. */
export class DurableFileQuarantinedError extends Error {
  readonly code = "durable_file_quarantined";

  constructor(quarantine: Pick<DurableFileQuarantine, "kind" | "lostRecords" | "error">) {
    super(
      `Unreadable ${quarantine.kind} durable file moved aside; about ${quarantine.lostRecords} records lost (${quarantine.error.message})`,
      { cause: quarantine.error },
    );
    this.name = "DurableFileQuarantinedError";
  }
}

export interface FileRuntimeDurabilityStoreOptions {
  /**
   * Told once per quarantined file. The records in it are lost to this Client: the host logs and
   * reports them, because no Run, report, or notice they held will happen.
   */
  readonly onQuarantine?: (quarantine: DurableFileQuarantine) => void;
  readonly now?: () => number;
}

export class FileRuntimeDurabilityStore implements RuntimeDurabilityStore {
  readonly #directory: string;
  readonly #tails = new Map<DurableWorkKind, Promise<void>>();
  readonly #onQuarantine: (quarantine: DurableFileQuarantine) => void;
  readonly #now: () => number;

  constructor(home: string, options: FileRuntimeDurabilityStoreOptions = {}) {
    this.#directory = resolve(resolveOpenTagHomeLayout(home).runtime, "durability");
    this.#onQuarantine = options.onQuarantine ?? (() => undefined);
    this.#now = options.now ?? Date.now;
  }

  async list<T = unknown>(kind: DurableWorkKind): Promise<DurableWorkRecord<T>[]> {
    try {
      return (await this.#read(kind)) as DurableWorkRecord<T>[];
    } catch (error) {
      if (!isInvalidStorage(error)) throw error;
      // Quarantine under the kind lock: a concurrent write may already have moved the file aside.
      return (await this.#withKindLock(kind, () => this.#readOrQuarantine(kind))) as DurableWorkRecord<T>[];
    }
  }

  async write<T>(record: DurableWorkRecord<T>): Promise<void> {
    await this.#withKindLock(record.kind, async () => {
      await ensurePrivateDirectory(dirname(this.#directory), this.#directory);
      const path = durabilityPath(this.#directory, record.kind);
      const records = await this.#readOrQuarantine(record.kind);
      // Replace an existing record in place: list order is the durable FIFO that hydration restores.
      const index = records.findIndex((candidate) => candidate.key === record.key);
      const next = [...records];
      if (index === -1) next.push(record as DurableWorkRecord);
      else next[index] = record as DurableWorkRecord;
      // Every write rewrites the whole file, so finished history of the pruned kinds is dropped here.
      const nowMs = this.#now();
      await writeDurableJson(
        path,
        next.filter((candidate) => candidate.key === record.key || retained(candidate, nowMs)),
      );
    });
  }

  async #read(kind: DurableWorkKind): Promise<DurableWorkRecord[]> {
    return (await readDurableJson(durabilityPath(this.#directory, kind), (value) => parseRecords(value, kind))) ?? [];
  }

  /**
   * Read a kind, moving an unreadable file aside rather than failing: one corrupt file must not keep
   * the Client from starting or stop every later write of its kind. Called under the kind lock.
   */
  async #readOrQuarantine(kind: DurableWorkKind): Promise<DurableWorkRecord[]> {
    try {
      return await this.#read(kind);
    } catch (error) {
      if (!isInvalidStorage(error)) throw error;
      const path = durabilityPath(this.#directory, kind);
      const lostRecords = countRecords(await readSecureFile(path), kind);
      const quarantinedPath = await archive(path, `${path}.corrupt-${this.#now()}`);
      await syncDurableDirectory(this.#directory);
      try {
        this.#onQuarantine({ kind, quarantinedPath, lostRecords, error });
      } catch {
        // Reporting is best effort; the store has already recovered.
      }
      return [];
    }
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

function isInvalidStorage(error: unknown): error is RuntimeStorageError {
  return error instanceof RuntimeStorageError && error.code === "invalid";
}

/**
 * How many records of this kind the unreadable file still names. An estimate: each record carries its
 * kind, so a truncated or garbled file can still be counted, but an opaque payload could repeat it.
 */
function countRecords(content: string | undefined, kind: DurableWorkKind): number {
  return String(content).match(new RegExp(`"kind"\\s*:\\s*"${kind}"`, "g"))?.length ?? 0;
}

/**
 * Move `path` to the first free name starting at `base`. `link` refuses an existing destination, so an
 * earlier archive with the same clock value is never replaced, as `rename` would on POSIX.
 */
async function archive(path: string, base: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const destination = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      await link(path, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    await unlink(path);
    return destination;
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
