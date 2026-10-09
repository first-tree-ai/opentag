import { createHash, randomUUID } from "node:crypto";
import {
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  type TurnActivityRequest,
  type TurnActivityResult,
} from "@opentag/shared";
import { and, eq, getTableColumns, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  imBindings,
  imMessageDeliveries,
  sessionPlacements,
  sessions,
  slackInstallations,
  slackWorkingTargets,
  slackWorkingTurns,
} from "../../db/schema/index.js";
import type { RuntimeBusinessContext } from "../../runtime/runtime-session.js";

export type WorkingTarget = typeof slackWorkingTargets.$inferSelect;
export const WORKING_LEASE_MS = 90_000;

/** Called inside the custody transaction: a committed terminal report always schedules cleanup. */
export async function finishSlackWorkingTurn(tx: DatabaseTransaction, deliveryId: string, now: Date): Promise<void> {
  const rows = await tx
    .update(slackWorkingTurns)
    .set({ phase: "terminal", leaseExpiresAt: now })
    .where(eq(slackWorkingTurns.deliveryId, deliveryId))
    .returning({ targetId: slackWorkingTurns.targetId });
  for (const row of rows) await dirtyTarget(tx, row.targetId, now);
}

async function dirtyTarget(tx: DatabaseTransaction, id: string, now: Date): Promise<void> {
  await tx
    .update(slackWorkingTargets)
    .set({ revision: sql`${slackWorkingTargets.revision} + 1`, nextAttemptAt: now })
    .where(eq(slackWorkingTargets.id, id));
}

async function refreshTargets(
  tx: DatabaseTransaction,
  previous: typeof slackWorkingTurns.$inferSelect | undefined,
  targetId: string,
  phase: TurnActivityRequest["phase"],
  now: Date,
): Promise<void> {
  if (previous && previous.targetId !== targetId) await dirtyTarget(tx, previous.targetId, now);
  if (
    !previous ||
    previous.phase !== phase ||
    previous.targetId !== targetId ||
    (phase === "running" && previous.leaseExpiresAt <= now)
  )
    await dirtyTarget(tx, targetId, now);
}

export class SlackWorkingStore {
  constructor(
    readonly database: DatabaseClient,
    readonly now: () => Date = () => new Date(),
  ) {}

  async record(frame: TurnActivityRequest, context: RuntimeBusinessContext): Promise<TurnActivityResult> {
    const status = await this.database.transaction(async (tx) => {
      const scope = await this.#scope(tx, frame, context);
      if (!scope || context.signal.aborted) return "stale_generation" as const;
      const { delivery, binding, installation } = scope;
      const request = workingRequest(delivery.dispatchPayload, installation);
      if (!request) return "stale_generation" as const;
      const ref = request.content.providerRef;
      const threadTs = ref.threadTs ?? ref.messageTs;
      const targetId = createHash("sha256")
        .update(JSON.stringify([installation.id, installation.credentialGeneration, ref.channelId, threadTs]))
        .digest("hex");
      const now = this.now();
      const deadlineAt = executionDeadline(request, delivery.acceptedAt ?? now);
      await tx
        .insert(slackWorkingTargets)
        .values({
          id: targetId,
          bindingId: binding.id,
          installationId: installation.id,
          credentialGeneration: installation.credentialGeneration,
          channelId: ref.channelId,
          threadTs,
          nextAttemptAt: now,
          notBeforeAt: now,
        })
        .onConflictDoNothing();
      await tx
        .select({ id: slackWorkingTargets.id })
        .from(slackWorkingTargets)
        .where(eq(slackWorkingTargets.id, targetId))
        .for("update");
      const [previous] = await tx
        .select()
        .from(slackWorkingTurns)
        .where(eq(slackWorkingTurns.deliveryId, frame.deliveryId));
      if (isReplay(previous, frame)) return "already_recorded" as const;
      const phase = now >= deadlineAt ? "terminal" : frame.phase;
      const leaseExpiresAt = new Date(Math.min(now.getTime() + WORKING_LEASE_MS, deadlineAt.getTime()));
      await tx
        .insert(slackWorkingTurns)
        .values({
          deliveryId: frame.deliveryId,
          targetId,
          turnId: frame.turnId,
          sequence: frame.sequence,
          phase,
          leaseExpiresAt,
          deadlineAt,
        })
        .onConflictDoUpdate({
          target: slackWorkingTurns.deliveryId,
          set: { targetId, sequence: frame.sequence, phase, leaseExpiresAt },
        });
      if (!previous)
        await tx
          .update(slackWorkingTargets)
          .set({ disabled: false, failures: 0 })
          .where(eq(slackWorkingTargets.id, targetId));
      await refreshTargets(tx, previous, targetId, phase, now);
      return "recorded" as const;
    });
    return {
      type: "turn:activity:result",
      requestId: frame.requestId,
      turnId: frame.turnId,
      sequence: frame.sequence,
      status,
    };
  }

  async #scope(tx: DatabaseTransaction, frame: TurnActivityRequest, context: RuntimeBusinessContext) {
    // Same lock order as custody/reporting and placement changes.
    const [placement] = await tx
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, frame.sessionId))
      .for("update");
    if (!placement || placement.computerId !== context.computerId || placement.generation !== frame.placementGeneration)
      return;
    const [scope] = await tx
      .select({ delivery: imMessageDeliveries, binding: imBindings, installation: slackInstallations })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(
        and(
          eq(imMessageDeliveries.id, frame.deliveryId),
          eq(imMessageDeliveries.sessionId, frame.sessionId),
          eq(imMessageDeliveries.turnId, frame.turnId),
          eq(imMessageDeliveries.reportOwnerInstanceId, context.instanceId),
          eq(imMessageDeliveries.placementGeneration, frame.placementGeneration),
          eq(imMessageDeliveries.state, "accepted"),
          isNull(imMessageDeliveries.reportedAt),
          isNull(sessions.endedAt),
          eq(imBindings.agentId, frame.agentId),
          eq(imBindings.provider, "slack"),
          eq(imBindings.status, "active"),
          eq(slackInstallations.status, "active"),
          eq(imBindings.credentialGeneration, slackInstallations.credentialGeneration),
        ),
      )
      .for("update", { of: imMessageDeliveries });
    return scope;
  }

  async claim(): Promise<WorkingTarget | undefined> {
    const now = this.now();
    return this.database.transaction(async (tx) => {
      const [target] = await tx
        .select(getTableColumns(slackWorkingTargets))
        .from(slackWorkingTargets)
        .innerJoin(slackInstallations, eq(slackInstallations.id, slackWorkingTargets.installationId))
        .where(
          and(
            eq(slackWorkingTargets.disabled, false),
            lte(slackWorkingTargets.nextAttemptAt, now),
            lte(slackWorkingTargets.notBeforeAt, now),
            lte(slackInstallations.workingStatusNotBeforeAt, now),
            or(isNull(slackWorkingTargets.claimExpiresAt), lte(slackWorkingTargets.claimExpiresAt, now)),
          ),
        )
        .orderBy(slackWorkingTargets.nextAttemptAt)
        .limit(1)
        .for("update", { of: slackWorkingTargets, skipLocked: true });
      if (!target) return;
      const [claimed] = await tx
        .update(slackWorkingTargets)
        .set({ claimId: randomUUID(), claimExpiresAt: new Date(now.getTime() + 30_000) })
        .where(eq(slackWorkingTargets.id, target.id))
        .returning();
      return claimed;
    });
  }

  async ownsClaim(target: WorkingTarget): Promise<boolean> {
    if (!target.claimId) return false;
    const [owned] = await this.database
      .select({ id: slackWorkingTargets.id })
      .from(slackWorkingTargets)
      .innerJoin(slackInstallations, eq(slackInstallations.id, slackWorkingTargets.installationId))
      .where(
        and(
          eq(slackWorkingTargets.id, target.id),
          eq(slackWorkingTargets.claimId, target.claimId),
          gt(slackWorkingTargets.claimExpiresAt, new Date(this.now().getTime() + 5_000)),
          lte(slackInstallations.workingStatusNotBeforeAt, this.now()),
        ),
      );
    return owned !== undefined;
  }

  async desired(target: WorkingTarget): Promise<boolean> {
    const [active] = await this.database
      .select({ id: slackWorkingTurns.deliveryId })
      .from(slackWorkingTurns)
      .innerJoin(imMessageDeliveries, eq(imMessageDeliveries.id, slackWorkingTurns.deliveryId))
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .where(
        and(
          eq(slackWorkingTurns.targetId, target.id),
          eq(slackWorkingTurns.phase, "running"),
          gt(slackWorkingTurns.leaseExpiresAt, this.now()),
          gt(slackWorkingTurns.deadlineAt, this.now()),
          isNull(imMessageDeliveries.reportedAt),
          isNull(sessions.endedAt),
          eq(sessionPlacements.generation, imMessageDeliveries.placementGeneration),
        ),
      )
      .limit(1);
    return active !== undefined;
  }

  async settle(
    target: WorkingTarget,
    input: {
      working: boolean;
      delayMs: number;
      failed?: boolean;
      disabled?: boolean;
      dormant?: boolean;
      deferred?: boolean;
      cooldownMs?: number;
    },
  ): Promise<void> {
    if (!target.claimId) return;
    const now = this.now();
    const retryAt = input.dormant ? new Date("9999-12-31T00:00:00.000Z") : new Date(now.getTime() + input.delayMs);
    await this.database.transaction(async (tx) => {
      if (input.cooldownMs !== undefined)
        await tx
          .update(slackInstallations)
          .set({
            workingStatusNotBeforeAt: sql`greatest(${slackInstallations.workingStatusNotBeforeAt}, ${new Date(now.getTime() + input.cooldownMs).toISOString()}::timestamptz)`,
          })
          .where(eq(slackInstallations.id, target.installationId));
      await tx
        .update(slackWorkingTargets)
        .set({
          working: input.working,
          failures: input.deferred ? target.failures : input.failed ? target.failures + 1 : 0,
          disabled: input.disabled ?? false,
          claimId: null,
          claimExpiresAt: null,
          notBeforeAt: input.failed ? new Date(now.getTime() + input.delayMs) : now,
          nextAttemptAt: sql`case when ${slackWorkingTargets.revision} <> ${target.revision} and ${input.failed ?? false} = false then ${now.toISOString()}::timestamptz
        else ${retryAt.toISOString()}::timestamptz end`,
        })
        .where(and(eq(slackWorkingTargets.id, target.id), eq(slackWorkingTargets.claimId, target.claimId)));
    });
  }
}

function workingRequest(payload: unknown, installation: typeof slackInstallations.$inferSelect) {
  const parsed = DirectImMessageDeliveryRequestSchema.safeParse(payload);
  if (!parsed.success || parsed.data.replyRole === "observer") return;
  const ref = parsed.data.content.providerRef;
  if (
    ref.provider !== "slack" ||
    ref.teamId !== installation.externalTeamId ||
    ref.appId !== installation.externalAppId ||
    ref.botUserId !== installation.externalBotId
  )
    return;
  return { ...parsed.data, content: { ...parsed.data.content, providerRef: ref } };
}

function executionDeadline(request: DirectImMessageDeliveryRequest, acceptedAt: Date): Date {
  return new Date(
    Math.min(
      acceptedAt.getTime() + (request.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS),
      request.deadlineAt ? Date.parse(request.deadlineAt) : Number.POSITIVE_INFINITY,
    ),
  );
}

function isReplay(previous: typeof slackWorkingTurns.$inferSelect | undefined, frame: TurnActivityRequest): boolean {
  return previous !== undefined && (previous.sequence >= frame.sequence || previous.phase === "terminal");
}
