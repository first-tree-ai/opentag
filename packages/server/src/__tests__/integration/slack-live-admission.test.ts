import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { registerSlackEventsRoute } from "../../api/slack-events.js";
import { createDatabaseClient } from "../../db/client.js";
import { imMessageDeliveries, imMessages, slackWebhookReceipts } from "../../db/schema/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { INBOUND_WORK_LEASE_MS } from "../../services/im/inbound-work.js";
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
  const client = createDatabaseClient(testDatabase.databaseUrl, {
    max: 4,
    statementTimeoutMs: 1500,
    queryTimeoutMs: 2500,
  });
  cleanup.push(() => client.sql.end({ timeout: 1 }));
  const service = new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
    now: () => value.clock.now,
  });
  return { ...value, client, service };
}

async function fixture() {
  const { client, clock, agent, service } = await baseFixture();
  await service.activateSlack(
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
  const adapter = new SlackAdapter({
    api: {} as never,
    token: ingress.botAccessToken,
    appId: ingress.appId,
    teamId: ingress.teamId,
    botUserId: ingress.botUserId,
    botId: ingress.botId,
  });
  const app = (inbox = new ImMessageInbox(client.database, { now: () => clock.now })) => {
    const server = Fastify({ logger: false });
    const controller = registerSlackEventsRoute(server, {
      imBindings: service,
      inbox,
      receipts: new SlackWebhookReceiptStore(client.database, { now: () => clock.now }),
      maxPendingEvents: 2,
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
  return { client, clock, agent, event, app, send };
}

it("bounds live Slack Inbox work and recovers acknowledged overflow from durable receipts", async () => {
  const f = await fixture();
  const inbox = new ImMessageInbox(f.client.database, { now: () => f.clock.now });
  const blockedInboxKey = `fixture-inbox:${f.agent.id}`;
  const ingest = inbox.ingest.bind(inbox);
  const blockedIngest = vi.spyOn(inbox, "ingest").mockImplementation(async (...args) => {
    await f.client.sql`select pg_advisory_xact_lock(hashtextextended(${blockedInboxKey}, 0))`;
    return ingest(...args);
  });
  cleanup.push(async () => blockedIngest.mockRestore());
  const app = f.app(inbox);
  const receivedAt = f.clock.now;
  const observer = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  cleanup.push(() => observer.sql.end({ timeout: 1 }));
  const admin = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  cleanup.push(() => admin.sql.end({ timeout: 1 }));
  let release!: () => void, held!: () => void;
  const wait = new Promise<void>((done) => {
      release = done;
    }),
    ready = new Promise<void>((done) => {
      held = done;
    });
  const holder = admin.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${blockedInboxKey}, 0))`;
    held();
    await wait;
  });
  await ready;
  try {
    for (let i = 0; i < 4; i++) {
      expect(
        (
          await f.send(app.server, {
            ...f.event,
            event_id: `Ev_POOL_${i}`,
            event: { ...f.event.event, ts: `${Math.floor(f.clock.now.getTime() / 1000)}.00000${i + 1}` },
          })
        ).statusCode,
      ).toBe(200);
      await expect
        .poll(
          async () => {
            const [r] =
              await observer.sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='advisory'`;
            return r?.n;
          },
          { timeout: 500, interval: 5 },
        )
        .toBe(Math.min(i + 1, 2));
    }
    expect(await f.client.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
    expect(await f.client.database.select().from(slackWebhookReceipts)).toHaveLength(4);
  } finally {
    release();
    await holder;
  }
  await expect
    .poll(
      async () =>
        (await f.client.database.select().from(slackWebhookReceipts)).filter((r) => r.status === "processed").length,
      { timeout: 3000 },
    )
    .toBe(2);
  f.clock.now = new Date(f.clock.now.getTime() + INBOUND_WORK_LEASE_MS + 1);
  await f.app().recoverOnce();
  const receipts = await f.client.database.select().from(slackWebhookReceipts);
  expect(receipts.every((row) => row.status === "processed")).toBe(true);
  expect(receipts.every((row) => row.receivedAt.getTime() === receivedAt.getTime())).toBe(true);
  expect(await f.client.database.select().from(imMessages)).toHaveLength(4);
  expect(await f.client.database.select().from(imMessageDeliveries)).toHaveLength(4);
  const duplicate = await f.send(app.server, {
    ...f.event,
    event_id: "Ev_POOL_2",
    event: { ...f.event.event, ts: `${Math.floor((f.clock.now.getTime() - INBOUND_WORK_LEASE_MS - 1) / 1000)}.000003` },
  });
  expect(duplicate.statusCode).toBe(200);
  expect(await f.client.database.select().from(imMessages)).toHaveLength(4);
});
