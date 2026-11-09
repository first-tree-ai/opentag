import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type ImFeedbackActionKind,
  type ImFeedbackActionRequest,
  ImFeedbackActionRequestSchema,
  type ImFeedbackDestination,
  ImFeedbackDestinationSchema,
  type ImFeedbackList,
  ImFeedbackListSchema,
  type ImFeedbackView,
  ImFeedbackViewSchema,
} from "@opentag/shared";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  imBindings,
  imFeedbackActions,
  imFeedbackTargets,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  sessions,
  slackInstallations,
  users,
} from "../../db/schema/index.js";
import { DomainServiceError } from "../domain-service-error.js";
import { WorkspaceSaveFailedError } from "../sandboxes/errors.js";
import type { SandboxRunnerService } from "../sandboxes/sandbox-runner-service.js";
import {
  type FeedbackAction,
  type FeedbackTarget,
  hasFrozenFeedbackBatch,
  ImFeedbackStore,
} from "./im-feedback-store.js";
import { lockImAgentCustody } from "./inbound-admission.js";

export class ImFeedbackServiceError extends DomainServiceError<
  "IM_FEEDBACK_NOT_FOUND" | "IM_FEEDBACK_CONFLICT",
  "deterministic",
  number
> {
  constructor(code: "IM_FEEDBACK_NOT_FOUND" | "IM_FEEDBACK_CONFLICT", message: string, statusCode: number) {
    super({ code, category: "deterministic", message, statusCode });
    this.name = "ImFeedbackServiceError";
  }
}
const conflict = () =>
  new ImFeedbackServiceError(
    "IM_FEEDBACK_CONFLICT",
    "This operation is unavailable or changed. Refresh its current result before deciding again.",
    409,
  );
const notFound = () => new ImFeedbackServiceError("IM_FEEDBACK_NOT_FOUND", "This feedback is unavailable.", 404);

type Actor = { accountId: string };

export class ImFeedbackActionsService {
  readonly #jobs = new Set<Promise<void>>();
  readonly store: ImFeedbackStore;
  constructor(
    readonly options: {
      database: DatabaseClient;
      secret: string;
      sandboxRunner?: Pick<SandboxRunnerService, "statusForAccount" | "stopForAccount" | "verifySavedForAccount">;
      now?: () => Date;
      onRetryQueued?: () => void;
      onFailure?: (code: string) => void;
    },
  ) {
    this.store = new ImFeedbackStore(options.database, options.now);
  }
  get now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Where a card link leads for the signed-in reader. The link is visible to everyone in the conversation and
   * IM identities aren't Accounts, so ownership is decided here: the owner gets the Agent and Task, anyone else
   * only the owner's display name and the Agent's name.
   */
  async destinationForAccount(accountId: string, id: string): Promise<ImFeedbackDestination> {
    const [row] = await this.options.database
      .select({
        agentId: agents.id,
        agentName: agents.displayName,
        ownerId: agents.createdByUserId,
        ownerDisplayName: users.displayName,
        targetAccountId: imFeedbackTargets.accountId,
        taskId: imFeedbackTargets.messageId,
      })
      .from(imFeedbackTargets)
      .innerJoin(agents, eq(agents.id, imFeedbackTargets.agentId))
      .innerJoin(users, eq(users.id, agents.createdByUserId))
      .where(and(eq(imFeedbackTargets.id, id), ne(agents.status, "deleted")))
      .limit(1);
    if (!row) throw notFound();
    return ImFeedbackDestinationSchema.parse(
      row.ownerId === accountId && row.targetAccountId === accountId
        ? { owner: true, agentId: row.agentId, taskId: row.taskId }
        : {
            owner: false,
            ownerDisplayName: row.ownerDisplayName.slice(0, 255),
            agentName: row.agentName.slice(0, 255),
          },
    );
  }

  async listForAccount(accountId: string, agentId: string, cursor?: string): Promise<ImFeedbackList> {
    return this.options.database.transaction(
      async (tx) => {
        const [owner] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")))
          .limit(1);
        if (!owner) throw notFound();
        const [boundary] = cursor
          ? await tx
              .select({ createdAt: imFeedbackTargets.createdAt, id: imFeedbackTargets.id })
              .from(imFeedbackTargets)
              .where(
                and(
                  eq(imFeedbackTargets.id, cursor),
                  eq(imFeedbackTargets.accountId, accountId),
                  eq(imFeedbackTargets.agentId, agentId),
                ),
              )
              .limit(1)
          : [];
        if (cursor && !boundary) throw notFound();
        const rows = await tx
          .select()
          .from(imFeedbackTargets)
          .where(
            and(
              eq(imFeedbackTargets.accountId, accountId),
              eq(imFeedbackTargets.agentId, agentId),
              inArray(imFeedbackTargets.state, ["failed", "workspace_blocked", "retry_queued", "resolved", "stale"]),
              boundary
                ? sql`(${imFeedbackTargets.createdAt},${imFeedbackTargets.id}) < (${boundary.createdAt.toISOString()}::timestamptz,${boundary.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(sql`${imFeedbackTargets.createdAt} desc`, sql`${imFeedbackTargets.id} desc`)
          .limit(21);
        const items = rows.slice(0, 20).map((t) => ({
          id: t.id,
          agentId: t.agentId,
          sessionId: t.sessionId,
          state: t.state,
          errorCode: t.errorCode,
          deliveryState: t.cardState,
          createdAt: t.createdAt.toISOString(),
        }));
        return ImFeedbackListSchema.parse({ items, nextCursor: rows.length > 20 ? (items.at(-1)?.id ?? null) : null });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async getForAccount(accountId: string, id: string): Promise<ImFeedbackView> {
    return this.options.database.transaction(
      async (tx) => {
        const [target] = await tx
          .select({ target: imFeedbackTargets })
          .from(imFeedbackTargets)
          .innerJoin(agents, eq(agents.id, imFeedbackTargets.agentId))
          .where(
            and(
              eq(imFeedbackTargets.id, id),
              eq(imFeedbackTargets.accountId, accountId),
              eq(agents.createdByUserId, accountId),
              ne(agents.status, "deleted"),
            ),
          )
          .limit(1);
        if (!target) throw notFound();
        const [action] = await tx
          .select()
          .from(imFeedbackActions)
          .where(eq(imFeedbackActions.feedbackId, id))
          .orderBy(sql`${imFeedbackActions.feedbackRevision} desc`)
          .limit(1);
        const allowed = await this.#available(tx, target.target, action);
        const t = target.target;
        return ImFeedbackViewSchema.parse({
          id: t.id,
          agentId: t.agentId,
          taskId: t.messageId,
          sessionId: t.sessionId,
          revision: t.revision,
          state: t.state,
          errorCode: t.errorCode,
          effects: t.effects,
          sandboxId: t.sandboxId,
          environmentGeneration: t.environmentGeneration,
          deliveryState: t.cardState,
          retryBlockedReason: (await hasFrozenFeedbackBatch(tx, t.deliveryId)) ? "batch_initial" : null,
          actions: allowed.map((kind) => ({ kind, confirmation: this.#confirmation(accountId, t, kind) })),
          action: action
            ? {
                kind: action.kind,
                state: action.state,
                resultCode: action.resultCode,
                actorDisplayName: action.actorDisplayName,
                updatedAt: action.updatedAt.toISOString(),
              }
            : null,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async submitForAccount(accountId: string, id: string, input: ImFeedbackActionRequest): Promise<ImFeedbackView> {
    const parsed = ImFeedbackActionRequestSchema.safeParse(input);
    if (!parsed.success || !this.#verifyConfirmation(accountId, id, parsed.data)) throw conflict();
    const admitted = await this.#admit(id, input.revision, input.kind, { accountId });
    this.#dispatch(admitted);
    return this.getForAccount(accountId, id);
  }

  async #available(
    tx: DatabaseTransaction,
    t: FeedbackTarget,
    action?: FeedbackAction,
  ): Promise<ImFeedbackActionKind[]> {
    if (
      t.actionsExpireAt <= this.now ||
      ["stale", "resolved", "retry_queued", "completed", "queued", "working"].includes(t.state) ||
      ["confirmed", "submitting", "checking", "succeeded"].includes(action?.state ?? "")
    )
      return [];
    const [scope] = await tx
      .select({
        binding: imBindings,
        agent: agents,
        session: sessions,
        delivery: imMessageDeliveries,
        placement: sessionPlacements,
        sandbox: sandboxes,
        installation: slackInstallations,
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(sessions, eq(sessions.imBindingId, imBindings.id))
      .innerJoin(imMessageDeliveries, eq(imMessageDeliveries.sessionId, sessions.id))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .leftJoin(sandboxes, eq(sandboxes.id, t.sandboxId ?? "00000000-0000-0000-0000-000000000000"))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .innerJoin(users, eq(users.id, agents.createdByUserId))
      .where(
        and(
          eq(imBindings.id, t.bindingId),
          eq(sessions.id, t.sessionId),
          eq(imMessageDeliveries.id, t.deliveryId),
          isNull(users.suspendedAt),
        ),
      )
      .limit(1);
    if (
      !scope ||
      scope.agent.createdByUserId !== t.accountId ||
      scope.placement.generation !== t.placementGeneration ||
      scope.binding.status !== "active" ||
      scope.binding.credentialGeneration !== t.bindingGeneration ||
      scope.binding.provider !== t.provider ||
      (t.provider === "slack" &&
        (scope.binding.slackInstallationId !== t.installationId ||
          scope.installation?.status !== "active" ||
          scope.installation.credentialGeneration !== t.bindingGeneration))
    )
      return [];
    if (t.state === "workspace_blocked") return workspaceActions(this.options.sandboxRunner, scope.sandbox, t);
    return [];
  }

  async #lockScope(tx: DatabaseTransaction, id: string, actor: Actor) {
    const [initial] = await tx.select().from(imFeedbackTargets).where(eq(imFeedbackTargets.id, id)).limit(1);
    if (!initial) throw notFound();
    await lockImAgentCustody(tx, initial.agentId);
    const [agent] = await tx.select().from(agents).where(eq(agents.id, initial.agentId)).for("update");
    if (!agent || agent.createdByUserId !== initial.accountId || agent.status === "deleted") throw notFound();
    if (actor.accountId !== agent.createdByUserId) throw notFound();
    const [binding] = await tx.select().from(imBindings).where(eq(imBindings.id, initial.bindingId)).for("update");
    if (
      binding?.status !== "active" ||
      binding.credentialGeneration !== initial.bindingGeneration ||
      binding.provider !== initial.provider
    )
      throw conflict();
    const [session] = await tx.select().from(sessions).where(eq(sessions.id, initial.sessionId)).for("no key update");
    const [placement] = await tx
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, initial.sessionId))
      .for("update");
    const [delivery] = await tx
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, initial.deliveryId))
      .for("update");
    const [target] = await tx.select().from(imFeedbackTargets).where(eq(imFeedbackTargets.id, id)).for("update");
    if (!session || !placement || !delivery || !target || placement.generation !== target.placementGeneration)
      throw conflict();
    if (target.bindingGeneration !== binding.credentialGeneration) throw notFound();
    return { agent, session, placement, delivery, target };
  }

  async #currentMessage(tx: DatabaseTransaction, target: FeedbackTarget): Promise<boolean> {
    const [message] = await tx.select().from(imMessages).where(eq(imMessages.id, target.messageId)).limit(1);
    if (!message || message.operation === "deleted") return false;
    const [newer] = await tx
      .select({ id: imMessages.id })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, target.bindingId),
          eq(imMessages.channelId, target.channelId),
          eq(imMessages.externalMessageId, target.inputExternalId),
          sql`(${imMessages.occurredAt},${imMessages.providerRevisionKey},${imMessages.id}) > (${message.occurredAt.toISOString()}::timestamptz,${message.providerRevisionKey},${message.id}::uuid)`,
        ),
      )
      .limit(1);
    return !newer;
  }

  async #insertAction(
    tx: DatabaseTransaction,
    target: FeedbackTarget,
    revision: number,
    kind: ImFeedbackActionKind,
    actor: Actor,
    resultDeliveryId?: string,
  ): Promise<FeedbackAction> {
    const [user] = await tx
      .select({ displayName: users.displayName })
      .from(users)
      .where(and(eq(users.id, actor.accountId), isNull(users.suspendedAt)))
      .limit(1);
    if (!user) throw notFound();
    const now = this.now;
    const [action] = await tx
      .insert(imFeedbackActions)
      .values({
        feedbackId: target.id,
        feedbackRevision: revision,
        kind,
        state: kind === "retry_task" ? "succeeded" : "submitting",
        actorAccountId: actor.accountId,
        actorProviderId: null,
        actorDisplayName: (user.displayName ?? "Account owner").slice(0, 255),
        bindingGeneration: target.bindingGeneration,
        sessionId: target.sessionId,
        placementGeneration: target.placementGeneration,
        environmentGeneration: target.environmentGeneration,
        resourceUid: target.resourceUid,
        reportHash: target.reportHash,
        idempotencyKey: `${target.id}:${revision}:${kind}`,
        resultDeliveryId,
        resultCode: kind === "retry_task" ? "retry_queued" : null,
        confirmedAt: now,
        expiresAt: target.actionsExpireAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!action) throw conflict();
    await tx
      .update(imFeedbackTargets)
      .set({
        ...(kind === "retry_task"
          ? { state: "retry_queued" as const, desiredReaction: "none" as const, settledAt: now }
          : {}),
        revision: sql`${imFeedbackTargets.revision} + 1`,
        nextAttemptAt: now,
        updatedAt: now,
      })
      .where(eq(imFeedbackTargets.id, target.id));
    return action;
  }

  async #admit(
    id: string,
    revision: number,
    kind: ImFeedbackActionKind,
    actor: Actor,
  ): Promise<{ action: FeedbackAction; target: FeedbackTarget; fresh: boolean }> {
    return this.options.database.transaction(async (tx) => {
      const scope = await this.#lockScope(tx, id, actor);
      const target = scope.target;
      const [previous] = await tx
        .select()
        .from(imFeedbackActions)
        .where(and(eq(imFeedbackActions.feedbackId, id), eq(imFeedbackActions.feedbackRevision, revision)))
        .limit(1);
      if (previous) {
        if (previous.kind !== kind) throw conflict();
        return { action: previous, target, fresh: false };
      }
      const [latest] = await tx
        .select()
        .from(imFeedbackActions)
        .where(eq(imFeedbackActions.feedbackId, id))
        .orderBy(sql`${imFeedbackActions.feedbackRevision} desc`)
        .limit(1);
      if (target.revision !== revision || !(await this.#available(tx, target, latest)).includes(kind)) throw conflict();
      if (!(await this.#currentMessage(tx, target))) throw conflict();
      if (kind === "retry_task") throw conflict();
      const action = await this.#insertAction(tx, target, revision, kind, actor);
      return { action, target, fresh: true };
    });
  }

  #dispatch(admitted: { action: FeedbackAction; target: FeedbackTarget; fresh: boolean }): void {
    if (!admitted.fresh) return;
    if (admitted.action.kind === "retry_task") {
      this.options.onRetryQueued?.();
      return;
    }
    const job = this.#runWorkspace(admitted.action, admitted.target).catch(() =>
      this.options.onFailure?.("IM_FEEDBACK_OPERATION_UNKNOWN"),
    );
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job));
  }

  async #runWorkspace(action: FeedbackAction, target: FeedbackTarget): Promise<void> {
    if (
      !this.options.sandboxRunner ||
      !target.sandboxId ||
      target.environmentGeneration === null ||
      !action.actorAccountId
    )
      return;
    try {
      const before = await this.options.sandboxRunner.statusForAccount(action.actorAccountId, target.sandboxId);
      if (
        before.environmentGeneration !== target.environmentGeneration ||
        before.currentResourceUid !== target.resourceUid
      ) {
        await this.#result(action, "stale", "environment_changed");
        return;
      }
      const status = await this.options.sandboxRunner.stopForAccount(action.actorAccountId, target.sandboxId, {
        environmentGeneration: target.environmentGeneration,
        ...(action.kind === "discard" ? { discardUnsavedChanges: true as const } : {}),
      });
      if (status.environmentGeneration === target.environmentGeneration && status.lifecycle === "unallocated") {
        const code = await this.#releaseResultCode(action, target);
        await this.#result(action, "succeeded", code);
      } else await this.#result(action, "checking", "checking_result");
    } catch (error) {
      await this.#result(
        action,
        error instanceof WorkspaceSaveFailedError ? "failed" : "checking",
        error instanceof WorkspaceSaveFailedError ? "workspace_save_failed" : "checking_result",
      );
    }
  }

  async #releaseResultCode(action: FeedbackAction, target: FeedbackTarget): Promise<string> {
    if (action.kind === "discard") return "discarded";
    if (
      !action.actorAccountId ||
      !target.sandboxId ||
      target.environmentGeneration === null ||
      !this.options.sandboxRunner
    )
      return "released_unverified";
    const saved = await this.options.sandboxRunner.verifySavedForAccount(
      action.actorAccountId,
      target.sandboxId,
      target.environmentGeneration,
    );
    return saved ? "saved_released" : "released_unverified";
  }

  async reconcile(target: FeedbackTarget): Promise<void> {
    const action = await this.store.latestAction(target.id);
    if (
      !action ||
      !["submitting", "checking"].includes(action.state) ||
      !action.actorAccountId ||
      !target.sandboxId ||
      !this.options.sandboxRunner
    )
      return;
    const status = await this.options.sandboxRunner.statusForAccount(action.actorAccountId, target.sandboxId);
    if (status.environmentGeneration !== target.environmentGeneration)
      await this.#result(action, "stale", "environment_changed");
    else if (status.lifecycle === "unallocated") await this.#result(action, "succeeded", "released_unverified");
  }

  async #result(action: FeedbackAction, state: FeedbackAction["state"], code: string): Promise<void> {
    await this.options.database.transaction(async (tx) => {
      await tx
        .select({ id: imFeedbackTargets.id })
        .from(imFeedbackTargets)
        .where(eq(imFeedbackTargets.id, action.feedbackId))
        .for("update");
      const [changed] = await tx
        .update(imFeedbackActions)
        .set({ state, resultCode: code, updatedAt: this.now })
        .where(
          and(
            eq(imFeedbackActions.id, action.id),
            or(
              inArray(imFeedbackActions.state, ["submitting", "checking"]),
              state === "succeeded" && ["saved_released", "discarded"].includes(code)
                ? and(eq(imFeedbackActions.state, "succeeded"), eq(imFeedbackActions.resultCode, "released_unverified"))
                : undefined,
            ),
            sql`(${imFeedbackActions.state},coalesce(${imFeedbackActions.resultCode},'')) <> (${state},${code})`,
          ),
        )
        .returning();
      if (!changed) return;
      await tx
        .update(imFeedbackTargets)
        .set({
          ...(state === "succeeded"
            ? { state: "resolved" as const, desiredReaction: "none" as const, settledAt: this.now }
            : {}),
          revision: sql`${imFeedbackTargets.revision} + 1`,
          nextAttemptAt: this.now,
          updatedAt: this.now,
        })
        .where(
          and(
            eq(imFeedbackTargets.id, action.feedbackId),
            eq(imFeedbackTargets.bindingGeneration, action.bindingGeneration),
          ),
        );
    });
  }

  #confirmationKey(): Buffer {
    return createHmac("sha256", this.options.secret).update("opentag/im-feedback-confirmation/v1").digest();
  }

  #confirmation(accountId: string, t: FeedbackTarget, kind: ImFeedbackActionKind): string {
    const body = Buffer.from(
      JSON.stringify({ accountId, id: t.id, revision: t.revision, kind, expires: this.now.getTime() + 5 * 60_000 }),
    ).toString("base64url");
    return `${body}.${createHmac("sha256", this.#confirmationKey()).update(body).digest("base64url")}`;
  }
  #verifyConfirmation(accountId: string, id: string, input: ImFeedbackActionRequest): boolean {
    const [body, signature, ...extra] = input.confirmation.split(".");
    if (!body || !signature || extra.length) return false;
    const expected = createHmac("sha256", this.#confirmationKey()).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
      return (
        payload.accountId === accountId &&
        payload.id === id &&
        payload.revision === input.revision &&
        payload.kind === input.kind &&
        typeof payload.expires === "number" &&
        payload.expires > this.now.getTime() &&
        payload.expires <= this.now.getTime() + 5 * 60_000
      );
    } catch {
      return false;
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.#jobs]);
  }
}

function workspaceActions(
  runner: Pick<SandboxRunnerService, "statusForAccount" | "stopForAccount" | "verifySavedForAccount"> | undefined,
  sandbox: typeof sandboxes.$inferSelect | null,
  target: FeedbackTarget,
): ImFeedbackActionKind[] {
  return runner &&
    sandbox &&
    sandbox.environmentGeneration === target.environmentGeneration &&
    sandbox.currentResourceUid === target.resourceUid &&
    sandbox.lifecycle !== "unallocated"
    ? ["save_release", "discard"]
    : [];
}
