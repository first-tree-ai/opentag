import type { ProviderInboundContext } from "@opentag/shared";
import { count, eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient, type DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessions,
  users,
} from "../../db/schema/index.js";
import type { AuthServiceError } from "../../services/auth/index.js";
import {
  ImOutboundCapture,
  OUTBOUND_CREATED_REVISION_KEY,
  type OutboundCaptureEvent,
} from "../../services/im/im-outbound-capture.js";
import { ImMessageInbox } from "../../services/im/index.js";
import { normalizeFeishuMessage } from "../../services/im-bindings/feishu/index.js";
import { TaskService } from "../../services/tasks/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const OBSERVED_AT = new Date("2026-09-22T02:00:00.000Z");

async function accountFixture(displayName = "Admin", email = "admin@example.com") {
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, { displayName, email });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const [agent] = await client.database
    .insert(agents)
    .values({
      createdByUserId: bootstrap.userId,
      computerId: computer.id,
      name: "atlas",
      displayName: "Atlas",
      runtimeProvider: "codex",
    })
    .returning();
  if (!agent) throw new Error("Agent fixture was not created");
  return { ...client, agent, bootstrap };
}

async function bind(
  database: DatabaseClient,
  agentId: string,
  provider: "feishu" | "slack",
  externalBotId: string | null,
) {
  const [binding] = await database.insert(imBindings).values({ agentId, provider, externalBotId }).returning();
  if (!binding) throw new Error("IM Binding fixture was not created");
  return binding;
}

async function inboundMessage(
  database: DatabaseClient,
  input: {
    bindingId: string;
    channelId: string;
    externalMessageId: string;
    threadKey?: string;
    providerContext?: ProviderInboundContext;
    occurredAt: Date;
  },
) {
  const [message] = await database
    .insert(imMessages)
    .values({
      imBindingId: input.bindingId,
      providerEventId: `event-${input.externalMessageId}`,
      channelId: input.channelId,
      externalMessageId: input.externalMessageId,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      threadKey: input.threadKey ?? null,
      authorKind: "human",
      authorExternalId: "ou_human",
      authorDisplayName: "Mia",
      content: { version: 1, fallbackText: `Request ${input.externalMessageId}`, blocks: [], truncated: false },
      providerContext: input.providerContext ?? { provider: "feishu", chatType: "p2p" },
      occurredAt: input.occurredAt,
    })
    .returning();
  if (!message) throw new Error("IM Message fixture was not created");
  return message;
}

function slackSend(messageId: string, text: string, extra: Partial<OutboundCaptureEvent> = {}): OutboundCaptureEvent {
  return {
    provider: "slack",
    operationId: "chat.postMessage",
    bindingId: "",
    pathParams: {},
    query: "",
    requestBody: { channel: "C0CHAT", text },
    responsePayload: {
      ok: true,
      channel: "C0CHAT",
      ts: messageId,
      message: { type: "message", subtype: "bot_message", bot_id: "B0BOT", text },
    },
    observedAt: OBSERVED_AT,
    ...extra,
  };
}

async function outboundRows(database: DatabaseClient, bindingId: string) {
  return database.select().from(imMessages).where(eq(imMessages.imBindingId, bindingId));
}

/**
 * The runtime tables a reply read must never consult. It reads chat Sessions, because a Task is one,
 * but never a Sandbox, a collaboration message, or runtime execution state.
 */
const RUNTIME_TABLE_READ =
  /\b(?:from|join)\s+(?:"?\w+"?\.)?"?(?:sandboxes|session_messages|cloud_runs|runtime_instances)\b/i;

/** Chat Sessions exist before any message these tests store, so ownership by time is unambiguous. */
const SESSION_CREATED_AT = new Date("2026-09-01T00:00:00.000Z");

async function chatSession(
  database: DatabaseClient,
  input: {
    bindingId: string;
    channelId: string;
    conversationKind?: "channel" | "dm";
    threadKey?: string;
    createdAt?: Date;
  },
) {
  const [session] = await database
    .insert(sessions)
    .values({
      imBindingId: input.bindingId,
      channelId: input.channelId,
      conversationKind: input.conversationKind ?? "channel",
      kind: input.threadKey ? "thread" : "channel",
      threadKey: input.threadKey ?? null,
      createdAt: input.createdAt ?? SESSION_CREATED_AT,
    })
    .returning();
  if (!session) throw new Error("Session fixture was not created");
  return session;
}

/** A TaskService whose reads record their SQL, so a test can prove what the query touches. */
function tracedService(database: DatabaseClient) {
  const statements: string[] = [];
  const dialect = new PgDialect();
  const traced = (executor: DatabaseClient | DatabaseTransaction): DatabaseClient | DatabaseTransaction =>
    new Proxy(executor, {
      get(target, property) {
        if (property === "execute") {
          return (query: SQL) => {
            statements.push(dialect.sqlToQuery(query).sql);
            return target.execute(query);
          };
        }
        const value = Reflect.get(target, property);
        if (property === "transaction") {
          return (read: (transaction: DatabaseTransaction) => Promise<unknown>, options: unknown) =>
            Reflect.apply(value, target, [
              (transaction: DatabaseTransaction) => read(traced(transaction) as DatabaseTransaction),
              options,
            ]);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return { service: new TaskService(traced(database) as DatabaseClient), statements };
}

describe("ImOutboundCapture persistence", () => {
  it("persists a confirmed send once, keeps the same text under a different native id", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "slack", "B0BOT");
    const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT });

    const send = slackSend("1790042400.000100", "Confirmed reply");
    await capture.capture({ ...send, bindingId: binding.id });
    await capture.capture({ ...send, bindingId: binding.id });
    await capture.capture({ ...slackSend("1790042401.000200", "Confirmed reply"), bindingId: binding.id });

    const rows = await outboundRows(value.database, binding.id);
    expect(rows).toHaveLength(2);
    const first = rows.find((row) => row.externalMessageId === "1790042400.000100");
    expect(first).toMatchObject({
      imBindingId: binding.id,
      providerEventId: null,
      channelId: "C0CHAT",
      providerRevisionKey: OUTBOUND_CREATED_REVISION_KEY,
      operation: "created",
      direction: "outbound",
      authorKind: "bot",
      authorExternalId: "B0BOT",
    });
    expect(first?.occurredAt.toISOString()).toBe("2026-09-22T02:00:00.000Z");
    expect(first?.content.outbound).toEqual({
      messageType: "bot_message",
      contentAvailable: true,
      timeSource: "provider",
    });
    // The captured record stores no URL, handle, or credential — only extracted display fields.
    expect(JSON.stringify(first?.content)).not.toContain("http");
    await value.sql.end();
  });

  it("creates no delivery, Session, or inbox side effect", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "slack", "B0BOT");
    const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT });

    await capture.capture({ ...slackSend("1790042400.000100", "Confirmed reply"), bindingId: binding.id });

    const [deliveryRow] = await value.database.select({ value: count() }).from(imMessageDeliveries);
    const [sessionRow] = await value.database.select({ value: count() }).from(sessions);
    expect(deliveryRow?.value).toBe(0);
    expect(sessionRow?.value).toBe(0);
    await value.sql.end();
  });

  it("a capture database failure is swallowed by the isolation boundary", async () => {
    const value = await accountFixture();
    await value.sql.end();
    const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT });
    // The database is gone; capture() must still resolve so the confirmed send stands.
    await expect(
      capture.capture({ ...slackSend("1790042400.000100", "x"), bindingId: crypto.randomUUID() }),
    ).resolves.toBeUndefined();
  });

  it("uses the response-confirmed bot identity only when the binding has none, and skips when neither exists", async () => {
    const value = await accountFixture();
    const withoutBot = await bind(value.database, value.agent.id, "slack", null);
    const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT });

    await capture.capture({ ...slackSend("1790042400.000100", "Confirmed"), bindingId: withoutBot.id });
    let rows = await outboundRows(value.database, withoutBot.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authorExternalId).toBe("B0BOT");

    const noIdentity = slackSend("1790042402.000300", "Confirmed");
    const payload = noIdentity.responsePayload as { message: Record<string, unknown> };
    delete payload.message.bot_id;
    delete payload.message.user;
    await capture.capture({ ...noIdentity, bindingId: withoutBot.id });
    rows = await outboundRows(value.database, withoutBot.id);
    expect(rows).toHaveLength(1);
    await value.sql.end();
  });

  it("resolves a Feishu reply's thread from the locally stored same-binding parent", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "feishu", "ou_bot");
    const parent = await inboundMessage(value.database, {
      bindingId: binding.id,
      channelId: "oc_chat",
      externalMessageId: "om_root",
      occurredAt: new Date("2026-09-22T01:00:00.000Z"),
    });
    const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT });

    await capture.capture({
      provider: "feishu",
      operationId: "feishu.im.messages.reply",
      bindingId: binding.id,
      pathParams: { message_id: "om_root" },
      query: "",
      requestBody: { msg_type: "text", content: '{"text":"reply"}' },
      responsePayload: {
        code: 0,
        data: {
          message_id: "om_reply",
          chat_id: "oc_chat",
          msg_type: "text",
          create_time: "1790042400000",
          body: { content: '{"text":"reply"}' },
        },
      },
      observedAt: OBSERVED_AT,
    });

    const rows = await outboundRows(value.database, binding.id);
    const replyRow = rows.find((row) => row.externalMessageId === "om_reply");
    expect(replyRow?.threadKey).toBe(parent.externalMessageId);
    expect(replyRow?.replyToExternalId).toBe("om_root");
    expect(replyRow?.providerContext).toMatchObject({ provider: "feishu", rootId: "om_root", parentId: "om_root" });
    await value.sql.end();
  });
});

describe("Task replies subresource", () => {
  async function dmTask() {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "slack", "B0BOT");
    // A private chat is one Task: its channel Session.
    const session = await chatSession(value.database, {
      bindingId: binding.id,
      channelId: "D0DM",
      conversationKind: "dm",
    });
    const anchor = await inboundMessage(value.database, {
      bindingId: binding.id,
      channelId: "D0DM",
      externalMessageId: "1790000000.000001",
      providerContext: { provider: "slack", channelType: "im" },
      occurredAt: new Date("2026-09-22T01:00:00.000Z"),
    });
    return { ...value, binding, anchor, session, service: new TaskService(value.database) };
  }

  async function captureOutbound(
    database: DatabaseClient,
    bindingId: string,
    messageId: string,
    text: string,
    options: { channelId?: string; threadTs?: string } = {},
  ) {
    const channelId = options.channelId ?? "D0DM";
    const capture = new ImOutboundCapture(database, { now: () => OBSERVED_AT });
    await capture.capture({
      ...slackSend(messageId, text),
      bindingId,
      requestBody: { channel: channelId, text, ...(options.threadTs ? { thread_ts: options.threadTs } : {}) },
      responsePayload: {
        ok: true,
        channel: channelId,
        ts: messageId,
        message: {
          type: "message",
          bot_id: "B0BOT",
          text,
          ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
        },
      },
    });
  }

  async function captureFeishuReply(
    database: DatabaseClient,
    bindingId: string,
    input: {
      messageId: string;
      chatId: string;
      text: string;
      rootId?: string;
      parentId?: string;
      threadId?: string;
      createTime?: string;
      observedAt?: Date;
    },
  ) {
    const observedAt = input.observedAt ?? OBSERVED_AT;
    const capture = new ImOutboundCapture(database, { now: () => observedAt });
    await capture.capture({
      provider: "feishu",
      operationId: "feishu.im.messages.reply",
      bindingId,
      pathParams: { message_id: input.parentId ?? input.rootId ?? "om_anchor" },
      query: "",
      requestBody: {},
      responsePayload: {
        code: 0,
        data: {
          message_id: input.messageId,
          chat_id: input.chatId,
          ...(input.rootId ? { root_id: input.rootId } : {}),
          ...(input.parentId ? { parent_id: input.parentId } : {}),
          ...(input.threadId ? { thread_id: input.threadId } : {}),
          ...(input.createTime ? { create_time: input.createTime } : {}),
          msg_type: "text",
          body: { content: JSON.stringify({ text: input.text }) },
        },
      },
      observedAt,
    });
  }

  it("lists only the Task scope's outbound messages, newest first, with an independent cursor", async () => {
    const value = await dmTask();
    await captureOutbound(value.database, value.binding.id, "1790042400.000100", "First reply");
    await captureOutbound(value.database, value.binding.id, "1790042460.000200", "Second reply");
    await captureOutbound(value.database, value.binding.id, "1790042520.000300", "Third reply");
    const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT });
    await capture.capture({
      ...slackSend("1790042580.000400", "Other channel"),
      bindingId: value.binding.id,
      requestBody: { channel: "D0OTHER" },
      responsePayload: {
        ok: true,
        channel: "D0OTHER",
        ts: "1790042580.000400",
        message: { type: "message", bot_id: "B0BOT", text: "Other channel" },
      },
    });

    const firstPage = await value.service.listReplies(value.bootstrap.userId, value.anchor.id, { limit: 2 });
    // Reading creates nothing: the only Session is the fixture's, and no delivery exists.
    const [sessionRow] = await value.database.select({ value: count() }).from(sessions);
    const [deliveryRow] = await value.database.select({ value: count() }).from(imMessageDeliveries);
    expect(sessionRow?.value).toBe(1);
    expect(deliveryRow?.value).toBe(0);
    // The Session id and the anchor message id name the same Task.
    const bySession = await value.service.listReplies(value.bootstrap.userId, value.session.id, { limit: 2 });
    expect(firstPage.items.map((item) => item.fallbackText)).toEqual(["Third reply", "Second reply"]);
    expect(bySession.items.map((item) => item.fallbackText)).toEqual(["Third reply", "Second reply"]);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.items[0]).toMatchObject({
      provider: "slack",
      channelId: "D0DM",
      externalMessageId: "1790042520.000300",
      authorKind: "bot",
      contentAvailable: true,
      truncated: false,
      timeSource: "provider",
      messageType: "message",
    });

    const secondPage = await value.service.listReplies(value.bootstrap.userId, value.anchor.id, {
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.items.map((item) => item.fallbackText)).toEqual(["First reply"]);
    expect(secondPage.nextCursor).toBeNull();
    await value.sql.end();
  });

  it("resolves the scope and reads replies without touching runtime state", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "feishu", "ou_bot");
    await chatSession(value.database, { bindingId: binding.id, channelId: "oc_trace_group" });
    const anchor = await inboundMessage(value.database, {
      bindingId: binding.id,
      channelId: "oc_trace_group",
      externalMessageId: "om_root",
      providerContext: { provider: "feishu", chatType: "group" },
      occurredAt: new Date("2026-09-22T01:00:00.000Z"),
    });
    await captureFeishuReply(value.database, binding.id, {
      messageId: "om_first_reply",
      chatId: "oc_trace_group",
      text: "First thread reply",
      rootId: "om_root",
      parentId: "om_root",
      threadId: "omt_trace_topic",
    });

    const { service, statements } = tracedService(value.database);
    const replies = await service.listReplies(value.bootstrap.userId, anchor.id, { limit: 20 });
    expect(replies.items.map((item) => item.externalMessageId)).toEqual(["om_first_reply"]);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((statement) => RUNTIME_TABLE_READ.test(statement))).toEqual([]);
    await value.sql.end();
  });

  it("keeps a thread reply with the channel Session until that thread's Session exists", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "feishu", "ou_bot");
    const channel = await chatSession(value.database, { bindingId: binding.id, channelId: "oc_group" });
    const rootAnchor = await inboundMessage(value.database, {
      bindingId: binding.id,
      channelId: "oc_group",
      externalMessageId: "om_root",
      providerContext: { provider: "feishu", chatType: "group" },
      occurredAt: new Date("2026-09-22T01:00:00.000Z"),
    });
    // The channel Session answers in a new thread before anybody replied there.
    await captureFeishuReply(value.database, binding.id, {
      messageId: "om_first_reply",
      chatId: "oc_group",
      text: "First thread reply",
      rootId: "om_root",
      parentId: "om_root",
      threadId: "omt_first_topic",
    });

    const service = new TaskService(value.database);
    const replies = await service.listReplies(value.bootstrap.userId, rootAnchor.id, { limit: 20 });
    expect(replies.items.map((item) => item.externalMessageId)).toEqual(["om_first_reply"]);
    expect(replies.items[0]).toMatchObject({
      messageType: "text",
      contentAvailable: true,
      fallbackText: "First thread reply",
      timeSource: "observed",
    });

    // Somebody answers in the thread: its Session now owns the thread's later replies.
    const thread = await chatSession(value.database, {
      bindingId: binding.id,
      channelId: "oc_group",
      threadKey: "omt_first_topic",
      createdAt: new Date(OBSERVED_AT.getTime() + 60_000),
    });
    const followup = await inboundMessage(value.database, {
      bindingId: binding.id,
      channelId: "oc_group",
      externalMessageId: "om_followup",
      threadKey: "omt_first_topic",
      providerContext: { provider: "feishu", chatType: "group", threadId: "omt_first_topic", rootId: "om_root" },
      occurredAt: new Date("2026-09-22T01:10:00.000Z"),
    });
    await captureFeishuReply(value.database, binding.id, {
      messageId: "om_second_reply",
      chatId: "oc_group",
      text: "Second thread reply",
      rootId: "om_root",
      parentId: "om_followup",
      threadId: "omt_first_topic",
      observedAt: new Date(OBSERVED_AT.getTime() + 120_000),
    });
    const viaChild = await service.listReplies(value.bootstrap.userId, followup.id, { limit: 20 });
    expect(viaChild.items.map((item) => item.externalMessageId)).toEqual(["om_second_reply"]);
    const viaThread = await service.listReplies(value.bootstrap.userId, thread.id, { limit: 20 });
    expect(viaThread.items.map((item) => item.externalMessageId)).toEqual(["om_second_reply"]);
    const viaChannel = await service.listReplies(value.bootstrap.userId, channel.id, { limit: 20 });
    expect(viaChannel.items.map((item) => item.externalMessageId)).toEqual(["om_first_reply"]);
    await value.sql.end();
  });

  it("keeps the captured reply to a Feishu quote reply without thread_id in the channel Session's Task", async () => {
    const value = await accountFixture();
    const [binding] = await value.database
      .insert(imBindings)
      .values({
        agentId: value.agent.id,
        provider: "feishu",
        status: "active",
        externalAppId: "cli_quote",
        externalTeamId: "workspace_quote",
        externalBotId: "ou_bot",
        credentialSchemaVersion: 1,
        credentialGeneration: 1,
        encryptedCredential: "synthetic",
        activatedAt: new Date("2026-09-22T00:00:00.000Z"),
      })
      .returning();
    if (!binding) throw new Error("IM Binding fixture was not created");
    const inbox = new ImMessageInbox(value.database);
    const ingest = async (messageId: string, createTime: number, thread: { rootId?: string; parentId?: string }) => {
      const [event] = normalizeFeishuMessage({
        appId: "cli_quote",
        teamId: "workspace_quote",
        message: {
          messageId,
          chatId: "oc_quote_group",
          chatType: "group",
          senderId: "ou_human",
          content: `@_user_1 ${messageId}`,
          rawContentType: "text",
          resources: [],
          mentions: [{ key: "@_user_1", openId: "ou_bot", name: "Atlas", isBot: true }],
          mentionAll: false,
          mentionedBot: true,
          ...(thread.rootId ? { rootId: thread.rootId } : {}),
          ...(thread.parentId ? { replyToMessageId: thread.parentId } : {}),
          createTime,
          raw: { header: { event_id: `ev_${messageId}`, tenant_key: "workspace_quote" } },
        },
      });
      if (!event) throw new Error("Missing normalized Feishu event");
      const result = await inbox.ingest(binding.id, 1, event);
      expect(result.deliveryIds).toHaveLength(1);
      const [delivery] = await value.database
        .select({ kind: sessions.kind, threadKey: sessions.threadKey })
        .from(imMessageDeliveries)
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .where(eq(imMessageDeliveries.id, result.deliveryIds[0] as string));
      expect(delivery).toEqual({ kind: "channel", threadKey: null });
      const [stored] = await value.database
        .select()
        .from(imMessages)
        .where(eq(imMessages.externalMessageId, messageId));
      if (!stored) throw new Error(`Inbound ${messageId} was not stored`);
      return stored;
    };
    const root = await ingest("om_quoted_root", Date.parse("2026-09-22T01:00:00.000Z"), {});
    const quote = await ingest("om_quote", Date.parse("2026-09-22T01:01:00.000Z"), {
      rootId: "om_quoted_root",
      parentId: "om_quoted_root",
    });
    expect(quote.threadKey).toBeNull();

    // Feishu answers an unthreaded reply with the quote chain's root_id and the target as parent_id.
    // The inbox created the channel Session at wall-clock time, so the capture is stored after it.
    await captureFeishuReply(value.database, binding.id, {
      messageId: "om_agent_reply",
      chatId: "oc_quote_group",
      text: "Answer to the quote reply",
      rootId: "om_quoted_root",
      parentId: "om_quote",
      observedAt: new Date(Date.now() + 60_000),
    });
    const [captured] = await value.database
      .select()
      .from(imMessages)
      .where(eq(imMessages.externalMessageId, "om_agent_reply"));
    // Keyed by the message it answers, never by the quote chain's root_id; no thread Session has it.
    expect(captured?.threadKey).toBe("om_quote");
    const chatSessions = await value.database
      .select({ id: sessions.id, kind: sessions.kind })
      .from(sessions)
      .where(eq(sessions.imBindingId, binding.id));
    expect(chatSessions).toHaveLength(1);
    const channelSessionId = chatSessions[0]?.id as string;
    expect(chatSessions[0]?.kind).toBe("channel");

    const service = new TaskService(value.database);
    for (const id of [quote.id, root.id, channelSessionId]) {
      const replies = await service.listReplies(value.bootstrap.userId, id, { limit: 20 });
      expect(replies.items.map((item) => item.externalMessageId)).toEqual(["om_agent_reply"]);
    }
    const detail = await service.detail(value.bootstrap.userId, quote.id);
    expect(detail.task.id).toBe(channelSessionId);
    await value.sql.end();
  });

  it("keeps a native-thread reply stored by the earlier capture, without threadId, in its thread's Task", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "feishu", "ou_bot");
    const channel = await chatSession(value.database, { bindingId: binding.id, channelId: "oc_legacy_group" });
    const thread = await chatSession(value.database, {
      bindingId: binding.id,
      channelId: "oc_legacy_group",
      threadKey: "omt_native",
    });
    await inboundMessage(value.database, {
      bindingId: binding.id,
      channelId: "oc_legacy_group",
      externalMessageId: "om_root",
      providerContext: { provider: "feishu", chatType: "group" },
      occurredAt: new Date("2026-09-22T01:00:00.000Z"),
    });
    await captureFeishuReply(value.database, binding.id, {
      messageId: "om_first",
      chatId: "oc_legacy_group",
      text: "First thread reply",
      rootId: "om_root",
      parentId: "om_root",
      threadId: "omt_native",
      createTime: String(Date.parse("2026-09-22T01:01:00.000Z")),
    });
    // The row the earlier capture stored for a reply to om_first whose response omitted thread_id and
    // root_id: thread key and root resolved from the stored parent, but no threadId recorded.
    await value.database.insert(imMessages).values({
      imBindingId: binding.id,
      providerEventId: null,
      channelId: "oc_legacy_group",
      externalMessageId: "om_legacy_second",
      providerRevisionKey: OUTBOUND_CREATED_REVISION_KEY,
      operation: "created",
      direction: "outbound",
      threadKey: "omt_native",
      replyToExternalId: "om_first",
      authorKind: "bot",
      authorExternalId: "ou_bot",
      authorDisplayName: null,
      content: { version: 1, fallbackText: "Legacy second reply", blocks: [], truncated: false },
      providerContext: { provider: "feishu", parentId: "om_first", rootId: "om_root" },
      occurredAt: new Date("2026-09-22T01:02:00.000Z"),
      receivedAt: new Date("2026-09-22T01:02:00.000Z"),
    });

    // Attribution is by thread key, so the row with no recorded threadId still matches its thread's
    // Session; its root_id never moves it to the channel Session that holds the root.
    const service = new TaskService(value.database);
    const replies = await service.listReplies(value.bootstrap.userId, thread.id, { limit: 20 });
    expect(replies.items.map((item) => item.externalMessageId)).toEqual(["om_legacy_second", "om_first"]);
    const channelReplies = await service.listReplies(value.bootstrap.userId, channel.id, { limit: 20 });
    expect(channelReplies.items).toEqual([]);
    await value.sql.end();
  });

  it("paginates replies that share an instant by native identity without duplicates", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "feishu", "ou_bot");
    await chatSession(value.database, { bindingId: binding.id, channelId: "oc_dm", conversationKind: "dm" });
    const anchor = await inboundMessage(value.database, {
      bindingId: binding.id,
      channelId: "oc_dm",
      externalMessageId: "om_dm_anchor",
      providerContext: { provider: "feishu", chatType: "p2p" },
      occurredAt: new Date("2026-09-22T01:00:00.000Z"),
    });
    for (const messageId of ["om_tie_a", "om_tie_b", "om_tie_c"]) {
      await captureFeishuReply(value.database, binding.id, { messageId, chatId: "oc_dm", text: `Reply ${messageId}` });
    }
    const stored = (await outboundRows(value.database, binding.id)).filter((row) => row.direction === "outbound");
    expect(new Set(stored.map((row) => row.occurredAt.getTime())).size).toBe(1);
    const expected = [...stored]
      .sort((left, right) => (left.id === right.id ? 0 : left.id > right.id ? -1 : 1))
      .map((row) => row.externalMessageId);

    const service = new TaskService(value.database);
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = await service.listReplies(value.bootstrap.userId, anchor.id, { limit: 1, cursor });
      collected.push(...result.items.map((item) => item.externalMessageId));
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(3);
    await value.sql.end();
  });

  it("keeps a private chat's captures isolated by binding and channel", async () => {
    const value = await dmTask();
    // One current binding per agent, so the sibling binding belongs to a second Agent of the Account.
    const [otherAgent] = await value.database
      .insert(agents)
      .values({
        createdByUserId: value.bootstrap.userId,
        computerId: value.agent.computerId,
        name: "other-atlas",
        displayName: "Other Atlas",
        runtimeProvider: "codex",
      })
      .returning();
    if (!otherAgent) throw new Error("Other Agent fixture was not created");
    const otherBinding = await bind(value.database, otherAgent.id, "slack", "B1OTHER");
    await captureOutbound(value.database, value.binding.id, "1790042400.000100", "Own reply");
    await captureOutbound(value.database, otherBinding.id, "1790042460.000200", "Other binding reply");
    await captureOutbound(value.database, value.binding.id, "1790042520.000300", "Other channel reply", {
      channelId: "D0OTHER",
    });

    const replies = await value.service.listReplies(value.bootstrap.userId, value.anchor.id, { limit: 20 });
    expect(replies.items.map((item) => item.externalMessageId)).toEqual(["1790042400.000100"]);
    await value.sql.end();
  });

  it("splits a group's replies between its channel Session and its thread Sessions", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "slack", "B0BOT");
    const channel = await chatSession(value.database, { bindingId: binding.id, channelId: "C0GRP" });
    const firstThread = await chatSession(value.database, {
      bindingId: binding.id,
      channelId: "C0GRP",
      threadKey: "1790000000.000001",
    });
    const secondThread = await chatSession(value.database, {
      bindingId: binding.id,
      channelId: "C0GRP",
      threadKey: "1790000000.000002",
    });
    const firstAnchor = await inboundMessage(value.database, {
      bindingId: binding.id,
      channelId: "C0GRP",
      externalMessageId: "1790000000.000011",
      threadKey: "1790000000.000001",
      providerContext: { provider: "slack", channelType: "channel" },
      occurredAt: new Date("2026-09-22T01:00:00.000Z"),
    });
    await captureOutbound(value.database, binding.id, "1790042400.000100", "Top-level message", {
      channelId: "C0GRP",
    });
    await captureOutbound(value.database, binding.id, "1790042460.000200", "First thread reply", {
      channelId: "C0GRP",
      threadTs: "1790000000.000001",
    });
    await captureOutbound(value.database, binding.id, "1790042520.000300", "Second thread reply", {
      channelId: "C0GRP",
      threadTs: "1790000000.000002",
    });

    const service = new TaskService(value.database);
    const read = async (id: string) =>
      (await service.listReplies(value.bootstrap.userId, id, { limit: 20 })).items.map(
        (item) => item.externalMessageId,
      );
    expect(await read(channel.id)).toEqual(["1790042400.000100"]);
    expect(await read(firstThread.id)).toEqual(["1790042460.000200"]);
    expect(await read(firstAnchor.id)).toEqual(["1790042460.000200"]);
    expect(await read(secondThread.id)).toEqual(["1790042520.000300"]);
    await value.sql.end();
  });

  it("attributes a Feishu topic reply to the thread Session of its thread id", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "feishu", "ou_bot");
    await chatSession(value.database, { bindingId: binding.id, channelId: "oc_topic_group" });
    await chatSession(value.database, { bindingId: binding.id, channelId: "oc_topic_group", threadKey: "omt_topic" });
    // A follow-up inbound message inside the topic creates the thread_key → root mapping.
    const anchor = await inboundMessage(value.database, {
      bindingId: binding.id,
      channelId: "oc_topic_group",
      externalMessageId: "om_followup",
      threadKey: "omt_topic",
      providerContext: { provider: "feishu", chatType: "group", threadId: "omt_topic", rootId: "om_root" },
      occurredAt: new Date("2026-09-22T01:00:00.000Z"),
    });
    const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT });
    await capture.capture({
      provider: "feishu",
      operationId: "feishu.im.messages.reply",
      bindingId: binding.id,
      pathParams: { message_id: "om_followup" },
      query: "",
      requestBody: { msg_type: "text", content: '{"text":"Topic reply"}' },
      responsePayload: {
        code: 0,
        data: {
          message_id: "om_agent_reply",
          chat_id: "oc_topic_group",
          root_id: "om_root",
          parent_id: "om_followup",
          thread_id: "omt_topic",
          msg_type: "text",
          create_time: "1790042400000",
          body: { content: '{"text":"Topic reply"}' },
        },
      },
      observedAt: OBSERVED_AT,
    });

    const service = new TaskService(value.database);
    const replies = await service.listReplies(value.bootstrap.userId, anchor.id, { limit: 20 });
    expect(replies.items.map((item) => item.externalMessageId)).toEqual(["om_agent_reply"]);
    expect(replies.items[0]?.fallbackText).toBe("Topic reply");
    await value.sql.end();
  });

  it("refuses another Account's Task and reports no record for a scope without captures", async () => {
    const value = await dmTask();
    const [otherUser] = await value.database
      .insert(users)
      .values({ email: "other@example.com", displayName: "Other" })
      .returning();
    if (!otherUser) throw new Error("Other Account fixture was not created");
    await expect(value.service.listReplies(otherUser.id, value.anchor.id, { limit: 20 })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    } satisfies Partial<AuthServiceError>);

    const empty = await value.service.listReplies(value.bootstrap.userId, value.anchor.id, { limit: 20 });
    expect(empty).toEqual({ items: [], nextCursor: null });
    await value.sql.end();
  });
});
