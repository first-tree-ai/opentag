import { createHash } from "node:crypto";
import type { AgentScheduleLastDispatch, SessionMessageScheduledOrigin } from "@opentag/shared";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agentSchedules, sessionMessages } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { ScheduleDispatch, ScheduledMessageSnapshot } from "../sessions/session-collaboration-service.js";
import type { SessionService } from "../sessions/session-service.js";
import { nextScheduleOccurrence, normalizeAndValidateRule } from "./calculator.js";
import { type ScheduleClock, scheduleDatabaseClock, scheduleDetailUrl } from "./service.js";

/*
 * ScheduleScheduler — the Server's fixed-Chat schedule scanner.
 *
 * Every five seconds one non-reentrant scan locates due enabled schedules (ordered by
 * `(next_trigger_at, id)`, at most `scanLimit`), and claims each row in its own transaction under
 * `FOR UPDATE SKIP LOCKED`. The claim samples the database `clock_timestamp()` only AFTER the row
 * lock is held, re-checks due/enabled, applies the inclusive 30-second claim window, validates the
 * stored rule, freezes the snapshot, inserts the deterministic SessionMessage, advances
 * `next_trigger_at`, and writes the `unknown` dispatch summary — atomically. Only a committed
 * claim returns a dispatch snapshot; a rolled-back or uncertain commit is never dispatched or
 * retried from the message row.
 *
 * In-flight dispatches occupy at most `maxInFlight` slots and resolve independently of the scan
 * loop, so a Cloud cold start never blocks the next scan. When no slot is free the scan does not
 * claim deliverable rows (they are neither locked nor advanced early), but still skips rows that
 * are already expired. One accepted hand-off releases its slot immediately; the scheduler never
 * waits for business completion and never replays after a restart.
 */

/** The RFC 9562 URL namespace: the schedule message id derives from the occurrence identity. */
const SCHEDULE_MESSAGE_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** UUIDv5 over `opentag:schedule:<scheduleId>:<scheduledFor UTC ISO>`; the occurrence's stable message id. */
export function scheduledMessageId(scheduleId: string, scheduledFor: Date): string {
  const namespace = Buffer.from(SCHEDULE_MESSAGE_NAMESPACE.replaceAll("-", ""), "hex");
  const name = `opentag:schedule:${scheduleId}:${scheduledFor.toISOString()}`;
  const digest = createHash("sha1").update(namespace).update(name, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type ScheduleClaimOutcome =
  /** The row is absent, locked elsewhere, disabled, or not actually due at the locked clock read. */
  | { kind: "none" }
  /** Due and deliverable, but no free dispatch slot: left untouched for a later scan. */
  | { kind: "deferred" }
  /** Skipped without a message: expired window or a known-temporary authority gap. */
  | { kind: "skipped"; code: string }
  /** Auto-disabled: invalid stored rule, permanent target failure, or message identity conflict. */
  | { kind: "disabled"; code: string }
  /** The identical message already existed: advanced without a second dispatch. */
  | { kind: "duplicate"; messageId: string }
  /** Claimed and committed; the snapshot is the only dispatch authorization. */
  | { kind: "claimed"; snapshot: ScheduledMessageSnapshot };

export interface ScheduleSchedulerOptions {
  database: DatabaseClient;
  dispatch: ScheduleDispatch;
  sessions: Pick<SessionService, "resolveScheduledMessageRoute">;
  /** The trusted public origin for the dispatch frame's detail link. */
  publicUrl: string;
  clock?: ScheduleClock;
  logger?: Pick<ServiceLogger, "error" | "info">;
  /** Scan cadence; 5000ms in production. */
  scanIntervalMs?: number;
  /** Per-scan candidate ceiling; 100 in production. */
  scanLimit?: number;
  /** In-flight dispatch slot ceiling; 100 in production. */
  maxInFlight?: number;
  /** Inclusive claim window; 30000ms in production. */
  claimWindowMs?: number;
  /** Test seam replacing the due-candidate query. */
  listDue?: (limit: number) => Promise<readonly string[]>;
  /** Test seam replacing the whole claim (loop tests never touch the database). */
  claimOccurrence?: (scheduleId: string, allowDispatch: boolean) => Promise<ScheduleClaimOutcome>;
  /** Test seam: runs inside the claim transaction right after the row lock is held. */
  afterRowLock?: (scheduleId: string) => Promise<void>;
  /** Test seam: runs inside the claim transaction right after the message insert attempt. */
  afterMessageInsert?: (messageId: string) => Promise<void>;
}

type ScheduleRow = typeof agentSchedules.$inferSelect;
type SessionMessageRow = typeof sessionMessages.$inferSelect;

const DEFAULT_SCAN_INTERVAL_MS = 5_000;
const DEFAULT_SCAN_LIMIT = 100;
const DEFAULT_MAX_IN_FLIGHT = 100;
const DEFAULT_CLAIM_WINDOW_MS = 30_000;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export class ScheduleScheduler {
  readonly #options: ScheduleSchedulerOptions;
  readonly #database: DatabaseClient;
  readonly #clock: ScheduleClock;
  readonly #scanIntervalMs: number;
  readonly #scanLimit: number;
  readonly #maxInFlight: number;
  readonly #claimWindowMs: number;
  readonly #inFlight = new Set<{ controller: AbortController; done: Promise<void> }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #scanning = false;
  #currentScan: Promise<void> | undefined;
  #stopped = false;

  constructor(options: ScheduleSchedulerOptions) {
    this.#options = options;
    this.#database = options.database;
    this.#clock = options.clock ?? scheduleDatabaseClock;
    this.#scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.#scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
    this.#maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.#claimWindowMs = options.claimWindowMs ?? DEFAULT_CLAIM_WINDOW_MS;
  }

  /** Tracks in-flight dispatches; tests read it to prove slot accounting. */
  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  /**
   * Start the production cadence: one scan immediately after services and the database are up,
   * then one per interval. A scan still in its claim phase drops the next tick — scans never
   * re-enter, while already-dispatched hand-offs settle asynchronously.
   */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), this.#scanIntervalMs);
    this.#timer.unref?.();
  }

  /**
   * Stop new scans, cancel every not-yet-sent hand-off, and wait for in-flight dispatches to
   * converge. Runs before Runtime and database shutdown; a claim already committed but not yet
   * dispatched falls into the accepted crash window (the message stays `unknown`, never replayed).
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    for (const entry of this.#inFlight) entry.controller.abort();
    await Promise.allSettled([...this.#inFlight].map((entry) => entry.done));
    await this.#currentScan?.catch(() => undefined);
  }

  /** One explicit scan pass: waits out any running scan first, then runs exactly one. Test-facing. */
  async scanNow(): Promise<void> {
    const running = this.#currentScan;
    if (running) await running;
    if (this.#stopped) return;
    await this.#runScan();
  }

  #tick(): void {
    if (this.#scanning || this.#stopped) return;
    void this.#runScan();
  }

  async #runScan(): Promise<void> {
    if (this.#stopped || this.#scanning) return;
    this.#scanning = true;
    const run = (async () => {
      try {
        await this.#scanCycle();
      } catch (error) {
        this.#options.logger?.error(
          { event: "schedule.scan_failed", reason: error instanceof Error ? error.name : "unknown" },
          "Schedule scan failed",
        );
      } finally {
        this.#scanning = false;
      }
    })();
    this.#currentScan = run;
    await run;
  }

  async #scanCycle(): Promise<void> {
    const due = await this.#listDue(this.#scanLimit);
    for (const id of due) {
      if (this.#stopped) return;
      // A deliverable claim requires a free slot; the skip-only path still retires expired rows.
      const allowDispatch = this.#inFlight.size < this.#maxInFlight;
      let outcome: ScheduleClaimOutcome;
      try {
        outcome = await this.#claim(id, allowDispatch);
      } catch (error) {
        // An ordinary database failure rolls the claim back; the row stays claimable next scan.
        this.#options.logger?.error(
          { event: "schedule.claim_failed", scheduleId: id, reason: error instanceof Error ? error.name : "unknown" },
          "Schedule claim failed",
        );
        continue;
      }
      if (outcome.kind === "claimed") {
        this.#track(outcome.snapshot);
      } else if (outcome.kind === "skipped" || outcome.kind === "disabled") {
        this.#options.logger?.info(
          { event: `schedule.${outcome.kind}`, scheduleId: id, code: outcome.code },
          "Schedule occurrence resolved without dispatch",
        );
      }
    }
  }

  /**
   * Track one committed hand-off: occupies a slot until the dispatch outcome is recorded, never
   * until the task finishes. The entry is registered BEFORE the dispatch body runs, so even a
   * synchronous dispatch failure frees the slot; every failure converges to one logged result.
   */
  #track(snapshot: ScheduledMessageSnapshot): void {
    if (this.#stopped) return;
    const controller = new AbortController();
    const entry: { controller: AbortController; done: Promise<void> } = {
      controller,
      done: Promise.resolve(),
    };
    this.#inFlight.add(entry);
    entry.done = this.#runDispatch(entry, snapshot);
  }

  async #runDispatch(
    entry: { controller: AbortController; done: Promise<void> },
    snapshot: ScheduledMessageSnapshot,
  ): Promise<void> {
    try {
      const outcome = await this.#options.dispatch.dispatchScheduledMessage(snapshot, entry.controller.signal);
      this.#options.logger?.info(
        {
          event: "schedule.dispatched",
          scheduleId: snapshot.scheduleId,
          messageId: snapshot.messageId,
          scheduledFor: snapshot.origin.scheduledFor,
          outcome: outcome.outcome,
          code: outcome.code,
        },
        "Scheduled message dispatch settled",
      );
    } catch {
      this.#options.logger?.error(
        {
          event: "schedule.dispatch_failed",
          scheduleId: snapshot.scheduleId,
          messageId: snapshot.messageId,
          scheduledFor: snapshot.origin.scheduledFor,
        },
        "Scheduled message dispatch failed",
      );
    } finally {
      this.#inFlight.delete(entry);
    }
  }

  async #listDue(limit: number): Promise<readonly string[]> {
    if (this.#options.listDue) return this.#options.listDue(limit);
    // The candidate query only locates; the locked claim decides with its own clock sample.
    const rows = await this.#database
      .select({ id: agentSchedules.id })
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.enabled, true),
          isNotNull(agentSchedules.nextTriggerAt),
          lte(agentSchedules.nextTriggerAt, sql`clock_timestamp()`),
        ),
      )
      .orderBy(asc(agentSchedules.nextTriggerAt), asc(agentSchedules.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async #claim(scheduleId: string, allowDispatch: boolean): Promise<ScheduleClaimOutcome> {
    if (this.#options.claimOccurrence) return this.#options.claimOccurrence(scheduleId, allowDispatch);
    return this.claimOccurrence(scheduleId, { allowDispatch });
  }

  /**
   * The claim transaction. Locks exactly the schedule row (never authority rows, so the global
   * lock order is preserved), samples the database clock after the lock, and either retires the
   * occurrence or atomically writes the message + `unknown` summary + advanced next trigger.
   */
  async claimOccurrence(scheduleId: string, options: { allowDispatch: boolean }): Promise<ScheduleClaimOutcome> {
    return this.#database.transaction((transaction) => this.#claimInTransaction(transaction, scheduleId, options));
  }

  async #claimInTransaction(
    transaction: DatabaseTransaction,
    scheduleId: string,
    options: { allowDispatch: boolean },
  ): Promise<ScheduleClaimOutcome> {
    const [row] = await transaction
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.id, scheduleId))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return { kind: "none" } as const;
    await this.#options.afterRowLock?.(row.id);
    // The claim time is the database clock read after the row lock — never the scan start.
    const claimNow = await this.#clock.now(transaction);
    if (!row.enabled || row.nextTriggerAt === null) return { kind: "none" } as const;
    const scheduledFor = toDate(row.nextTriggerAt);
    if (scheduledFor.getTime() > claimNow.getTime()) return { kind: "none" } as const;

    const plan = this.#planAdvance(row, claimNow);
    if (plan.kind === "invalid") {
      await this.#disableClaimed(transaction, row, claimNow, scheduledFor, "invalid_schedule");
      return { kind: "disabled", code: "invalid_schedule" } as const;
    }
    if (claimNow.getTime() - scheduledFor.getTime() > this.#claimWindowMs) {
      await this.#skipClaimed(transaction, row, claimNow, scheduledFor, plan.next, "late");
      return { kind: "skipped", code: "late" } as const;
    }
    if (!options.allowDispatch) return { kind: "deferred" } as const;

    // Readily known target validity, read WITHOUT authority locks: the claim only ever holds the
    // schedule row. Anything uncertain here defers to the locked final admission instead.
    const resolution = await this.#options.sessions.resolveScheduledMessageRoute(
      row.targetSessionId,
      row.agentId,
      transaction,
    );
    if (resolution.kind === "permanent") {
      await this.#disableClaimed(transaction, row, claimNow, scheduledFor, resolution.code);
      return { kind: "disabled", code: resolution.code } as const;
    }
    if (resolution.kind === "temporary") {
      await this.#skipClaimed(transaction, row, claimNow, scheduledFor, plan.next, resolution.code);
      return { kind: "skipped", code: resolution.code } as const;
    }
    return this.#materializeClaim(transaction, row, claimNow, scheduledFor, plan.next);
  }

  /** Validate the stored rule and compute the next occurrence; a broken rule never hot-loops. */
  #planAdvance(row: ScheduleRow, claimNow: Date): { kind: "invalid" } | { kind: "advance"; next: Date | null } {
    try {
      const normalized = normalizeAndValidateRule(row.schedule, row.timezone);
      return { kind: "advance", next: nextScheduleOccurrence(normalized.rule, normalized.timezone, claimNow) };
    } catch {
      return { kind: "invalid" };
    }
  }

  /** Freeze the snapshot and atomically insert the deterministic message, or settle the identity check. */
  async #materializeClaim(
    transaction: DatabaseTransaction,
    row: ScheduleRow,
    claimNow: Date,
    scheduledFor: Date,
    next: Date | null,
  ): Promise<ScheduleClaimOutcome> {
    const messageId = scheduledMessageId(row.id, scheduledFor);
    const origin: SessionMessageScheduledOrigin = {
      scheduleId: row.id,
      scheduledFor: scheduledFor.toISOString(),
      timezone: row.timezone,
      name: row.name,
    };
    const contentHash = createHash("sha256").update(row.prompt, "utf8").digest("hex");
    const [inserted] = await transaction
      .insert(sessionMessages)
      .values({
        id: messageId,
        sourceSessionId: null,
        scheduledOrigin: origin,
        targetSessionId: row.targetSessionId,
        content: row.prompt,
        contentHash,
        lastOutcome: "unknown",
        attemptCount: 0,
        createdAt: claimNow,
        updatedAt: claimNow,
      })
      .onConflictDoNothing()
      .returning();
    await this.#options.afterMessageInsert?.(messageId);
    if (inserted) {
      await this.#advanceClaimed(transaction, row, claimNow, next, {
        attemptedAt: claimNow,
        code: null,
        messageId,
        outcome: "unknown",
        scheduledFor,
      });
      return {
        kind: "claimed",
        snapshot: {
          scheduleId: row.id,
          revision: row.revision,
          agentId: row.agentId,
          targetSessionId: row.targetSessionId,
          messageId,
          content: row.prompt,
          origin,
          attemptedAt: claimNow,
          detailUrl: scheduleDetailUrl(this.#options.publicUrl, row.agentId, row.id),
        },
      } as const;
    }
    return this.#settleExistingMessage(transaction, row, claimNow, scheduledFor, next, messageId, origin, contentHash);
  }

  /**
   * The insert found an existing row with the deterministic id: an identical snapshot means the
   * occurrence was already materialized — advance if needed, never re-dispatch. Any difference is
   * an identity conflict: the schedule disables and the original message is never overwritten.
   */
  async #settleExistingMessage(
    transaction: DatabaseTransaction,
    row: ScheduleRow,
    claimNow: Date,
    scheduledFor: Date,
    next: Date | null,
    messageId: string,
    origin: SessionMessageScheduledOrigin,
    contentHash: string,
  ): Promise<ScheduleClaimOutcome> {
    const [existing] = await transaction
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.id, messageId))
      .limit(1)
      .for("update");
    if (existing && scheduledMessageIdentityMatches(existing, row, origin, contentHash)) {
      await this.#advanceClaimed(transaction, row, claimNow, next, {
        attemptedAt: null,
        code: null,
        messageId,
        outcome: "unknown",
        scheduledFor,
      });
      return { kind: "duplicate", messageId } as const;
    }
    await this.#disableClaimed(transaction, row, claimNow, scheduledFor, "message_identity_conflict", messageId);
    return { kind: "disabled", code: "message_identity_conflict" } as const;
  }

  /** The one-time skip write for occurrences that never produce a message. */
  async #skipClaimed(
    transaction: DatabaseTransaction,
    row: ScheduleRow,
    claimNow: Date,
    scheduledFor: Date,
    next: Date | null,
    code: string,
  ): Promise<void> {
    await this.#advanceClaimed(transaction, row, claimNow, next, {
      attemptedAt: null,
      code,
      messageId: null,
      outcome: "skipped",
      scheduledFor,
    });
  }

  /**
   * Auto-disable: a permanently undeliverable schedule stops here — `enabled = false`,
   * `next_trigger_at = null`, revision bumped like a management edit, reason recorded. It never
   * re-enables itself; resume re-validates the target through the management surface.
   */
  async #disableClaimed(
    transaction: DatabaseTransaction,
    row: ScheduleRow,
    claimNow: Date,
    scheduledFor: Date,
    code: string,
    messageId?: string,
  ): Promise<void> {
    await transaction
      .update(agentSchedules)
      .set({
        enabled: false,
        nextTriggerAt: null,
        revision: row.revision + 1,
        lastDispatch: {
          scheduledFor: scheduledFor.toISOString(),
          attemptedAt: null,
          messageId: messageId ?? null,
          outcome: "skipped",
          code,
        },
        updatedAt: claimNow,
      })
      .where(eq(agentSchedules.id, row.id));
  }

  /** Advance the next trigger and record the occurrence summary; the revision never moves here. */
  async #advanceClaimed(
    transaction: DatabaseTransaction,
    row: ScheduleRow,
    claimNow: Date,
    next: Date | null,
    summary: {
      attemptedAt: Date | null;
      code: string | null;
      messageId: string | null;
      outcome: AgentScheduleLastDispatch["outcome"];
      scheduledFor: Date;
    },
  ): Promise<void> {
    const lastDispatch: AgentScheduleLastDispatch = {
      scheduledFor: summary.scheduledFor.toISOString(),
      attemptedAt: summary.attemptedAt ? summary.attemptedAt.toISOString() : null,
      messageId: summary.messageId,
      outcome: summary.outcome,
      code: summary.code,
    };
    await transaction
      .update(agentSchedules)
      .set({ nextTriggerAt: next, lastDispatch, updatedAt: claimNow })
      .where(eq(agentSchedules.id, row.id));
  }
}

/**
 * The existing message row participates in the identity check with the claim's frozen facts:
 * origin snapshot, target, and body together — the content hash alone is never enough.
 */
function scheduledMessageIdentityMatches(
  existing: SessionMessageRow,
  row: ScheduleRow,
  origin: SessionMessageScheduledOrigin,
  contentHash: string,
): boolean {
  const stored = existing.scheduledOrigin;
  return (
    existing.sourceSessionId === null &&
    stored !== null &&
    stored.scheduleId === origin.scheduleId &&
    stored.scheduledFor === origin.scheduledFor &&
    stored.timezone === origin.timezone &&
    stored.name === origin.name &&
    existing.targetSessionId === row.targetSessionId &&
    existing.content === row.prompt &&
    existing.contentHash === contentHash
  );
}
