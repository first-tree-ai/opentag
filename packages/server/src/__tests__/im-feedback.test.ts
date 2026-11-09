import { randomUUID } from "node:crypto";
import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  computers,
  imBindings,
  imFeedbackActions,
  imFeedbackTargets,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  users,
} from "../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ImFeedbackActionsService } from "../services/im/im-feedback-actions.js";
import { feedbackCardContent, renderFeedbackCard, renderFeedbackText } from "../services/im/im-feedback-card.js";
import {
  FeedbackCooldownStorageError,
  FeedbackProviderError,
  type FeedbackTransport,
} from "../services/im/im-feedback-messenger.js";
import { createImFeedbackTarget, ImFeedbackStore, startImFeedback } from "../services/im/im-feedback-store.js";
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
afterEach(() => vi.unstubAllEnvs());
async function fixture(provider: "slack" | "feishu" = "slack") {
  const h = await createSlackWorkingFixture(db.database, new ApplicationCipher(Buffer.alloc(32, 11)), () => clock);
  const entry = await h.delivery();
  await db.database.transaction((tx) => startImFeedback(tx, entry.frame.deliveryId, clock));
  const store = new ImFeedbackStore(db.database, () => clock);
  const transport = {
    reaction: vi.fn<FeedbackTransport["reaction"]>(async () => {}),
    post: vi.fn<FeedbackTransport["post"]>(async () => "card-1"),
    postOfflineNotice: vi.fn<FeedbackTransport["postOfflineNotice"]>(async () => {}),
    update: vi.fn<FeedbackTransport["update"]>(async () => {}),
    find: vi.fn<FeedbackTransport["find"]>(async () => ({ ids: [] as string[] })),
  };
  const warn = vi.fn();
  const worker = new ImFeedbackWorker({ store, transport, logger: { warn }, now: () => clock });
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
    return service.submitForAccount(h.accountId, t.id, {
      ...(kind === "discard" ? ({ kind, permanentLossAcknowledged: true } as const) : { kind }),
      revision: view.revision,
      confirmation: a.confirmation,
    });
  }
  return { ...h, t, status, runner, service, submit };
}

describe("IM offline notice", () => {
  const setComputer = async (
    h: Awaited<ReturnType<typeof fixture>>,
    values: Partial<typeof computers.$inferInsert>,
  ) => {
    const [placement] = await db.database
      .select({ computerId: sessionPlacements.computerId })
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, h.frame.sessionId));
    await db.database
      .update(computers)
      .set(values)
      .where(eq(computers.id, placement?.computerId ?? ""));
  };
  const offlineSince = (h: Awaited<ReturnType<typeof fixture>>, ms: number) =>
    setComputer(h, { lastSeenAt: new Date(clock.getTime() - ms), currentInstanceId: null });
  async function queued() {
    const h = await fixture();
    const park = async (deliveryId: string, receivedMsAgo: number) => {
      await db.database
        .update(imMessageDeliveries)
        .set({ state: "pending", acceptedAt: null, inputHash: null, turnId: null, reportOwnerInstanceId: null })
        .where(eq(imMessageDeliveries.id, deliveryId));
      const [delivery] = await db.database
        .select({ messageId: imMessageDeliveries.messageId })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, deliveryId));
      await db.database
        .update(imMessages)
        .set({ receivedAt: new Date(clock.getTime() - receivedMsAgo) })
        .where(eq(imMessages.id, delivery?.messageId ?? ""));
      await db.database
        .update(imFeedbackTargets)
        .set({ state: "queued", desiredReaction: "none" })
        .where(eq(imFeedbackTargets.deliveryId, deliveryId));
    };
    await park(h.frame.deliveryId, 300_000);
    return { ...h, park };
  }

  it("waits sixty seconds from the later of receipt and the Computer going silent", async () => {
    const h = await queued();
    await offlineSince(h, 59_000);
    expect(await h.store.reserveOfflineNotice(await h.target())).toBeUndefined();
    await offlineSince(h, 61_000);
    expect(await h.store.reserveOfflineNotice(await h.target())).toEqual(clock);
  });

  it("starts the sixty seconds at receipt when a message arrives during an outage", async () => {
    const h = await queued();
    await offlineSince(h, 300_000);
    await h.park(h.frame.deliveryId, 59_000);
    expect(await h.store.reserveOfflineNotice(await h.target())).toBeUndefined();
  });

  it("sends once per Session and offline period, and again in a later period", async () => {
    const h = await queued();
    const second = await h.delivery();
    await db.database.transaction((tx) => createImFeedbackTarget(tx, second.frame.deliveryId, clock));
    await h.park(second.frame.deliveryId, 300_000);
    await offlineSince(h, 120_000);
    const [secondTarget] = await db.database
      .select()
      .from(imFeedbackTargets)
      .where(eq(imFeedbackTargets.deliveryId, second.frame.deliveryId));
    if (!secondTarget) throw new Error("Missing second target");
    expect(await h.store.reserveOfflineNotice(await h.target())).toEqual(clock);
    expect(await h.store.reserveOfflineNotice(secondTarget)).toBeUndefined();
    expect(await h.store.reserveOfflineNotice(await h.target())).toBeUndefined();

    clock = new Date(clock.getTime() + 600_000);
    await offlineSince(h, 120_000);
    expect(await h.store.reserveOfflineNotice(secondTarget)).toEqual(clock);
  });

  it("keeps one notice through an outage longer than the input lifetime", async () => {
    const h = await queued();
    await offlineSince(h, 120_000);
    expect(await h.store.reserveOfflineNotice(await h.target())).toEqual(clock);
    const later = await h.delivery();
    await db.database.transaction((tx) => createImFeedbackTarget(tx, later.frame.deliveryId, clock));
    await h.park(later.frame.deliveryId, 300_000);
    await db.database
      .update(imFeedbackTargets)
      .set({ createdAt: new Date(clock.getTime() - 9 * 86_400_000) })
      .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    const [target] = await db.database
      .select()
      .from(imFeedbackTargets)
      .where(eq(imFeedbackTargets.deliveryId, later.frame.deliveryId));
    if (!target) throw new Error("Missing later target");
    expect(await h.store.reserveOfflineNotice(target)).toBeUndefined();
  });

  it("starts a never-connected Computer's offline period when it was created, not at the epoch", async () => {
    const h = await queued();
    await setComputer(h, {
      lastSeenAt: null,
      currentInstanceId: null,
      createdAt: new Date(clock.getTime() - 120_000),
    });
    const second = await h.delivery();
    await db.database.transaction((tx) => createImFeedbackTarget(tx, second.frame.deliveryId, clock));
    await h.park(second.frame.deliveryId, 300_000);
    const [secondTarget] = await db.database
      .select()
      .from(imFeedbackTargets)
      .where(eq(imFeedbackTargets.deliveryId, second.frame.deliveryId));
    if (!secondTarget) throw new Error("Missing second target");

    // A send from before this Computer existed belongs to no offline period of it.
    await db.database
      .update(imFeedbackTargets)
      .set({ sendStartedAt: new Date(clock.getTime() - 86_400_000) })
      .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    expect(await h.store.reserveOfflineNotice(secondTarget)).toEqual(clock);

    // Later input in the same outage still gets no second notice, whenever it was received.
    await h.park(h.frame.deliveryId, 61_000);
    expect(await h.store.reserveOfflineNotice(await h.target())).toBeUndefined();
  });

  it("stays silent for a connected Computer, a Cloud Computer and a suspended Agent", async () => {
    const h = await queued();
    await setComputer(h, { lastSeenAt: new Date(clock.getTime() - 10_000), currentInstanceId: randomUUID() });
    expect(await h.store.reserveOfflineNotice(await h.target())).toBeUndefined();

    await offlineSince(h, 300_000);
    await setComputer(h, { kind: "cloud" });
    expect(await h.store.reserveOfflineNotice(await h.target())).toBeUndefined();

    await setComputer(h, { kind: "local" });
    await db.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, h.frame.agentId));
    expect(await h.store.reserveOfflineNotice(await h.target())).toBeUndefined();
  });

  it("treats a Computer that stopped heartbeating as offline at the presence timeout", async () => {
    const h = await queued();
    const live = randomUUID();
    await setComputer(h, { lastSeenAt: new Date(clock.getTime() - 89_000), currentInstanceId: live });
    expect(await h.store.reserveOfflineNotice(await h.target())).toBeUndefined();
    await setComputer(h, { lastSeenAt: new Date(clock.getTime() - 91_000), currentInstanceId: live });
    expect(await h.store.reserveOfflineNotice(await h.target())).toEqual(clock);
  });

  it("posts through the worker, retries only a send known not to have applied, and keeps the failure message", async () => {
    const h = await queued();
    await offlineSince(h, 300_000);
    const due = () =>
      db.database
        .update(imFeedbackTargets)
        .set({ nextAttemptAt: new Date(clock.getTime() - 1_000), claimId: null, claimExpiresAt: null })
        .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    h.transport.postOfflineNotice.mockRejectedValueOnce(new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true));
    await due();
    await h.worker.runOnce();
    expect((await h.target()).sendStartedAt).toBeNull();
    h.transport.postOfflineNotice.mockRejectedValueOnce(new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false));
    await due();
    await h.worker.runOnce();
    expect((await h.target()).sendStartedAt).toEqual(clock);
    await due();
    await h.worker.runOnce();
    expect(h.transport.postOfflineNotice).toHaveBeenCalledTimes(2);
    expect((await h.target()).cardState).toBe("none");
    expect(h.transport.post).not.toHaveBeenCalled();
  });
});

describe("durable IM feedback", () => {
  it("creates plain text targets unless the rollback flag is set", async () => {
    const h = await fixture();
    expect((await h.target()).messageFormat).toBe("text_v1");
  });

  it("uses a card for a workspace failure because it needs buttons", async () => {
    const h = await workspaceFixture();
    expect((await h.target()).messageFormat).toBe("interactive_v1");
  });

  it("does not change the format of a message already sent", async () => {
    const sent = await fixture();
    await db.database
      .update(imFeedbackTargets)
      .set({ cardState: "sent", cardMessageId: "text-message" })
      .where(eq(imFeedbackTargets.deliveryId, sent.frame.deliveryId));
    await sent.finish("failed", "completed", "workspace_failed");
    expect(await sent.target()).toMatchObject({ state: "workspace_blocked", messageFormat: "text_v1" });
  });

  it("keeps an ordinary failure in plain text and leaves code to the details page", async () => {
    const h = await fixture();
    await h.finish();
    const target = await h.target();
    expect(target.messageFormat).toBe("text_v1");
    const text = renderFeedbackText(target, "https://example.test");
    expect(text).not.toContain("provider_failed");
    expect(text.split("\n\n")).toHaveLength(3);
  });

  it("reads the language of the input the target was created for", async () => {
    const h = await fixture();
    expect(await h.store.messageLanguage((await h.target()).messageId)).toBe("en");
    expect(await h.store.messageLanguage(randomUUID())).toBe("en");
  });

  it("freezes the message format at target creation across rollout flag changes", async () => {
    vi.stubEnv("OPENTAG_IM_FEEDBACK_TEXT_ENABLED", "true");
    const h = await fixture();
    expect((await h.target()).messageFormat).toBe("text_v1");
    vi.stubEnv("OPENTAG_IM_FEEDBACK_TEXT_ENABLED", "false");
    await db.database.transaction((tx) => createImFeedbackTarget(tx, h.frame.deliveryId, clock));
    expect((await h.target()).messageFormat).toBe("text_v1");
    const old = await h.delivery();
    await db.database.transaction((tx) => startImFeedback(tx, old.frame.deliveryId, clock));
    const [legacy] = await db.database
      .select()
      .from(imFeedbackTargets)
      .where(eq(imFeedbackTargets.deliveryId, old.frame.deliveryId));
    expect(legacy?.messageFormat).toBe("interactive_v1");
  });

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
  it("repairs a cancelled task after an in-flight working reaction without creating a failure card", async () => {
    const h = await fixture();
    h.transport.reaction.mockImplementationOnce(async () => {
      await h.finish("cancelled", "may_have_occurred");
    });
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({
      state: "completed",
      appliedReaction: "none",
      cardState: "none",
      claimId: null,
    });
    expect(h.transport.reaction.mock.calls.map((args) => args[1])).toEqual(["working", "none"]);
    expect(h.transport.post).not.toHaveBeenCalled();
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
    expect(card.slack.text).toContain("may already have run");
    expect(card.feishu).toContain("may already have run");
    expect(card.slack.text).not.toContain("no operations were run");
    expect(card.feishu).not.toContain("no operations were run");
    expect(card.slack.text).not.toContain("provider_failed");
    expect(card.feishu).not.toContain("provider_failed");
    expect(JSON.stringify(card.slack.blocks)).not.toContain("provider_failed");
    expect(feedbackCardContent({ ...t, errorCode: "<@everyone> private raw details" }).title).toBe(
      "The execution environment had a problem, so the task didn't finish.",
    );
    expect(renderFeedbackCard({ ...t, effects: "not_started" }, "https://example.test").slack.text).toContain(
      "no operations were run",
    );
  });
});

describe("safe feedback actions", () => {
  it("refuses new task retries without changing the original immutable report", async () => {
    const h = await fixture();
    const report = await h.finish("failed", "not_started");
    const service = new ImFeedbackActionsService({ database: db.database, secret: "test-secret", now: () => clock });
    const before = await h.target();
    expect((await service.getForAccount(h.accountId, before.id)).actions).toEqual([]);
    await expect(
      service.submitForAccount(h.accountId, before.id, {
        kind: "retry_task",
        revision: before.revision,
        confirmation: "retired-confirmation",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const rows = await db.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.messageId, before.messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.turnReport).toEqual(report);
    expect(await db.database.select().from(imFeedbackActions)).toEqual([]);
  });
  it("projects the highest retry ordinal even when creation clocks coincide", async () => {
    const h = await fixture();
    await h.finish("failed", "not_started");
    const t = await h.target();
    const [original] = await db.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, h.frame.deliveryId));
    if (!original) throw new Error("Missing original delivery");
    const [admitted] = await db.database
      .insert(imMessageDeliveries)
      .values({
        messageId: t.messageId,
        sessionId: t.sessionId,
        attention: "direct",
        placementGeneration: t.placementGeneration,
        attemptOrdinal: 1,
        retryOfDeliveryId: original.id,
        expiresAt: original.expiresAt,
      })
      .returning({ id: imMessageDeliveries.id });
    if (!admitted) throw new Error("Missing previously admitted retry");
    await db.database.transaction((tx) => createImFeedbackTarget(tx, admitted.id, clock));
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
    const h = await workspaceFixture();
    const t = await h.target();
    const service = h.service;
    await expect(service.getForAccount(randomUUID(), t.id)).rejects.toMatchObject({ statusCode: 404 });
    const view = await service.getForAccount(h.accountId, t.id);
    const action = view.actions[0];
    if (!action) throw new Error("Missing action");
    await expect(
      service.submitForAccount(h.accountId, t.id, {
        kind: "save_release",
        revision: t.revision,
        confirmation: "forged",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    clock = new Date(clock.getTime() + 6 * 60_000);
    await expect(
      service.submitForAccount(h.accountId, t.id, {
        kind: "save_release",
        revision: t.revision,
        confirmation: action.confirmation,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("refuses an edited source message even with a previously valid confirmation", async () => {
    const h = await workspaceFixture();
    const t = await h.target();
    const service = h.service;
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
      service.submitForAccount(h.accountId, t.id, {
        kind: "save_release",
        revision: t.revision,
        confirmation: a.confirmation,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("rejects retired native Retry buttons even for the original sender", async () => {
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
    expect(await service.submitNativeRetry(input)).toBe("unavailable");
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
    const input = { kind: "save_release" as const, revision: view.revision, confirmation: a.confirmation };
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

describe("feedback review regressions", () => {
  it.each([undefined, false])(
    "rejects discard without a permanent-loss acknowledgement (%s) before admission",
    async (ack) => {
      const h = await workspaceFixture();
      const view = await h.service.getForAccount(h.accountId, h.t.id);
      const action = view.actions.find((a) => a.kind === "discard");
      if (!action) throw new Error("Missing discard");
      await expect(
        h.service.submitForAccount(h.accountId, h.t.id, {
          kind: "discard",
          revision: view.revision,
          confirmation: action.confirmation,
          ...(ack !== undefined ? { permanentLossAcknowledged: ack } : {}),
        } as never),
      ).rejects.toMatchObject({ statusCode: 409 });
      await h.service.close();
      expect(h.runner.stopForAccount).not.toHaveBeenCalled();
      expect(await db.database.select().from(imFeedbackActions)).toHaveLength(0);
    },
  );
  it.each(["save_release", "discard"] as const)(
    "rejects %s after placement changes, even with a valid current-environment token",
    async (kind) => {
      const h = await workspaceFixture();
      const view = await h.service.getForAccount(h.accountId, h.t.id);
      const action = view.actions.find((a) => a.kind === kind);
      if (!action) throw new Error("Missing operation");
      await db.database
        .update(sessionPlacements)
        .set({ generation: 2 })
        .where(eq(sessionPlacements.sessionId, h.t.sessionId));
      expect((await h.service.getForAccount(h.accountId, h.t.id)).actions).toEqual([]);
      await expect(
        h.service.submitForAccount(h.accountId, h.t.id, {
          ...(kind === "discard" ? ({ kind, permanentLossAcknowledged: true } as const) : { kind }),
          revision: view.revision,
          confirmation: action.confirmation,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(h.runner.stopForAccount).not.toHaveBeenCalled();
      expect(await db.database.select().from(imFeedbackActions)).toHaveLength(0);
    },
  );
  it("never publishes a fresh completion card when a send is known not applied after concurrent completion", async () => {
    const h = await fixture();
    await db.database
      .update(imFeedbackTargets)
      .set({ state: "failed", errorCode: "input_expired", desiredReaction: "warning", cardState: "pending" })
      .where(eq(imFeedbackTargets.deliveryId, h.frame.deliveryId));
    h.transport.post.mockImplementationOnce(async () => {
      expect((await h.target()).cardState).toBe("sending");
      await h.finish("completed", "completed");
      throw new FeedbackProviderError("TRANSIENT_NOT_APPLIED", true);
    });
    await h.worker.runOnce();
    clock = new Date(clock.getTime() + 301_000);
    await h.worker.runOnce();
    expect(await h.target()).toMatchObject({
      state: "completed",
      cardState: "none",
      cardMessageId: null,
      appliedReaction: "none",
    });
    expect(h.transport.post).toHaveBeenCalledOnce();
  });
  it("disables root-only retry of a frozen initial batch in API, native actions and card", async () => {
    const h = await fixture();
    const child = await h.delivery();
    await db.database
      .update(imMessageDeliveries)
      .set({
        state: "steered",
        reason: "batch_initial",
        steerTargetDeliveryId: h.frame.deliveryId,
        steeredAt: clock,
        turnId: null,
        reportOwnerInstanceId: null,
        acceptedAt: null,
      })
      .where(eq(imMessageDeliveries.id, child.frame.deliveryId));
    await db.database.transaction((tx) => startImFeedback(tx, child.frame.deliveryId, clock));
    await h.finish("failed", "not_started", "provider_start_failed");
    const target = await h.target();
    const service = new ImFeedbackActionsService({ database: db.database, secret: "secret", now: () => clock });
    const view = await service.getForAccount(h.accountId, target.id);
    expect(view).toMatchObject({ actions: [], retryBlockedReason: "batch_initial" });
    await h.worker.runOnce();
    const posted = h.transport.post.mock.calls[0]?.[0];
    if (!posted) throw new Error("Missing card");
    const card = renderFeedbackCard(posted, "https://example.test");
    expect(card.slack.text).toContain("frozen batch cannot be retried");
    expect(JSON.stringify(card.slack.blocks)).not.toContain('"opentag_feedback_retry"');
    expect(
      await service.submitNativeRetry({
        feedbackId: target.id,
        revision: target.revision,
        provider: "slack",
        userId: target.senderExternalId,
        generation: target.bindingGeneration,
        channelId: target.channelId,
        messageId: "card-1",
        installationId: target.installationId ?? undefined,
      }),
    ).toBe("unavailable");
    expect(await db.database.select().from(imMessageDeliveries)).toHaveLength(2);
    expect(await db.database.select().from(imFeedbackActions)).toHaveLength(0);
  });
  it("stops unknown-send readback after the bounded deadline and preserves the unresolved diagnostic across restart", async () => {
    const h = await fixture();
    await h.finish();
    h.transport.post.mockRejectedValueOnce(new Error("ambiguous"));
    await h.worker.runOnce();
    clock = new Date((await h.target()).actionsExpireAt.getTime() + 1);
    await h.worker.runOnce();
    const restarted = new ImFeedbackWorker({
      store: new ImFeedbackStore(db.database, () => clock),
      transport: h.transport,
      logger: { warn: h.warn },
      now: () => clock,
    });
    clock = new Date(clock.getTime() + 91 * 86400_000);
    await h.store.retain();
    await restarted.runOnce();
    expect(await h.target()).toMatchObject({
      cardState: "send_unknown",
      lastErrorCode: "IM_FEEDBACK_SEND_UNKNOWN_EXPIRED",
    });
    expect(h.transport.find).not.toHaveBeenCalled();
    expect(h.transport.post).toHaveBeenCalledOnce();
  });
});

it("preserves workspace recovery and paused-Session guidance for a frozen batch root on both providers", async () => {
  const h = await workspaceFixture();
  const card = renderFeedbackCard({ ...(await h.target()), batchRetryBlocked: true }, "https://example.test");
  for (const rendered of [JSON.stringify(card.slack), card.feishu]) {
    expect(rendered).toContain("Retry save");
    expect(rendered).toContain("Discard unsaved changes");
    expect(rendered).toContain("Work in this Session is paused; new input for this Session remains queued.");
    expect(rendered).not.toContain("frozen batch cannot be retried");
    expect(rendered).not.toContain("opentag_feedback_retry");
  }
});

it.each(["reaction", "post"] as const)(
  "stops the worker pass on %s cooldown-storage failure without inventing an unknown send",
  async (operation) => {
    const h = await fixture();
    await h.finish();
    const claim = vi.spyOn(h.store, "claim");
    h.transport[operation].mockRejectedValueOnce(new FeedbackCooldownStorageError(30_000));
    await h.worker.runOnce();
    expect((await Promise.all(claim.mock.results.map((result) => result.value))).filter(Boolean)).toHaveLength(1);
    expect(await h.target()).toMatchObject({
      cardState: "pending",
      cardMessageId: null,
      lastErrorCode: "IM_FEEDBACK_COOLDOWN_UNAVAILABLE",
    });
    if (operation === "reaction") expect(h.transport.post).not.toHaveBeenCalled();
  },
);
