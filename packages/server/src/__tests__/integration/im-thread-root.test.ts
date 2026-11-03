import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type NormalizedInboundImEvent, type ProviderInboundContext, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imBindings, imMessageDeliveries, imMessages, sessions } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImMessageInbox } from "../../services/im/im-message-inbox.js";
import { threadRootExternalId } from "../../services/im/provider-thread-context.js";
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
  "preserves the complete late-root selection and ordering for %s",
  async (provider) => {
    const f = await fixture(provider);
    const root = "arriving-root";
    const rows: (typeof imMessages.$inferInsert)[] = [];
    const add = (
      threadKey: string | null,
      externalMessageId: string,
      at: number,
      rootId?: string,
      overrides: Partial<typeof imMessages.$inferInsert> = {},
    ) => {
      rows.push({
        id: `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`,
        imBindingId: f.bindingId,
        channelId: "channel",
        externalMessageId,
        providerRevisionKey: "1",
        direction: "inbound",
        operation: "created",
        authorKind: "human",
        authorExternalId: "human",
        content: f.event(externalMessageId, false, threadKey).message.content,
        providerContext: f.context(rootId),
        threadKey,
        occurredAt: new Date(now.getTime() + at),
        receivedAt: now,
        ...overrides,
      });
    };
    add("fallback", "fallback-anchor", 1, root);
    add("fallback", "fallback-missing", 2);
    add("fallback", "fallback-empty", 3, "");
    add("moved-root", "moved-old", 1, root);
    add("moved-root", "moved-new", 4, "other-root");
    add("cross", "cross-revision", 1, root);
    add("cross", "cross-anchor", 2, root);
    add("other-thread", "cross-revision", 4, "other-root", { providerRevisionKey: "2" });
    add("empty-shadow", "empty-revision", 1, root);
    add("", "empty-revision", 4, "other-root", { providerRevisionKey: "2" });
    add("uuid-root", "uuid-low", 10, root);
    add("uuid-root", "uuid-high", 10, "other-root");
    add("revision-root", "revision-low", 10, root, { providerRevisionKey: "10" });
    add("revision-root", "revision-high", 10, "other-root", { providerRevisionKey: "2" });
    add("ordered", "ordered-two", 10, root, { providerRevisionKey: "2" });
    add("ordered", "ordered-ten", 10, root, { providerRevisionKey: "10" });
    add("ordered", "ordered-tie", 10, root, { providerRevisionKey: "2" });
    add("whitespace", "whitespace-old", 1, root);
    add("whitespace", "whitespace-new", 4, ` ${root} `);
    add("before", "before-root", -1, root);
    add("before", "before-missing", 4);
    add("keep", "kept", 5, root);
    add("keep", "kept", 20, "other-root", { providerRevisionKey: "outbound", direction: "outbound" });
    add(null, "kept", 21, "other-root", { providerRevisionKey: "no-thread" });
    add("keep", "kept", 22, "other-root", { channelId: "other-channel" });
    const [binding] = await client.database.select().from(imBindings).where(eq(imBindings.id, f.bindingId));
    assert(binding);
    const [otherBinding] = await client.database
      .insert(imBindings)
      .values({ ...binding, id: randomUUID(), status: "disabled", encryptedCredential: null, disabledAt: now })
      .returning();
    assert(otherBinding);
    add("keep", "kept", 23, "other-root", { imBindingId: otherBinding.id });
    await client.database.insert(imMessages).values(rows);

    // Preserve the old selection as an independent oracle over the original SQL order.
    const original = await client.database
      .select()
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, f.bindingId),
          eq(imMessages.channelId, "channel"),
          eq(imMessages.direction, "inbound"),
          isNotNull(imMessages.threadKey),
          gte(imMessages.occurredAt, now),
        ),
      )
      .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id));
    const roots = new Map<string, string>();
    for (const row of original) {
      if (!row.threadKey || roots.has(row.threadKey)) continue;
      const value = threadRootExternalId(row.providerContext);
      if (value) roots.set(row.threadKey, value);
    }
    const seen = new Set<string>();
    const expected = original
      .filter((row) => {
        if (seen.has(row.externalMessageId)) return false;
        seen.add(row.externalMessageId);
        return true;
      })
      .reverse()
      .filter((row) => row.threadKey && roots.get(row.threadKey) === root);
    expect(expected.map((row) => row.externalMessageId)).toEqual([
      "fallback-anchor",
      "fallback-missing",
      "cross-anchor",
      "fallback-empty",
      "kept",
      "ordered-ten",
      "ordered-two",
      "ordered-tie",
    ]);
    const observed: { text: string; params: (string | number)[] }[] = [];
    const debug = client.sql.options.debug;
    client.sql.options.debug = (_id, text, parameters) => {
      if (text.includes('"ranked_thread_messages"')) {
        observed.push({ text, params: [...parameters] as (string | number)[] });
      }
    };
    const inbox = new ImMessageInbox(client.database, { now: () => now });
    try {
      await inbox.ingest(f.bindingId, 1, f.event(root, true, null));
    } finally {
      await inbox.close();
      client.sql.options.debug = debug;
    }
    expect(observed).toHaveLength(1);
    const query = observed[0];
    assert(query);
    const selected = await client.sql.unsafe<{ id: string }[]>(query.text, query.params);
    expect(selected.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    const delivered = await client.database
      .select({ messageId: imMessageDeliveries.messageId, attention: imMessageDeliveries.attention })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .where(and(eq(sessions.imBindingId, f.bindingId), eq(sessions.kind, "thread")));
    expect(delivered.map((row) => row.messageId).sort()).toEqual(expected.map((row) => row.id).sort());
    expect(delivered.every((row) => row.attention === "ambient")).toBe(true);
  },
);

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

it.each([0, 50000])(
  "materializes five late-root matches with %i unrelated payloads",
  async (size) => {
    const f = await fixture("feishu");
    const content = {
      ...f.event("sample", false, "thread").message.content,
      fallbackText: "x".repeat(1024),
      blocks: [{ type: "text", text: "x".repeat(1024) }],
    };
    await client.sql`insert into im_messages (im_binding_id, channel_id, external_message_id,
      provider_revision_key, operation, direction, thread_key, author_kind, author_external_id,
      content, provider_context, occurred_at, received_at)
    select ${f.bindingId}::uuid, 'channel', 'message-' || g::text, '1',
      'created'::im_message_operation, 'inbound'::im_message_direction,
      case when g <= 5 then 'matching-thread' else 'thread-' || g::text end,
      'human'::im_author_kind, 'human', ${JSON.stringify(content)}::jsonb,
      jsonb_build_object('provider', 'feishu', 'chatType', 'group', 'rootId',
        case when g <= 5 then 'arriving-root' else 'other-root-' || g::text end),
      ${now.toISOString()}::timestamptz + g * interval '1 millisecond', ${now.toISOString()}::timestamptz
    from generate_series(1, ${size + 5}::int) as g`;
    const observed: { text?: string; params?: (string | number)[]; control?: Promise<unknown> } = {};
    const debug = client.sql.options.debug;
    client.sql.options.debug = (_id, text, parameters) => {
      if (text.includes('"im_messages"."thread_key" is not null')) {
        observed.text = text;
        observed.params = [...parameters] as (string | number)[];
        observed.control = client.sql`select 1 as healthy`.then((rows) => rows);
      }
    };
    const inbox = new ImMessageInbox(client.database, { now: () => now });
    try {
      await inbox.ingest(f.bindingId, 1, f.event("arriving-root", true, null));
      expect(await observed.control).toEqual([{ healthy: 1 }]);
    } finally {
      await inbox.close();
      client.sql.options.debug = debug;
    }
    assert(observed.text && observed.params);
    const selected = await client.sql.unsafe<{ external_message_id: string }[]>(observed.text, observed.params);
    expect(selected.map((row) => row.external_message_id)).toEqual(
      Array.from({ length: 5 }, (_, index) => `message-${index + 1}`),
    );
    const threads = await client.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.imBindingId, f.bindingId), eq(sessions.kind, "thread")));
    expect(threads).toHaveLength(1);
  },
  40000,
);
