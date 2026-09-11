import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { computeTurnResultHash, type TurnReportRequest, TurnReportRequestSchema } from "@opentag/shared";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { agents, computers, imBindings, imMessageDeliveries, imMessages, sessions } from "../../db/schema/index.js";
import { normalizeFeishuMessage } from "../../services/im-bindings/feishu/adapter.js";
import { normalizeSlackEnvelope } from "../../services/im-bindings/slack/adapter.js";
import { TaskQueryError, TaskService } from "../../services/tasks/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function fixture() {
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
  });
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
  const [binding] = await client.database
    .insert(imBindings)
    .values({ agentId: agent.id, provider: "feishu" })
    .returning();
  if (!binding) throw new Error("IM Binding fixture was not created");
  const [session] = await client.database
    .insert(sessions)
    .values({
      imBindingId: binding.id,
      channelId: "oc_debug",
      conversationKind: "dm",
      kind: "channel",
      createdAt: new Date("2026-08-27T01:00:00.000Z"),
    })
    .returning();
  if (!session) throw new Error("Session fixture was not created");
  const [message] = await client.database
    .insert(imMessages)
    .values({
      imBindingId: binding.id,
      providerEventId: "event-debug",
      channelId: "oc_debug",
      externalMessageId: "om_debug",
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "ou_debug",
      authorDisplayName: "Mia",
      content: { version: 1, fallbackText: "Please debug this Turn.", blocks: [], truncated: false },
      providerContext: { provider: "feishu", chatType: "p2p" },
      occurredAt: new Date("2026-08-27T01:01:00.000Z"),
    })
    .returning();
  if (!message) throw new Error("IM Message fixture was not created");

  const deliveryId = crypto.randomUUID();
  const turnId = "turn-debug";
  const reportInput = {
    deliveryId,
    turnId,
    sessionId: session.id,
    agentId: agent.id,
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "Stored runtime output",
    usage: { inputTokens: 100, outputTokens: 50 },
    traceSummary: { lastSequence: 4, droppedEvents: 0 },
  };
  const report: TurnReportRequest = {
    type: "turn:report",
    requestId: crypto.randomUUID(),
    ...reportInput,
    resultHash: computeTurnResultHash(reportInput),
  };
  await client.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId: message.id,
    sessionId: session.id,
    attention: "direct",
    state: "accepted",
    placementGeneration: 1,
    inputHash: "a".repeat(64),
    turnId,
    reportOwnerInstanceId: crypto.randomUUID(),
    acceptedAt: new Date("2026-08-27T01:02:00.000Z"),
    expiresAt: new Date("2026-08-28T01:00:00.000Z"),
    resultHash: report.resultHash,
    turnReport: report,
    reportedAt: new Date("2026-08-27T01:03:00.000Z"),
  });
  return {
    ...client,
    agent,
    binding,
    bootstrap,
    deliveryId,
    message,
    service: new TaskService(client.database),
    session,
    turnId,
  };
}

/** A later message of the fixture's private chat whose delivery still waits in the queue. */
async function queueMessage(value: Awaited<ReturnType<typeof fixture>>, suffix: string, occurredAt: Date) {
  const [message] = await value.database
    .insert(imMessages)
    .values({
      imBindingId: value.binding.id,
      providerEventId: `event-${suffix}`,
      channelId: "oc_debug",
      externalMessageId: `om_${suffix}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "ou_debug",
      authorDisplayName: "Mia",
      content: { version: 1, fallbackText: `Queued follow-up ${suffix}.`, blocks: [], truncated: false },
      providerContext: { provider: "feishu", chatType: "p2p" },
      occurredAt,
    })
    .returning();
  if (!message) throw new Error("Queued message fixture was not created");
  const [delivery] = await value.database
    .insert(imMessageDeliveries)
    .values({
      messageId: message.id,
      sessionId: value.session.id,
      attention: "direct",
      state: "pending",
      placementGeneration: 1,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .returning();
  if (!delivery) throw new Error("Queued delivery fixture was not created");
  return { message, delivery };
}

/**
 * Locks one delivery row from a second connection, as a worker's write does, so a cancel that
 * starts meanwhile waits inside its transaction. `commit()` runs `write` on the holding connection
 * and commits, and the waiting cancel then reads the row as `write` left it.
 */
async function holdDeliveryLock(deliveryId: string, write: (tx: postgres.TransactionSql) => Promise<unknown>) {
  const holder = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  let release = (): void => undefined;
  let locked = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = holder.begin(async (tx) => {
    await tx`select id from im_message_deliveries where id = ${deliveryId}::uuid for update`;
    locked();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await write(tx);
  });
  await ready;
  return {
    async commit(): Promise<void> {
      release();
      await held;
    },
    end: () => holder.end(),
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function deliveryState(value: Awaited<ReturnType<typeof fixture>>, deliveryId: string) {
  const [row] = await value.database
    .select({ state: imMessageDeliveries.state, reason: imMessageDeliveries.reason })
    .from(imMessageDeliveries)
    .where(eq(imMessageDeliveries.id, deliveryId));
  if (!row) throw new Error("Delivery row disappeared");
  return row;
}

describe("Task cancel under a row lock", () => {
  // Each race starts the cancel, gives it a second to block on the held row, and only then lets the
  // lock holder write and commit. PGlite cannot stage this: it has one connection, and a row that
  // left `pending` before the transaction starts is never locked in the first place.
  it("returns the idempotent 200 when a concurrent cancel withdrew the row it waited for", async () => {
    const value = await fixture();
    const { delivery } = await queueMessage(value, "race-cancel", new Date("2026-08-27T01:10:00.000Z"));
    const lock = await holdDeliveryLock(
      delivery.id,
      (tx) => tx`
        update im_message_deliveries
        set state = 'expired', reason = 'cancelled', expires_at = now()
        where id = ${delivery.id}::uuid
      `,
    );
    try {
      expect((await value.service.get(value.bootstrap.userId, value.message.id, { limit: 5 })).task.status).toBe(
        "queued",
      );
      const racing = value.service.cancel(value.bootstrap.userId, value.message.id);
      await wait(1_000);
      await lock.commit();
      await expect(racing).resolves.toMatchObject({ status: "cancelled" });
      expect(await deliveryState(value, delivery.id)).toEqual({ state: "expired", reason: "cancelled" });
    } finally {
      await lock.end();
      await value.sql.end();
    }
  }, 20_000);

  it("refuses with the Task's actual status when a worker rejected the only row it waited for", async () => {
    const value = await fixture();
    const { delivery } = await queueMessage(value, "race-reject", new Date("2026-08-27T01:10:00.000Z"));
    const lock = await holdDeliveryLock(
      delivery.id,
      (tx) => tx`
        update im_message_deliveries
        set state = 'terminal_rejected', reason = 'No connected computer', last_error_code = 'RUNTIME_UNAVAILABLE'
        where id = ${delivery.id}::uuid
      `,
    );
    try {
      const racing = value.service.cancel(value.bootstrap.userId, value.message.id);
      await wait(1_000);
      await lock.commit();
      await expect(racing).rejects.toMatchObject({
        code: "TASK_NOT_QUEUED",
        statusCode: 409,
        message: "The Task is failed, not queued, so there is nothing to cancel",
      });
      expect(await deliveryState(value, delivery.id)).toEqual({
        state: "terminal_rejected",
        reason: "No connected computer",
      });
      expect((await value.service.get(value.bootstrap.userId, value.message.id, { limit: 5 })).task.status).toBe(
        "failed",
      );
    } finally {
      await lock.end();
      await value.sql.end();
    }
  }, 20_000);

  it("withdraws the sibling still pending when a worker rejected one row while the cancel waited", async () => {
    const value = await fixture();
    const rejected = await queueMessage(value, "race-mixed-a", new Date("2026-08-27T01:10:00.000Z"));
    const sibling = await queueMessage(value, "race-mixed-b", new Date("2026-08-27T01:11:00.000Z"));
    const lock = await holdDeliveryLock(
      rejected.delivery.id,
      (tx) => tx`
        update im_message_deliveries
        set state = 'terminal_rejected', reason = 'No connected computer', last_error_code = 'RUNTIME_UNAVAILABLE'
        where id = ${rejected.delivery.id}::uuid
      `,
    );
    try {
      const racing = value.service.cancel(value.bootstrap.userId, value.message.id);
      await wait(1_000);
      await lock.commit();
      // The rejected row left the queue on its own and is left as the worker wrote it; the row
      // still queued behind it is withdrawn, so the Task reads cancelled rather than queued.
      await expect(racing).resolves.toMatchObject({ status: "cancelled" });
      expect(await deliveryState(value, rejected.delivery.id)).toEqual({
        state: "terminal_rejected",
        reason: "No connected computer",
      });
      expect(await deliveryState(value, sibling.delivery.id)).toEqual({ state: "expired", reason: "cancelled" });
      expect((await value.service.get(value.bootstrap.userId, value.message.id, { limit: 5 })).task.status).toBe(
        "cancelled",
      );
    } finally {
      await lock.end();
      await value.sql.end();
    }
  }, 20_000);

  it("refuses as running when a worker accepted the row it waited for, and leaves the sibling queued", async () => {
    const value = await fixture();
    const claimed = await queueMessage(value, "race-accept-a", new Date("2026-08-27T01:10:00.000Z"));
    const sibling = await queueMessage(value, "race-accept-b", new Date("2026-08-27T01:11:00.000Z"));
    // The worker's claim is committed before the lock is taken, as it is in the worker itself.
    await value.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: "IM_DELIVERY_CLAIM_RACE", nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(imMessageDeliveries.id, claimed.delivery.id));
    const lock = await holdDeliveryLock(
      claimed.delivery.id,
      (tx) => tx`
        update im_message_deliveries
        set state = 'accepted', accepted_at = now(), input_hash = ${"e".repeat(64)},
            turn_id = 'turn-race-accept', report_owner_instance_id = gen_random_uuid(),
            last_error_code = null
        where id = ${claimed.delivery.id}::uuid
      `,
    );
    try {
      const racing = value.service.cancel(value.bootstrap.userId, value.message.id);
      await wait(1_000);
      await lock.commit();
      // An accepted row is a Turn that started, not an exit from the queue: the whole cancel is
      // refused as running and the message queued behind the new Turn stays where it is.
      await expect(racing).rejects.toMatchObject({
        code: "TASK_NOT_QUEUED",
        statusCode: 409,
        message: "The Task is running, not queued, so there is nothing to cancel",
      });
      expect(await deliveryState(value, claimed.delivery.id)).toEqual({ state: "accepted", reason: null });
      expect(await deliveryState(value, sibling.delivery.id)).toEqual({ state: "pending", reason: null });
      expect((await value.service.get(value.bootstrap.userId, value.message.id, { limit: 5 })).task.status).toBe(
        "running",
      );
    } finally {
      await lock.end();
      await value.sql.end();
    }
  }, 20_000);
});

describe("Task topic queries", () => {
  it.each(["running", "expired", "ended", "superseded"] as const)(
    "projects %s liveness consistently into Task detail",
    async (state) => {
      const value = await fixture();
      try {
        await value.database
          .update(imMessageDeliveries)
          .set({ reportedAt: null, turnReport: null, resultHash: null })
          .where(eq(imMessageDeliveries.id, value.deliveryId));
        if (state === "ended") {
          await value.database
            .update(sessions)
            .set({ endedAt: new Date("2026-08-27T01:03:00.000Z") })
            .where(eq(sessions.id, value.session.id));
        }
        if (state === "superseded") {
          const [message] = await value.database
            .insert(imMessages)
            .values({
              imBindingId: value.binding.id,
              providerEventId: "event-later",
              channelId: "oc_debug",
              externalMessageId: "om_later",
              providerRevisionKey: "1",
              operation: "created",
              direction: "inbound",
              authorKind: "human",
              authorExternalId: "ou_debug",
              content: value.message.content,
              providerContext: value.message.providerContext,
              occurredAt: new Date("2026-08-27T01:03:00.000Z"),
            })
            .returning();
          if (!message) throw new Error("Expected later message");
          await value.database.insert(imMessageDeliveries).values({
            messageId: message.id,
            sessionId: value.session.id,
            attention: "direct",
            state: "accepted",
            placementGeneration: 1,
            inputHash: "b".repeat(64),
            turnId: "turn-later",
            reportOwnerInstanceId: crypto.randomUUID(),
            acceptedAt: new Date("2026-08-27T01:03:00.000Z"),
            expiresAt: new Date("2026-08-28T01:00:00.000Z"),
          });
        }
        const now = new Date(state === "expired" ? "2026-08-28T01:00:00.000Z" : "2026-08-27T01:04:00.000Z");
        const service = new TaskService(value.database, { now: () => now });
        const detail = await service.get(value.bootstrap.userId, value.message.id, { limit: 50 });
        expect(detail.task.status).toBe(state === "superseded" ? "running" : state);
        expect(detail.turns.find((turn) => turn.deliveryId === value.deliveryId)).toMatchObject({
          delivery: { state: "accepted", isRunning: state === "running" },
          report: null,
        });
        if (state === "superseded") expect(detail.turns[0]?.delivery.isRunning).toBe(true);
      } finally {
        await value.sql.end();
      }
    },
  );

  it("round-trips actual replies through JSONB with empty finalText and a stable report hash", async () => {
    const value = await fixture();
    try {
      const [stored] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, value.deliveryId));
      if (!stored?.turnReport) throw new Error("Expected stored report");
      const { finalText: _summary, ...base } = stored.turnReport;
      const report: TurnReportRequest = {
        ...base,
        outgoingReplies: {
          status: "complete",
          replies: [
            {
              provider: "feishu",
              teamBrand: "lark",
              messageId: "om_actual_reply",
              chatId: "oc_debug",
              content: {
                msgType: "post",
                text: "Actual title\n\nActual body",
                post: { title: "Actual title", content: [[], [{ tag: "text", text: "Actual body" }]] },
              },
            },
          ],
        },
      };
      report.resultHash = computeTurnResultHash(report);
      await value.database
        .update(imMessageDeliveries)
        .set({ turnReport: report, resultHash: report.resultHash })
        .where(eq(imMessageDeliveries.id, value.deliveryId));
      const [reloaded] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, value.deliveryId));
      expect(TurnReportRequestSchema.parse(reloaded?.turnReport)).toEqual(report);
      const detail = await value.service.get(value.bootstrap.userId, value.message.id, { limit: 50 });
      expect(detail.turns[0]?.report?.finalText).toBeNull();
      expect(detail.turns[0]?.report?.outgoingReplies).toEqual(report.outgoingReplies);
      await expect(value.service.get(crypto.randomUUID(), value.message.id, { limit: 50 })).rejects.toThrow();
    } finally {
      await value.sql.end();
    }
  });

  it("projects a private chat as one Task with its stored Turn report", async () => {
    const value = await fixture();
    try {
      const listed = await value.service.list(value.bootstrap.userId, { limit: 50 });
      expect(listed).toMatchObject({
        nextCursor: null,
        tasks: [
          {
            id: value.message.id,
            title: "Please debug this Turn.",
            status: "completed",
            agent: { id: value.agent.id, displayName: "Atlas" },
            source: { provider: "feishu", channelId: "oc_debug" },
          },
        ],
      });

      const detail = await value.service.get(value.bootstrap.userId, value.message.id, { limit: 50 });
      expect(detail.turns).toHaveLength(1);
      expect(detail.turns[0]).toMatchObject({
        attention: "direct",
        message: { fallbackText: "Please debug this Turn.", authorDisplayName: "Mia" },
        report: { turnId: "turn-debug", finalText: "Stored runtime output", outcome: "completed" },
      });
    } finally {
      await value.sql.end();
    }
  });

  it("removes only the addressed Slack mention after provider normalization", async () => {
    const value = await fixture();
    try {
      const [event] = normalizeSlackEnvelope({
        eventId: "event-slack-title",
        appId: "A1",
        teamId: "T1",
        botUserId: "U_BOT",
        botId: "B_BOT",
        event: {
          type: "app_mention",
          channel: "C1",
          channel_type: "channel",
          user: "U_HUMAN",
          text: "<@U_BOT> ask <@U_ALICE> to review",
          ts: "1724025600.123",
        },
      });
      if (!event) throw new Error("Slack title event was not normalized");
      await value.database
        .update(imBindings)
        .set({ provider: "slack", externalBotId: "U_BOT" })
        .where(eq(imBindings.id, value.binding.id));
      await value.database
        .update(imMessages)
        .set({ content: event.message.content, providerContext: event.providerContext })
        .where(eq(imMessages.id, value.message.id));

      const listed = await value.service.list(value.bootstrap.userId, { limit: 50 });
      expect(listed.tasks[0]?.title).toBe("ask <@U_ALICE> to review");
    } finally {
      await value.sql.end();
    }
  });

  it("removes only the addressed Feishu mention after provider normalization", async () => {
    const value = await fixture();
    try {
      const message: NormalizedMessage = {
        messageId: "om_title",
        chatId: "oc_debug",
        chatType: "group",
        senderId: "ou_human",
        content: "@_user_1 ask @_user_2 to review",
        rawContentType: "text",
        resources: [],
        mentions: [
          { key: "@_user_1", openId: "ou_bot", name: "Atlas", isBot: true },
          { key: "@_user_2", openId: "ou_alice", name: "Alice", isBot: false },
        ],
        mentionAll: false,
        mentionedBot: true,
        createTime: 1_724_025_600_000,
      };
      const [event] = normalizeFeishuMessage({ appId: "cli_1", teamId: "workspace_1", message });
      if (!event) throw new Error("Feishu title event was not normalized");
      await value.database
        .update(imBindings)
        .set({ externalBotId: "ou_bot" })
        .where(eq(imBindings.id, value.binding.id));
      await value.database
        .update(imMessages)
        .set({ content: event.message.content, providerContext: event.providerContext })
        .where(eq(imMessages.id, value.message.id));

      const listed = await value.service.list(value.bootstrap.userId, { limit: 50 });
      expect(listed.tasks[0]?.title).toBe("ask @Alice to review");
    } finally {
      await value.sql.end();
    }
  });

  it("follows list and Turn cursors past the first page", async () => {
    const value = await fixture();
    try {
      const [secondSession] = await value.database
        .insert(sessions)
        .values({
          imBindingId: value.binding.id,
          channelId: "oc_second",
          conversationKind: "dm",
          kind: "channel",
          createdAt: new Date("2026-08-26T01:00:00.000Z"),
        })
        .returning();
      if (!secondSession) throw new Error("Second Session fixture was not created");
      const [secondMessage] = await value.database
        .insert(imMessages)
        .values({
          imBindingId: value.binding.id,
          providerEventId: "event-second-chat",
          channelId: "oc_second",
          externalMessageId: "om_second_chat",
          providerRevisionKey: "1",
          operation: "created",
          direction: "inbound",
          authorKind: "human",
          authorExternalId: "ou_other",
          authorDisplayName: "Noah",
          content: { version: 1, fallbackText: "Older private request.", blocks: [], truncated: false },
          providerContext: { provider: "feishu", chatType: "p2p" },
          occurredAt: new Date("2026-08-26T01:01:00.000Z"),
        })
        .returning();
      if (!secondMessage) throw new Error("Second chat message fixture was not created");
      await value.database.insert(imMessageDeliveries).values({
        messageId: secondMessage.id,
        sessionId: secondSession.id,
        attention: "direct",
        state: "pending",
        placementGeneration: 1,
        expiresAt: new Date("2026-08-28T02:00:00.000Z"),
      });

      const firstPage = await value.service.list(value.bootstrap.userId, { limit: 1 });
      expect(firstPage.tasks).toHaveLength(1);
      expect(firstPage.nextCursor).not.toBeNull();
      if (!firstPage.nextCursor) throw new Error("The first Task page did not issue a cursor");

      const secondPage = await value.service.list(value.bootstrap.userId, {
        cursor: firstPage.nextCursor,
        limit: 1,
      });
      expect(secondPage.tasks.map((task) => task.id)).toEqual([secondMessage.id]);
      expect(secondPage.nextCursor).toBeNull();

      const [followUpMessage] = await value.database
        .insert(imMessages)
        .values({
          imBindingId: value.binding.id,
          providerEventId: "event-second",
          channelId: "oc_debug",
          externalMessageId: "om_second",
          providerRevisionKey: "1",
          operation: "created",
          direction: "inbound",
          authorKind: "human",
          authorExternalId: "ou_debug",
          authorDisplayName: "Mia",
          content: { version: 1, fallbackText: "And once more.", blocks: [], truncated: false },
          providerContext: { provider: "feishu", chatType: "p2p" },
          occurredAt: new Date("2026-08-27T02:01:00.000Z"),
        })
        .returning();
      if (!followUpMessage) throw new Error("Second IM Message fixture was not created");
      await value.database.insert(imMessageDeliveries).values({
        messageId: followUpMessage.id,
        sessionId: value.session.id,
        attention: "direct",
        state: "pending",
        placementGeneration: 1,
        expiresAt: new Date("2026-08-28T02:00:00.000Z"),
      });

      const firstTurnPage = await value.service.get(value.bootstrap.userId, value.message.id, { limit: 1 });
      expect(firstTurnPage.turns).toHaveLength(1);
      expect(firstTurnPage.nextCursor).not.toBeNull();
      if (!firstTurnPage.nextCursor) throw new Error("The first Turn page did not issue a cursor");

      const secondTurnPage = await value.service.get(value.bootstrap.userId, value.message.id, {
        cursor: firstTurnPage.nextCursor,
        limit: 1,
      });
      expect(secondTurnPage.turns).toHaveLength(1);
      expect(secondTurnPage.turns[0]?.deliveryId).toBe(value.deliveryId);
      expect(secondTurnPage.nextCursor).toBeNull();
    } finally {
      await value.sql.end();
    }
  });

  it("titles a Task from its root message even when it no longer addresses the Agent", async () => {
    const value = await fixture();
    try {
      const message: NormalizedMessage = {
        messageId: "om_followup",
        chatId: "oc_debug",
        chatType: "group",
        senderId: "ou_human",
        content: "@_user_2 take another look at the regression",
        rawContentType: "text",
        resources: [],
        mentions: [{ key: "@_user_2", openId: "ou_alice", name: "Alice", isBot: false }],
        mentionAll: false,
        mentionedBot: false,
        createTime: 1_724_025_600_000,
      };
      const [event] = normalizeFeishuMessage({ appId: "cli_1", teamId: "workspace_1", message });
      if (!event) throw new Error("Feishu follow-up event was not normalized");
      await value.database
        .update(imBindings)
        .set({ externalBotId: "ou_bot" })
        .where(eq(imBindings.id, value.binding.id));
      await value.database
        .update(imMessages)
        .set({ content: event.message.content, providerContext: event.providerContext })
        .where(eq(imMessages.id, value.message.id));

      const listed = await value.service.list(value.bootstrap.userId, { limit: 50 });
      expect(listed.tasks[0]?.title).toBe("@Alice take another look at the regression");
    } finally {
      await value.sql.end();
    }
  });

  it("isolates Account data and rejects malformed cursors", async () => {
    const value = await fixture();
    try {
      await expect(value.service.list(crypto.randomUUID(), { limit: 50 })).resolves.toEqual({
        tasks: [],
        nextCursor: null,
      });
      await expect(value.service.get(crypto.randomUUID(), value.message.id, { limit: 50 })).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(value.service.list(value.bootstrap.userId, { cursor: "invalid", limit: 50 })).rejects.toBeInstanceOf(
        TaskQueryError,
      );
    } finally {
      await value.sql.end();
    }
  });

  it("projects a steered input as absorbed by the root Turn without duplicating its report or usage", async () => {
    const value = await fixture();
    try {
      const [message] = await value.database
        .insert(imMessages)
        .values({
          imBindingId: value.binding.id,
          providerEventId: "event-steered",
          channelId: "oc_debug",
          externalMessageId: "om_steered",
          providerRevisionKey: "1",
          operation: "created",
          direction: "inbound",
          authorKind: "human",
          authorExternalId: "ou_debug",
          authorDisplayName: "Mia",
          content: { version: 1, fallbackText: "Use the newer requirement.", blocks: [], truncated: false },
          providerContext: { provider: "feishu", chatType: "p2p" },
          occurredAt: new Date("2026-08-27T01:04:00.000Z"),
        })
        .returning();
      if (!message) throw new Error("Steered message fixture was not created");
      const steeredAt = new Date("2026-08-27T01:05:00.000Z");
      await value.database.insert(imMessageDeliveries).values({
        messageId: message.id,
        sessionId: value.session.id,
        attention: "direct",
        state: "steered",
        placementGeneration: 1,
        inputHash: "b".repeat(64),
        steerTargetDeliveryId: value.deliveryId,
        steeredAt,
        expiresAt: new Date("2026-08-28T01:00:00.000Z"),
      });

      const listed = await value.service.list(value.bootstrap.userId, { limit: 50 });
      expect(listed.tasks[0]).toMatchObject({
        status: "completed",
        title: "Please debug this Turn.",
        lastActivityAt: steeredAt.toISOString(),
      });
      const [pendingMessage] = await value.database
        .insert(imMessages)
        .values({
          imBindingId: value.binding.id,
          providerEventId: "event-steer-deferred",
          channelId: "oc_debug",
          externalMessageId: "om_steer_deferred",
          providerRevisionKey: "1",
          operation: "created",
          direction: "inbound",
          authorKind: "human",
          authorExternalId: "ou_debug",
          authorDisplayName: "Mia",
          content: { version: 1, fallbackText: "Run this after the root.", blocks: [], truncated: false },
          providerContext: { provider: "feishu", chatType: "p2p" },
          occurredAt: new Date("2026-08-27T01:06:00.000Z"),
        })
        .returning();
      if (!pendingMessage) throw new Error("Deferred steer message fixture was not created");
      const [pendingDelivery] = await value.database
        .insert(imMessageDeliveries)
        .values({
          messageId: pendingMessage.id,
          sessionId: value.session.id,
          attention: "direct",
          state: "pending",
          placementGeneration: 1,
          steerTargetDeliveryId: value.deliveryId,
          expiresAt: new Date("2026-08-28T01:00:00.000Z"),
        })
        .returning();
      if (!pendingDelivery) throw new Error("Deferred steer delivery fixture was not created");
      const detail = await value.service.get(value.bootstrap.userId, value.message.id, { limit: 50 });
      expect(detail.turns.find((turn) => turn.deliveryId === pendingDelivery.id)).toMatchObject({
        delivery: { state: "pending" },
        absorbedBy: null,
        report: null,
      });
      expect(
        detail.turns.find((turn) => turn.deliveryId !== value.deliveryId && turn.delivery.state === "steered"),
      ).toMatchObject({
        delivery: { state: "steered", acceptedAt: null, steeredAt: steeredAt.toISOString() },
        absorbedBy: { deliveryId: value.deliveryId, turnId: value.turnId },
        report: null,
      });
      expect(detail.turns.find((turn) => turn.deliveryId === value.deliveryId)?.report?.usage).toEqual({
        inputTokens: 100,
        cachedInputTokens: null,
        outputTokens: 50,
      });
    } finally {
      await value.sql.end();
    }
  });
});
