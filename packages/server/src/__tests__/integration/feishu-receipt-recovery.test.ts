import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { feishuInboundReceipts, imBindings, imMessageDeliveries, imMessages } from "../../db/schema/index.js";
import { ImMessageInbox } from "../../services/im/index.js";
import {
  type FeishuAdapter,
  type FeishuChannel,
  normalizeFeishuMessage,
} from "../../services/im-bindings/feishu/adapter.js";
import { FeishuConnectionManager } from "../../services/im-bindings/feishu/connection-manager.js";
import { FeishuInboundReceiptStore } from "../../services/im-bindings/feishu/inbound-receipt-store.js";
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

async function fixture() {
  const f = await createInboundFixture(testDatabase.databaseUrl);
  cleanup.push(f.close);
  const activation = {
    agentId: f.agent.id,
    appId: "cli_work",
    teamId: "tenant_work",
    botOpenId: "ou_bot",
    appSecret: "not-persisted-in-work",
    teamBrand: "feishu",
    grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
  };
  const bindingId = await f.service.activateFeishu(activation);
  const receipts = new FeishuInboundReceiptStore(f.client.database, { now: () => f.clock.now });
  const message = (eventId = "ev_work") => ({
    messageId: "om_work",
    chatId: "oc_work",
    chatType: "p2p",
    senderId: "ou_human",
    content: "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: f.clock.now.getTime(),
    raw: {
      header: { event_id: eventId, tenant_key: "tenant_work" },
      opentagSenderOpenId: "ou_human",
      token: "not-persisted-envelope-token",
    },
  });
  const manager = (client = f.client) => {
    let handlers: Parameters<FeishuChannel["on"]>[0] | undefined;
    const instanceId = randomUUID();
    const lookups: string[] = [];
    const store = new FeishuInboundReceiptStore(client.database, { now: () => f.clock.now });
    const owner = new FeishuConnectionManager({
      database: client.database,
      imBindings: f.service,
      inbox: new ImMessageInbox(client.database, { now: () => f.clock.now }),
      instanceId,
      receipts: store,
      leaseMs: 120_000,
      maintenanceMs: 60_000,
      now: () => f.clock.now,
      createAdapter: () =>
        ({
          channel: {
            on: (value: Parameters<FeishuChannel["on"]>[0]) => {
              handlers = value;
              return () => undefined;
            },
            connect: async () => undefined,
            disconnect: async () => undefined,
          },
          validateBinding: async () => ({
            externalAppId: activation.appId,
            externalTeamId: activation.teamId,
            externalBotId: activation.botOpenId,
          }),
          normalizeInbound: normalizeFeishuMessage,
          resolveSenderName: async (input: { chatId: string; senderOpenId: string }) => {
            lookups.push(input.senderOpenId);
            return undefined;
          },
        }) as unknown as FeishuAdapter,
    });
    cleanup.push(() => owner.stop());
    return {
      lookups,
      hasHandlers: () => handlers !== undefined,
      owner,
      store,
      instanceId,
      handlers: () => {
        assert(handlers);
        return handlers;
      },
    };
  };
  const receipt = async () => {
    const [row] = await f.client.database.select().from(feishuInboundReceipts);
    assert(row);
    return row;
  };
  const connect = async (value: ReturnType<typeof manager>) => {
    value.owner.start();
    await expect
      .poll(
        async () => {
          const [row] = await f.client.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
          return row?.connectionOwnerInstanceId === value.instanceId && value.hasHandlers();
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  };
  return { ...f, activation, bindingId, receipts, message, manager, receipt, connect };
}

async function failNextIngress(f: Awaited<ReturnType<typeof fixture>>) {
  await f.client.sql.unsafe(
    "create function fail_feishu_ingress() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure' using errcode='40001'; end $$",
  );
  await f.client.sql.unsafe(
    "create trigger fail_feishu_ingress before insert on im_messages for each row execute function fail_feishu_ingress()",
  );
  return async () => {
    await f.client.sql.unsafe("drop trigger fail_feishu_ingress on im_messages");
    await f.client.sql.unsafe("drop function fail_feishu_ingress()");
  };
}

it("recovers through a new connection owner after receipt persistence and an Inbox failure", async () => {
  const f = await fixture();
  const receivedAt = new Date(f.clock.now);
  const first = f.manager();
  await f.connect(first);
  const restore = await failNextIngress(f);
  try {
    await expect(first.handlers().message?.(f.message() as never)).rejects.toBeDefined();
    expect(await f.receipt()).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(JSON.stringify((await f.receipt()).workPayload)).not.toContain("not-persisted");
  } finally {
    await restore();
  }
  await first.owner.stop();
  f.clock.now = new Date(receivedAt.getTime() + 3_000);
  const replicaClient = createDatabaseClient(testDatabase.databaseUrl, { max: 2 });
  cleanup.push(() => replicaClient.sql.end());
  const second = f.manager(replicaClient);
  await f.connect(second);
  await expect
    .poll(async () => {
      await second.owner.maintain();
      return (await f.receipt()).status;
    })
    .toBe("processed");
  expect(await f.receipt()).toMatchObject({ attemptCount: 2, workPayload: null, receivedAt });
  const messages = await f.client.database.select().from(imMessages);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.receivedAt).toEqual(receivedAt);
  expect(await f.client.database.select().from(imMessageDeliveries)).toHaveLength(1);
  await expect(first.handlers().message?.(f.message("ev_old_owner") as never)).rejects.toMatchObject({
    code: "FEISHU_INBOUND_FENCE_STALE",
  });
  expect(await f.client.database.select().from(feishuInboundReceipts)).toHaveLength(1);
  await second.handlers().message?.(f.message() as never);
  expect(await f.client.database.select().from(imMessages)).toHaveLength(1);
});

it("does not claim recoverable input without the current Feishu connection fence", async () => {
  const f = await fixture();
  const current = f.manager();
  await f.connect(current);
  const [event] = normalizeFeishuMessage({
    appId: f.activation.appId,
    teamId: f.activation.teamId,
    message: f.message() as never,
  });
  assert(event);
  await expect(
    f.receipts.claim({
      bindingId: f.bindingId,
      credentialGeneration: 1,
      eventId: "ev_work",
      work: { version: 1, provider: "feishu", event },
      fence: { holderInstanceId: randomUUID(), fencingEpoch: 1 },
    }),
  ).rejects.toMatchObject({ code: "FEISHU_INBOUND_FENCE_STALE" });
  expect(await f.client.database.select().from(feishuInboundReceipts)).toHaveLength(0);
  expect(await f.receipts.recovery.claimNext({ holderInstanceId: randomUUID() })).toBeUndefined();
});

it("discards the original generation after credential rotation instead of restoring it", async () => {
  const f = await fixture();
  const current = f.manager();
  await f.connect(current);
  const restore = await failNextIngress(f);
  try {
    await expect(current.handlers().message?.(f.message() as never)).rejects.toBeDefined();
  } finally {
    await restore();
  }
  await f.service.activateFeishu({ ...f.activation, appSecret: "rotated-secret" });
  f.clock.now = new Date(f.clock.now.getTime() + 3_000);
  await expect
    .poll(async () => {
      await current.owner.maintain();
      return (await f.receipt()).workPayload;
    })
    .toBeNull();
  expect(await f.receipt()).toMatchObject({ status: "failed", credentialGeneration: 1 });
  expect(await f.client.database.select().from(imMessages)).toHaveLength(0);
});

it("recovers a processing receipt after Inbox committed but its status update failed", async () => {
  const f = await fixture();
  const first = f.manager();
  await f.connect(first);
  await f.client.sql.unsafe(
    "create function fail_receipt_completion() returns trigger language plpgsql as $$ begin if new.status = 'processed' then raise exception 'synthetic receipt failure' using errcode='40001'; end if; return new; end $$",
  );
  await f.client.sql.unsafe(
    "create trigger fail_receipt_completion before update on feishu_inbound_receipts for each row execute function fail_receipt_completion()",
  );
  try {
    await expect(first.handlers().message?.(f.message() as never)).rejects.toBeDefined();
    expect(await f.receipt()).toMatchObject({ status: "processing", attemptCount: 1 });
    expect(await f.client.database.select().from(imMessages)).toHaveLength(1);
  } finally {
    await f.client.sql.unsafe("drop trigger fail_receipt_completion on feishu_inbound_receipts");
    await f.client.sql.unsafe("drop function fail_receipt_completion()");
  }
  await first.owner.stop();
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  const second = f.manager();
  await f.connect(second);
  await expect
    .poll(async () => {
      await second.owner.maintain();
      return (await f.receipt()).status;
    })
    .toBe("processed");
  expect(await f.receipt()).toMatchObject({ attemptCount: 2, workPayload: null });
  expect(await f.client.database.select().from(imMessages)).toHaveLength(1);
  expect(await f.client.database.select().from(imMessageDeliveries)).toHaveLength(1);
});

it("keeps binding/event deduplication across generations and fences receipt attempt takeover", async () => {
  const f = await fixture();
  const holderInstanceId = randomUUID();
  const fence = { holderInstanceId, fencingEpoch: 3 };
  await f.client.database
    .update(imBindings)
    .set({
      connectionOwnerInstanceId: holderInstanceId,
      connectionFencingEpoch: 3,
      connectionLeaseExpiresAt: new Date(f.clock.now.getTime() + 600_000),
    })
    .where(eq(imBindings.id, f.bindingId));
  const [event] = normalizeFeishuMessage({
    appId: f.activation.appId,
    teamId: f.activation.teamId,
    message: f.message() as never,
  });
  assert(event);
  const input = {
    bindingId: f.bindingId,
    credentialGeneration: 1,
    eventId: "ev_work",
    fence,
    work: { version: 1 as const, provider: "feishu" as const, event },
  };
  const other = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  cleanup.push(() => other.sql.end());
  const replica = new FeishuInboundReceiptStore(other.database, { now: () => f.clock.now });
  const initial = await Promise.all([f.receipts.claim(input), replica.claim(input)]);
  expect(initial.filter((row) => row.accepted)).toHaveLength(1);
  expect(initial.filter((row) => row.duplicate)).toHaveLength(1);
  expect(await f.receipts.recovery.claimNext({ holderInstanceId })).toBeUndefined();
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  const claims = await Promise.all([
    f.receipts.recovery.claimNext({ holderInstanceId }),
    replica.recovery.claimNext({ holderInstanceId }),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const attempt = claims.find(Boolean);
  assert(attempt);
  await f.receipts.markProcessed(attempt.receiptId, 1);
  expect(await f.receipt()).toMatchObject({ status: "processing", attemptCount: 2 });
  await replica.markProcessed(attempt.receiptId, attempt.attempt);
  await f.service.activateFeishu({ ...f.activation, appSecret: "rotated" });
  await f.client.database
    .update(imBindings)
    .set({
      connectionOwnerInstanceId: holderInstanceId,
      connectionFencingEpoch: 4,
      connectionLeaseExpiresAt: new Date(f.clock.now.getTime() + 600_000),
    })
    .where(eq(imBindings.id, f.bindingId));
  expect(
    await f.receipts.claim({ ...input, credentialGeneration: 2, fence: { ...fence, fencingEpoch: 4 } }),
  ).toMatchObject({ duplicate: true, accepted: false });
  expect(await f.client.database.select().from(feishuInboundReceipts)).toHaveLength(1);
});

it("finishes a normal self-message receipt without turning it into delivery success", async () => {
  const f = await fixture();
  const current = f.manager();
  await f.connect(current);
  const source = f.message();
  await current.handlers().message?.({
    ...source,
    senderId: "ou_bot",
    raw: { ...source.raw, event: { sender: { sender_type: "app" } } },
  } as never);
  expect(await f.receipt()).toMatchObject({ status: "processed", workPayload: null });
  expect(await f.client.database.select().from(imMessages)).toHaveLength(0);
  expect(await f.client.database.select().from(imMessageDeliveries)).toHaveLength(0);
});

it("does not add sender-name lookups when the original SDK input had no sender Open ID", async () => {
  const f = await fixture();
  const current = f.manager();
  await f.connect(current);
  const source = f.message();
  const { opentagSenderOpenId: _senderOpenId, ...raw } = source.raw;
  const restore = await failNextIngress(f);
  try {
    await expect(current.handlers().message?.({ ...source, raw } as never)).rejects.toBeDefined();
  } finally {
    await restore();
  }
  f.clock.now = new Date(f.clock.now.getTime() + 3_000);
  await expect
    .poll(async () => {
      await current.owner.maintain();
      return (await f.receipt()).status;
    })
    .toBe("processed");
  expect(current.lookups).toEqual([]);
});
