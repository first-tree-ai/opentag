import { randomUUID } from "node:crypto";
import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  imBindings,
  imFeedbackActions,
  imFeedbackTargets,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  users,
} from "../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ImFeedbackActionsService } from "../services/im/im-feedback-actions.js";
import { feedbackCardContent, renderFeedbackCard } from "../services/im/im-feedback-card.js";
import { FeedbackProviderError, type FeedbackTransport } from "../services/im/im-feedback-messenger.js";
import { ImFeedbackStore, startImFeedback } from "../services/im/im-feedback-store.js";
import { ImFeedbackWorker } from "../services/im/im-feedback-worker.js";
import { WorkspaceSaveFailedError } from "../services/sandboxes/errors.js";
import { createSlackWorkingFixture } from "./support/slack-working-fixture.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let db: UnitDatabase;
let clock: Date;
beforeAll(async () => {
  db = await createUnitDatabase();
}, 30_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.reset();
  clock = new Date();
});
async function fixture(provider: "slack" | "feishu" = "slack") {
  const h = await createSlackWorkingFixture(db.database, new ApplicationCipher(Buffer.alloc(32, 11)), () => clock);
  const entry = await h.delivery();
  await db.database.transaction((tx) => startImFeedback(tx, entry.frame.deliveryId, clock));
  const store = new ImFeedbackStore(db.database, () => clock);
  const transport = {
    reaction: vi.fn<FeedbackTransport["reaction"]>(async () => {}),
    post: vi.fn<FeedbackTransport["post"]>(async () => "card-1"),
    update: vi.fn<FeedbackTransport["update"]>(async () => {}),
    find: vi.fn<FeedbackTransport["find"]>(async () => ({ ids: [] as string[] })),
  };
  const warn = vi.fn();
  const worker = new ImFeedbackWorker({ store, transport, logger: { warn } });
  const [agent] = await db.database.select().from(agents).where(eq(agents.id, entry.frame.agentId));
  if (!agent) throw new Error("Missing fixture Agent");
  if (provider === "feishu") {
    await db.database
      .update(imBindings)
      .set({
        provider: "feishu",
        slackInstallationId: null,
        slackRouteKind: null,
        encryptedCredential: "unit-encrypted",
      })
      .where(eq(imBindings.id, h.binding.id));
    await db.database
      .update(imFeedbackTargets)
      .set({ provider: "feishu", installationId: null })
      .where(eq(imFeedbackTargets.deliveryId, entry.frame.deliveryId));
  }
  const target = async () => {
    const [row] = await db.database
      .select()
      .from(imFeedbackTargets)
      .where(eq(imFeedbackTargets.deliveryId, entry.frame.deliveryId));
    if (!row) throw new Error("Missing feedback target");
    return row;
  };
  const finish = async (
    outcome: TurnReportRequest["outcome"] = "failed",
    effects: TurnReportRequest["executionEffects"] = "may_have_occurred",
    reason: TurnReportRequest["errorReason"] = "provider_failed",
  ) => {
    const report: TurnReportRequest = {
      type: "turn:report",
      requestId: randomUUID(),
      deliveryId: entry.frame.deliveryId,
      turnId: entry.frame.turnId,
      sessionId: entry.frame.sessionId,
      agentId: entry.frame.agentId,
      placementGeneration: 1,
      outcome,
      executionEffects: effects,
      ...(outcome === "completed" ? {} : { errorReason: reason }),
      traceSummary: { lastSequence: 1, droppedEvents: 0 },
      resultHash: "0".repeat(64),
    };
    report.resultHash = computeTurnResultHash(report);
    const result = await new PostgresRuntimeCustodyStore(db.database, { now: () => clock }).recordTurn(
      report,
      h.context,
    );
    expect(result).toBe("recorded");
    return report;
  };
  return { ...h, ...entry, store, transport, warn, worker, target, finish, accountId: agent.createdByUserId };
}

async function workspaceFixture() {
  const h = await fixture();
  await h.finish("failed", "completed", "workspace_failed");
  const t = await h.target();
  const [sandbox] = await db.database
    .insert(sandboxes)
    .values({
      sessionId: t.sessionId,
      storageUri: "gs://test/workspace",
      environmentGeneration: 3,
      lifecycle: "ready",
      currentResourceName: "projects/test/locations/test/instances/example",
      currentResourceUid: "uid-3",
    })
    .returning();
  if (!sandbox) throw new Error("Missing sandbox");
  await db.database
    .update(imFeedbackTargets)
    .set({ sandboxId: sandbox.id, environmentGeneration: 3, resourceUid: "uid-3" })
    .where(eq(imFeedbackTargets.id, t.id));
  const status = {
    sandboxId: sandbox.id,
    sessionId: t.sessionId,
    lifecycle: "ready" as "ready" | "unallocated",
    environmentGeneration: 3,
    currentResourceName: sandbox.currentResourceName,
    currentResourceUid: "uid-3" as string | null,
    currentOperationName: null,
    runnerConnected: true,
    runnerReady: false,
    runnerReadiness: null,
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: clock.toISOString(),
  };
  const runner = {
    statusForAccount: vi.fn(async () => status),
    stopForAccount: vi.fn(async () => ({ ...status, lifecycle: "unallocated" as const, currentResourceUid: null })),
    verifySavedForAccount: vi.fn(async () => true),
  };
  const service = new ImFeedbackActionsService({
    database: db.database,
    secret: "secret",
    now: () => clock,
    sandboxRunner: runner,
  });
  async function submit(kind: "save_release" | "discard") {
    const view = await service.getForAccount(h.accountId, t.id);
    const a = view.actions.find((a) => a.kind === kind);
    if (!a) throw new Error("Missing operation");
    return service.submitForAccount(h.accountId, t.id, { kind, revision: view.revision, confirmation: a.confirmation });
  }
  return { ...h, t, status, runner, service, submit };
}

describe("durable IM feedback", () => {
  it("retires an ingress projection when dispatch establishes an observer-only copy", async () => {
    const h = await fixture();
    await db.database
      .update(imFeedbackTargets)
      .set({ state: "queued", desiredReaction: "none" })
      .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    await db.database
      .update(imMessageDeliveries)
      .set({ dispatchPayload: { ...h.request, replyRole: "observer" } })
      .where(eq(imMessageDeliveries.id, h.frame.deliveryId));
    await db.database.transaction((tx) => startImFeedback(tx, h.frame.deliveryId, clock));
    await h.finish();
    await h.worker.runOnce();
    expect((await h.target()).state).toBe("stale");
    expect(h.transport.post).not.toHaveBeenCalled();
    expect(h.transport.reaction).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "settles an input-expiry card after retained custody proves completion (bound=%s)",
    async (bound) => {
      const h = await fixture();
      await db.database
        .update(imFeedbackTargets)
        .set({ state: "failed", errorCode: "input_expired", desiredReaction: "warning", cardState: "pending" })
        .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
      if (bound) await h.worker.runOnce();
      await h.finish("completed", "completed");
      await h.worker.runOnce();
      expect((await h.target()).state).toBe("completed");
      if (bound) {
        expect(h.transport.update).toHaveBeenCalledOnce();
        expect(renderFeedbackCard(await h.target(), "https://app.test").slack.text).toContain("Task completed");
      } else expect(h.transport.post).not.toHaveBeenCalled();
    },
  );
  it("settles its projection lease", async () => {
    const h = await fixture();
    const target = await h.store.claim();
    if (!target) throw new Error("Missing claim");
    await h.store.settle(target, { reaction: "working" });
    expect((await h.target()).claimId).toBeNull();
  });
  it.each(["slack", "feishu"] as const)("has only start/end reaction changes for %s", async (provider) => {
    const h = await fixture(provider);
    await h.worker.runOnce();
    await db.database.transaction((tx) => startImFeedback(tx, h.frame.deliveryId, clock));
    clock = new Date(clock.getTime() + 61_000);
    await h.worker.runOnce();
    expect(h.transport.reaction.mock.calls.map((args) => args[1])).toEqual(["working"]);
    await h.finish("completed", "completed");
    await h.worker.runOnce();
    expect(h.transport.reaction.mock.calls.map((args) => args[1])).toEqual(["working", "none"]);
    expect(h.transport.post).not.toHaveBeenCalled();
  });
  it("persists terminal error feedback in the same report transaction", async () => {
    const h = await fixture();
    await h.finish();
    const target = await h.target();
    expect(target).toMatchObject({
      state: "failed",
      desiredReaction: "warning",
      cardState: "pending",
      effects: "may_have_occurred",
    });
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({ cardState: "sent", cardMessageId: "card-1" });
    await h.worker.runOnce();
    expect(h.transport.post).toHaveBeenCalledOnce();
  });
  it("still sends the error card when reaction writing fails", async () => {
    const h = await fixture();
    await h.finish();
    h.transport.reaction.mockRejectedValueOnce(new Error("private upstream text"));
    await h.worker.runOnce();
    expect(h.transport.post).toHaveBeenCalledOnce();
    expect(await h.target()).toMatchObject({ appliedReaction: null, cardState: "sent" });
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("private upstream text");
  });
  it("honors reaction Retry-After while still publishing the incident card", async () => {
    const h = await fixture();
    await h.finish();
    h.transport.reaction.mockRejectedValueOnce(
      new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, 45_000),
    );
    await h.worker.runOnce();
    expect((await h.target()).nextAttemptAt).toEqual(new Date(clock.getTime() + 45_000));
    expect(h.transport.post).toHaveBeenCalledOnce();
    clock = new Date(clock.getTime() + 44_000);
    await h.worker.runOnce();
    expect(h.transport.reaction).toHaveBeenCalledOnce();
    clock = new Date(clock.getTime() + 2_000);
    await h.worker.runOnce();
    expect(h.transport.reaction).toHaveBeenCalledTimes(2);
    expect(h.transport.post).toHaveBeenCalledOnce();
  });
  it("retries a definitely rate-limited card only after Retry-After", async () => {
    const h = await fixture();
    await h.finish();
    h.transport.post.mockRejectedValueOnce(new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, 45_000));
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({ cardState: "pending", nextAttemptAt: new Date(clock.getTime() + 45_000) });
    clock = new Date(clock.getTime() + 44_000);
    await h.worker.runOnce();
    expect(h.transport.post).toHaveBeenCalledOnce();
    clock = new Date(clock.getTime() + 2_000);
    await h.worker.runOnce();
    expect(h.transport.post).toHaveBeenCalledTimes(2);
    expect((await h.target()).cardState).toBe("sent");
  });
  it("honors Retry-After on bound-card updates", async () => {
    const h = await fixture();
    await h.finish();
    await h.worker.runOnce();
    await db.database
      .update(imFeedbackTargets)
      .set({ revision: sql`${imFeedbackTargets.revision}+1`, nextAttemptAt: clock })
      .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    h.transport.update.mockRejectedValueOnce(
      new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, 60_000),
    );
    await h.worker.runOnce();
    expect((await h.target()).nextAttemptAt).toEqual(new Date(clock.getTime() + 60_000));
  });
  it("preserves the longest rate limit when the card send is also ambiguous", async () => {
    const h = await fixture();
    await h.finish();
    h.transport.reaction.mockRejectedValueOnce(
      new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, 60_000),
    );
    h.transport.post.mockRejectedValueOnce(new Error("unknown send"));
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({
      cardState: "send_unknown",
      nextAttemptAt: new Date(clock.getTime() + 60_000),
    });
  });
  it("reconciles an unanswered send without automatically creating another card", async () => {
    const h = await fixture();
    await h.finish();
    h.transport.post.mockRejectedValueOnce(new Error("request may have succeeded"));
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({ cardState: "send_unknown" });
    clock = new Date(clock.getTime() + 31_000);
    await h.worker.runOnce();
    expect(h.transport.find).toHaveBeenCalledOnce();
    expect(h.transport.post).toHaveBeenCalledOnce();
    h.transport.find.mockResolvedValueOnce({ ids: ["provider-confirmed-card"] });
    clock = new Date(clock.getTime() + 301_000);
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({ cardMessageId: "provider-confirmed-card", cardState: "sent" });
    expect(h.transport.post).toHaveBeenCalledOnce();
  });
  it("recovers after a provider accepted the card but its DB acknowledgement failed", async () => {
    const h = await fixture();
    await h.finish();
    const settle = vi.spyOn(h.store, "settle");
    settle.mockRejectedValueOnce(new Error("lost DB ack"));
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({ cardState: "send_unknown" });
    h.transport.find.mockResolvedValueOnce({ ids: ["card-1"] });
    clock = new Date(clock.getTime() + 31_000);
    await new ImFeedbackWorker({ store: h.store, transport: h.transport, logger: { warn: h.warn } }).runOnce();
    expect(h.transport.post).toHaveBeenCalledOnce();
    expect((await h.target()).cardMessageId).toBe("card-1");
  });
  it("does not publish with revoked binding generation or transferred ownership", async () => {
    const h = await fixture();
    await h.finish();
    await db.database
      .update(imBindings)
      .set({ credentialGeneration: h.binding.credentialGeneration + 1 })
      .where(eq(imBindings.id, h.binding.id));
    await h.worker.runOnce();
    expect(h.transport.post).not.toHaveBeenCalled();
    expect((await h.target()).state).toBe("stale");
  });
  it("blocks projections after the owning Account is suspended", async () => {
    const h = await fixture();
    await h.finish();
    await db.database.update(users).set({ suspendedAt: clock }).where(eq(users.id, h.accountId));
    await h.worker.runOnce();
    expect(h.transport.post).not.toHaveBeenCalled();
    expect((await h.target()).state).toBe("stale");
  });
  it("projects a newer revision after a delayed older card update returns", async () => {
    const h = await fixture();
    await h.finish();
    await h.worker.runOnce();
    await db.database
      .update(imFeedbackTargets)
      .set({ revision: sql`${imFeedbackTargets.revision}+1`, nextAttemptAt: clock })
      .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    h.transport.update.mockImplementationOnce(async () => {
      await db.database
        .update(imFeedbackTargets)
        .set({
          errorCode: "provider_unavailable",
          revision: sql`${imFeedbackTargets.revision}+1`,
          nextAttemptAt: clock,
        })
        .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    });
    await h.worker.runOnce();
    const t = await h.target();
    expect(h.transport.update).toHaveBeenCalledTimes(2);
    expect(t.cardRevision).toBe(t.revision);
    expect(t.state).toBe("failed");
  });
  it("blocks confirmed permanent rejection without claiming delivery", async () => {
    const h = await fixture();
    await h.finish();
    h.transport.post.mockRejectedValueOnce(new FeedbackProviderError("IM_FEEDBACK_BINDING_STALE", true, true));
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({ cardState: "blocked", cardMessageId: null });
  });
  it("reclaims a newer terminal revision without marking it stale", async () => {
    const h = await fixture();
    const isCurrent = h.store.isCurrent.bind(h.store);
    vi.spyOn(h.store, "isCurrent").mockImplementationOnce(async (t, claim) => {
      await h.finish();
      return isCurrent(t, claim);
    });
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({ state: "failed", cardState: "sent" });
    expect(h.transport.post).toHaveBeenCalledOnce();
  });
  it("repairs a queued projection from authoritative retained custody", async () => {
    const h = await fixture();
    await db.database
      .update(imFeedbackTargets)
      .set({ state: "queued", desiredReaction: "none" })
      .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({ state: "working", appliedReaction: "working" });
  });
  it("retains unknown sends but expires confirmed, settled failure diagnostics after 90 days", async () => {
    const h = await fixture();
    await h.finish();
    h.transport.post.mockRejectedValueOnce(new Error("lost ack"));
    await h.worker.runOnce();
    clock = new Date(clock.getTime() + 91 * 86_400_000);
    await h.store.retain();
    expect((await h.target()).cardState).toBe("send_unknown");
    await db.database
      .update(imFeedbackTargets)
      .set({ cardState: "sent", cardMessageId: "known", settledAt: new Date(clock.getTime() - 91 * 86_400_000) })
      .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    await h.store.retain();
    expect(await db.database.select().from(imFeedbackTargets)).toHaveLength(0);
  });
  it("renders external-effect uncertainty identically and never copies arbitrary runtime output", async () => {
    const h = await fixture();
    await h.finish();
    const t = await h.target();
    const card = renderFeedbackCard(t, "https://example.test");
    expect(card.slack.text).toContain("may already have occurred");
    expect(card.feishu).toContain("may already have occurred");
    expect(card.slack.text).not.toContain("No task operations");
    expect(card.feishu).not.toContain("No task operations");
    expect(feedbackCardContent({ ...t, errorCode: "<@everyone> private raw details" }).title).toBe(
      "Task failed: The task could not complete",
    );
    expect(renderFeedbackCard({ ...t, effects: "not_started" }, "https://example.test").slack.text).toContain(
      "No task operations were executed",
    );
  });
});

describe("safe feedback actions", () => {
  it("creates one retry attempt while preserving the original immutable report", async () => {
    const h = await fixture();
    const report = await h.finish("failed", "not_started");
    const service = new ImFeedbackActionsService({ database: db.database, secret: "test-secret", now: () => clock });
    const before = await h.target();
    const view = await service.getForAccount(h.accountId, before.id);
    const action = view.actions.find((a) => a.kind === "retry_task");
    expect(action).toBeDefined();
    if (!action) return;
    const input = { kind: "retry_task" as const, revision: view.revision, confirmation: action.confirmation };
    await service.submitForAccount(h.accountId, before.id, input);
    await service.submitForAccount(h.accountId, before.id, input);
    const rows = await db.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.messageId, before.messageId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.attemptOrdinal === 0)?.turnReport).toEqual(report);
    expect(rows.find((r) => r.attemptOrdinal === 1)).toMatchObject({
      state: "pending",
      retryOfDeliveryId: h.frame.deliveryId,
    });
    expect(await db.database.select().from(imFeedbackActions)).toHaveLength(1);
    await h.worker.runOnce();
    expect(h.transport.post.mock.calls[0]?.[1]).toMatchObject({
      kind: "retry_task",
      state: "succeeded",
      resultCode: "retry_queued",
    });
  });
  it("projects the highest retry ordinal even when creation clocks coincide", async () => {
    const h = await fixture();
    await h.finish("failed", "not_started");
    const t = await h.target();
    const service = new ImFeedbackActionsService({ database: db.database, secret: "secret", now: () => clock });
    const view = await service.getForAccount(h.accountId, t.id);
    const a = view.actions[0];
    if (!a) throw new Error("Missing retry");
    await service.submitForAccount(h.accountId, t.id, {
      kind: a.kind,
      revision: t.revision,
      confirmation: a.confirmation,
    });
    const [retry] = await db.database.select().from(imFeedbackTargets).where(eq(imFeedbackTargets.state, "queued"));
    if (!retry) throw new Error("Missing retry target");
    await db.database
      .update(imFeedbackTargets)
      .set({ state: "working", desiredReaction: "working" })
      .where(eq(imFeedbackTargets.id, retry.id));
    await db.database
      .update(imFeedbackTargets)
      .set({ desiredReaction: "warning", createdAt: new Date(clock.getTime() + 1_000) })
      .where(eq(imFeedbackTargets.id, t.id));
    expect(await h.store.desiredReaction(t)).toBe("working");
  });
  it.each(["may_have_occurred", "completed"] as const)(
    "does not offer task replay after effects=%s",
    async (effects) => {
      const h = await fixture();
      await h.finish("failed", effects);
      const t = await h.target();
      const service = new ImFeedbackActionsService({ database: db.database, secret: "secret", now: () => clock });
      expect((await service.getForAccount(h.accountId, t.id)).actions).toEqual([]);
      expect(
        await service.submitNativeRetry({
          feedbackId: t.id,
          revision: t.revision,
          provider: "slack",
          userId: t.senderExternalId,
          generation: t.bindingGeneration,
          channelId: t.channelId,
          messageId: "card-1",
          installationId: t.installationId ?? undefined,
        }),
      ).toBe("unavailable");
    },
  );
  it("rejects a forged confirmation, foreign Account, expired action and stale revision", async () => {
    const h = await fixture();
    await h.finish("failed", "not_started");
    const t = await h.target();
    const service = new ImFeedbackActionsService({ database: db.database, secret: "secret", now: () => clock });
    await expect(service.getForAccount(randomUUID(), t.id)).rejects.toMatchObject({ statusCode: 404 });
    const view = await service.getForAccount(h.accountId, t.id);
    const action = view.actions[0];
    if (!action) throw new Error("Missing action");
    await expect(
      service.submitForAccount(h.accountId, t.id, { kind: "retry_task", revision: t.revision, confirmation: "forged" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    clock = new Date(clock.getTime() + 6 * 60_000);
    await expect(
      service.submitForAccount(h.accountId, t.id, {
        kind: "retry_task",
        revision: t.revision,
        confirmation: action.confirmation,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("refuses an edited source message even with a previously valid confirmation", async () => {
    const h = await fixture();
    await h.finish("failed", "not_started");
    const t = await h.target();
    const service = new ImFeedbackActionsService({ database: db.database, secret: "secret", now: () => clock });
    const view = await service.getForAccount(h.accountId, t.id);
    const a = view.actions[0];
    if (!a) throw new Error("Missing action");
    const [source] = await db.database.select().from(imMessages).where(eq(imMessages.id, t.messageId));
    if (!source) throw new Error("Missing message");
    await db.database.insert(imMessages).values({
      ...source,
      id: randomUUID(),
      providerRevisionKey: "2",
      operation: "edited",
      occurredAt: new Date(source.occurredAt.getTime() + 1_000),
    });
    await expect(
      service.submitForAccount(h.accountId, t.id, { kind: a.kind, revision: t.revision, confirmation: a.confirmation }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("lets only the original native sender retry the exact card", async () => {
    const h = await fixture();
    await h.finish("failed", "not_started");
    await h.worker.runOnce();
    const t = await h.target();
    const service = new ImFeedbackActionsService({ database: db.database, secret: "secret", now: () => clock });
    const input = {
      feedbackId: t.id,
      revision: t.revision,
      provider: "slack" as const,
      userId: t.senderExternalId,
      generation: t.bindingGeneration,
      channelId: t.channelId,
      messageId: t.cardMessageId ?? "",
      installationId: t.installationId ?? undefined,
    };
    expect(await service.submitNativeRetry({ ...input, userId: "someone-else" })).toBe("unavailable");
    expect(await service.submitNativeRetry({ ...input, messageId: "another-card" })).toBe("unavailable");
    expect(await service.submitNativeRetry(input)).toBe("recorded");
  });
  it.each(["save_release", "discard"] as const)("updates the original card from a verified %s result", async (kind) => {
    const h = await workspaceFixture();
    await h.worker.runOnce();
    await h.submit(kind);
    await h.service.close();
    await h.worker.runOnce();
    const view = await h.service.getForAccount(h.accountId, h.t.id);
    expect(view.state).toBe("resolved");
    expect(view.action).toMatchObject({
      kind,
      state: "succeeded",
      resultCode: kind === "discard" ? "discarded" : "saved_released",
    });
    const content = renderFeedbackCard(
      await h.target(),
      "https://app.test",
      (await db.database.select().from(imFeedbackActions))[0],
    );
    expect(content.slack.text).toContain(
      kind === "discard" ? "Unsaved changes discarded" : "Saved and environment released",
    );
    expect(content.slack.text).not.toContain("Task completed");
    expect(content.feishu).toContain("Working");
    expect(h.transport.post).toHaveBeenCalledOnce();
    expect(h.transport.update).toHaveBeenCalledOnce();
    expect(h.runner.stopForAccount).toHaveBeenCalledWith(h.accountId, expect.any(String), {
      environmentGeneration: 3,
      ...(kind === "discard" ? { discardUnsavedChanges: true } : {}),
    });
  });
  it("requires exact sealed proof before claiming a successful save", async () => {
    const h = await workspaceFixture();
    h.runner.verifySavedForAccount.mockResolvedValue(false);
    await h.submit("save_release");
    await h.service.close();
    expect((await h.service.getForAccount(h.accountId, h.t.id)).action?.resultCode).toBe("released_unverified");
  });
  it("upgrades an unverified concurrent read when its own save returns exact proof", async () => {
    const h = await workspaceFixture();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runner.stopForAccount.mockImplementationOnce(async () => {
      await gate;
      return { ...h.status, lifecycle: "unallocated" as const, currentResourceUid: null };
    });
    try {
      await h.submit("save_release");
      h.status.lifecycle = "unallocated";
      h.status.currentResourceUid = null;
      await h.service.reconcile(await h.target());
      expect((await h.service.getForAccount(h.accountId, h.t.id)).action?.resultCode).toBe("released_unverified");
    } finally {
      release();
      await h.service.close();
    }
    expect((await h.service.getForAccount(h.accountId, h.t.id)).action?.resultCode).toBe("saved_released");
  });
  it("allows a new explicit save decision after a definite save failure", async () => {
    const h = await workspaceFixture();
    h.runner.stopForAccount.mockRejectedValueOnce(new WorkspaceSaveFailedError("synthetic save failure"));
    await h.submit("save_release");
    await h.service.close();
    const failed = await h.service.getForAccount(h.accountId, h.t.id);
    expect(failed.action?.state).toBe("failed");
    expect(failed.actions.map((a) => a.kind)).toEqual(["save_release", "discard"]);
    await h.submit("save_release");
    await h.service.close();
    expect(h.runner.stopForAccount).toHaveBeenCalledTimes(2);
    expect((await h.service.getForAccount(h.accountId, h.t.id)).action?.state).toBe("succeeded");
  });
  it("fences an allocation replaced after confirmation without calling stop", async () => {
    const h = await workspaceFixture();
    h.status.environmentGeneration = 4;
    await h.submit("discard");
    await h.service.close();
    expect(h.runner.stopForAccount).not.toHaveBeenCalled();
    expect((await h.service.getForAccount(h.accountId, h.t.id)).action?.state).toBe("stale");
  });
  it("reconciles an unknown release conservatively after restart", async () => {
    const h = await workspaceFixture();
    h.runner.stopForAccount.mockRejectedValueOnce(new Error("lost ack"));
    await h.submit("discard");
    await h.service.close();
    h.status.lifecycle = "unallocated";
    h.status.currentResourceUid = null;
    await h.service.reconcile(await h.target());
    const view = await h.service.getForAccount(h.accountId, h.t.id);
    expect(view.action).toMatchObject({ state: "succeeded", resultCode: "released_unverified" });
    expect(h.runner.stopForAccount).toHaveBeenCalledOnce();
  });
  it("keeps unknown workspace operations pending without resubmission", async () => {
    const h = await fixture();
    await h.finish("failed", "completed", "workspace_failed");
    const t = await h.target();
    const [sandbox] = await db.database
      .insert(sandboxes)
      .values({
        sessionId: t.sessionId,
        storageUri: "gs://test/workspace",
        environmentGeneration: 3,
        lifecycle: "ready",
        currentResourceName: "projects/test/locations/test/instances/example",
        currentResourceUid: "uid-3",
      })
      .returning();
    if (!sandbox) throw new Error("Missing sandbox");
    await db.database
      .update(imFeedbackTargets)
      .set({ sandboxId: sandbox.id, environmentGeneration: 3, resourceUid: "uid-3" })
      .where(eq(imFeedbackTargets.id, t.id));
    const status = {
      sandboxId: sandbox.id,
      sessionId: t.sessionId,
      lifecycle: "ready" as const,
      environmentGeneration: 3,
      currentResourceName: sandbox.currentResourceName,
      currentResourceUid: "uid-3",
      currentOperationName: null,
      runnerConnected: true,
      runnerReady: false,
      runnerReadiness: null,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedAt: clock.toISOString(),
    };
    const runner = {
      statusForAccount: vi.fn(async () => status),
      stopForAccount: vi.fn(async () => {
        throw new Error("unknown response");
      }),
      verifySavedForAccount: vi.fn(async () => false),
    };
    const service = new ImFeedbackActionsService({
      database: db.database,
      secret: "secret",
      now: () => clock,
      sandboxRunner: runner,
    });
    const view = await service.getForAccount(h.accountId, t.id);
    const a = view.actions.find((a) => a.kind === "save_release");
    if (!a) throw new Error("Missing save action");
    const input = { kind: a.kind, revision: view.revision, confirmation: a.confirmation };
    await service.submitForAccount(h.accountId, t.id, input);
    await service.close();
    await service.submitForAccount(h.accountId, t.id, input);
    await service.reconcile(await h.target());
    expect(runner.stopForAccount).toHaveBeenCalledOnce();
    const pending = await service.getForAccount(h.accountId, t.id);
    expect(pending.action?.state).toBe("checking");
    expect(pending.actions).toEqual([]);
  });
});
