import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { imBindings, imFailureReactions, imMessageDeliveries, imMessages, sessions } from "../db/schema/index.js";
import { ImFailureReactionStore } from "../services/im/im-failure-reaction-store.js";
import { ImFailureReactionWorker } from "../services/im/im-failure-reaction-worker.js";
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
async function target() {
  const [row] = await db.database.select().from(imFailureReactions);
  if (!row) throw new Error("missing reaction target");
  return row;
}

describe("durable message failure reactions", () => {
  it("adds a failure marker once and removes it when a later revision of that message succeeds", async () => {
    const h = await fixture(),
      failed = await h.delivery();
    await h.report(failed.frame, "failed");
    await h.worker.runOnce();
    await h.worker.runOnce();
    expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true]);
    clock = new Date(clock.getTime() + 1_000);
    const retry = await h.delivery();
    await db.database
      .update(imMessages)
      .set({ externalMessageId: failed.request.imMessageId, providerRevisionKey: "2", operation: "edited" })
      .where(eq(imMessages.id, retry.request.imMessageId));
    await h.worker.runOnce();
    expect((await target()).desired).toBe(true);
    await h.report(retry.frame, "completed");
    await h.worker.runOnce();
    expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true, false]);
    expect(await target()).toMatchObject({ desired: false, applied: false });
  });

  it("does not clear a failed message when a different message succeeds", async () => {
    const h = await fixture(),
      failed = await h.delivery(),
      other = await h.delivery();
    await h.report(failed.frame, "failed");
    await h.report(other.frame, "completed");
    await h.worker.runOnce();
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
    await h.worker.runOnce();
    await db.database
      .update(imMessageDeliveries)
      .set({ ...original, reason: null })
      .where(eq(imMessageDeliveries.id, original.id));
    await h.worker.runOnce();
    expect((await target()).desired).toBe(true);
    await h.report(delivery.frame, "completed");
    await h.worker.runOnce();
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
    await h.worker.runOnce();
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
    await h.worker.runOnce();
    expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true, false]);
  });

  it.each(["completed", "cancelled"] as const)("does not mark a %s Turn as failed", async (outcome) => {
    const h = await fixture(),
      delivery = await h.delivery();
    await h.report(delivery.frame, outcome);
    await h.worker.runOnce();
    expect(h.setFailureReaction).not.toHaveBeenCalled();
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
    await h.worker.runOnce();
    await db.database
      .update(imMessageDeliveries)
      .set({ state: "expired", reason: "cancelled" })
      .where(eq(imMessageDeliveries.id, delivery.frame.deliveryId));
    await h.worker.runOnce();
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
      await h.worker.runOnce();
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
    await h.worker.runOnce();
    expect(h.setFailureReaction).not.toHaveBeenCalled();
  });

  it("retries lost removal responses after a worker restart without leaking diagnostics", async () => {
    const h = await fixture(),
      delivery = await h.delivery();
    await h.report(delivery.frame, "failed");
    await h.worker.runOnce();
    await h.report(delivery.frame, "completed");
    h.setFailureReaction.mockRejectedValueOnce(new Error("unit-secret body"));
    await h.worker.runOnce();
    expect((await target()).applied).toBeNull();
    clock = new Date(clock.getTime() + 2_001);
    const restarted = new ImFailureReactionWorker({
      store: new ImFailureReactionStore(db.database, () => clock),
      resolveAdapter: async () => h.adapter,
      logger: { warn: h.warn },
    });
    await restarted.runOnce();
    expect((await target()).applied).toBe(false);
    expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true, false, false]);
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("unit-secret");
  });

  it("reconciles a success that arrives while an add is in flight", async () => {
    const h = await fixture(),
      delivery = await h.delivery();
    await h.report(delivery.frame, "failed");
    await h.store.reconcile();
    const claim = await h.store.claim();
    if (!claim) throw new Error("missing claim");
    await h.report(delivery.frame, "completed");
    await h.store.reconcile();
    expect(await h.store.ownsClaim(claim)).toBe(false);
    await h.store.settle(claim);
    expect(await target()).toMatchObject({ desired: false, applied: null });
    await h.worker.runOnce();
    expect(h.setFailureReaction).toHaveBeenCalledExactlyOnceWith({
      channelId: "C1",
      externalMessageId: delivery.request.imMessageId,
      failed: false,
    });
  });

  it("reclaims abandoned provider writes after their lease expires", async () => {
    const h = await fixture(),
      delivery = await h.delivery();
    await h.report(delivery.frame, "failed");
    await h.store.reconcile();
    const first = await h.store.claim();
    expect(first).toBeDefined();
    expect(await h.store.claim()).toBeUndefined();
    clock = new Date(clock.getTime() + 30_001);
    const next = await h.store.claim();
    expect(next?.claimId).not.toBe(first?.claimId);
    if (first) await h.store.settle(first);
    expect((await target()).claimId).toBe(next?.claimId);
  });

  it("revalidates credentials and ignores disabled bindings", async () => {
    const h = await fixture(),
      delivery = await h.delivery();
    await h.report(delivery.frame, "failed");
    await h.store.reconcile();
    const claim = await h.store.claim();
    if (!claim) throw new Error("missing claim");
    await db.database.update(imBindings).set({ credentialGeneration: 2 }).where(eq(imBindings.id, h.binding.id));
    expect(await h.store.ownsClaim(claim)).toBe(false);
    await h.store.settle(claim, 0);
    await h.worker.runOnce();
    expect((await target()).credentialGeneration).toBe(2);
    await db.database
      .update(imBindings)
      .set({
        status: "disabled",
        disabledAt: clock,
        credentialSchemaVersion: null,
        encryptedCredential: null,
        grantedCapabilities: [],
        slackInstallationId: null,
      })
      .where(eq(imBindings.id, h.binding.id));
    await db.database.update(imFailureReactions).set({ applied: null, claimId: randomUUID(), claimExpiresAt: clock });
    expect(await h.store.claim()).toBeUndefined();
  });
});
