import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  type TurnReportRequest,
  TurnReportRequestSchema,
} from "@opentag/shared";
import { z } from "zod";

/**
 * Trusted-parent durable journal for Cloud deliveries. Lives in the Runner's own state directory —
 * never inside the Session workspace, the Sandbox mounts, or any user-readable location. Every
 * mutation is write-temp + fsync + rename + directory fsync BEFORE the corresponding channel
 * acknowledgement, so a Runner crash never loses the boundary between "received, not started",
 * "started, outcome unknown", and "reported, awaiting ack".
 *
 * The entry persists everything needed to reconstruct a durable answer after a full process
 * restart without any in-memory map:
 * - the exact bounded dispatch payload the Server dispatched, plus its canonical input hash, so a
 *   re-dispatch with the same ids but different content is a visible conflict, never a new turn;
 * - the exact allocation scope that owned the delivery (sandbox/session/generation/resource/UID),
 *   so a reopened journal under another allocation fails closed instead of re-emitting old work;
 * - the Runner-allocated turn id and the exact report once recorded.
 *
 * All mutations are serialized through one in-process queue, so concurrent frames can never
 * interleave a read-modify-write (the previous timestamp-named temp file raced under bursts).
 *
 * Phase machine (no backward transitions, no blind replays):
 *   received  — input durably journaled; receipt (re)sent on reconnect; execution NEVER started
 *   started   — Server verification arrived and execution began; a crash from here reports
 *               outcome "unknown" with executionEffects "may_have_occurred"
 *   reported  — result durably journaled; the report is re-sent until a durable ack
 *
 * A `received` entry may also settle directly into a terminal `reported` not-started failure
 * (missing model grant, expired deadline, explicit cancel before start); it may never transition
 * to `started` afterwards.
 */

export const CLOUD_JOURNAL_VERSION = 2;
export const CLOUD_JOURNAL_PHASES = ["received", "started", "reported"] as const;
/** Hard cap per entry: the dispatch frame budget plus scope/hash overhead. Oversize fails loudly. */
export const CLOUD_JOURNAL_ENTRY_MAX_BYTES = 320 * 1024;
/** Hard cap on entries scanned per operation; bounds reconnect reconciliation work. */
export const CLOUD_JOURNAL_MAX_ENTRIES = 1024;

/** Exact allocation identity that owns a journaled delivery. */
export const CloudJournalScopeSchema = z
  .object({
    sandboxId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
    environmentGeneration: z.number().int().nonnegative(),
    resourceName: z.string().min(1).max(1024),
    resourceUid: z.string().min(1).max(128),
  })
  .strict();
export type CloudJournalScope = z.infer<typeof CloudJournalScopeSchema>;

const CloudJournalEntrySchema = z
  .object({
    version: z.literal(CLOUD_JOURNAL_VERSION),
    delivery: DirectImMessageDeliveryRequestSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: CloudJournalScopeSchema,
    deliveryId: z.string().min(1).max(256),
    requestId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256),
    phase: z.enum(CLOUD_JOURNAL_PHASES),
    report: TurnReportRequestSchema.optional(),
  })
  .strict();

export type CloudJournalPhase = (typeof CLOUD_JOURNAL_PHASES)[number];

export interface CloudJournalEntry {
  /** The exact dispatched delivery payload; needed to rebuild reports after a crash. */
  readonly delivery: DirectImMessageDeliveryRequest;
  /** sha256 over the canonical dispatch payload; detects same-id/different-input replays. */
  readonly inputHash: string;
  /** The exact allocation that owned this delivery when it was received. */
  readonly scope: CloudJournalScope;
  readonly deliveryId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly phase: CloudJournalPhase;
  readonly report?: TurnReportRequest;
}

export interface CloudJournalDurableAck {
  readonly turnId: string;
  readonly resultHash: string;
  readonly status: "recorded" | "already_recorded";
}

const ENTRY_NAME = /^[a-zA-Z0-9-]{1,256}\.json$/;

export class CloudJournalError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "unknown_entry"
      | "invalid_transition"
      | "store_failed"
      | "scope_mismatch"
      | "scope_unbound"
      | "ack_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "CloudJournalError";
  }
}

/** Canonical (key-sorted) JSON so the same logical payload always hashes identically. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** Stable identity of one dispatch payload. */
export function computeCloudDeliveryInputHash(delivery: DirectImMessageDeliveryRequest): string {
  return createHash("sha256").update(canonicalJson(delivery)).digest("hex");
}

/** Fail visibly when a durable entry belongs to another allocation. */
export function assertCloudJournalScope(entry: CloudJournalEntry, scope: CloudJournalScope): void {
  const same = CloudJournalScopeSchema.safeParse(entry.scope);
  if (!same.success) {
    throw new CloudJournalError("store_failed", `Delivery ${entry.deliveryId} has an unreadable allocation scope`);
  }
  const fields = ["sandboxId", "sessionId", "environmentGeneration", "resourceName", "resourceUid"] as const;
  for (const field of fields) {
    if (entry.scope[field] !== scope[field]) {
      throw new CloudJournalError(
        "scope_mismatch",
        `Delivery ${entry.deliveryId} belongs to allocation ${entry.scope.sandboxId}/${entry.scope.environmentGeneration} (${entry.scope.resourceUid}), not the current one`,
      );
    }
  }
}

export class CloudJournal {
  readonly #directory: string;
  /** Serializes every mutation so concurrent frames cannot interleave read-modify-write. */
  #mutations: Promise<unknown> = Promise.resolve();

  private constructor(directory: string) {
    this.#directory = directory;
  }

  get directory(): string {
    return this.#directory;
  }

  /** Open (and create) the journal directory with owner-only permissions. */
  static async open(directory: string): Promise<CloudJournal> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new CloudJournal(directory);
  }

  /** Every entry, for reconnect reconciliation. Corrupt files fail loudly, never silently skipped. */
  async list(): Promise<CloudJournalEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entryNames = names.filter((name) => ENTRY_NAME.test(name)).sort();
    if (entryNames.length > CLOUD_JOURNAL_MAX_ENTRIES) {
      throw new CloudJournalError(
        "store_failed",
        `The Cloud delivery journal holds more than ${CLOUD_JOURNAL_MAX_ENTRIES} entries`,
      );
    }
    const entries: CloudJournalEntry[] = [];
    for (const name of entryNames) {
      entries.push(await this.#readFile(name));
    }
    return entries;
  }

  /**
   * Durable receipt: fsync BEFORE the receipt frame is sent. Recording the same dispatch twice
   * (idempotent retransmission) keeps the original turn id; a different request id, a different
   * input payload, or a different allocation for the same delivery is a visible conflict and must
   * never be silently merged or re-run.
   */
  async recordReceived(input: {
    delivery: DirectImMessageDeliveryRequest;
    scope: CloudJournalScope;
    deliveryId: string;
    requestId: string;
    turnId: string;
  }): Promise<CloudJournalEntry> {
    return this.#mutate(async () => {
      const scope = CloudJournalScopeSchema.parse(input.scope);
      const inputHash = computeCloudDeliveryInputHash(input.delivery);
      const existing = await this.#readEntry(input.deliveryId);
      if (existing) {
        assertCloudJournalScope(existing, scope);
        if (existing.requestId !== input.requestId) {
          throw new CloudJournalError(
            "conflict",
            `Journal entry for delivery ${input.deliveryId} belongs to a different dispatch`,
          );
        }
        if (existing.inputHash !== inputHash) {
          throw new CloudJournalError(
            "conflict",
            `Journal entry for delivery ${input.deliveryId} was already received with different input`,
          );
        }
        return existing;
      }
      const entry: CloudJournalEntry = {
        delivery: input.delivery,
        inputHash,
        scope,
        deliveryId: input.deliveryId,
        requestId: input.requestId,
        turnId: input.turnId,
        phase: "received",
      };
      await this.#write(input.deliveryId, entry);
      return entry;
    });
  }

  /** received -> started, fsynced BEFORE the native worker launches. */
  async markStarted(deliveryId: string, scope: CloudJournalScope): Promise<CloudJournalEntry> {
    return this.#mutate(async () => {
      const entry = await this.#requireScoped(deliveryId, scope);
      if (entry.phase === "received") return this.#transition(entry, "started");
      if (entry.phase === "started") return entry;
      throw new CloudJournalError(
        "invalid_transition",
        `Delivery ${deliveryId} cannot start from phase ${entry.phase}`,
      );
    });
  }

  /**
   * started -> reported with the exact Turn Report, fsynced BEFORE the report frame is sent.
   * received -> reported is admitted ONLY for a terminal `not_started` failure that proves no
   * native/Pi/tool work happened (missing/expired model grant, expired deadline, cancel).
   */
  async recordReport(
    deliveryId: string,
    scope: CloudJournalScope,
    report: TurnReportRequest,
  ): Promise<CloudJournalEntry> {
    return this.#mutate(async () => {
      const entry = await this.#requireScoped(deliveryId, scope);
      if (entry.phase === "reported") {
        if (entry.report?.resultHash !== report.resultHash) {
          throw new CloudJournalError("conflict", `Delivery ${deliveryId} already has a different journaled report`);
        }
        return entry;
      }
      if (entry.phase === "received" && report.executionEffects !== "not_started") {
        throw new CloudJournalError(
          "invalid_transition",
          `Delivery ${deliveryId} cannot report effects "${report.executionEffects}" from phase received`,
        );
      }
      return this.#transition(entry, "reported", report);
    });
  }

  /**
   * The Server explicitly refused custody before any start (stale scope/generation). Only a
   * `received` entry may retire this way; a started/reported entry represents real durable state.
   */
  async clearRejected(deliveryId: string, scope: CloudJournalScope): Promise<void> {
    return this.#mutate(async () => {
      const entry = await this.#requireScoped(deliveryId, scope);
      if (entry.phase !== "received") {
        throw new CloudJournalError(
          "invalid_transition",
          `Delivery ${deliveryId} cannot be retired as rejected from phase ${entry.phase}`,
        );
      }
      await this.#remove(deliveryId);
    });
  }

  /**
   * The Server durably acknowledged THIS exact report: only a matching turn id, result hash, and
   * recorded/already_recorded status retires the entry. Conflicts and stale-generation acks leave
   * the durable report in place for reconciliation.
   */
  async clearAcknowledged(deliveryId: string, scope: CloudJournalScope, ack: CloudJournalDurableAck): Promise<void> {
    return this.#mutate(async () => {
      const entry = await this.#requireScoped(deliveryId, scope);
      if (entry.phase !== "reported" || !entry.report) {
        throw new CloudJournalError(
          "invalid_transition",
          `Delivery ${deliveryId} has no durable report to acknowledge (phase ${entry.phase})`,
        );
      }
      if (
        entry.turnId !== ack.turnId ||
        entry.report.resultHash !== ack.resultHash ||
        (ack.status !== "recorded" && ack.status !== "already_recorded")
      ) {
        throw new CloudJournalError("ack_mismatch", `The acknowledgement does not match the journaled report`);
      }
      await this.#remove(deliveryId);
    });
  }

  /** Read one entry without scope assumptions; callers assert scope before acting on it. */
  async read(deliveryId: string): Promise<CloudJournalEntry | undefined> {
    return this.#readEntry(deliveryId);
  }

  async #requireScoped(deliveryId: string, scope: CloudJournalScope): Promise<CloudJournalEntry> {
    const entry = await this.#readEntry(deliveryId);
    if (!entry) throw new CloudJournalError("unknown_entry", `No journaled delivery ${deliveryId}`);
    assertCloudJournalScope(entry, scope);
    return entry;
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutations.then(operation, operation);
    this.#mutations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #readEntry(deliveryId: string): Promise<CloudJournalEntry | undefined> {
    try {
      return await this.#readFile(`${deliveryId}.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #readFile(name: string): Promise<CloudJournalEntry> {
    if (!ENTRY_NAME.test(name)) {
      throw new CloudJournalError("store_failed", `Unsafe Cloud delivery journal entry name ${name}`);
    }
    let raw: string;
    try {
      raw = await readFile(join(this.#directory, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw new CloudJournalError("store_failed", `The Cloud delivery journal entry ${name} could not be read`);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new CloudJournalError("store_failed", `The Cloud delivery journal entry ${name} is not valid JSON`);
    }
    const parsed = CloudJournalEntrySchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new CloudJournalError("store_failed", `The Cloud delivery journal entry ${name} is unreadable`);
    }
    return {
      delivery: parsed.data.delivery,
      inputHash: parsed.data.inputHash,
      scope: parsed.data.scope,
      deliveryId: parsed.data.deliveryId,
      requestId: parsed.data.requestId,
      turnId: parsed.data.turnId,
      phase: parsed.data.phase,
      ...(parsed.data.report ? { report: parsed.data.report } : {}),
    };
  }

  async #transition(
    entry: CloudJournalEntry,
    phase: CloudJournalPhase,
    report?: TurnReportRequest,
  ): Promise<CloudJournalEntry> {
    const next: CloudJournalEntry = { ...entry, phase, ...(report ? { report } : {}) };
    await this.#write(entry.deliveryId, next);
    return next;
  }

  /** Atomic write: temp file, fsync, rename, directory fsync. Serialized by the caller. */
  async #write(deliveryId: string, entry: CloudJournalEntry): Promise<void> {
    const target = this.#path(deliveryId);
    const serialized = `${JSON.stringify({ version: CLOUD_JOURNAL_VERSION, ...entry } satisfies Record<string, unknown>)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > CLOUD_JOURNAL_ENTRY_MAX_BYTES) {
      throw new CloudJournalError(
        "store_failed",
        `The Cloud delivery journal entry for ${deliveryId} exceeds ${CLOUD_JOURNAL_ENTRY_MAX_BYTES} bytes`,
      );
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch {
      throw new CloudJournalError(
        "store_failed",
        `The Cloud delivery journal entry for ${deliveryId} could not be written`,
      );
    }
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } catch {
      throw new CloudJournalError(
        "store_failed",
        `The Cloud delivery journal entry for ${deliveryId} could not be synced`,
      );
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
      await this.#syncDirectory();
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new CloudJournalError("store_failed", `The Cloud delivery journal entry for ${deliveryId} was not durable`);
    }
  }

  async #remove(deliveryId: string): Promise<void> {
    await rm(this.#path(deliveryId), { force: true });
    await this.#syncDirectory();
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#directory, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  #path(deliveryId: string): string {
    if (!/^[a-zA-Z0-9-]{1,256}$/.test(deliveryId)) {
      throw new CloudJournalError("store_failed", "Unsafe delivery id for the journal path");
    }
    return join(this.#directory, `${deliveryId}.json`);
  }
}
