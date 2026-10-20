import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { registerSlackEventsRoute } from "../../api/slack-events.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents,
  imBindings,
  imMessageDeliveries,
  imMessages,
  slackInstallations,
  slackWebhookReceipts,
} from "../../db/schema/index.js";
import { resolveImDeliveryJanitorConfig, runImDeliveryRetention } from "../../runtime/im-delivery-janitor.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { InboundWorkSchema, slackWorkEvent } from "../../services/im/inbound-work.js";
import { ImMessageInbox } from "../../services/im/index.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { SlackAdapter } from "../../services/im-bindings/slack/adapter.js";
import { SlackWebhookReceiptStore } from "../../services/im-bindings/slack/webhook-receipt-store.js";
import { createInboundFixture } from "./inbound-receipt-recovery-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => testDatabase.reset());
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});
afterAll(async () => testDatabase.stop());

async function baseFixture() {
  const value = await createInboundFixture(testDatabase.databaseUrl);
  cleanup.push(value.close);
  return value;
}

async function fixture() {
  const { client, clock, account, agent, service } = await baseFixture();
  const binding = await service.activateSlack(
    {
      intent: "create",
      agentId: agent.id,
      appId: "A_WORK",
      teamId: "T_WORK",
      botUserId: "U_BOT",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "xoxb-not-stored-in-work",
      signingSecret: "not-stored-signing",
      installedAt: clock.now,
    },
    "B_BOT",
  );
  const ingress = await service.findSlackInstallationIngress("A_WORK", "T_WORK");
  assert(ingress);
  const event = {
    type: "event_callback",
    api_app_id: "A_WORK",
    team_id: "T_WORK",
    event_id: "Ev_WORK",
    event_time: Math.floor(clock.now.getTime() / 1000),
    authorizations: [{ team_id: "T_WORK", user_id: "U_BOT", is_bot: true }],
    event: {
      type: "message",
      channel_type: "im",
      channel: "D_WORK",
      user: "U_HUMAN",
      text: "hello",
      ts: `${Math.floor(clock.now.getTime() / 1000)}.000001`,
      token: "unrelated-envelope-secret",
    },
  };
  const receipts = new SlackWebhookReceiptStore(client.database, { now: () => clock.now });
  const inbox = new ImMessageInbox(client.database, { now: () => clock.now });
  const adapter = new SlackAdapter({
    api: {} as never,
    token: ingress.botAccessToken,
    appId: ingress.appId,
    teamId: ingress.teamId,
    botUserId: ingress.botUserId,
    botId: ingress.botId,
  });
  const work = () =>
    InboundWorkSchema.parse({
      version: 1,
      provider: "slack",
      bindingId: binding.imBindingId,
      appId: ingress.appId,
      teamId: ingress.teamId,
      botUserId: ingress.botUserId,
      botId: ingress.botId,
      eventId: event.event_id,
      eventTime: event.event_time,
      identityClosed: true,
      revokesBot: false,
      event: slackWorkEvent(event.event),
    });
  const app = () => {
    const server = Fastify({ logger: false });
    const controller = registerSlackEventsRoute(server, {
      imBindings: service,
      inbox,
      receipts,
      now: () => clock.now,
      createAdapter: () => adapter,
    });
    cleanup.push(() => server.close());
    return { server, ...controller };
  };
  const send = (server: ReturnType<typeof Fastify>, envelope: Record<string, unknown> = event) => {
    const timestamp = String(Math.floor(clock.now.getTime() / 1000));
    const payload = JSON.stringify(envelope);
    const signature = `v0=${createHmac("sha256", ingress.signingSecret).update(`v0:${timestamp}:${payload}`).digest("hex")}`;
    return server.inject({
      method: "POST",
      url: "/api/v1/im-bindings/slack/events",
      payload,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });
  };
  const receipt = async () => {
    const [row] = await client.database.select().from(slackWebhookReceipts);
    assert(row);
    return row;
  };
  return {
    client,
    clock,
    binding,
    ingress,
    service,
    agent,
    account,
    event,
    receipts,
    inbox,
    adapter,
    work,
    app,
    send,
    receipt,
  };
}

it("recovers an acknowledged Slack Inbox failure without provider redelivery", async () => {
  const f = await fixture();
  const normalize = vi.spyOn(f.adapter, "normalizeInbound");
  const receivedAt = new Date(f.clock.now);
  const app = f.app();
  await f.client.sql.unsafe(
    "create function fail_inbound_message() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure' using errcode='40001'; end $$",
  );
  await f.client.sql.unsafe(
    "create trigger fail_inbound_message before insert on im_messages for each row execute function fail_inbound_message()",
  );
  try {
    expect((await f.send(app.server)).statusCode).toBe(200);
    await expect.poll(async () => (await f.receipt()).status).toBe("failed");
    const pending = await f.receipt();
    const serialized = JSON.stringify(pending.workPayload);
    expect(serialized).not.toContain("xoxb-not-stored-in-work");
    expect(serialized).not.toContain("not-stored-signing");
    expect(serialized).not.toContain("unrelated-envelope-secret");
    expect(pending.attemptCount).toBe(1);
  } finally {
    await f.client.sql.unsafe("drop trigger fail_inbound_message on im_messages");
    await f.client.sql.unsafe("drop function fail_inbound_message()");
  }
  f.clock.now = new Date(receivedAt.getTime() + 3_000);
  await app.recoverOnce();
  expect(normalize).toHaveBeenCalledTimes(2);
  expect(normalize.mock.calls[0]?.[0]).toEqual(normalize.mock.calls[1]?.[0]);
  expect(normalize.mock.calls[0]?.[0].event).not.toHaveProperty("token");
  expect(await f.receipt()).toMatchObject({
    status: "processed",
    attemptCount: 2,
    workPayload: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    receivedAt,
  });
  const messages = await f.client.database.select().from(imMessages);
  const deliveries = await f.client.database.select().from(imMessageDeliveries);
  expect(messages).toHaveLength(1);
  expect(deliveries).toHaveLength(1);
  expect(messages[0]?.receivedAt).toEqual(receivedAt);
  expect(deliveries[0]?.expiresAt).toEqual(new Date(receivedAt.getTime() + 7 * 86_400_000));
  expect((await f.send(app.server)).statusCode).toBe(200);
  expect(await f.client.database.select().from(imMessages)).toHaveLength(1);
});

it("resumes durable input through a fresh HTTP application after an abandoned attempt", async () => {
  const f = await fixture();
  const accepted = await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  assert(accepted.receiptId);
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  const restarted = f.app();
  await restarted.server.ready();
  await restarted.recoverOnce();
  expect(await f.receipt()).toMatchObject({ status: "processed", attemptCount: 2, workPayload: null });
  expect(await f.client.database.select().from(imMessages)).toHaveLength(1);
});

it("fences late settlement and allows only one replica to reclaim a receipt", async () => {
  const f = await fixture();
  const accepted = await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  assert(accepted.receiptId);
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  const other = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  cleanup.push(() => other.sql.end());
  const replica = new SlackWebhookReceiptStore(other.database, { now: () => f.clock.now });
  const claims = await Promise.all([f.receipts.recovery.claimNext(), replica.recovery.claimNext()]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claimed = claims.find(Boolean);
  assert(claimed);
  await f.receipts.markProcessed(accepted.receiptId, 1);
  await f.receipts.markFailed(accepted.receiptId, "LATE_FAILURE", 1);
  await f.receipts.markProcessed(accepted.receiptId);
  expect(await f.receipt()).toMatchObject({ status: "processing", attemptCount: 2 });
  await replica.markProcessed(accepted.receiptId, claimed.attempt);
  await f.receipts.markFailed(accepted.receiptId, "LATE_FAILURE", 1);
  await f.receipts.markFailed(accepted.receiptId, "UNFENCED_LATE_FAILURE");
  expect(await f.receipt()).toMatchObject({ status: "processed", attemptCount: 2, workPayload: null });
});

it("deduplicates an Inbox commit whose receipt settlement was interrupted", async () => {
  const f = await fixture();
  const receivedAt = new Date(f.clock.now);
  await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  const [event] = f.adapter.normalizeInbound({
    eventId: f.event.event_id,
    appId: f.ingress.appId,
    teamId: f.ingress.teamId,
    botUserId: f.ingress.botUserId,
    botId: f.ingress.botId,
    event: f.event.event,
  });
  assert(event);
  await f.inbox.ingest(f.binding.imBindingId, 1, event);
  f.clock.now = new Date(receivedAt.getTime() + 61_000);
  await f.app().recoverOnce();
  expect(await f.receipt()).toMatchObject({ status: "processed", attemptCount: 2 });
  expect(await f.client.database.select().from(imMessages)).toHaveLength(1);
  expect(await f.client.database.select().from(imMessageDeliveries)).toHaveLength(1);
});

it.each(["unsupported", "identity-mismatch", "no-route"])("preserves the normal %s ignored result", async (kind) => {
  const f = await fixture();
  const app = f.app();
  if (kind === "no-route")
    await f.client.database
      .update(imBindings)
      .set({ status: "disabled", disabledAt: f.clock.now, encryptedCredential: null })
      .where(eq(imBindings.id, f.binding.imBindingId));
  const envelope = {
    ...f.event,
    ...(kind === "unsupported" ? { event: { type: "reaction_added" } } : {}),
    ...(kind === "identity-mismatch" ? { authorizations: [] } : {}),
  };
  const result = await f.send(app.server, envelope);
  expect(result.statusCode).toBe(200);
  await expect.poll(async () => (await f.receipt()).status).toBe("processed");
  expect(await f.client.database.select().from(imMessages)).toHaveLength(0);
});

it.each(["revocation", "unbind"])("does not restore old authority after %s", async (kind) => {
  const f = await fixture();
  await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  if (kind === "revocation")
    await f.service.requireSlackInstallationReauthorization(f.ingress.installationId, 1, "SLACK_TOKEN_REVOKED");
  else
    await f.service.unbindForAgent(f.account.userId, f.agent.id, {
      provider: "slack",
      bindingId: f.binding.imBindingId,
    });
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  await f.app().recoverOnce();
  expect(await f.receipt()).toMatchObject({ status: "processed", workPayload: null });
  expect(await f.client.database.select().from(imMessages)).toHaveLength(0);
});

it("clears expired work without changing legacy receipt retention", async () => {
  const f = await fixture();
  const receivedAt = new Date(f.clock.now);
  await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  const legacy = await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: "Ev_LEGACY",
  });
  f.clock.now = new Date(receivedAt.getTime() + 8 * 86_400_000);
  await runImDeliveryRetention(f.client.database, { ...resolveImDeliveryJanitorConfig({}), clock: () => f.clock.now });
  const rows = await f.client.database.select().from(slackWebhookReceipts);
  expect(rows.find((row) => row.eventId === f.event.event_id)).toMatchObject({
    status: "failed",
    lastErrorCode: "IM_INBOUND_WORK_EXPIRED",
    workPayload: null,
    receivedAt,
  });
  expect(rows.find((row) => row.id === legacy.receiptId)).toMatchObject({ status: "processing", attemptCount: 1 });
  await f.app().recoverOnce();
  expect(await f.client.database.select().from(imMessages)).toHaveLength(0);
  f.clock.now = new Date(receivedAt.getTime() + 31 * 86_400_000);
  await runImDeliveryRetention(f.client.database, { ...resolveImDeliveryJanitorConfig({}), clock: () => f.clock.now });
  expect((await f.client.database.select().from(slackWebhookReceipts)).map((row) => row.id)).toEqual([
    legacy.receiptId,
  ]);
});

it("retains the original ambient deadline when recovery occurs two days later", async () => {
  const f = await fixture();
  const receivedAt = new Date(f.clock.now);
  f.event.event.channel_type = "channel";
  f.event.event.channel = "C_WORK";
  await f.client.database.update(agents).set({ receiveMode: "all_message" }).where(eq(agents.id, f.agent.id));
  await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  f.clock.now = new Date(receivedAt.getTime() + 2 * 86_400_000);
  await f.app().recoverOnce();
  const [delivery] = await f.client.database.select().from(imMessageDeliveries);
  expect(delivery).toMatchObject({ attention: "ambient", expiresAt: new Date(receivedAt.getTime() + 86_400_000) });
  const [message] = await f.client.database.select().from(imMessages);
  expect(message?.receivedAt).toEqual(receivedAt);
});

it("does not take over a live lease even if its due-time hint is earlier", async () => {
  const f = await fixture();
  const accepted = await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  assert(accepted.receiptId);
  await f.client.database
    .update(slackWebhookReceipts)
    .set({ nextAttemptAt: new Date(f.clock.now.getTime() - 1_000) })
    .where(eq(slackWebhookReceipts.id, accepted.receiptId));
  expect(await f.receipts.recovery.claimNext()).toBeUndefined();
  expect(await f.receipt()).toMatchObject({ status: "processing", attemptCount: 1 });
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  expect(await f.receipts.recovery.claimNext()).toMatchObject({ receiptId: accepted.receiptId, attempt: 2 });
});

it("keeps retryable input through a shorter diagnostic receipt retention", async () => {
  const f = await fixture();
  const accepted = await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  assert(accepted.receiptId);
  await f.receipts.markFailed(accepted.receiptId, "TRANSIENT", 1);
  f.clock.now = new Date(f.clock.now.getTime() + 3_000);
  const options = {
    ...resolveImDeliveryJanitorConfig({ slackWebhookReceiptsRetentionMs: 1_000 }),
    clock: () => f.clock.now,
  };
  await runImDeliveryRetention(f.client.database, options);
  expect(await f.receipt()).toMatchObject({ status: "failed", attemptCount: 1 });
  await f.app().recoverOnce();
  expect(await f.receipt()).toMatchObject({ status: "processed", attemptCount: 2, workPayload: null });
  await runImDeliveryRetention(f.client.database, options);
  expect(await f.client.database.select().from(slackWebhookReceipts)).toHaveLength(0);
});

it("retains acknowledged input when one replica cannot read current credentials", async () => {
  const f = await fixture();
  await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  const unreadable = new ImBindingService(f.client.database, new ApplicationCipher(Buffer.alloc(32, 19)), {
    now: () => f.clock.now,
  });
  const server = Fastify({ logger: false });
  cleanup.push(() => server.close());
  const worker = registerSlackEventsRoute(server, {
    imBindings: unreadable,
    inbox: f.inbox,
    receipts: f.receipts,
    now: () => f.clock.now,
    createAdapter: () => f.adapter,
  });
  await worker.recoverOnce();
  expect(await f.receipt()).toMatchObject({ status: "failed", attemptCount: 2 });
  expect((await f.receipt()).workPayload).not.toBeNull();
  expect(await f.client.database.select().from(imMessages)).toHaveLength(0);
  f.clock.now = new Date(f.clock.now.getTime() + 5_000);
  await f.app().recoverOnce();
  expect(await f.receipt()).toMatchObject({ status: "processed", attemptCount: 3, workPayload: null });
  expect(await f.client.database.select().from(imMessages)).toHaveLength(1);
});

it("settles current-installation work once when required Slack bot permissions are missing", async () => {
  const f = await fixture();
  await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  await f.client.database
    .update(slackInstallations)
    .set({ grantedCapabilities: SLACK_REQUIRED_BOT_SCOPES.slice(1) })
    .where(eq(slackInstallations.id, f.ingress.installationId));
  await expect(f.service.findSlackInstallationIngress("A_WORK", "T_WORK")).resolves.toBeUndefined();
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  const app = f.app();
  await app.recoverOnce();
  const terminal = await f.receipt();
  expect(terminal).toMatchObject({
    status: "failed",
    attemptCount: 2,
    lastErrorCode: "SLACK_INBOUND_SCOPES_MISSING",
    workPayload: null,
    nextAttemptAt: null,
    leaseExpiresAt: null,
  });
  f.clock.now = new Date(f.clock.now.getTime() + 31_000);
  await app.recoverOnce();
  expect(await f.receipt()).toEqual(terminal);
  expect(await f.client.database.select().from(imMessages)).toHaveLength(0);
});

it("accepts the existing 1 MiB HTTP body limit with durable identity metadata", async () => {
  const f = await fixture();
  Reflect.deleteProperty(f.event.event, "token");
  f.event.event.text = "";
  const overhead = Buffer.byteLength(JSON.stringify(f.event));
  f.event.event.text = "x".repeat(1024 * 1024 - overhead);
  expect(Buffer.byteLength(JSON.stringify(f.event))).toBe(1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(f.work()))).toBeGreaterThan(1024 * 1024);
  const app = f.app();
  expect((await f.send(app.server)).statusCode).toBe(200);
  await expect.poll(async () => (await f.receipt()).status).toBe("processed");
  const [message] = await f.client.database.select().from(imMessages);
  expect(message?.content.truncated).toBe(true);
  expect(await f.receipt()).toMatchObject({ workPayload: null, attemptCount: 1 });
});

it.each(["live", "recovered"] as const)(
  "stops retrying permanently stale Slack routes in the %s path",
  async (path) => {
    const f = await fixture();
    const disableRoute = () =>
      f.client.database
        .update(imBindings)
        .set({ status: "disabled", disabledAt: f.clock.now })
        .where(eq(imBindings.id, f.binding.imBindingId));
    if (path === "live") {
      const observe = f.service.recordSlackInstallationIdentityClosure.bind(f.service);
      vi.spyOn(f.service, "recordSlackInstallationIdentityClosure").mockImplementationOnce(async (...args) => {
        const observed = await observe(...args);
        await disableRoute();
        return observed;
      });
      expect((await f.send(f.app().server)).statusCode).toBe(200);
      await expect.poll(async () => (await f.receipt()).status).toBe("failed");
    } else {
      await f.receipts.claim({
        installationId: f.ingress.installationId,
        credentialGeneration: 1,
        eventId: f.event.event_id,
        work: f.work(),
      });
      await disableRoute();
      f.clock.now = new Date(f.clock.now.getTime() + 61_000);
      await f.app().recoverOnce();
    }
    const terminal = await f.receipt();
    expect(terminal).toMatchObject({
      status: "failed",
      lastErrorCode: "IM_INBOUND_BINDING_STALE",
      workPayload: null,
      nextAttemptAt: null,
      leaseExpiresAt: null,
    });
    f.clock.now = new Date(f.clock.now.getTime() + 31_000);
    await f.app().recoverOnce();
    expect(await f.receipt()).toEqual(terminal);
    expect(await f.client.database.select().from(imMessages)).toHaveLength(0);
  },
);

it.each(["schema", "identity"] as const)("settles invalid persisted Slack work once (%s)", async (kind) => {
  const f = await fixture();
  const claim = await f.receipts.claim({
    installationId: f.ingress.installationId,
    credentialGeneration: 1,
    eventId: f.event.event_id,
    work: f.work(),
  });
  assert(claim.receiptId);
  const payload = kind === "schema" ? { version: 2 } : { ...f.work(), eventId: "Ev_OTHER" };
  await f.client.database
    .update(slackWebhookReceipts)
    .set({ workPayload: payload })
    .where(eq(slackWebhookReceipts.id, claim.receiptId));
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  await f.app().recoverOnce();
  const terminal = await f.receipt();
  expect(terminal).toMatchObject({
    status: "failed",
    lastErrorCode: "SLACK_INBOUND_WORK_INVALID",
    attemptCount: 2,
    workPayload: null,
    nextAttemptAt: null,
  });
  f.clock.now = new Date(f.clock.now.getTime() + 31_000);
  await f.app().recoverOnce();
  expect(await f.receipt()).toEqual(terminal);
  expect(await f.client.database.select().from(imMessages)).toHaveLength(0);
});
