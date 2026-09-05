import {
  type RuntimeDurableWorkKind,
  type RuntimeDurableWorkRecord,
  RuntimeDurableWorkRecordSchema,
  RuntimeDurableWorkStatusSchema,
  SessionMessageDeliveryRequestSchema,
  TurnReportRequestSchema,
} from "@opentag/shared";
import { and, asc, eq, gt, inArray, lt, or } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { computers } from "../db/schema/computers.js";
import { type RuntimeDurableWorkRow, runtimeDurableWork } from "../db/schema/runtime-durable-work.js";

export const DEFAULT_RUNTIME_DURABLE_WORK_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RUNTIME_DURABLE_WORK_TERMINAL_LIMIT = 512;
/** Maximum number of non-terminal records retained for one Computer. */
export const DEFAULT_RUNTIME_DURABLE_WORK_RECORD_LIMIT = 4_096;
/** Maximum UTF-8 bytes of serialized payloads retained for one Computer. */
export const DEFAULT_RUNTIME_DURABLE_WORK_PAYLOAD_BYTES_LIMIT = 16 * 1024 * 1024;
/** Maximum UTF-8 bytes accepted for one serialized payload. */
export const DEFAULT_RUNTIME_DURABLE_WORK_SINGLE_PAYLOAD_BYTES_LIMIT = 1 * 1024 * 1024;
/** Default page size for durable-work list requests. The response schema permits at most 1024 records. */
export const DEFAULT_RUNTIME_DURABLE_WORK_PAGE_SIZE = 256;
export const RUNTIME_DURABLE_WORK_MAX_PAGE_SIZE = 1024;

export const RUNTIME_DURABLE_WORK_ALLOWED_TRANSITIONS = {
  accepted: ["accepted", "running", "dead-letter"],
  running: ["running", "succeeded", "failed", "retryable", "dead-letter"],
  succeeded: ["succeeded"],
  retryable: ["retryable", "accepted", "running", "dead-letter"],
  failed: ["failed"],
  "dead-letter": ["dead-letter"],
} as const satisfies Record<RuntimeDurableWorkRecord["status"], readonly RuntimeDurableWorkRecord["status"][]>;

export interface RuntimeDurableWorkStoreOptions {
  now?: () => number;
  retentionMs?: number;
  maxTerminalRecords?: number;
  maxRecordsPerComputer?: number;
  maxPayloadBytesPerComputer?: number;
  maxPayloadBytesPerRecord?: number;
}

export interface RuntimeDurableWorkListOptions {
  cursor?: string;
  limit?: number;
}

export interface RuntimeDurableWorkListPage {
  items: RuntimeDurableWorkRecord[];
  nextCursor?: string;
}

export class RuntimeDurableWorkConflictError extends Error {
  constructor() {
    super("A durable Runtime record already exists with a different payload");
    this.name = "RuntimeDurableWorkConflictError";
  }
}

export class RuntimeDurableWorkStaleWriteError extends Error {
  constructor(
    readonly storedUpdatedAt: number,
    readonly incomingUpdatedAt: number,
  ) {
    super("The durable Runtime record was updated by a newer writer");
    this.name = "RuntimeDurableWorkStaleWriteError";
  }
}

export class RuntimeDurableWorkTransitionError extends Error {
  constructor(
    readonly from: RuntimeDurableWorkRecord["status"],
    readonly to: RuntimeDurableWorkRecord["status"],
  ) {
    super(`The durable Runtime record cannot transition from ${from} to ${to}`);
    this.name = "RuntimeDurableWorkTransitionError";
  }
}

export class RuntimeDurableWorkQuotaExceededError extends Error {
  constructor(
    readonly quota: "records" | "payload-bytes",
    readonly limit: number,
    readonly current: number,
    readonly requested: number,
  ) {
    super(
      quota === "records"
        ? "The Computer durable Runtime record quota has been reached"
        : "The Computer durable Runtime payload quota has been reached",
    );
    this.name = "RuntimeDurableWorkQuotaExceededError";
  }
}

export class RuntimeDurableWorkPayloadTooLargeError extends Error {
  constructor(
    readonly limit: number,
    readonly size: number,
  ) {
    super("The durable Runtime payload exceeds the per-record size limit");
    this.name = "RuntimeDurableWorkPayloadTooLargeError";
  }
}

export class RuntimeDurableWorkCursorError extends Error {
  constructor() {
    super("The durable Runtime list cursor is invalid");
    this.name = "RuntimeDurableWorkCursorError";
  }
}

export class PostgresRuntimeDurableWorkStore {
  readonly #database: DatabaseClient;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #maxTerminalRecords: number;
  readonly #maxRecordsPerComputer: number;
  readonly #maxPayloadBytesPerComputer: number;
  readonly #maxPayloadBytesPerRecord: number;

  constructor(database: DatabaseClient, options: RuntimeDurableWorkStoreOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? Date.now;
    this.#retentionMs = positive(options.retentionMs ?? DEFAULT_RUNTIME_DURABLE_WORK_RETENTION_MS, "retentionMs");
    this.#maxTerminalRecords = positive(
      options.maxTerminalRecords ?? DEFAULT_RUNTIME_DURABLE_WORK_TERMINAL_LIMIT,
      "maxTerminalRecords",
    );
    this.#maxRecordsPerComputer = positive(
      options.maxRecordsPerComputer ?? DEFAULT_RUNTIME_DURABLE_WORK_RECORD_LIMIT,
      "maxRecordsPerComputer",
    );
    this.#maxPayloadBytesPerComputer = positive(
      options.maxPayloadBytesPerComputer ?? DEFAULT_RUNTIME_DURABLE_WORK_PAYLOAD_BYTES_LIMIT,
      "maxPayloadBytesPerComputer",
    );
    this.#maxPayloadBytesPerRecord = positive(
      options.maxPayloadBytesPerRecord ?? DEFAULT_RUNTIME_DURABLE_WORK_SINGLE_PAYLOAD_BYTES_LIMIT,
      "maxPayloadBytesPerRecord",
    );
  }

  async list(
    computerId: string,
    kind: RuntimeDurableWorkKind,
    options: RuntimeDurableWorkListOptions = {},
  ): Promise<RuntimeDurableWorkListPage> {
    const now = this.#now();
    const limit = pageLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    return this.#database.transaction(async (transaction) => {
      await this.#prune(transaction, computerId, kind, now);
      const conditions = [eq(runtimeDurableWork.computerId, computerId), eq(runtimeDurableWork.kind, kind)];
      if (cursor) {
        const cursorCondition = or(
          gt(runtimeDurableWork.updatedAt, cursor.updatedAt),
          and(eq(runtimeDurableWork.updatedAt, cursor.updatedAt), gt(runtimeDurableWork.recordKey, cursor.recordKey)),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      }
      const rows = await transaction
        .select()
        .from(runtimeDurableWork)
        .where(and(...conditions))
        .orderBy(asc(runtimeDurableWork.updatedAt), asc(runtimeDurableWork.recordKey))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = pageRows.at(-1);
      return {
        items: pageRows.map((row) => rowToRecord(row)),
        ...(hasMore && lastRow ? { nextCursor: encodeCursor(lastRow) } : {}),
      };
    });
  }

  async write(computerId: string, input: RuntimeDurableWorkRecord): Promise<void> {
    const record = RuntimeDurableWorkRecordSchema.parse(input);
    validatePayload(record);
    const payloadBytes = serializedPayloadBytes(record.payload);
    if (payloadBytes > this.#maxPayloadBytesPerRecord) {
      throw new RuntimeDurableWorkPayloadTooLargeError(this.#maxPayloadBytesPerRecord, payloadBytes);
    }
    const now = this.#now();
    await this.#database.transaction((transaction) =>
      this.#writeInTransaction(transaction, computerId, record, payloadBytes, now),
    );
  }

  async #writeInTransaction(
    transaction: DatabaseTransaction,
    computerId: string,
    record: RuntimeDurableWorkRecord,
    payloadBytes: number,
    now: number,
  ): Promise<void> {
    // Every writer locks the Computer row. This serializes quota accounting for one Computer
    // while keeping unrelated Computers independent.
    const [computer] = await transaction
      .select({ id: computers.id })
      .from(computers)
      .where(eq(computers.id, computerId))
      .for("update");
    if (!computer) throw new Error("The durable Runtime Computer does not exist");

    await this.#prune(transaction, computerId, record.kind, now);
    const [existing] = await transaction
      .select()
      .from(runtimeDurableWork)
      .where(
        and(
          eq(runtimeDurableWork.computerId, computerId),
          eq(runtimeDurableWork.kind, record.kind),
          eq(runtimeDurableWork.recordKey, record.key),
        ),
      )
      .limit(1)
      .for("update");

    if (!existing) {
      await this.#assertQuota(transaction, computerId, payloadBytes);
      await transaction.insert(runtimeDurableWork).values(recordValues(computerId, record));
      return;
    }
    if (stableJson(existing.payload) !== stableJson(record.payload)) {
      throw new RuntimeDurableWorkConflictError();
    }
    if (sameRecord(existing, record)) return;
    if (record.updatedAt <= existing.updatedAt) {
      throw new RuntimeDurableWorkStaleWriteError(existing.updatedAt, record.updatedAt);
    }
    if (!isAllowedTransition(existing.status, record.status)) {
      throw new RuntimeDurableWorkTransitionError(existing.status, record.status);
    }
    if (payloadBytes > serializedPayloadBytes(existing.payload)) {
      await this.#assertQuota(transaction, computerId, payloadBytes, existing);
    }
    const updated = await transaction
      .update(runtimeDurableWork)
      .set(recordValues(computerId, record))
      .where(and(eq(runtimeDurableWork.id, existing.id), lt(runtimeDurableWork.updatedAt, record.updatedAt)))
      .returning({ id: runtimeDurableWork.id });
    if (updated.length === 0) {
      throw new RuntimeDurableWorkStaleWriteError(existing.updatedAt, record.updatedAt);
    }
  }

  async #assertQuota(
    transaction: DatabaseTransaction,
    computerId: string,
    incomingPayloadBytes: number,
    replacing?: RuntimeDurableWorkRow,
  ): Promise<void> {
    const rows = await transaction
      .select({ id: runtimeDurableWork.id, payload: runtimeDurableWork.payload, status: runtimeDurableWork.status })
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.computerId, computerId));
    const currentRecords = rows.filter((row) => isNonTerminalStatus(row.status)).length;
    const replacingNonTerminal = replacing ? isNonTerminalStatus(replacing.status) : false;
    const requestedRecords = currentRecords - (replacingNonTerminal ? 1 : 0) + 1;
    if (!replacing && requestedRecords > this.#maxRecordsPerComputer) {
      throw new RuntimeDurableWorkQuotaExceededError(
        "records",
        this.#maxRecordsPerComputer,
        currentRecords,
        requestedRecords,
      );
    }
    const currentPayloadBytes = rows.reduce((total, row) => total + serializedPayloadBytes(row.payload), 0);
    const requestedPayloadBytes =
      currentPayloadBytes - (replacing ? serializedPayloadBytes(replacing.payload) : 0) + incomingPayloadBytes;
    if (requestedPayloadBytes > this.#maxPayloadBytesPerComputer) {
      throw new RuntimeDurableWorkQuotaExceededError(
        "payload-bytes",
        this.#maxPayloadBytesPerComputer,
        currentPayloadBytes - (replacing ? serializedPayloadBytes(replacing.payload) : 0),
        requestedPayloadBytes,
      );
    }
  }

  async #prune(
    transaction: DatabaseTransaction,
    computerId: string,
    kind: RuntimeDurableWorkKind,
    now: number,
  ): Promise<void> {
    const cutoff = now - this.#retentionMs;
    await transaction
      .delete(runtimeDurableWork)
      .where(
        and(
          eq(runtimeDurableWork.computerId, computerId),
          eq(runtimeDurableWork.kind, kind),
          lt(runtimeDurableWork.updatedAt, cutoff),
        ),
      );
    const terminal = await transaction
      .select({ id: runtimeDurableWork.id })
      .from(runtimeDurableWork)
      .where(
        and(
          eq(runtimeDurableWork.computerId, computerId),
          eq(runtimeDurableWork.kind, kind),
          inArray(runtimeDurableWork.status, ["succeeded", "failed", "dead-letter"]),
        ),
      )
      .orderBy(asc(runtimeDurableWork.updatedAt), asc(runtimeDurableWork.id));
    const excess = terminal.slice(0, Math.max(0, terminal.length - this.#maxTerminalRecords)).map((row) => row.id);
    if (excess.length > 0) await transaction.delete(runtimeDurableWork).where(inArray(runtimeDurableWork.id, excess));
  }
}

function recordValues(computerId: string, record: RuntimeDurableWorkRecord) {
  return {
    computerId,
    kind: record.kind,
    recordKey: record.key,
    payload: record.payload,
    status: RuntimeDurableWorkStatusSchema.parse(record.status),
    attempts: record.attempts,
    acceptedAt: record.acceptedAt,
    nextAttemptAt: record.nextAttemptAt ?? null,
    lastError: record.lastError ?? null,
    updatedAt: record.updatedAt,
  } as const;
}

function rowToRecord(row: RuntimeDurableWorkRow): RuntimeDurableWorkRecord {
  return RuntimeDurableWorkRecordSchema.parse({
    attempts: row.attempts,
    acceptedAt: row.acceptedAt,
    key: row.recordKey,
    kind: row.kind,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.nextAttemptAt === null ? {} : { nextAttemptAt: row.nextAttemptAt }),
    payload: row.payload,
    status: row.status,
    updatedAt: row.updatedAt,
  });
}

function validatePayload(record: RuntimeDurableWorkRecord): void {
  const parsed =
    record.kind === "session-message"
      ? SessionMessageDeliveryRequestSchema.safeParse(record.payload)
      : TurnReportRequestSchema.safeParse(record.payload);
  if (!parsed.success) throw new Error(`Invalid ${record.kind} durable payload`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameRecord(row: RuntimeDurableWorkRow, record: RuntimeDurableWorkRecord): boolean {
  return (
    row.status === record.status &&
    row.attempts === record.attempts &&
    row.acceptedAt === record.acceptedAt &&
    row.updatedAt === record.updatedAt &&
    (row.nextAttemptAt ?? null) === (record.nextAttemptAt ?? null) &&
    stableJson(row.lastError) === stableJson(record.lastError ?? null) &&
    stableJson(row.payload) === stableJson(record.payload)
  );
}

function isAllowedTransition(
  from: RuntimeDurableWorkRecord["status"],
  to: RuntimeDurableWorkRecord["status"],
): boolean {
  return (RUNTIME_DURABLE_WORK_ALLOWED_TRANSITIONS[from] as readonly string[]).includes(to);
}

function isNonTerminalStatus(status: RuntimeDurableWorkRecord["status"]): boolean {
  return status === "accepted" || status === "running" || status === "retryable";
}

function serializedPayloadBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Durable Runtime payload is not serializable");
  return Buffer.byteLength(serialized, "utf8");
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RUNTIME_DURABLE_WORK_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUNTIME_DURABLE_WORK_MAX_PAGE_SIZE) {
    throw new Error(`Runtime durable work page limit must be between 1 and ${RUNTIME_DURABLE_WORK_MAX_PAGE_SIZE}`);
  }
  return limit;
}

type RuntimeDurableWorkCursor = { updatedAt: number; recordKey: string };

function encodeCursor(row: Pick<RuntimeDurableWorkRow, "updatedAt" | "recordKey">): string {
  return Buffer.from(JSON.stringify({ updatedAt: row.updatedAt, recordKey: row.recordKey }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(value: string): RuntimeDurableWorkCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Number.isSafeInteger((parsed as { updatedAt?: unknown }).updatedAt) ||
      ((parsed as { updatedAt: number }).updatedAt ?? -1) < 0 ||
      typeof (parsed as { recordKey?: unknown }).recordKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test((parsed as { recordKey: string }).recordKey)
    ) {
      throw new Error("invalid cursor");
    }
    return parsed as RuntimeDurableWorkCursor;
  } catch {
    throw new RuntimeDurableWorkCursorError();
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Runtime durable work ${name} must be positive`);
  return value;
}
