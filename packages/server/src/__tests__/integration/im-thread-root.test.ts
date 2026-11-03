import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type NormalizedInboundImEvent, type ProviderInboundContext, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imBindings, imMessageDeliveries, imMessages, sessions } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImMessageInbox } from "../../services/im/im-message-inbox.js";
import { ImBindingService } from "../../services/im-bindings/im-binding-service.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase, client: ReturnType<typeof createDatabaseClient>;
const now = new Date("2026-11-03T00:00:00Z");
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
  client = createDatabaseClient(pg.databaseUrl, { max: 1 });
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => {
  await client?.sql.end();
  await pg?.stop();
});

async function fixture(provider: "slack" | "feishu") {
  const { userId } = await bootstrapInitialAdmin(client.database, { email: "root@example.test", displayName: "Root" });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: userId,
      currentInstallationId: randomUUID(),
      displayName: "Root",
      platform: "linux",
      arch: "arm64",
      clientVersion: "0.0.1",
    })
    .returning();
  assert(computer);
  const agent = await new AgentService(client.database).createForAccount(userId, {
    name: "root",
    displayName: "Root",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  await new AgentService(client.database).updateById(userId, agent.id, {
    expectedRevision: agent.revision,
    receiveMode: "mention_only",
  });
  let bindingId: string;
  if (provider === "slack") {
    const bindings = new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
      now: () => now,
      imCliReadiness: () => "ready",
      credentialExecutionReadiness: () => ({ status: "ready" }),
    });
    const activated = await bindings.activateSlack(
      {
        intent: "create",
        agentId: agent.id,
        appId: "app",
        teamId: "team",
        botUserId: "bot",
        grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        botAccessToken: "xoxb-fixture",
        signingSecret: "fixture",
        installedAt: now,
      },
      "external-bot",
    );
    await bindings.recordSlackIdentityClosure(activated.imBindingId, activated.credentialGeneration);
    bindingId = activated.imBindingId;
  } else {
    const [binding] = await client.database
      .insert(imBindings)
      .values({
        agentId: agent.id,
        provider,
        status: "active",
        externalAppId: "app",
        externalBotId: "bot",
        externalTeamBrand: "feishu",
        externalTeamId: "team",
        credentialSchemaVersion: 1,
        credentialGeneration: 1,
        encryptedCredential: "unused-fixture",
        activatedAt: now,
      })
      .returning();
    assert(binding);
    bindingId = binding.id;
  }
  const context = (root?: string): ProviderInboundContext =>
    provider === "slack"
      ? { provider, channelType: "channel", ...(root === undefined ? {} : { threadTs: root }) }
      : { provider, chatType: "group", ...(root === undefined ? {} : { rootId: root }) };
  const event = (id: string, direct: boolean, thread: string | null): NormalizedInboundImEvent => ({
    providerEventId: id,
    externalAppId: "app",
    externalTeamId: "team",
    providerContext: context(),
    conversation: { externalId: "channel", kind: "channel" },
    message: {
      externalId: id,
      revisionKey: "1",
      operation: "created",
      threadKey: thread,
      replyToExternalId: null,
      author: { externalId: "human", kind: "human", displayName: "Human" },
      occurredAt: now,
      content: { version: 1, fallbackText: "Root", blocks: [{ type: "text", text: "Root" }], truncated: false },
      resources: [],
    },
    mentions: direct ? [{ externalId: "bot", displayName: "Bot" }] : [],
  });
  return { bindingId, context, event };
}

it.each(["slack", "feishu"] as const)(
  "selects one materialized root under large %s history and tied ordering",
  async (provider) => {
    const f = await fixture(provider);
    const inbox = new ImMessageInbox(client.database, { now: () => now });
    await inbox.ingest(f.bindingId, 1, f.event("root-direct", true, null));
    const content = f.event("sample", false, "thread").message.content;
    await client.database.insert(imMessages).values(
      Array.from({ length: 1000 }, (_, i) => ({
        imBindingId: f.bindingId,
        channelId: "channel",
        externalMessageId: `missing-${i}`,
        providerRevisionKey: "1",
        providerContext: f.context(i % 2 ? "" : undefined),
        direction: "inbound" as const,
        operation: "created" as const,
        authorKind: "human" as const,
        authorExternalId: "human",
        content,
        threadKey: "thread",
        occurredAt: new Date(now.getTime() + i),
      })),
    );
    const candidates = [
      { id: "00000000-0000-4000-8000-000000000001", root: "not-direct", revision: "9", at: -10 },
      { id: "00000000-0000-4000-8000-000000000002", root: "not-direct", revision: "2", at: 0 },
      { id: "00000000-0000-4000-8000-000000000003", root: "root-direct", revision: "2", at: 0 },
    ];
    await client.database.insert(imMessages).values(
      candidates.map((c) => ({
        id: c.id,
        imBindingId: f.bindingId,
        channelId: "channel",
        externalMessageId: c.id,
        providerRevisionKey: c.revision,
        providerContext: f.context(c.root),
        direction: "inbound" as const,
        operation: "created" as const,
        authorKind: "human" as const,
        authorExternalId: "human",
        content,
        threadKey: "thread",
        occurredAt: new Date(now.getTime() + c.at),
      })),
    );
    await checkLookup(f, 1);
  },
);

it.each(["slack", "feishu"] as const)("keeps newest-time and revision ordering for %s roots", async (provider) => {
  const f = await fixture(provider);
  await new ImMessageInbox(client.database, { now: () => now }).ingest(
    f.bindingId,
    1,
    f.event("root-direct", true, null),
  );
  const content = f.event("sample", false, "thread").message.content;
  await client.database.insert(imMessages).values([
    {
      imBindingId: f.bindingId,
      channelId: "channel",
      externalMessageId: "old",
      providerRevisionKey: "99",
      providerContext: f.context("root-direct"),
      direction: "inbound",
      operation: "created",
      authorKind: "human",
      authorExternalId: "human",
      content,
      threadKey: "thread",
      occurredAt: new Date(now.getTime() - 1000),
    },
    {
      imBindingId: f.bindingId,
      channelId: "channel",
      externalMessageId: "new-low",
      providerRevisionKey: "1",
      providerContext: f.context("root-direct"),
      direction: "inbound",
      operation: "created",
      authorKind: "human",
      authorExternalId: "human",
      content,
      threadKey: "thread",
      occurredAt: now,
    },
    {
      imBindingId: f.bindingId,
      channelId: "channel",
      externalMessageId: "new-high",
      providerRevisionKey: "2",
      providerContext: f.context("not-direct"),
      direction: "inbound",
      operation: "created",
      authorKind: "human",
      authorExternalId: "human",
      content,
      threadKey: "thread",
      occurredAt: now,
    },
  ]);
  await checkLookup(f, 0);
});

it.each(["slack", "feishu"] as const)("keeps missing-root fallback and scoped predicates for %s", async (provider) => {
  const f = await fixture(provider);
  const content = f.event("sample", false, "thread").message.content;
  await client.database.insert(imMessages).values([
    {
      imBindingId: f.bindingId,
      channelId: "channel",
      externalMessageId: "missing",
      providerRevisionKey: "1",
      providerContext: f.context(),
      direction: "inbound",
      operation: "created",
      authorKind: "human",
      authorExternalId: "human",
      content,
      threadKey: "thread",
      occurredAt: now,
    },
    {
      imBindingId: f.bindingId,
      channelId: "other",
      externalMessageId: "wrong-channel",
      providerRevisionKey: "1",
      providerContext: f.context("wrong"),
      direction: "inbound",
      operation: "created",
      authorKind: "human",
      authorExternalId: "human",
      content,
      threadKey: "thread",
      occurredAt: now,
    },
    {
      imBindingId: f.bindingId,
      channelId: "channel",
      externalMessageId: "wrong-thread",
      providerRevisionKey: "1",
      providerContext: f.context("wrong"),
      direction: "inbound",
      operation: "created",
      authorKind: "human",
      authorExternalId: "human",
      content,
      threadKey: "other",
      occurredAt: now,
    },
    {
      imBindingId: f.bindingId,
      channelId: "channel",
      externalMessageId: "outbound",
      providerRevisionKey: "1",
      providerContext: f.context("wrong"),
      direction: "outbound",
      operation: "created",
      authorKind: "bot",
      authorExternalId: "bot",
      content,
      threadKey: "thread",
      occurredAt: now,
    },
  ]);
  await checkLookup(f, 0, 0);
});

async function checkLookup(f: Awaited<ReturnType<typeof fixture>>, expectedThread: number, materialized = 1) {
  const observed: { query?: { text: string; params: (string | number)[] } } = {};
  let reading = false;
  const debug = client.sql.options.debug;
  client.sql.options.debug = (_id, text, parameters) => {
    if (reading && !observed.query) observed.query = { text, params: [...parameters] as (string | number)[] };
  };
  try {
    const inbox = new ImMessageInbox(client.database, {
      now: () => now,
      beforeReliableThreadRootLookup: () => {
        reading = true;
      },
    });
    const result = await inbox.ingest(f.bindingId, 1, f.event("thread-input", false, "thread"));
    const delivered = await client.database
      .select({ id: sessions.id })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .where(and(inArray(imMessageDeliveries.id, result.deliveryIds), eq(sessions.kind, "thread")));
    expect(delivered).toHaveLength(expectedThread);
  } finally {
    client.sql.options.debug = debug;
  }
  assert(observed.query, "Actual root lookup did not run");
  const [plan] = await client.sql.unsafe<{ "QUERY PLAN": { Plan: { "Actual Rows": number } }[] }[]>(
    `explain (analyze, format json) ${observed.query.text}`,
    observed.query.params,
  );
  expect(plan?.["QUERY PLAN"][0]?.Plan["Actual Rows"]).toBe(materialized);
}
