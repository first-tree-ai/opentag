import {
  type RuntimeDurableWorkKind,
  type RuntimeDurableWorkRecord,
  RuntimeDurableWorkRecordSchema,
  RuntimeDurableWorkStatusSchema,
  SessionMessageDeliveryRequestSchema,
  TurnReportRequestSchema,
} from "@opentag/shared";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { type RuntimeDurableWorkRow, runtimeDurableWork } from "../db/schema/runtime-durable-work.js";

export const DEFAULT_RUNTIME_DURABLE_WORK_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RUNTIME_DURABLE_WORK_TERMINAL_LIMIT = 512;

export interface RuntimeDurableWorkStoreOptions {
  now?: () => number;
  retentionMs?: number;
  maxTerminalRecords?: number;
}

export class RuntimeDurableWorkConflictError extends Error {
  constructor() {
    super("A durable Runtime record already exists with a different payload");
    this.name = "RuntimeDurableWorkConflictError";
  }
}

export class PostgresRuntimeDurableWorkStore {
  readonly #database: DatabaseClient;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #maxTerminalRecords: number;

  constructor(database: DatabaseClient, options: RuntimeDurableWorkStoreOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? Date.now;
    this.#retentionMs = positive(options.retentionMs ?? DEFAULT_RUNTIME_DURABLE_WORK_RETENTION_MS, "retentionMs");
    this.#maxTerminalRecords = positive(
      options.maxTerminalRecords ?? DEFAULT_RUNTIME_DURABLE_WORK_TERMINAL_LIMIT,
      "maxTerminalRecords",
    );
  }

  async list(computerId: string, kind: RuntimeDurableWorkKind): Promise<RuntimeDurableWorkRecord[]> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await this.#prune(transaction, computerId, kind, now);
      const rows = await transaction
        .select()
        .from(runtimeDurableWork)
        .where(and(eq(runtimeDurableWork.computerId, computerId), eq(runtimeDurableWork.kind, kind)))
        .orderBy(asc(runtimeDurableWork.updatedAt), asc(runtimeDurableWork.recordKey));
      return rows.map((row) => rowToRecord(row));
    });
  }

  async write(computerId: string, input: RuntimeDurableWorkRecord): Promise<void> {
    const record = RuntimeDurableWorkRecordSchema.parse(input);
    validatePayload(record);
    const now = this.#now();
    await this.#database.transaction(async (transaction) => {
      const values = {
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
      await transaction
        .insert(runtimeDurableWork)
        .values(values)
        .onConflictDoNothing({
          target: [runtimeDurableWork.computerId, runtimeDurableWork.kind, runtimeDurableWork.recordKey],
        });
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
      if (existing && stableJson(existing.payload) !== stableJson(record.payload)) {
        throw new RuntimeDurableWorkConflictError();
      }
      if (existing)
        await transaction.update(runtimeDurableWork).set(values).where(eq(runtimeDurableWork.id, existing.id));
      await this.#prune(transaction, computerId, record.kind, now);
    });
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

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Runtime durable work ${name} must be positive`);
  return value;
}
