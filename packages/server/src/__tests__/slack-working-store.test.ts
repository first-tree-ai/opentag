import { SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  imMessageDeliveries,
  sessionPlacements,
  slackInstallations,
  slackWorkingTargets,
  slackWorkingTurns,
} from "../db/schema/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { finishSlackWorkingTurn } from "../services/im/slack-working-store.js";
import {
  SlackThreadStatusError,
  SlackWorkingWorker,
  slackWorkingCredentialResolver,
} from "../services/im/slack-working-worker.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createSlackWorkingFixture } from "./support/slack-working-fixture.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let db: UnitDatabase;
let clock = new Date();
const cipher = new ApplicationCipher(Buffer.alloc(32, 11));
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
const fixture = () => createSlackWorkingFixture(db.database, cipher, () => clock);
async function rotate(agentId: string) {
  await new ImBindingService(db.database, cipher).activateSlack(
    {
      intent: "reauthorize",
      agentId,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "unit-secret-rotated",
      signingSecret: "unit-signing",
      installedAt: clock,
    },
    "B1",
  );
}
async function target() {
  const [row] = await db.database.select().from(slackWorkingTargets);
  if (!row) throw new Error("missing target");
  return row;
}

describe("Slack working SQL state machine", () => {
  it("projects running, waiting, resumed and terminal execution without replay extending its lease", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    expect((await h.store.record(frame, h.context)).status).toBe("recorded");
    await h.worker.runOnce();
    const [before] = await db.database.select().from(slackWorkingTurns);
    clock = new Date(clock.getTime() + 30_000);
    expect((await h.store.record(frame, h.context)).status).toBe("already_recorded");
    const [after] = await db.database.select().from(slackWorkingTurns);
    expect(after?.leaseExpiresAt).toEqual(before?.leaseExpiresAt);
    await h.store.record({ ...frame, sequence: 2, phase: "waiting_user" }, h.context);
    await h.worker.runOnce();
    await h.store.record({ ...frame, sequence: 3 }, h.context);
    await h.worker.runOnce();
    await h.store.record({ ...frame, sequence: 4, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    expect((await h.store.record({ ...frame, sequence: 5 }, h.context)).status).toBe("already_recorded");
    expect(h.calls).toEqual(["is working", "", "is working", ""]);
    expect((await target()).nextAttemptAt.getUTCFullYear()).toBe(9999);
  });

  it("clears a lost heartbeat and recovers only on a new observation", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    clock = new Date(clock.getTime() + 91_000);
    await h.worker.runOnce();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
    await h.store.record({ ...frame, sequence: 2 }, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", "", "is working"]);
  });

  it("aggregates siblings across real credential rotation and schedules custody cleanup", async () => {
    const h = await fixture(),
      a = await h.delivery(),
      b = await h.delivery();
    await h.store.record(a.frame, h.context);
    await h.store.record(b.frame, h.context);
    await h.worker.runOnce();
    const id = (await target()).id;
    await rotate(a.frame.agentId);
    await h.store.record({ ...a.frame, sequence: 2, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", "is working"]);
    expect((await target()).id).toBe(id);
    expect((await target()).credentialGeneration).toBe(2);
    await db.database.transaction(async (tx) => {
      await finishSlackWorkingTurn(tx, b.frame.deliveryId, clock);
      await finishSlackWorkingTurn(tx, "00000000-0000-4000-8000-000000000000", clock);
    });
    await h.worker.runOnce();
    expect(h.calls.at(-1)).toBe("");
    expect(h.api.setThreadStatus.mock.calls.at(-1)?.[0].token).toBe("unit-secret-rotated");
  });

  it.each(["budget", "deadline", "default"] as const)(
    "does not extend the %s execution deadline with heartbeats",
    async (kind) => {
      const h = await fixture(),
        { frame, request } = await h.delivery();
      const duration = kind === "default" ? 30 * 60_000 : 60_000;
      if (kind === "budget") request.runtime.budget = { maxDurationMs: duration };
      else {
        delete request.runtime.budget;
        if (kind === "deadline") request.deadlineAt = new Date(clock.getTime() + duration).toISOString();
      }
      await db.database
        .update(imMessageDeliveries)
        .set({ dispatchPayload: request })
        .where(eq(imMessageDeliveries.id, frame.deliveryId));
      await h.store.record(frame, h.context);
      clock = new Date(clock.getTime() + duration + 1);
      await h.store.record({ ...frame, sequence: 2 }, h.context);
      await h.worker.runOnce();
      expect(h.calls).toEqual([""]);
    },
  );

  it("rejects stale runtime ownership, aborted activity, observers and mismatched provider identity", async () => {
    const h = await fixture(),
      { frame, request } = await h.delivery();
    expect((await h.store.record({ ...frame, placementGeneration: 2 }, h.context)).status).toBe("stale_generation");
    expect(
      (await h.store.record({ ...frame, agentId: "00000000-0000-4000-8000-000000000000" }, h.context)).status,
    ).toBe("stale_generation");
    expect((await h.store.record(frame, { ...h.context, signal: AbortSignal.abort() })).status).toBe(
      "stale_generation",
    );
    for (const payload of [
      { ...request, replyRole: "observer" as const },
      { ...request, content: { ...request.content, providerRef: { ...request.content.providerRef, teamId: "OTHER" } } },
      null,
    ]) {
      await db.database
        .update(imMessageDeliveries)
        .set({ dispatchPayload: payload })
        .where(eq(imMessageDeliveries.id, frame.deliveryId));
      expect((await h.store.record(frame, h.context)).status).toBe("stale_generation");
    }
    expect(await db.database.select().from(slackWorkingTargets)).toEqual([]);
  });

  it("clears placement-fenced work even while its lease is live", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    await db.database
      .update(sessionPlacements)
      .set({ generation: 2 })
      .where(eq(sessionPlacements.sessionId, frame.sessionId));
    clock = new Date(clock.getTime() + 46_000);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
  });

  it("fences replaced claims while preserving current-installation Retry-After", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    const first = await h.store.claim();
    if (!first) throw new Error("missing claim");
    expect(await h.store.claim()).toBeUndefined();
    expect(await h.store.ownsClaim({ ...first, claimId: null })).toBe(false);
    await h.store.settle({ ...first, claimId: null }, { working: false, delayMs: 0 });
    clock = new Date(clock.getTime() + 31_000);
    const replacement = await h.store.claim();
    if (!replacement) throw new Error("missing replacement");
    await h.store.settle(first, { working: false, failed: true, deferred: true, delayMs: 60_000, cooldownMs: 60_000 });
    expect(await h.store.ownsClaim(replacement)).toBe(false);
    expect((await target()).claimId).toBe(replacement.claimId);
    expect(await h.store.claim()).toBeUndefined();
    clock = new Date(clock.getTime() + 60_001);
    const current = await h.store.claim();
    if (!current) throw new Error("missing current claim");
    await h.store.settle(current, { working: false, failed: true, delayMs: 2_000, disabled: true });
    expect(await h.store.claim()).toBeUndefined();
    await rotate(frame.agentId);
    clock = new Date(clock.getTime() + 2_001);
    expect((await h.store.claim())?.credentialGeneration).toBe(2);
  });

  it("rejects a token resolved before real reauthorization without sending the old token", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    const resolveToken = slackWorkingCredentialResolver(db.database, cipher);
    const worker = new SlackWorkingWorker({
      store: h.store,
      api: h.api,
      token: async (claim) => {
        const token = await resolveToken(claim);
        expect(token).toBe("unit-secret");
        await rotate(frame.agentId);
        return token;
      },
    });
    await worker.runOnce();
    expect(h.api.setThreadStatus).not.toHaveBeenCalled();
    await h.store.record({ ...frame, sequence: 2 }, h.context);
    await h.worker.runOnce();
    expect(h.api.setThreadStatus).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ token: "unit-secret-rotated" }),
    );
  });

  it.each(["success", "ratelimited"])(
    "rejects an old-generation %s settlement after real reauthorization",
    async (outcome) => {
      const h = await fixture(),
        { frame } = await h.delivery();
      await h.store.record(frame, h.context);
      let afterRotation: Awaited<ReturnType<typeof target>> | undefined;
      h.api.setThreadStatus.mockImplementationOnce(async () => {
        await rotate(frame.agentId);
        afterRotation = await target();
        if (outcome === "ratelimited") throw new SlackThreadStatusError("ratelimited", 60_000);
      });
      await h.worker.runOnce();
      expect(await target()).toEqual(afterRotation);
      const [installation] = await db.database.select().from(slackInstallations);
      expect(installation?.workingStatusNotBeforeAt.getTime()).toBe(0);
      await h.store.record({ ...frame, sequence: 2 }, h.context);
      await h.worker.runOnce();
      expect(h.api.setThreadStatus.mock.calls.at(-1)?.[0].token).toBe("unit-secret-rotated");
    },
  );

  it.each(["disabled", "reauthorization_required"] as const)(
    "rejects ownership and settlement after the installation becomes %s",
    async (status) => {
      const h = await fixture(),
        { frame } = await h.delivery();
      await h.store.record(frame, h.context);
      const claim = await h.store.claim();
      if (!claim) throw new Error("missing claim");
      await db.database
        .update(slackInstallations)
        .set({ status, ...(status === "disabled" ? { encryptedCredential: null, disabledAt: clock } : {}) })
        .where(eq(slackInstallations.id, claim.installationId));
      expect(await h.store.ownsClaim(claim)).toBe(false);
      const before = await target();
      await h.store.settle(claim, { working: true, delayMs: 60_000, cooldownMs: 60_000 });
      expect(await target()).toEqual(before);
      expect((await db.database.select().from(slackInstallations))[0]?.workingStatusNotBeforeAt.getTime()).toBe(0);
      clock = new Date(clock.getTime() + 31_000);
      expect(await h.store.claim()).toBeUndefined();
    },
  );
});
