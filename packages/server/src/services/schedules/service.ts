import { isDeepStrictEqual } from "node:util";
import {
  type AgentSchedule,
  type AgentScheduleInput,
  type AgentScheduleListItem,
  type AgentScheduleListQuery,
  type AgentScheduleListResponse,
  type AgentSchedulePreview,
  type AgentScheduleRule,
  type AgentScheduleTarget,
  type CreateAgentScheduleRequest,
  type RuntimeUserTaskSource,
  SCHEDULE_ERROR_CODES,
  type UpdateAgentScheduleRequest,
} from "@opentag/shared";
import { and, desc, eq, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agentSchedules, agents, imBindings, sessions } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { AgentOwnerResolver } from "../agents/agent-self-service.js";
import { resourceNotFound } from "../agents/errors.js";
import type { SessionCliProofService, SessionCliSourceContext } from "../sessions/session-cli-proof-service.js";
import {
  normalizeIanaTimezone,
  previewSchedule,
  requireFutureOccurrence,
  ScheduleRuleError,
  scheduleRuleFromInput,
} from "./calculator.js";
import { ScheduleServiceError, scheduleInvalidRequest } from "./errors.js";

/*
 * ScheduleService — the Schedule management plane.
 *
 * A Schedule belongs to exactly one Agent and pins the Session that created it as its fixed target;
 * the target can never change afterwards. Two caller surfaces reach the same
 * operations: the Agent itself through a Session CLI proof (`/api/v1/runtime/agent/schedules`),
 * and the owning Account through the Web session (`/api/v1/agents/:agentId/schedules`,
 * read/pause/resume/delete only). Both conceal foreign or missing schedules as 404.
 *
 * Every write runs in one transaction that locks the schedule row, compares the caller's
 * `expectedRevision` (CAS), and — for time-bearing changes — samples the database clock as the
 * reference instant. The same calculator validates and schedules every rule, so a rule stored by
 * management is interpreted identically by the scanner. Scanning and dispatch-summary writes (the
 * scheduler worker) never bump the revision; only actual management edits and auto-disable do.
 */

interface ScheduleAuthority {
  readonly accountId: string;
  readonly source?: SessionCliSourceContext;
}

/** The authenticated Agent self scope. Only `authenticate` creates one; callers pass it back unchanged. */
export interface AgentScheduleScope {
  readonly source: SessionCliSourceContext;
  readonly accountId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly sessionKind: "channel" | "thread" | "internal";
  readonly userTaskSource?: RuntimeUserTaskSource;
}

/** Anything that can run queries: the pool client or an open transaction. */
type ScheduleDbExecutor = DatabaseClient | DatabaseTransaction;

/**
 * The reference clock for management decisions. The production implementation reads the
 * PostgreSQL `clock_timestamp()` through the current transaction so anchor and preview instants
 * are database time, never process time. Tests inject a deterministic clock.
 */
export interface ScheduleClock {
  now(executor: Pick<DatabaseClient, "execute">): Promise<Date>;
}

export const scheduleDatabaseClock: ScheduleClock = {
  async now(executor) {
    const rows = await executor.execute<{ at: Date | string }>(sql`select clock_timestamp() as at`);
    const raw = rows[0]?.at;
    const at = raw instanceof Date ? raw : typeof raw === "string" ? new Date(raw) : undefined;
    if (!at || Number.isNaN(at.getTime())) throw new Error("The database clock did not return a timestamp");
    return at;
  },
};

export interface ScheduleServiceOptions {
  database: DatabaseClient;
  owners: AgentOwnerResolver;
  proofs: Pick<SessionCliProofService, "authenticate" | "assertCurrentSource" | "lockCurrentSource">;
  /** The deployment's trusted public origin; the only base ever used for Schedule detail links. */
  publicUrl: string;
  clock?: ScheduleClock;
  logger?: ServiceLogger;
}

type ScheduleRow = typeof agentSchedules.$inferSelect;

const ListCursorSchema = z
  .object({
    at: z.string().datetime(),
    id: z.string().uuid(),
    /** The Agent this page belongs to; a cursor never crosses schedule collections. */
    agent: z.string().uuid(),
  })
  .strict();

function encodeListCursor(agentId: string, row: { createdAt: Date | string; id: string }): string {
  const at = row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();
  return Buffer.from(JSON.stringify({ at, id: row.id, agent: agentId }), "utf8").toString("base64url");
}

function decodeListCursor(agentId: string, cursor: string | undefined): { at: Date; id: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    const decoded = ListCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (decoded.agent !== agentId) throw new Error("scope mismatch");
    return { at: new Date(decoded.at), id: decoded.id };
  } catch {
    throw scheduleInvalidRequest("The pagination cursor is invalid");
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Map the calculator's stable rule failures onto the public Schedule error codes. */
function rethrowRuleFailure(error: unknown): never {
  if (error instanceof ScheduleRuleError) {
    const code =
      error.code === "invalid_timezone"
        ? SCHEDULE_ERROR_CODES.INVALID_TIMEZONE
        : error.code === "no_future_occurrence"
          ? SCHEDULE_ERROR_CODES.NO_FUTURE_OCCURRENCE
          : SCHEDULE_ERROR_CODES.INVALID_RULE;
    throw new ScheduleServiceError(code, error.message);
  }
  throw error;
}

/** The Web detail deep link: the owning Agent's page with the schedule search parameter. */
export function scheduleDetailUrl(publicUrl: string, agentId: string, scheduleId: string): string {
  const url = new URL(`/agents/${encodeURIComponent(agentId)}`, publicUrl);
  url.search = new URLSearchParams({ schedule: scheduleId }).toString();
  return url.toString();
}

export class ScheduleService {
  readonly #options: ScheduleServiceOptions;
  readonly #clock: ScheduleClock;

  constructor(options: ScheduleServiceOptions) {
    this.#options = options;
    this.#clock = options.clock ?? scheduleDatabaseClock;
  }

  /* ------------------------------------------------------------------------------------------
   * Authentication: the Session CLI proof is the only identity input on the runtime surface.
   * ---------------------------------------------------------------------------------------- */

  async authenticate(proof: string, executionId?: string): Promise<AgentScheduleScope> {
    const source = executionId
      ? await this.#options.proofs.authenticate(proof, executionId)
      : await this.#options.proofs.authenticate(proof);
    const { accountId } = await this.#options.owners.resolve(source.agentId);
    return {
      source,
      accountId,
      agentId: source.agentId,
      sessionId: source.sessionId,
      sessionKind: source.sessionKind,
      ...(source.userTaskSource ? { userTaskSource: source.userTaskSource } : {}),
    };
  }

  /* ------------------------------------------------------------------------------------------
   * Runtime Agent surface (proof-authenticated; the proof's Agent manages its own schedules)
   * ---------------------------------------------------------------------------------------- */

  async createForAgent(scope: AgentScheduleScope, input: CreateAgentScheduleRequest): Promise<AgentSchedule> {
    const created = await this.#options.database.transaction(async (transaction) => {
      await this.#lockAgent(transaction, scope, scope.agentId);
      const now = await this.#clock.now(transaction);
      const target = await this.#resolveCreateTarget(transaction, scope);
      const { rule, timezone } = this.#ruleFromInput(input.schedule, input.timezone, now);
      const next = this.#requireNext(rule, timezone, now);
      const [row] = await transaction
        .insert(agentSchedules)
        .values({
          agentId: scope.agentId,
          targetSessionId: target.sessionId,
          name: input.name,
          prompt: input.prompt,
          userTaskSource: scope.userTaskSource ?? null,
          schedule: rule,
          timezone,
          enabled: true,
          nextTriggerAt: next,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("Schedule insert did not return a row");
      return { row, target };
    });
    this.#audit("schedule.created", { agentId: scope.agentId, scheduleId: created.row.id });
    return this.#toDetail(created.row, created.target);
  }

  async listForAgent(scope: AgentScheduleScope, query: AgentScheduleListQuery): Promise<AgentScheduleListResponse> {
    return this.#list(scope, scope.agentId, query);
  }

  async getForAgent(scope: AgentScheduleScope, scheduleId: string): Promise<AgentSchedule> {
    return this.#get(scope, scope.agentId, scheduleId);
  }

  async updateForAgent(
    scope: AgentScheduleScope,
    scheduleId: string,
    input: UpdateAgentScheduleRequest,
  ): Promise<AgentSchedule> {
    const updated = await this.#options.database.transaction(async (transaction) => {
      const locked = await this.#lockOwned(transaction, scope, scope.agentId, scheduleId);
      this.#requireRevision(locked, input.expectedRevision);
      const now = await this.#clock.now(transaction);
      const timing = this.#resolveEditedTiming(locked, input, now);
      const name = input.name ?? locked.name;
      const prompt = input.prompt ?? locked.prompt;
      if (!timing.changed && name === locked.name && prompt === locked.prompt) {
        return { row: locked, changed: false };
      }
      const [row] = await transaction
        .update(agentSchedules)
        .set({
          name,
          prompt,
          userTaskSource: scope.userTaskSource ?? null,
          schedule: timing.rule,
          timezone: timing.timezone,
          nextTriggerAt: timing.nextTriggerAt,
          revision: locked.revision + 1,
          updatedAt: now,
        })
        .where(eq(agentSchedules.id, locked.id))
        .returning();
      if (!row) throw new Error("Schedule update did not return a row");
      return { row, changed: true };
    });
    if (updated.changed) {
      this.#audit("schedule.updated", { agentId: scope.agentId, scheduleId, revision: updated.row.revision });
    }
    return this.#detailForRow(updated.row);
  }

  /**
   * The timing half of an edit. Rule and timezone edits re-validate through the one calculator
   * and must still have a future occurrence; name/prompt-only edits are exempt. The `every`
   * anchor survives only when the interval is unchanged; any other rule edit re-anchors at the
   * database time. A paused schedule stays paused with no next trigger.
   */
  #resolveEditedTiming(
    locked: ScheduleRow,
    input: UpdateAgentScheduleRequest,
    now: Date,
  ): { rule: AgentScheduleRule; timezone: string; nextTriggerAt: Date | null; changed: boolean } {
    if (input.schedule === undefined && input.timezone === undefined) {
      return { rule: locked.schedule, timezone: locked.timezone, nextTriggerAt: locked.nextTriggerAt, changed: false };
    }
    const timezone = input.timezone !== undefined ? this.#normalizeTimezone(input.timezone) : locked.timezone;
    let rule = locked.schedule;
    if (input.schedule) {
      const anchor = this.#everyAnchor(locked.schedule, input.schedule, now);
      rule = this.#ruleFromInput(input.schedule, timezone, anchor).rule;
    }
    if (timezone === locked.timezone && isDeepStrictEqual(rule, locked.schedule)) {
      return { rule: locked.schedule, timezone: locked.timezone, nextTriggerAt: locked.nextTriggerAt, changed: false };
    }
    const next = this.#requireNext(rule, timezone, now);
    return { rule, timezone, nextTriggerAt: locked.enabled ? next : locked.nextTriggerAt, changed: true };
  }

  async pauseForAgent(scope: AgentScheduleScope, scheduleId: string, expectedRevision: number): Promise<AgentSchedule> {
    return this.#pause(scope, scope.agentId, scheduleId, expectedRevision);
  }

  async resumeForAgent(
    scope: AgentScheduleScope,
    scheduleId: string,
    expectedRevision: number,
  ): Promise<AgentSchedule> {
    return this.#resume(scope, scope.agentId, scheduleId, expectedRevision, scope.userTaskSource ?? null);
  }

  async deleteForAgent(scope: AgentScheduleScope, scheduleId: string, expectedRevision: number): Promise<void> {
    await this.#remove(scope, scope.agentId, scheduleId, expectedRevision);
    this.#audit("schedule.deleted", { agentId: scope.agentId, scheduleId });
  }

  async previewForAgent(
    scope: AgentScheduleScope,
    input: { scheduleId: string } | { schedule: AgentScheduleInput; timezone: string },
  ): Promise<AgentSchedulePreview> {
    return this.#readOwned(scope, scope.agentId, async (transaction) => {
      if ("scheduleId" in input) {
        const row = await this.#findOwned(transaction, scope.agentId, input.scheduleId);
        return this.#preview(row.schedule, row.timezone, await this.#clock.now(transaction));
      }
      const now = await this.#clock.now(transaction);
      const { rule, timezone } = this.#ruleFromInput(input.schedule, input.timezone, now);
      return this.#preview(rule, timezone, now);
    });
  }

  /* ------------------------------------------------------------------------------------------
   * Account surface (Web session; the Account manages only Agents it owns, no create/update)
   * ---------------------------------------------------------------------------------------- */

  async listForAccount(
    accountId: string,
    agentId: string,
    query: AgentScheduleListQuery,
  ): Promise<AgentScheduleListResponse> {
    return this.#list({ accountId }, agentId, query);
  }

  async getForAccount(accountId: string, agentId: string, scheduleId: string): Promise<AgentSchedule> {
    return this.#get({ accountId }, agentId, scheduleId);
  }

  async pauseForAccount(
    accountId: string,
    agentId: string,
    scheduleId: string,
    expectedRevision: number,
  ): Promise<AgentSchedule> {
    return this.#pause({ accountId }, agentId, scheduleId, expectedRevision);
  }

  async resumeForAccount(
    accountId: string,
    agentId: string,
    scheduleId: string,
    expectedRevision: number,
  ): Promise<AgentSchedule> {
    return this.#resume({ accountId }, agentId, scheduleId, expectedRevision);
  }

  async deleteForAccount(
    accountId: string,
    agentId: string,
    scheduleId: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.#remove({ accountId }, agentId, scheduleId, expectedRevision);
    this.#audit("schedule.deleted", { agentId, scheduleId });
  }

  /* ------------------------------------------------------------------------------------------
   * Shared scoped operations
   * ---------------------------------------------------------------------------------------- */

  async #list(
    authority: ScheduleAuthority,
    agentId: string,
    query: AgentScheduleListQuery,
  ): Promise<AgentScheduleListResponse> {
    return this.#readOwned(authority, agentId, (transaction) => this.#listRows(transaction, agentId, query));
  }

  async #listRows(
    executor: ScheduleDbExecutor,
    agentId: string,
    query: AgentScheduleListQuery,
  ): Promise<AgentScheduleListResponse> {
    const cursor = decodeListCursor(agentId, query.cursor);
    const conditions: (SQL | undefined)[] = [eq(agentSchedules.agentId, agentId)];
    if (cursor) {
      conditions.push(
        sql`(${agentSchedules.createdAt}, ${agentSchedules.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await executor
      .select({ schedule: agentSchedules, target: targetFactsColumns() })
      .from(agentSchedules)
      .innerJoin(sessions, eq(sessions.id, agentSchedules.targetSessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .where(and(...conditions))
      .orderBy(desc(agentSchedules.createdAt), desc(agentSchedules.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#toListItem(row.schedule, row.target)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeListCursor(agentId, { createdAt: last.schedule.createdAt, id: last.schedule.id })
          : null,
    };
  }

  async #get(authority: ScheduleAuthority, agentId: string, scheduleId: string): Promise<AgentSchedule> {
    return this.#readOwned(authority, agentId, async (transaction) => {
      const row = await this.#findOwned(transaction, agentId, scheduleId);
      return this.#detailForRow(row, transaction);
    });
  }

  async #pause(
    authority: ScheduleAuthority,
    agentId: string,
    scheduleId: string,
    expectedRevision: number,
  ): Promise<AgentSchedule> {
    const row = await this.#options.database.transaction(async (transaction) => {
      const locked = await this.#lockOwned(transaction, authority, agentId, scheduleId);
      this.#requireRevision(locked, expectedRevision);
      // A repeated pause that changed nothing validates the revision and returns as-is.
      if (!locked.enabled) return locked;
      const now = await this.#clock.now(transaction);
      const [updated] = await transaction
        .update(agentSchedules)
        .set({ enabled: false, nextTriggerAt: null, revision: locked.revision + 1, updatedAt: now })
        .where(eq(agentSchedules.id, locked.id))
        .returning();
      if (!updated) throw new Error("Schedule pause did not return a row");
      return updated;
    });
    return this.#detailForRow(row);
  }

  async #resume(
    authority: ScheduleAuthority,
    agentId: string,
    scheduleId: string,
    expectedRevision: number,
    userTaskSource?: RuntimeUserTaskSource | null,
  ): Promise<AgentSchedule> {
    const row = await this.#options.database.transaction(async (transaction) => {
      const locked = await this.#lockOwned(transaction, authority, agentId, scheduleId);
      this.#requireRevision(locked, expectedRevision);
      const now = await this.#clock.now(transaction);
      /*
       * Resume ALWAYS revalidates the fixed target, even for the repeated-resume fast path: a
       * permanently invalid target can never be re-enabled, and an exhausted one-time rule reports
       * no future occurrence rather than silently succeeding.
       */
      await this.#requireValidTarget(transaction, locked.targetSessionId, locked.agentId);
      if (locked.enabled && locked.nextTriggerAt !== null) return locked;
      const next = this.#requireNext(locked.schedule, locked.timezone, now);
      const [updated] = await transaction
        .update(agentSchedules)
        .set({
          enabled: true,
          nextTriggerAt: next,
          revision: locked.revision + 1,
          updatedAt: now,
          // Account resume preserves provenance; an Agent resume must attest its current task.
          ...(userTaskSource !== undefined ? { userTaskSource } : {}),
        })
        .where(eq(agentSchedules.id, locked.id))
        .returning();
      if (!updated) throw new Error("Schedule resume did not return a row");
      return updated;
    });
    return this.#detailForRow(row);
  }

  async #remove(
    authority: ScheduleAuthority,
    agentId: string,
    scheduleId: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.#options.database.transaction(async (transaction) => {
      const locked = await this.#lockOwned(transaction, authority, agentId, scheduleId);
      this.#requireRevision(locked, expectedRevision);
      // Hard delete: already-generated messages keep their scheduledOrigin traceability snapshot
      // and their execution eligibility; nothing cascades.
      await transaction.delete(agentSchedules).where(eq(agentSchedules.id, locked.id));
    });
  }

  /* ------------------------------------------------------------------------------------------
   * Internals
   * ---------------------------------------------------------------------------------------- */

  /**
   * The fixed create target is the proof's own Session, whatever its kind. Nothing a caller sends can
   * name another Session, so a Session can only schedule itself.
   */
  async #resolveCreateTarget(transaction: DatabaseTransaction, scope: AgentScheduleScope): Promise<TargetFactsRow> {
    const [source] = await transaction
      .select({ endedAt: sessions.endedAt })
      .from(sessions)
      .where(eq(sessions.id, scope.sessionId))
      .limit(1);
    if (!source || source.endedAt) {
      throw new ScheduleServiceError(
        SCHEDULE_ERROR_CODES.TARGET_REQUIRED,
        "A schedule requires an active Session as its fixed target",
      );
    }
    const target = await this.#targetFacts(transaction, scope.sessionId);
    if (!target) throw new Error("The proof's Session is missing its target facts");
    return target;
  }

  /** Resume-time revalidation of the pinned target: permanent failure is TARGET_INVALID, never retargeting. */
  async #requireValidTarget(transaction: DatabaseTransaction, targetSessionId: string, agentId: string): Promise<void> {
    const [row] = await transaction
      .select({
        sessionEndedAt: sessions.endedAt,
        bindingDisabledAt: imBindings.disabledAt,
        bindingAgentId: imBindings.agentId,
        agentStatus: agents.status,
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(eq(sessions.id, targetSessionId))
      .limit(1);
    const valid =
      row !== undefined &&
      row.sessionEndedAt === null &&
      row.bindingDisabledAt === null &&
      row.bindingAgentId === agentId &&
      row.agentStatus !== "deleted";
    if (!valid) {
      throw new ScheduleServiceError(
        SCHEDULE_ERROR_CODES.TARGET_INVALID,
        "The schedule's fixed target is no longer valid; create a new schedule from an active Session",
      );
    }
  }

  async #targetFacts(executor: ScheduleDbExecutor, sessionId: string): Promise<TargetFactsRow | undefined> {
    const [row] = await executor
      .select({ target: targetFactsColumns() })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row?.target;
  }

  /** Read a schedule owned by this Agent or conceal it exactly like a missing one. */
  async #findOwned(executor: ScheduleDbExecutor, agentId: string, scheduleId: string): Promise<ScheduleRow> {
    const [row] = await executor
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.agentId, agentId)))
      .limit(1);
    if (!row) throw resourceNotFound();
    return row;
  }

  /** Lock the owned schedule row for a mutation; concurrent writers serialize on this lock. */
  async #lockOwned(
    transaction: DatabaseTransaction,
    authority: ScheduleAuthority,
    agentId: string,
    scheduleId: string,
  ): Promise<ScheduleRow> {
    await this.#lockAgent(transaction, authority, agentId);
    const [row] = await transaction
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.agentId, agentId)))
      .limit(1)
      .for("update");
    if (!row) throw resourceNotFound();
    return row;
  }

  #requireRevision(row: ScheduleRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new ScheduleServiceError(
        SCHEDULE_ERROR_CODES.REVISION_CONFLICT,
        "The schedule changed since it was read; re-read it and submit again",
      );
    }
  }

  async #requireOwnedAgent(accountId: string, agentId: string, executor: ScheduleDbExecutor): Promise<void> {
    const [row] = await executor
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row) throw resourceNotFound();
  }

  async #readOwned<T>(
    authority: ScheduleAuthority,
    agentId: string,
    read: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#options.database.transaction(
      async (transaction) => {
        if (authority.source && authority.source.agentId !== agentId) throw resourceNotFound();
        await this.#requireOwnedAgent(authority.accountId, agentId, transaction);
        if (authority.source) await this.#options.proofs.assertCurrentSource(transaction, authority.source);
        return read(transaction);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async #lockAgent(transaction: DatabaseTransaction, authority: ScheduleAuthority, agentId: string): Promise<void> {
    const [agent] = await transaction
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.createdByUserId, authority.accountId),
          ne(agents.status, "deleted"),
          authority.source ? eq(agents.id, authority.source.agentId) : undefined,
        ),
      )
      .limit(1)
      .for("no key update");
    if (!agent) throw resourceNotFound();
    if (authority.source) await this.#options.proofs.lockCurrentSource(transaction, authority.source);
  }

  #ruleFromInput(
    input: AgentScheduleInput,
    timezone: string,
    anchor: Date,
  ): { rule: AgentScheduleRule; timezone: string } {
    try {
      const normalized = scheduleRuleFromInput(input, timezone, anchor);
      return { rule: normalized.rule, timezone: normalized.timezone };
    } catch (error) {
      rethrowRuleFailure(error);
    }
  }

  #normalizeTimezone(timezone: string): string {
    try {
      return normalizeIanaTimezone(timezone);
    } catch (error) {
      rethrowRuleFailure(error);
    }
  }

  #requireNext(rule: AgentScheduleRule, timezone: string, after: Date): Date {
    try {
      return requireFutureOccurrence(rule, timezone, after);
    } catch (error) {
      rethrowRuleFailure(error);
    }
  }

  #preview(rule: AgentScheduleRule, timezone: string, at: Date): AgentSchedulePreview {
    try {
      const preview = previewSchedule(rule, timezone, at);
      return {
        calculatedAt: preview.calculatedAt.toISOString(),
        schedule: preview.rule,
        timezone: preview.timezone,
        items: preview.items,
      };
    } catch (error) {
      rethrowRuleFailure(error);
    }
  }

  /** The `every` anchor survives edits that keep kind and interval; anything else re-anchors at `now`. */
  #everyAnchor(current: AgentScheduleRule, input: AgentScheduleInput | undefined, now: Date): Date {
    if (input?.kind === "every" && current.kind === "every" && current.intervalSeconds === input.intervalSeconds) {
      return new Date(current.anchorAt);
    }
    return now;
  }

  async #detailForRow(row: ScheduleRow, executor: ScheduleDbExecutor = this.#options.database): Promise<AgentSchedule> {
    const target = await this.#targetFacts(executor, row.targetSessionId);
    if (!target) throw new Error("The schedule's pinned target Session is missing");
    return this.#toDetail(row, target);
  }

  #toDetail(row: ScheduleRow, target: TargetFactsRow): AgentSchedule {
    return {
      id: row.id,
      agentId: row.agentId,
      target: toScheduleTarget(target),
      name: row.name,
      prompt: row.prompt,
      schedule: row.schedule,
      timezone: row.timezone,
      enabled: row.enabled,
      nextTriggerAt: row.nextTriggerAt ? toIso(row.nextTriggerAt) : null,
      revision: row.revision,
      lastDispatch: row.lastDispatch ?? null,
      detailUrl: scheduleDetailUrl(this.#options.publicUrl, row.agentId, row.id),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  #toListItem(row: ScheduleRow, target: TargetFactsRow): AgentScheduleListItem {
    const { prompt: _prompt, detailUrl: _detailUrl, ...rest } = this.#toDetail(row, target);
    return rest;
  }

  #audit(event: string, details: Record<string, unknown>): void {
    // Stable ids and revisions only: never the prompt, never proof material.
    this.#options.logger?.info({ event, ...details }, event);
  }
}

/** The raw joined row behind a target's display facts; `sessionKind` narrows to visible Sessions. */
interface TargetFactsRow {
  sessionId: string;
  provider: "feishu" | "slack";
  sessionKind: "channel" | "thread" | "internal";
  channelId: string;
  threadKey: string | null;
}

/** The pinned target's existing IM conversation display facts, read back from the Session. */
function targetFactsColumns() {
  return {
    sessionId: sessions.id,
    provider: imBindings.provider,
    sessionKind: sessions.kind,
    channelId: sessions.channelId,
    threadKey: sessions.threadKey,
  } as const;
}

function toScheduleTarget(row: TargetFactsRow): AgentScheduleTarget {
  return {
    sessionId: row.sessionId,
    provider: row.provider,
    sessionKind: row.sessionKind,
    channelId: row.channelId,
    threadKey: row.threadKey,
  };
}
