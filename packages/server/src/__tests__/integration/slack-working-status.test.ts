import { randomUUID } from "node:crypto";
import { computeTurnResultHash, SLACK_REQUIRED_BOT_SCOPES, type TurnReportRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  imMessageDeliveries,
  sessionPlacements,
  sessions,
  slackInstallations,
  slackWorkingTargets,
  slackWorkingTurns,
} from "../../db/schema/index.js";
import { runImDeliveryRetention } from "../../runtime/im-delivery-janitor.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImOutboundCapture } from "../../services/im/im-outbound-capture.js";
import { SlackWorkingStore } from "../../services/im/slack-working-store.js";
import {
  SlackThreadStatusError,
  SlackWorkingWorker,
  slackWorkingCredentialResolver,
} from "../../services/im/slack-working-worker.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { createSlackWorkingFixture } from "../support/slack-working-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let clock = new Date();
const cipher = new ApplicationCipher(Buffer.alloc(32, 11));
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);
afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});
beforeEach(async () => {
  await testDatabase.reset();
  clock = new Date();
});

async function fixture() {
  return createSlackWorkingFixture(client.database, cipher, () => clock);
}

async function rotate(agentId: string, transaction?: import("../../db/client.js").DatabaseTransaction) {
  await new ImBindingService(client.database, cipher).activateSlack(
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
    transaction,
  );
}
async function target() {
  const [row] = await client.database.select().from(slackWorkingTargets);
  if (!row) throw new Error("missing target");
  return row;
}

describe("durable Slack working projection", () => {
  it("rechecks the installation fence after waiting for a concurrent reauthorization commit", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    const claim = await h.store.claim();
    if (!claim) throw new Error("missing claim");
    const before = await target();
    let unlock = () => {},
      signalReady = () => {};
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const rotating = client.database.transaction(async (tx) => {
      await rotate(frame.agentId, tx);
      signalReady();
      await released;
    });
    await ready;
    const settling = h.store.settle(claim, { working: false, delayMs: 60_000, cooldownMs: 60_000 });
    try {
      await expect
        .poll(
          async () => {
            const [row] =
              await client.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%slack_installations%'`;
            return Number(row?.count);
          },
          { timeout: 5_000 },
        )
        .toBeGreaterThanOrEqual(1);
    } finally {
      unlock();
      await rotating;
      await settling;
    }
    expect(await target()).toEqual(before);
    expect((await client.database.select().from(slackInstallations))[0]?.workingStatusNotBeforeAt.getTime()).toBe(0);
    await h.store.record({ ...frame, sequence: 2 }, h.context);
    await h.worker.runOnce();
    expect(h.api.setThreadStatus.mock.calls.at(-1)?.[0].token).toBe("unit-secret-rotated");
  });
  it("uses an explicit execution deadline without adding a default 30-minute cap", async () => {
    const h = await fixture(),
      { frame, request } = await h.delivery();
    delete request.runtime.budget;
    request.deadlineAt = new Date(clock.getTime() + 60 * 60_000).toISOString();
    await client.database
      .update(imMessageDeliveries)
      .set({ dispatchPayload: request, expiresAt: new Date(request.deadlineAt) })
      .where(eq(imMessageDeliveries.id, frame.deliveryId));
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    clock = new Date(clock.getTime() + 31 * 60_000);
    await h.store.record({ ...frame, sequence: 2 }, h.context);
    await h.worker.runOnce();
    const [turn] = await client.database.select().from(slackWorkingTurns);
    expect(turn?.phase).toBe("running");
    expect(turn?.deadlineAt.toISOString()).toBe(request.deadlineAt);
    expect(h.calls).toEqual(["is working", "is working"]);
  });
  it("starts a duration budget at execution instead of consuming it in the queue", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    clock = new Date(clock.getTime() + 60_000);
    await h.store.record(frame, h.context);
    clock = new Date(clock.getTime() + 9 * 60_000 + 30_000);
    await h.store.record({ ...frame, sequence: 2 }, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working"]);
    clock = new Date(clock.getTime() + 31_000);
    await h.store.record({ ...frame, sequence: 3 }, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
  });
  it("renews a live execution with new sequences and refreshes long-running work", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    for (let sequence = 2; sequence <= 5; sequence += 1) {
      clock = new Date(clock.getTime() + 30_000);
      await h.store.record({ ...frame, sequence }, h.context);
      await h.worker.runOnce();
    }
    expect(h.calls).toEqual(["is working", "is working", "is working"]);
  });
  it("clears explicit user waits and permits a newer running observation", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    await h.store.record({ ...frame, sequence: 2, phase: "waiting_user" }, h.context);
    await h.worker.runOnce();
    await h.store.record({ ...frame, sequence: 3 }, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", "", "is working"]);
  });
  it("lets only one worker claim a target and rejects a superseded claim", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    const claims = await Promise.all([h.store.claim(), h.store.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean);
    if (!first) throw new Error("missing claim");
    clock = new Date(clock.getTime() + 31_000);
    const replacement = await h.store.claim();
    if (!replacement) throw new Error("missing replacement claim");
    expect(await h.store.ownsClaim(first)).toBe(false);
    await h.store.settle(first, { working: false, delayMs: 86_400_000 });
    expect(await h.store.ownsClaim(replacement)).toBe(true);
  });
  it("clears ended Sessions even while a previous execution lease is live", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    await client.database.update(sessions).set({ endedAt: clock }).where(eq(sessions.id, h.sessionId));
    clock = new Date(clock.getTime() + 46_000);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
  });
  it("aggregates concurrent turns and clears only after the last one ends", async () => {
    const h = await fixture(),
      first = await h.delivery(),
      second = await h.delivery();
    await h.store.record(first.frame, h.context);
    await h.store.record(second.frame, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working"]);
    await h.store.record({ ...first.frame, sequence: 2, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    expect(h.calls.at(-1)).toBe("is working");
    await h.store.record({ ...second.frame, sequence: 2, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    expect(h.calls.at(-1)).toBe("");
  });
  it("ACK replay cannot extend a lease or resurrect terminal state", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    const [before] = await client.database.select().from(slackWorkingTurns);
    clock = new Date(clock.getTime() + 30_000);
    expect((await h.store.record(frame, h.context)).status).toBe("already_recorded");
    const [after] = await client.database.select().from(slackWorkingTurns);
    expect(after?.leaseExpiresAt).toEqual(before?.leaseExpiresAt);
    await h.store.record({ ...frame, sequence: 3, phase: "terminal" }, h.context);
    await h.store.record({ ...frame, sequence: 2 }, h.context);
    await h.store.record({ ...frame, sequence: 4 }, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual([""]);
  });
  it("expires lost execution heartbeats after a server restart", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    clock = new Date(clock.getTime() + 91_000);
    const restarted = new SlackWorkingWorker({
      store: new SlackWorkingStore(client.database, () => clock),
      api: h.api,
      token: slackWorkingCredentialResolver(client.database, cipher),
    });
    await restarted.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
  });
  it("restores a cleared status when the same execution resumes heartbeats", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    clock = new Date(clock.getTime() + 91_000);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
    await h.store.record({ ...frame, sequence: 2 }, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", "", "is working"]);
  });
  it("retires cleared orphan projections while preserving pending cleanup and referenced targets", async () => {
    const h = await fixture(),
      cleared = await h.delivery("1.1"),
      pending = await h.delivery("2.2");
    await h.store.record(cleared.frame, h.context);
    await h.worker.runOnce();
    await h.store.record({ ...cleared.frame, sequence: 2, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    await h.store.record(pending.frame, h.context);
    const referenced = await h.delivery("3.3");
    await h.store.record(referenced.frame, h.context);
    await h.store.record({ ...referenced.frame, sequence: 2, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    // Keep one unresolved cleanup intent after its delivery disappears.
    await client.database
      .update(slackWorkingTargets)
      .set({ working: true, nextAttemptAt: clock })
      .where(eq(slackWorkingTargets.threadTs, "2.2"));
    await client.database.delete(imMessageDeliveries).where(eq(imMessageDeliveries.id, cleared.frame.deliveryId));
    await client.database.delete(imMessageDeliveries).where(eq(imMessageDeliveries.id, pending.frame.deliveryId));
    await runImDeliveryRetention(client.database, {
      clock: () => clock,
      expiryBatchSize: 100,
      retentionBatchSize: 100,
      imMessagesRetentionMs: 1_000,
      imMessageDeliveriesRetentionMs: 1_000,
      slackWebhookReceiptsRetentionMs: 1_000,
      feishuInboundReceiptsRetentionMs: 1_000,
    });
    const targets = await client.database.select().from(slackWorkingTargets);
    expect(targets.map((target) => target.threadTs).sort()).toEqual(["2.2", "3.3"]);
  });
  it("isolates threads and excludes observer deliveries", async () => {
    const h = await fixture(),
      first = await h.delivery("1.1"),
      second = await h.delivery("3.3"),
      observer = await h.delivery("4.4", "observer");
    await h.store.record(first.frame, h.context);
    await h.store.record(second.frame, h.context);
    await h.store.record(observer.frame, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", "is working"]);
    expect(await client.database.select().from(slackWorkingTargets)).toHaveLength(2);
  });
  it.each(["instance", "placement", "agent", "session", "delivery"] as const)(
    "rejects a stale %s fence",
    async (fence) => {
      const h = await fixture(),
        { frame } = await h.delivery();
      const context = fence === "instance" ? { ...h.context, instanceId: randomUUID() } : h.context;
      const changes = {
        instance: {},
        placement: { placementGeneration: 2 },
        agent: { agentId: randomUUID() },
        session: { sessionId: randomUUID() },
        delivery: { deliveryId: randomUUID() },
      }[fence];
      expect((await h.store.record({ ...frame, ...changes }, context)).status).toBe("stale_generation");
      expect(await client.database.select().from(slackWorkingTargets)).toHaveLength(0);
    },
  );
  it("commits cleanup atomically with a durable terminal report", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    const body = {
      type: "turn:report" as const,
      requestId: randomUUID(),
      deliveryId: frame.deliveryId,
      turnId: frame.turnId,
      sessionId: frame.sessionId,
      agentId: frame.agentId,
      placementGeneration: 1,
      outcome: "completed" as const,
      executionEffects: "completed" as const,
      traceSummary: { lastSequence: 0, droppedEvents: 0 },
    };
    const report: TurnReportRequest = { ...body, resultHash: computeTurnResultHash(body) };
    expect(
      await new PostgresRuntimeCustodyStore(client.database, { now: () => clock }).recordTurn(report, h.context),
    ).toBe("recorded");
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
    expect((await h.store.record({ ...frame, sequence: 2 }, h.context)).status).toBe("stale_generation");
  });
  it("repairs a running status after a confirmed provider reply", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    await new ImOutboundCapture(client.database, { slackWorkingStatus: true, now: () => clock }).capture({
      provider: "slack",
      observedAt: clock,
      operationId: "chat.postMessage",
      bindingId: h.binding.id,
      pathParams: {},
      query: "",
      requestBody: { channel: "C1", thread_ts: "1.1", text: "result" },
      responsePayload: {
        ok: true,
        channel: "C1",
        ts: "5.5",
        message: { type: "message", user: "U1", bot_id: "B1", thread_ts: "1.1", text: "result" },
      },
    });
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", "is working"]);
  });
  it("repairs an in-flight start that races with completion", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    h.api.setThreadStatus.mockImplementationOnce(async (input) => {
      h.calls.push(input.status);
      await h.store.record({ ...frame, sequence: 2, phase: "terminal" }, h.context);
    });
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
  });
  it("does not bypass rate limiting when terminal activity arrives", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    h.api.setThreadStatus.mockRejectedValueOnce(new SlackThreadStatusError("ratelimited", 60_000));
    await h.worker.runOnce();
    await h.store.record({ ...frame, sequence: 2, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    expect(h.api.setThreadStatus).toHaveBeenCalledTimes(1);
    clock = new Date(clock.getTime() + 61_000);
    await h.worker.runOnce();
    expect(h.calls).toEqual([""]);
  });
  it("persists installation cooldowns across existing threads, new threads and worker restarts", async () => {
    const h = await fixture();
    for (const thread of ["1.1", "2.2"]) {
      const { frame } = await h.delivery(thread);
      await h.store.record(frame, h.context);
    }
    h.api.setThreadStatus.mockRejectedValueOnce(new SlackThreadStatusError("ratelimited", 60_000));
    await h.worker.runOnce();
    expect(h.api.setThreadStatus).toHaveBeenCalledTimes(1);
    const { frame } = await h.delivery("3.3");
    await h.store.record(frame, h.context);
    const restarted = new SlackWorkingWorker({
      store: new SlackWorkingStore(client.database, () => clock),
      api: h.api,
      token: slackWorkingCredentialResolver(client.database, cipher),
    });
    await restarted.runOnce();
    expect(h.api.setThreadStatus).toHaveBeenCalledTimes(1);
    const [target] = await client.database.select().from(slackWorkingTargets);
    expect(target?.failures).toBe(0);
    clock = new Date(clock.getTime() + 61_000);
    await restarted.runOnce();
    expect(h.calls).toEqual(["is working", "is working", "is working"]);
  });
  it("rechecks an installation cooldown before using an already acquired claim", async () => {
    const h = await fixture();
    const first = await h.delivery("1.1");
    await h.store.record(first.frame, h.context);
    const claimed = await h.store.claim();
    if (!claimed) throw new Error("missing claim");
    const second = await h.delivery("2.2");
    await h.store.record(second.frame, h.context);
    h.api.setThreadStatus.mockRejectedValueOnce(new SlackThreadStatusError("ratelimited", 60_000));
    await h.worker.runOnce();
    expect(h.api.setThreadStatus).toHaveBeenCalledTimes(1);
    expect(await h.store.ownsClaim(claimed)).toBe(false);
  });
  it("does not send using a replaced credential generation", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await client.database
      .update(slackInstallations)
      .set({ credentialGeneration: 2 })
      .where(eq(slackInstallations.id, h.binding.slackInstallationId ?? ""));
    await h.worker.runOnce();
    expect(h.calls).toEqual([]);
  });
  it("moves a live turn to the current credential target after same-identity reauthorization", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    await new ImBindingService(client.database, cipher).activateSlack(
      {
        intent: "reauthorize",
        agentId: frame.agentId,
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
    clock = new Date(clock.getTime() + 30_000);
    await h.store.record({ ...frame, sequence: 2 }, h.context);
    await h.worker.runOnce();
    const targets = await client.database.select().from(slackWorkingTargets);
    const [turn] = await client.database.select().from(slackWorkingTurns);
    const current = targets.find((target) => target.credentialGeneration === 2);
    expect(current).toBeDefined();
    expect(turn?.targetId).toBe(current?.id);
    expect(current?.working).toBe(true);
    expect(targets).toHaveLength(1);
    expect(h.calls).toEqual(["is working", "is working"]);
  });
  it("keeps sibling turns on one stable target so completion during reauthorization cannot clear live work", async () => {
    const h = await fixture(),
      first = await h.delivery(),
      second = await h.delivery();
    const siblingSession = randomUUID();
    await client.database.insert(sessions).values({
      id: siblingSession,
      imBindingId: h.binding.id,
      channelId: "C1",
      conversationKind: "channel",
      kind: "thread",
      threadKey: "1.1",
    });
    await client.database
      .insert(sessionPlacements)
      .values({ sessionId: siblingSession, computerId: h.context.computerId, generation: 1 });
    second.request.sessionId = siblingSession;
    second.frame.sessionId = siblingSession;
    await client.database
      .update(imMessageDeliveries)
      .set({ sessionId: siblingSession, dispatchPayload: second.request })
      .where(eq(imMessageDeliveries.id, second.frame.deliveryId));
    await h.store.record(first.frame, h.context);
    await h.store.record(second.frame, h.context);
    await h.worker.runOnce();
    await new ImBindingService(client.database, cipher).activateSlack(
      {
        intent: "reauthorize",
        agentId: first.frame.agentId,
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
    clock = new Date(clock.getTime() + 30_000);
    await h.store.record({ ...first.frame, sequence: 2 }, h.context);
    await h.worker.runOnce();
    await h.store.record({ ...first.frame, sequence: 3, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", "is working", "is working"]);
    const turns = await client.database.select().from(slackWorkingTurns);
    expect(new Set(turns.map((turn) => turn.targetId)).size).toBe(1);
    await h.store.record({ ...second.frame, sequence: 2, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    expect(h.calls.at(-1)).toBe("");
  });
  it("does not create an empty credential-generation target for a replay after reauthorization", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    await new ImBindingService(client.database, cipher).activateSlack(
      {
        intent: "reauthorize",
        agentId: frame.agentId,
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
    expect((await h.store.record(frame, h.context)).status).toBe("already_recorded");
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working"]);
    expect(await client.database.select().from(slackWorkingTargets)).toHaveLength(1);
    clock = new Date(clock.getTime() + 30_000);
    await h.store.record({ ...frame, sequence: 2 }, h.context);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", "is working"]);
  });
  it("serializes old and new generation activity before locking sibling turn rows", async () => {
    const h = await fixture(),
      first = await h.delivery(),
      second = await h.delivery();
    const siblingSession = randomUUID();
    await client.database.insert(sessions).values({
      id: siblingSession,
      imBindingId: h.binding.id,
      channelId: "C1",
      conversationKind: "channel",
      kind: "thread",
      threadKey: "1.1",
    });
    await client.database
      .insert(sessionPlacements)
      .values({ sessionId: siblingSession, computerId: h.context.computerId, generation: 1 });
    second.frame.sessionId = siblingSession;
    second.request.sessionId = siblingSession;
    await client.database
      .update(imMessageDeliveries)
      .set({ sessionId: siblingSession, dispatchPayload: second.request })
      .where(eq(imMessageDeliveries.id, second.frame.deliveryId));
    await h.store.record(first.frame, h.context);
    await h.store.record(second.frame, h.context);
    const [target] = await client.database.select().from(slackWorkingTargets);
    if (!target) throw new Error("missing target");
    let unlock = () => {},
      signalReady = () => {};
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const holding = client.sql.begin(async (tx) => {
      await tx`select id from slack_working_targets where id = ${target.id} for update`;
      signalReady();
      await released;
    });
    await ready;
    const old = h.store.record({ ...first.frame, sequence: 2 }, h.context).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let current: typeof old | undefined;
    try {
      await expect
        .poll(
          async () => {
            const [row] =
              await client.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%slack_working_targets%'`;
            return Number(row?.count);
          },
          { timeout: 5_000 },
        )
        .toBeGreaterThanOrEqual(1);
      await new ImBindingService(client.database, cipher).activateSlack(
        {
          intent: "reauthorize",
          agentId: first.frame.agentId,
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
      current = h.store.record({ ...second.frame, sequence: 2 }, h.context).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await expect
        .poll(
          async () => {
            const [row] =
              await client.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`;
            return Number(row?.count);
          },
          { timeout: 5_000 },
        )
        .toBe(1);
    } finally {
      unlock();
      await holding;
      const outcomes = await Promise.all([old, current]);
      expect(outcomes).toEqual([
        expect.objectContaining({ value: expect.objectContaining({ status: "recorded" }) }),
        expect.objectContaining({ value: expect.objectContaining({ status: "recorded" }) }),
      ]);
    }
    const targets = await client.database.select().from(slackWorkingTargets);
    const latest = targets.find((row) => row.credentialGeneration === 2);
    const turns = await client.database.select().from(slackWorkingTurns);
    expect(turns.every((turn) => turn.targetId === latest?.id)).toBe(true);
  }, 20_000);
  it("reuses one target across rotations and retires it after confirmed cleanup", async () => {
    const h = await fixture(),
      first = await h.delivery();
    await h.store.record(first.frame, h.context);
    await h.worker.runOnce();
    await h.store.record({ ...first.frame, sequence: 2, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    const [old] = await client.database.select().from(slackWorkingTargets);
    if (!old) throw new Error("missing target");
    await client.database.delete(imMessageDeliveries).where(eq(imMessageDeliveries.id, first.frame.deliveryId));
    await new ImBindingService(client.database, cipher).activateSlack(
      {
        intent: "reauthorize",
        agentId: first.frame.agentId,
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
    const second = await h.delivery();
    await h.store.record(second.frame, h.context);
    await h.worker.runOnce();
    await client.database.insert(slackWorkingTargets).values({
      ...old,
      id: "unresolved-current",
      threadTs: "9.9",
      credentialGeneration: 2,
      disabled: true,
      working: false,
      nextAttemptAt: clock,
      claimId: null,
      claimExpiresAt: null,
    });
    await runImDeliveryRetention(client.database, {
      clock: () => clock,
      expiryBatchSize: 100,
      retentionBatchSize: 100,
      imMessagesRetentionMs: 1_000,
      imMessageDeliveriesRetentionMs: 1_000,
      slackWebhookReceiptsRetentionMs: 1_000,
      feishuInboundReceiptsRetentionMs: 1_000,
    });
    const targets = await client.database.select().from(slackWorkingTargets);
    expect(targets.some((row) => row.credentialGeneration === 1)).toBe(false);
    expect(targets.some((row) => row.id === "unresolved-current")).toBe(true);
    expect(targets.some((row) => row.working)).toBe(true);
    expect(targets.find((row) => row.working)?.id).toBe(old.id);
    await h.store.record({ ...second.frame, sequence: 2, phase: "terminal" }, h.context);
    await h.worker.runOnce();
    await client.database.delete(imMessageDeliveries).where(eq(imMessageDeliveries.id, second.frame.deliveryId));
    await runImDeliveryRetention(client.database, {
      clock: () => clock,
      expiryBatchSize: 100,
      retentionBatchSize: 100,
      imMessagesRetentionMs: 1_000,
      imMessageDeliveriesRetentionMs: 1_000,
      slackWebhookReceiptsRetentionMs: 1_000,
      feishuInboundReceiptsRetentionMs: 1_000,
    });
    expect((await client.database.select().from(slackWorkingTargets)).map((row) => row.id)).toEqual([
      "unresolved-current",
    ]);
  });
  it("uses current credentials to clear terminal activity whose ACK was lost across reauthorization", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    const terminal = { ...frame, sequence: 2, phase: "terminal" as const };
    await h.store.record(terminal, h.context);
    await new ImBindingService(client.database, cipher).activateSlack(
      {
        intent: "reauthorize",
        agentId: frame.agentId,
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
    expect((await h.store.record(terminal, h.context)).status).toBe("already_recorded");
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
    expect(h.api.setThreadStatus.mock.calls[1]?.[0].token).toBe("unit-secret-rotated");
  });
  it("reactivates failed cleanup after credentials advance without reviving the old token", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    await h.worker.runOnce();
    await h.store.record({ ...frame, sequence: 2, phase: "terminal" }, h.context);
    h.api.setThreadStatus.mockRejectedValueOnce(new SlackThreadStatusError("invalid_auth"));
    await h.worker.runOnce();
    await new ImBindingService(client.database, cipher).activateSlack(
      {
        intent: "reauthorize",
        agentId: frame.agentId,
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
    clock = new Date(clock.getTime() + 2_001);
    await h.worker.runOnce();
    expect(h.calls).toEqual(["is working", ""]);
    expect(h.api.setThreadStatus.mock.calls[2]?.[0].token).toBe("unit-secret-rotated");
  });
  it("rejects a token resolved before real reauthorization without sending the old token", async () => {
    const h = await fixture(),
      { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    const resolveToken = slackWorkingCredentialResolver(client.database, cipher);
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
      const [installation] = await client.database.select().from(slackInstallations);
      expect(installation?.workingStatusNotBeforeAt.getTime()).toBe(0);
      await h.store.record({ ...frame, sequence: 2 }, h.context);
      await h.worker.runOnce();
      expect(h.api.setThreadStatus.mock.calls.at(-1)?.[0].token).toBe("unit-secret-rotated");
    },
  );
});
