import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { computeDirectInputHash, computeRuntimeImSteerInputHash } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
} from "../../db/schema/index.js";
import { lockEligibleDelivery } from "../../runtime/im-delivery-selector.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { readInboundPendingAgents } from "../../services/im/inbound-admission.js";
import { normalizeFeishuMessage } from "../../services/im-bindings/feishu/adapter.js";
import { FeishuInboundReceiptStore } from "../../services/im-bindings/feishu/inbound-receipt-store.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { SlackWebhookReceiptStore } from "../../services/im-bindings/slack/webhook-receipt-store.js";
import { createFixture, turnReport } from "./im-recovery-locks-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let database: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  database = await startMigratedTestDatabase();
  client = createDatabaseClient(database.databaseUrl);
}, 120_000);
beforeEach(async () => database.reset());
afterAll(async () => {
  await client?.sql.end();
  await database?.stop();
});

async function fixture(provider: "feishu" | "slack") {
  const f = await createFixture(client.database);
  const appId = `app-${f.agentId}`;
  await client.database
    .update(imBindings)
    .set({
      externalAppId: appId,
      connectionOwnerInstanceId: f.dispatchContext.instanceId,
      connectionFencingEpoch: 1,
      connectionLeaseExpiresAt: new Date(f.now.getTime() + 120000),
    })
    .where(eq(imBindings.id, f.bindingId));
  const [event] = normalizeFeishuMessage({
    appId,
    teamId: "tenant",
    message: {
      messageId: "older-receipt",
      chatId: "channel",
      chatType: "group",
      senderId: "human",
      content: "older input",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: f.now.getTime() - 1000,
      raw: { header: { event_id: "older-receipt" } },
    } as never,
  });
  if (!event) throw new Error("Missing normalized fixture event");
  const input = {
    bindingId: f.bindingId,
    credentialGeneration: 1,
    eventId: "older-receipt",
    work: { version: 1 as const, provider: "feishu" as const, event },
    fence: { holderInstanceId: f.dispatchContext.instanceId, fencingEpoch: 1 },
  };
  const installationId = randomUUID();
  if (provider === "slack") {
    await client.database.insert(slackInstallations).values({
      id: installationId,
      agentId: f.agentId,
      status: "active",
      externalAppId: appId,
      externalTeamId: "tenant",
      externalBotId: "bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "synthetic",
      activatedAt: f.now,
    });
    await client.database
      .update(imBindings)
      .set({
        provider: "slack",
        connectionOwnerInstanceId: null,
        connectionFencingEpoch: 0,
        connectionLeaseExpiresAt: null,
        externalTeamId: "tenant",
        slackInstallationId: installationId,
        slackRouteKind: "default",
        encryptedCredential: null,
      })
      .where(eq(imBindings.id, f.bindingId));
  }
  const actualInput = {
    ...input,
    installationId,
    work:
      provider === "feishu"
        ? input.work
        : {
            version: 1 as const,
            provider: "slack" as const,
            bindingId: f.bindingId,
            appId,
            teamId: "tenant",
            botUserId: "bot",
            botId: "B_BOT",
            eventId: input.eventId,
            identityClosed: true,
            revokesBot: false,
            event: { type: "message", text: "older", channel: "channel", ts: "1.000001", user: "human" },
          },
  };
  const receipts =
    provider === "feishu"
      ? new FeishuInboundReceiptStore(client.database, { now: () => f.now })
      : new SlackWebhookReceiptStore(client.database, { now: () => f.now });
  const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => f.now });
  return { ...f, input: actualInput, receipts, custody };
}

it.each(["feishu", "slack"] as const)(
  "%s: blocks fresh claim and dispatch during a live receipt lease and retry backoff",
  async (provider) => {
    const f = await fixture(provider);
    const receipt = await f.receipts.claim(f.input);
    expect(await readInboundPendingAgents(client.database, [f.agentId])).toEqual(new Set([f.agentId]));
    expect(
      await client.database.transaction((tx) => lockEligibleDelivery(tx, f.rootDeliveryId, f.agentId, new Date())),
    ).toBeUndefined();
    expect(
      await f.custody.beginDeliveryDispatch(f.rootRequest, computeDirectInputHash(f.rootRequest), f.dispatchContext),
    ).toBe("inbound_pending");
    assert(receipt.receiptId);
    await f.receipts.markFailed(receipt.receiptId, "SYNTHETIC", receipt.attempt);
    expect(
      await f.custody.beginDeliveryDispatch(f.rootRequest, computeDirectInputHash(f.rootRequest), f.dispatchContext),
    ).toBe("inbound_pending");
    const [row] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, f.rootDeliveryId));
    expect(row).toMatchObject({ state: "pending", dispatchRequestId: null, dispatchPayload: null, turnReport: null });
  },
);

it.each(["feishu", "slack"] as const)(
  "%s: fences the Agent's other Sessions while receipt routing is incomplete",
  async (provider) => {
    const f = await fixture(provider);
    await f.receipts.claim(f.input);
    const sessionId = randomUUID();
    const deliveryId = randomUUID();
    const messageId = randomUUID();
    await client.database.insert(sessions).values({
      id: sessionId,
      imBindingId: f.bindingId,
      channelId: "other-channel",
      conversationKind: "channel",
      kind: "channel",
    });
    await client.database
      .insert(sessionPlacements)
      .values({ sessionId, computerId: f.dispatchContext.computerId, generation: 1 });
    const [source] = await client.database
      .select()
      .from(imMessages)
      .where(eq(imMessages.id, f.rootRequest.imMessageId));
    assert(source);
    await client.database.insert(imMessages).values({
      ...source,
      id: messageId,
      channelId: "other-channel",
      externalMessageId: "other-input",
      providerEventId: null,
    });
    await client.database.insert(imMessageDeliveries).values({
      id: deliveryId,
      messageId,
      sessionId,
      attention: "direct",
      placementGeneration: 1,
      expiresAt: new Date(Date.now() + 60000),
    });
    const request = {
      ...f.rootRequest,
      deliveryId,
      imMessageId: messageId,
      sessionId,
      requestId: randomUUID(),
      runtime: { ...f.runtime, revision: { ...f.runtime.revision, session: { id: sessionId, sequence: 1 } } },
    };
    expect(await f.custody.beginDeliveryDispatch(request, computeDirectInputHash(request), f.dispatchContext)).toBe(
      "inbound_pending",
    );
  },
);

it.each(["feishu", "slack"] as const)(
  "%s: releases the barrier from the immutable Inbox event before receipt settlement",
  async (provider) => {
    const f = await fixture(provider);
    await f.receipts.claim(f.input);
    await client.database
      .update(imMessages)
      .set({ providerEventId: f.input.eventId })
      .where(eq(imMessages.id, f.rootRequest.imMessageId));
    expect(await readInboundPendingAgents(client.database, [f.agentId])).toEqual(new Set());
    expect(
      await f.custody.beginDeliveryDispatch(f.rootRequest, computeDirectInputHash(f.rootRequest), f.dispatchContext),
    ).toBe("dispatched");
  },
);

it.each(["feishu", "slack"] as const)(
  "%s: does not release a receipt for an equal event ID under another binding",
  async (provider) => {
    const f = await fixture(provider);
    const other = await createFixture(client.database);
    await f.receipts.claim(f.input);
    await client.database
      .update(imMessages)
      .set({ providerEventId: f.input.eventId })
      .where(eq(imMessages.id, other.rootRequest.imMessageId));
    expect(await readInboundPendingAgents(client.database, [f.agentId, other.agentId])).toEqual(new Set([f.agentId]));
    expect(
      await f.custody.beginDeliveryDispatch(
        other.rootRequest,
        computeDirectInputHash(other.rootRequest),
        other.dispatchContext,
      ),
    ).toBe("dispatched");
  },
);

it.each(["feishu", "slack"] as const)(
  "%s: ignores old-generation work and rejects an old holder after rotation",
  async (provider) => {
    const f = await fixture(provider);
    await f.receipts.claim(f.input);
    await client.database
      .update(imBindings)
      .set({ credentialGeneration: 2, connectionFencingEpoch: 2 })
      .where(eq(imBindings.id, f.bindingId));
    if (provider === "slack")
      await client.database
        .update(slackInstallations)
        .set({ credentialGeneration: 2 })
        .where(eq(slackInstallations.id, f.input.installationId));
    expect(await readInboundPendingAgents(client.database, [f.agentId])).toEqual(new Set());
    await expect(f.receipts.claim({ ...f.input, eventId: "stale-holder" })).rejects.toMatchObject({
      code: `${provider.toUpperCase()}_INBOUND_FENCE_STALE`,
    });
  },
);

it.each(["feishu", "slack"] as const)(
  "%s: lets frozen replay and report ACK custody progress while fresh steers wait",
  async (provider) => {
    const f = await fixture(provider);
    const hash = computeDirectInputHash(f.rootRequest);
    expect(await f.custody.beginDeliveryDispatch(f.rootRequest, hash, f.dispatchContext)).toBe("dispatched");
    await f.receipts.claim(f.input);
    expect(await f.custody.beginDeliveryDispatch(f.rootRequest, hash, f.dispatchContext)).toBe("already_dispatched");
    expect(await f.custody.acceptDelivery(f.rootRequest, hash, f.rootTurnId, f.context)).toBe("accepted");
    const steer = f.steerRequests[0];
    expect(await f.custody.beginSteerDispatch(steer, computeRuntimeImSteerInputHash(steer), f.dispatchContext)).toBe(
      "inbound_pending",
    );
    expect(await f.custody.recordTurn(turnReport(f, "completed"), f.context)).toBe("recorded");
    expect(await f.custody.recordTurn(turnReport(f, "completed"), f.context)).toBe("already_recorded");
  },
);

it.each(["feishu", "slack"] as const)(
  "%s: rejects fresh dispatch if a receipt appears after the selector hint",
  async (provider) => {
    const f = await fixture(provider);
    expect(
      await client.database.transaction((tx) => lockEligibleDelivery(tx, f.rootDeliveryId, f.agentId, new Date())),
    ).toBeDefined();
    await f.receipts.claim(f.input);
    expect(
      await f.custody.beginDeliveryDispatch(f.rootRequest, computeDirectInputHash(f.rootRequest), f.dispatchContext),
    ).toBe("inbound_pending");
  },
);

async function waitingLocks(kind: string) {
  const rows = await client.sql`select count(*)::int as count from pg_locks where locktype=${kind} and not granted`;
  return rows[0]?.count as number;
}

it.each(["feishu", "slack"] as const)(
  "%s: serializes a durable receipt commit ahead of a competing dispatch on independent connections",
  async (provider) => {
    const f = await fixture(provider);
    const gate = await client.sql.reserve();
    await gate.unsafe("begin");
    await gate.unsafe("select pg_advisory_xact_lock(712391)");
    await client.sql.unsafe(
      "create function gate_receipt_insert() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(712391); return new; end $$",
    );
    const table = provider === "feishu" ? "feishu_inbound_receipts" : "slack_webhook_receipts";
    await client.sql.unsafe(
      `create trigger gate_receipt_insert before insert on ${table} for each row execute function gate_receipt_insert()`,
    );
    let claim: ReturnType<typeof f.receipts.claim> | undefined;
    let dispatch: ReturnType<typeof f.custody.beginDeliveryDispatch> | undefined;
    try {
      claim = f.receipts.claim(f.input);
      await expect.poll(() => waitingLocks("advisory")).toBe(1);
      dispatch = f.custody.beginDeliveryDispatch(
        f.rootRequest,
        computeDirectInputHash(f.rootRequest),
        f.dispatchContext,
      );
      await expect.poll(() => waitingLocks("advisory")).toBe(2);
      await gate.unsafe("commit");
      expect((await claim).accepted).toBe(true);
      expect(await dispatch).toBe("inbound_pending");
    } finally {
      await gate.unsafe("rollback");
      gate.release();
      await Promise.allSettled([claim, dispatch]);
      await client.sql.unsafe(`drop trigger gate_receipt_insert on ${table}`);
      await client.sql.unsafe("drop function gate_receipt_insert()");
    }
  },
);

it.each(["feishu", "slack"] as const)(
  "%s: linearizes a later receipt behind an already freezing dispatch without blocking exact replay",
  async (provider) => {
    const f = await fixture(provider);
    const gate = await client.sql.reserve();
    await gate.unsafe("begin");
    await gate`select id from im_message_deliveries where id=${f.rootDeliveryId} for update`;
    let dispatch: ReturnType<typeof f.custody.beginDeliveryDispatch> | undefined;
    let claim: ReturnType<typeof f.receipts.claim> | undefined;
    try {
      dispatch = f.custody.beginDeliveryDispatch(
        f.rootRequest,
        computeDirectInputHash(f.rootRequest),
        f.dispatchContext,
      );
      await expect.poll(() => waitingLocks("transactionid")).toBe(1);
      claim = f.receipts.claim(f.input);
      await expect.poll(() => waitingLocks("advisory")).toBe(1);
      await gate.unsafe("commit");
      expect(await dispatch).toBe("dispatched");
      expect((await claim).accepted).toBe(true);
      expect(
        await f.custody.beginDeliveryDispatch(f.rootRequest, computeDirectInputHash(f.rootRequest), f.dispatchContext),
      ).toBe("already_dispatched");
    } finally {
      await gate.unsafe("rollback");
      gate.release();
      await Promise.allSettled([claim, dispatch]);
    }
  },
);

it("keeps Slack receipt admission in the lifecycle route-before-installation lock order", async () => {
  const f = await fixture("slack");
  const service = new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 7)));
  const gate = await client.sql.reserve();
  await gate.unsafe("begin");
  await gate`select id from im_bindings where id=${f.bindingId} for no key update`;
  let observation: Promise<boolean> | undefined;
  let claim: ReturnType<typeof f.receipts.claim> | undefined;
  const waiting = async () => {
    const rows =
      await client.sql`select count(*)::int as count from pg_locks where locktype in ('tuple','transactionid') and not granted`;
    return rows[0]?.count as number;
  };
  try {
    observation = service.recordSlackInstallationObservation(f.input.installationId, 1);
    await expect.poll(waiting).toBe(1);
    claim = f.receipts.claim(f.input);
    await expect.poll(waiting).toBe(2);
    await gate.unsafe("commit");
    expect(await observation).toBe(true);
    expect((await claim).accepted).toBe(true);
  } finally {
    await gate.unsafe("rollback");
    gate.release();
    await Promise.allSettled([observation, claim]);
  }
});
