import { randomUUID } from "node:crypto";
import {
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  SLACK_REQUIRED_BOT_SCOPES,
  type TurnActivityRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
  slackWorkingTargets,
  slackWorkingTurns,
  users,
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
  const userId = randomUUID(),
    computerId = randomUUID(),
    agentId = randomUUID(),
    sessionId = randomUUID(),
    instanceId = randomUUID();
  await client.database.insert(users).values({ id: userId, email: `${userId}@example.test`, displayName: "Working" });
  await client.database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    currentInstallationId: randomUUID(),
    displayName: "Working",
    platform: "darwin",
    arch: "arm64",
    clientVersion: "test",
  });
  await client.database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: "working",
    displayName: "Working",
    runtimeProvider: "codex",
  });
  await new ImBindingService(client.database, cipher).activateSlack(
    {
      intent: "create",
      agentId,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "unit-secret",
      signingSecret: "unit-signing",
      installedAt: clock,
    },
    "B1",
  );
  const [binding] = await client.database.select().from(imBindings);
  if (!binding) throw new Error("missing binding");
  const bindingId = binding.id;
  await client.database
    .insert(sessions)
    .values({ id: sessionId, imBindingId: bindingId, channelId: "C1", conversationKind: "channel", kind: "channel" });
  await client.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  const context = { computerId, installationId: randomUUID(), instanceId, signal: new AbortController().signal };
  const store = new SlackWorkingStore(client.database, () => clock);
  const calls: string[] = [];
  const api = {
    setThreadStatus: vi.fn(async (input: { status: string }) => {
      calls.push(input.status);
    }),
  };
  const worker = new SlackWorkingWorker({ store, api, token: slackWorkingCredentialResolver(client.database, cipher) });
  async function delivery(threadTs = "1.1", replyRole?: "observer") {
    const messageId = randomUUID(),
      deliveryId = randomUUID(),
      turnId = randomUUID(),
      requestId = randomUUID();
    const request: DirectImMessageDeliveryRequest = {
      type: "im:deliver",
      requestId,
      deliveryId,
      imMessageId: messageId,
      sessionId,
      agentId,
      placementGeneration: 1,
      attention: "direct",
      ...(replyRole ? { replyRole } : {}),
      content: {
        kind: "text",
        text: "work",
        providerRef: {
          provider: "slack",
          appId: "A1",
          teamId: "T1",
          botUserId: "U1",
          channelId: "C1",
          messageTs: "2.2",
          threadTs,
        },
      },
      runtime: {
        agentId,
        contextTrees: [],
        instructions: { agent: "A", platform: "P" },
        provider: "codex",
        revision: { agent: { id: randomUUID(), sequence: 1 }, session: { id: randomUUID(), sequence: 1 } },
        execution: { approvalPolicy: "never", networkAccess: true },
        workspace: { workspaceId: randomUUID(), mode: "empty_on_create", sharing: "agent" },
        budget: { maxDurationMs: 600_000 },
      },
    };
    await client.database.insert(imMessages).values({
      id: messageId,
      imBindingId: bindingId,
      channelId: "C1",
      externalMessageId: messageId,
      providerRevisionKey: "1",
      direction: "inbound",
      operation: "created",
      authorKind: "human",
      authorExternalId: "U2",
      content: { version: 1, fallbackText: "work", blocks: [], truncated: false },
      providerContext: { provider: "slack" },
      occurredAt: clock,
    });
    await client.database.insert(imMessageDeliveries).values({
      id: deliveryId,
      messageId,
      sessionId,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      dispatchRequestId: requestId,
      dispatchInputHash: "a".repeat(64),
      dispatchPayload: request,
      inputHash: "a".repeat(64),
      turnId,
      reportOwnerInstanceId: instanceId,
      acceptedAt: clock,
      expiresAt: new Date(clock.getTime() + 600_000),
    });
    const frame: TurnActivityRequest = {
      type: "turn:activity",
      requestId: randomUUID(),
      deliveryId,
      sessionId,
      agentId,
      placementGeneration: 1,
      turnId,
      sequence: 1,
      phase: "running",
    };
    return { request, frame };
  }
  return { store, worker, calls, api, delivery, binding, context, sessionId };
}

describe("durable Slack working projection", () => {
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
    expect(targets.find((target) => target.credentialGeneration === 1)?.disabled).toBe(true);
    expect(h.calls).toEqual(["is working", "is working"]);
  });
  it("moves all sibling turns atomically so a completion during reauthorization cannot clear live work", async () => {
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
});
