import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { agents, computers, imBindings, imMessages } from "../../db/schema/index.js";
import { ImOutboundCapture, type OutboundCaptureEvent } from "../../services/im/im-outbound-capture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * Focused persistence regressions for the bounded outbound capture. These exercise the real
 * PostgreSQL JSONB/text boundary and the cancellable postgres-js statements, which unit tests with
 * a scripted client cannot prove. Task-scope reads live in their own suite.
 */

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const OBSERVED_AT = new Date("2026-09-22T02:00:00.000Z");

async function accountFixture(
  options: { max?: number } = {},
  displayName = "Capture Admin",
  email = "capture@example.test",
) {
  const client = createDatabaseClient(databaseUrl, options);
  const bootstrap = await bootstrapInitialAdmin(client.database, { displayName, email });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: randomUUID(),
      displayName: "capture-workstation",
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
      name: "capture-agent",
      displayName: "Capture Agent",
      runtimeProvider: "codex",
    })
    .returning();
  if (!agent) throw new Error("Agent fixture was not created");
  return { ...client, agent };
}

function slackCaptureEvent(bindingId: string, messageId: string, text: string): OutboundCaptureEvent {
  return {
    provider: "slack",
    operationId: "chat.postMessage",
    bindingId,
    pathParams: {},
    query: "",
    requestBody: { channel: "D0DM", text: "request text" },
    responsePayload: {
      ok: true,
      channel: "D0DM",
      ts: messageId,
      message: { type: "message", subtype: "bot_message", bot_id: "B0BOT", text },
    },
    observedAt: OBSERVED_AT,
  };
}

async function bind(database: DatabaseClient, agentId: string, provider: "slack" | "feishu") {
  const [binding] = await database
    .insert(imBindings)
    .values({ agentId, provider, externalBotId: provider === "slack" ? "B0BOT" : "ou_bot" })
    .returning();
  if (!binding) throw new Error("IM Binding fixture was not created");
  return binding;
}

async function storedRows(database: DatabaseClient, externalMessageId: string) {
  return database.select().from(imMessages).where(eq(imMessages.externalMessageId, externalMessageId));
}

/** While the lock is still held, a stopped insert backend proves the cancelled statement is gone. */
async function waitForBlockedInsertToStop(sql: ReturnType<typeof createDatabaseClient>["sql"]): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count
      from pg_stat_activity
      where state = 'active' and wait_event_type = 'Lock' and query ilike 'insert into "im_messages"%'
    `;
    if ((rows[0]?.count ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The cancelled insert was still blocked while its transaction held the lock");
}

describe("ImOutboundCapture persistence safety", () => {
  it("keeps a confirmed identity whose display text contains NUL or a lone surrogate", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "slack");
    const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT });

    for (const [label, text, messageId] of [
      ["NUL", `Fixture ${String.fromCharCode(0)} body`, "1790035261.000002"],
      ["lone surrogate", `Fixture ${String.fromCharCode(0xd800)} body`, "1790035262.000002"],
    ] as const) {
      await capture.capture(slackCaptureEvent(binding.id, messageId, text));
      const rows = await storedRows(value.database, messageId);
      expect(rows, `${label} capture must persist the confirmed identity`).toHaveLength(1);
      const content = rows[0]?.content;
      expect(content?.fallbackText).toBe("Fixture \uFFFD body");
      expect(content?.truncated).toBe(true);
      expect(content?.outbound?.contentAvailable).toBe(true);
      expect(JSON.stringify(content)).not.toContain("\\u0000");
      expect(JSON.stringify(content)).not.toMatch(/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F])/);
    }
    await value.sql.end();
  });

  it("bounds a capture whose statement waits on a saturated pool and never writes after release", async () => {
    const value = await accountFixture({ max: 1 });
    const binding = await bind(value.database, value.agent.id, "slack");
    const messageId = "1790035263.000002";
    const reserved = await value.sql.reserve();
    try {
      const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT, deadlineMs: 250 });
      const started = performance.now();
      await capture.capture(slackCaptureEvent(binding.id, messageId, "Pool fixture"));
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await reserved.release();
    }
    expect(await storedRows(value.database, messageId)).toHaveLength(0);
    await value.sql.end();
  });

  it("cancels an insert blocked on a table lock and never writes after the lock releases", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "slack");
    const messageId = "1790035264.000002";
    const blocker = createDatabaseClient(databaseUrl, { max: 1 });
    let releaseLock!: () => void;
    let markLockReady!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      markLockReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockTransaction = blocker.sql.begin(async (sql) => {
      await sql`lock table im_messages in access exclusive mode`;
      markLockReady();
      await gate;
    });
    try {
      await lockReady;
      const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT, deadlineMs: 250 });
      const started = performance.now();
      await capture.capture(slackCaptureEvent(binding.id, messageId, "Lock fixture"));
      expect(performance.now() - started).toBeLessThan(2_000);
      // The lock stays held: the insert can only disappear by being cancelled, never by success.
      await waitForBlockedInsertToStop(value.sql);
    } finally {
      releaseLock();
      await lockTransaction;
      await blocker.sql.end({ timeout: 2 });
    }
    expect(await storedRows(value.database, messageId)).toHaveLength(0);
    await value.sql.end();
  });

  it("resolves a stored reply parent only inside the captured channel", async () => {
    const value = await accountFixture();
    const binding = await bind(value.database, value.agent.id, "feishu");
    const inbound = (channelId: string, externalMessageId: string, threadKey: string, rootId: string) =>
      value.database.insert(imMessages).values({
        imBindingId: binding.id,
        providerEventId: `event-${externalMessageId}`,
        channelId,
        externalMessageId,
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        threadKey,
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "Request", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group", threadId: threadKey, rootId },
        occurredAt: OBSERVED_AT,
      });
    await inbound("oc_target", "om_target_root", "omt_target", "om_target_root");
    await inbound("oc_other", "om_other_root", "omt_other", "om_other_root");
    const capture = new ImOutboundCapture(value.database, { now: () => OBSERVED_AT });
    const feishuReply = (messageId: string, target: string): OutboundCaptureEvent => ({
      provider: "feishu",
      operationId: "feishu.im.messages.reply",
      bindingId: binding.id,
      pathParams: { message_id: target },
      query: "",
      requestBody: {},
      observedAt: OBSERVED_AT,
      responsePayload: {
        code: 0,
        data: {
          message_id: messageId,
          chat_id: "oc_target",
          msg_type: "text",
          body: { content: '{"text":"reply"}' },
        },
      },
    });

    await capture.capture(feishuReply("om_reply_same", "om_target_root"));
    await capture.capture(feishuReply("om_reply_other", "om_other_root"));

    const [sameChannel] = await storedRows(value.database, "om_reply_same");
    expect(sameChannel?.threadKey).toBe("omt_target");
    expect(sameChannel?.providerContext).toEqual({
      provider: "feishu",
      parentId: "om_target_root",
      rootId: "om_target_root",
    });
    const [otherChannel] = await storedRows(value.database, "om_reply_other");
    expect(otherChannel?.threadKey).toBeNull();
    expect(otherChannel?.providerContext).toEqual({ provider: "feishu", parentId: "om_other_root" });
    await value.sql.end();
  });
});
