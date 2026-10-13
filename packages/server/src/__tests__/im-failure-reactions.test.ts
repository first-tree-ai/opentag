import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { imMessageDeliveries, imMessages, sessions } from "../db/schema/index.js";
import { runImDeliveryExpiry } from "../runtime/im-delivery-janitor.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { createFailureReactionFixture } from "./support/failure-reaction-fixture.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let db: UnitDatabase;
let clock = new Date();
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
const fixture = () => createFailureReactionFixture(db.database, () => clock);
describe("best-effort message failure reactions", () => {
  it("adds a failure marker once and removes it when a later revision of that message succeeds", async () => {
    const h = await fixture(),
      failed = await h.delivery();
    await h.report(failed.frame, "failed");
    await h.reactions.sync(failed.frame.deliveryId);
    expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true]);
    clock = new Date(clock.getTime() + 1_000);
    const retry = await h.delivery();
    await db.database
      .update(imMessages)
      .set({ externalMessageId: failed.request.imMessageId, providerRevisionKey: "2", operation: "edited" })
      .where(eq(imMessages.id, retry.request.imMessageId));
    await h.report(retry.frame, "completed");
    await h.reactions.sync(failed.frame.deliveryId);
    expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true, false]);
  });

  it("does not clear a failed message when a different message succeeds", async () => {
    const h = await fixture(),
      failed = await h.delivery(),
      other = await h.delivery();
    await h.report(failed.frame, "failed");
    await h.report(other.frame, "completed");
    await h.reactions.sync(failed.frame.deliveryId);
    expect(h.setFailureReaction).toHaveBeenCalledExactlyOnceWith({
      channelId: "C1",
      externalMessageId: failed.request.imMessageId,
      failed: true,
    });
  });

  it("clears an expired message after the same delivery is recovered and completed", async () => {
    const h = await fixture(),
      delivery = await h.delivery();
    const [original] = await db.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, delivery.frame.deliveryId));
    if (!original) throw new Error("missing delivery");
    await db.database
      .update(imMessageDeliveries)
      .set({
        state: "expired",
        reason: "ttl",
        inputHash: null,
        turnId: null,
        reportOwnerInstanceId: null,
        acceptedAt: null,
      })
      .where(eq(imMessageDeliveries.id, original.id));
    await h.reactions.sync(delivery.frame.deliveryId);
    await db.database
      .update(imMessageDeliveries)
      .set({ ...original, reason: null })
      .where(eq(imMessageDeliveries.id, original.id));
    await h.reactions.sync(delivery.frame.deliveryId);
    expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true]);
    await h.report(delivery.frame, "completed");
    await h.reactions.sync(delivery.frame.deliveryId);
    expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true, false]);
  });

  it("clears a recovered message that completes through a steered root Turn", async () => {
    const h = await fixture(),
      child = await h.delivery(),
      root = await h.delivery();
    await db.database
      .update(imMessageDeliveries)
      .set({
        state: "expired",
        reason: "ttl",
        inputHash: null,
        turnId: null,
        reportOwnerInstanceId: null,
        acceptedAt: null,
      })
      .where(eq(imMessageDeliveries.id, child.frame.deliveryId));
    await h.reactions.sync(child.frame.deliveryId);
    await db.database
      .update(imMessageDeliveries)
      .set({
        state: "steered",
        reason: null,
        inputHash: "a".repeat(64),
        steerTargetDeliveryId: root.frame.deliveryId,
        steeredAt: clock,
      })
      .where(eq(imMessageDeliveries.id, child.frame.deliveryId));
    await h.report(root.frame, "completed");
    await h.reactions.sync(root.frame.deliveryId);
    expect(
      h.setFailureReaction.mock.calls
        .filter(([input]) => input.externalMessageId === child.request.imMessageId)
        .map(([input]) => input.failed),
    ).toEqual([true, false]);
  });

  it.each(["completed", "cancelled"] as const)("does not mark a %s Turn as failed", async (outcome) => {
    const h = await fixture(),
      delivery = await h.delivery();
    await h.report(delivery.frame, outcome);
    await h.reactions.sync(delivery.frame.deliveryId);
    if (outcome === "completed")
      expect(h.setFailureReaction).toHaveBeenCalledWith(expect.objectContaining({ failed: false }));
    else expect(h.setFailureReaction).not.toHaveBeenCalled();
  });

  it("ignores pending transient failures and cancelled queue entries", async () => {
    const h = await fixture(),
      delivery = await h.delivery();
    await db.database
      .update(imMessageDeliveries)
      .set({
        state: "pending",
        inputHash: null,
        turnId: null,
        reportOwnerInstanceId: null,
        acceptedAt: null,
        lastErrorCode: "IM_DELIVERY_RUNTIME_UNAVAILABLE",
      })
      .where(eq(imMessageDeliveries.id, delivery.frame.deliveryId));
    await h.reactions.sync(delivery.frame.deliveryId);
    await db.database
      .update(imMessageDeliveries)
      .set({ state: "expired", reason: "cancelled" })
      .where(eq(imMessageDeliveries.id, delivery.frame.deliveryId));
    await h.reactions.sync(delivery.frame.deliveryId);
    expect(h.setFailureReaction).not.toHaveBeenCalled();
  });

  it.each(["expired", "terminal_rejected"] as const)(
    "marks %s delivery failures before the agent runs",
    async (state) => {
      const h = await fixture(),
        delivery = await h.delivery();
      await db.database
        .update(imMessageDeliveries)
        .set({ state, inputHash: null, turnId: null, reportOwnerInstanceId: null, acceptedAt: null, reason: "ttl" })
        .where(eq(imMessageDeliveries.id, delivery.frame.deliveryId));
      await h.reactions.sync(delivery.frame.deliveryId);
      expect(h.setFailureReaction).toHaveBeenCalledOnce();
    },
  );

  it("ignores observer and ambient copies", async () => {
    const h = await fixture(),
      observer = await h.delivery("1.1", "observer"),
      ambient = await h.delivery();
    await db.database
      .update(imMessageDeliveries)
      .set({ attention: "ambient" })
      .where(eq(imMessageDeliveries.id, ambient.frame.deliveryId));
    // Real observer copies have ambient attention too. Also exercise owner detection after
    // recordTurn has removed the dispatch payload containing the observer flag.
    const threadKey = "1.1";
    await db.database.update(imMessages).set({ threadKey }).where(eq(imMessages.id, observer.request.imMessageId));
    const [session] = await db.database
      .insert(sessions)
      .values({ imBindingId: h.binding.id, channelId: "C1", conversationKind: "channel", kind: "thread", threadKey })
      .returning();
    if (!session) throw new Error("missing thread");
    await db.database.insert(imMessageDeliveries).values({
      messageId: observer.request.imMessageId,
      sessionId: session.id,
      attention: "direct",
      placementGeneration: 1,
      expiresAt: clock,
    });
    await h.report(observer.frame, "failed");
    await h.report(ambient.frame, "failed");
    await h.reactions.sync(observer.frame.deliveryId);
    await h.reactions.sync(ambient.frame.deliveryId);
    expect(h.setFailureReaction).not.toHaveBeenCalled();
  });

  it("logs reaction failures without failing processing and clears on a later success", async () => {
    const h = await fixture(),
      delivery = await h.delivery();
    await h.report(delivery.frame, "failed");
    h.setFailureReaction.mockRejectedValueOnce(new Error("unit-secret body"));
    await expect(h.reactions.sync(delivery.frame.deliveryId)).resolves.toBeUndefined();
    await h.report(delivery.frame, "completed");
    await h.reactions.sync(delivery.frame.deliveryId);
    expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true, false]);
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("unit-secret");
  });

  it("notifies the reaction updater after a valid Turn report is recorded", async () => {
    const h = await fixture(),
      { frame } = await h.delivery(),
      onDeliverySettled = vi.fn();
    const { sequence: _sequence, phase: _phase, ...fields } = frame;
    const report: TurnReportRequest = {
      ...fields,
      type: "turn:report",
      outcome: "completed",
      executionEffects: "completed",
      traceSummary: { lastSequence: 1, droppedEvents: 0 },
      resultHash: "0".repeat(64),
    };
    report.resultHash = computeTurnResultHash(report);
    const custody = new PostgresRuntimeCustodyStore(db.database, { now: () => clock, onDeliverySettled });
    expect(await custody.recordTurn(report, h.context)).toBe("recorded");
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(frame.deliveryId);
    onDeliverySettled.mockClear();
    expect(await custody.recordTurn({ ...report, placementGeneration: 2 }, h.context)).toBe("stale_generation");
    expect(onDeliverySettled).not.toHaveBeenCalled();
  });

  it("notifies the existing expiry path only for messages actually expired", async () => {
    const h = await fixture(),
      delivery = await h.delivery(),
      onDeliverySettled = vi.fn();
    await db.database
      .update(imMessageDeliveries)
      .set({
        state: "pending",
        inputHash: null,
        turnId: null,
        reportOwnerInstanceId: null,
        acceptedAt: null,
        expiresAt: clock,
      })
      .where(eq(imMessageDeliveries.id, delivery.frame.deliveryId));
    await runImDeliveryExpiry(
      db.database,
      {
        clock: () => clock,
        expiryBatchSize: 10,
        retentionBatchSize: 10,
        imMessagesRetentionMs: 1,
        imMessageDeliveriesRetentionMs: 1,
        slackWebhookReceiptsRetentionMs: 1,
        feishuInboundReceiptsRetentionMs: 1,
      },
      onDeliverySettled,
    );
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(delivery.frame.deliveryId);
  });
});
