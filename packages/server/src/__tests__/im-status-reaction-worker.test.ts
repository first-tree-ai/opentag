import { randomUUID } from "node:crypto";
import { computeDirectInputHash } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { imMessageDeliveries, imMessages } from "../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { ImStatusReactionWorker } from "../services/im/im-status-reaction-worker.js";
import { createStatusReactionFixture, statusReactionReport } from "./support/status-reaction-fixture.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

describe("IM status reactions", () => {
  let unit: UnitDatabase;
  beforeAll(async () => {
    unit = await createUnitDatabase();
  }, 60_000);
  afterAll(async () => {
    await unit?.close();
  });
  beforeEach(async () => {
    await unit.reset();
  });

  async function harness() {
    const fixture = await createStatusReactionFixture(unit.database);
    let now = fixture.now;
    const wake = vi.fn();
    const custody = new PostgresRuntimeCustodyStore(unit.database, { now: () => now, onStatusReactionChanged: wake });
    const setStatusReaction = vi.fn().mockResolvedValue(undefined);
    const resolveAdapter = vi.fn().mockResolvedValue({ setStatusReaction });
    const logger = { warn: vi.fn() };
    const worker = () =>
      new ImStatusReactionWorker({ database: unit.database, resolveAdapter, logger, now: () => now });
    const read = async () =>
      (await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, fixture.deliveryId)))[0];
    const accept = async (request = fixture.request) => {
      const hash = computeDirectInputHash(request);
      await custody.beginDeliveryDispatch(request, hash, fixture.context);
      return custody.acceptDelivery(request, hash, "turn-status", fixture.context);
    };
    return {
      fixture,
      custody,
      accept,
      read,
      worker,
      setStatusReaction,
      resolveAdapter,
      logger,
      wake,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  it("does not acknowledge queued messages, persists working at acceptance, and deduplicates replays", async () => {
    const h = await harness();
    await h.worker().runOnce();
    expect(h.setStatusReaction).not.toHaveBeenCalled();
    await expect(h.accept()).resolves.toBe("accepted");
    expect(h.wake).toHaveBeenCalledOnce();
    expect(await h.read()).toMatchObject({ statusReactionDesired: "working", statusReactionApplied: null });
    const restarted = h.worker();
    await restarted.runOnce();
    expect(h.setStatusReaction).toHaveBeenCalledWith({
      channelId: "chat",
      messageExternalId: "om_message",
      status: "working",
    });
    await h.accept();
    await restarted.runOnce();
    expect(h.setStatusReaction).toHaveBeenCalledOnce();
    expect(await h.read()).toMatchObject({ statusReactionApplied: "working", statusReactionRetryAt: null });
  });

  it.each(["completed", "failed", "unknown", "cancelled"] as const)(
    "reconciles %s terminal state after restart",
    async (outcome) => {
      const h = await harness();
      await h.accept();
      await h.worker().runOnce();
      await expect(h.custody.recordTurn(statusReactionReport(h.fixture, outcome), h.fixture.context)).resolves.toBe(
        "recorded",
      );
      const expected = outcome === "unknown" ? "failed" : outcome;
      await h.worker().runOnce();
      expect(h.setStatusReaction).toHaveBeenLastCalledWith(expect.objectContaining({ status: expected }));
      await h.custody.recordTurn(statusReactionReport(h.fixture, outcome), h.fixture.context);
      await h.worker().runOnce();
      expect(h.setStatusReaction).toHaveBeenCalledTimes(2);
      expect(await h.read()).toMatchObject({ statusReactionApplied: expected, statusReactionRetryAt: null });
    },
  );

  it("backs off provider failures durably without changing execution and resets retries for completion", async () => {
    const h = await harness();
    await h.accept();
    h.setStatusReaction.mockRejectedValue(new Error("token-value-must-not-be-logged"));
    await h.worker().runOnce();
    expect(await h.read()).toMatchObject({
      state: "accepted",
      statusReactionApplied: null,
      statusReactionAttempts: 1,
      statusReactionRetryAt: new Date(h.fixture.now.getTime() + 1_000),
    });
    await h.worker().runOnce();
    expect(h.setStatusReaction).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("token-value");
    h.advance(1_000);
    await h.worker().runOnce();
    expect(await h.read()).toMatchObject({ statusReactionAttempts: 2 });
    await h.custody.recordTurn(statusReactionReport(h.fixture), h.fixture.context);
    h.setStatusReaction.mockResolvedValue(undefined);
    await h.worker().runOnce();
    expect(await h.read()).toMatchObject({ statusReactionApplied: "completed", statusReactionAttempts: 0 });
  });

  it("bounds attempts while retaining the desired status for diagnosis", async () => {
    const h = await harness();
    await h.accept();
    h.setStatusReaction.mockRejectedValue(new Error("unavailable"));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await h.worker().runOnce();
      h.advance(60_000);
    }
    await h.worker().runOnce();
    expect(h.setStatusReaction).toHaveBeenCalledTimes(8);
    expect(await h.read()).toMatchObject({
      statusReactionDesired: "working",
      statusReactionApplied: null,
      statusReactionAttempts: 8,
      statusReactionRetryAt: null,
    });
  });

  it("skips observer deliveries and bot-authored messages", async () => {
    const h = await harness();
    await h.accept({ ...h.fixture.request, replyRole: "observer" });
    await h.custody.recordTurn(statusReactionReport(h.fixture), h.fixture.context);
    await h.worker().runOnce();
    expect(h.setStatusReaction).not.toHaveBeenCalled();
    expect(await h.read()).toMatchObject({ statusReactionDesired: null });
    await unit.reset();
    const bot = await harness();
    await unit.database.update(imMessages).set({ authorKind: "bot" }).where(eq(imMessages.id, bot.fixture.messageId));
    await bot.accept();
    await bot.worker().runOnce();
    expect(bot.setStatusReaction).not.toHaveBeenCalled();
  });

  it("does not let an older revision's failed reaction overwrite a new turn", async () => {
    const h = await harness();
    await h.accept();
    await h.custody.recordTurn(statusReactionReport(h.fixture, "failed"), h.fixture.context);
    const [message] = await unit.database.select().from(imMessages).where(eq(imMessages.id, h.fixture.messageId));
    const original = await h.read();
    if (!message || !original) throw new Error("Missing fixture");
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    await unit.database.insert(imMessages).values({ ...message, id: messageId, providerRevisionKey: "2" });
    await unit.database.insert(imMessageDeliveries).values({
      ...original,
      id: deliveryId,
      messageId,
      turnId: "new-turn",
      dispatchRequestId: null,
      dispatchInputHash: null,
      dispatchPayload: null,
      reportedAt: null,
      turnReport: null,
      resultHash: null,
      acceptedAt: new Date(h.fixture.now.getTime() + 1),
      statusReactionDesired: "working",
      statusReactionApplied: null,
    });
    await h.worker().runOnce();
    expect(h.setStatusReaction).toHaveBeenCalledExactlyOnceWith({
      channelId: "chat",
      messageExternalId: "om_message",
      status: "working",
    });
  });
});
