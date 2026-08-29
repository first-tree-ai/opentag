import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  accountComputers,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessions,
  workspaceComputers,
} from "../../db/schema/index.js";
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
    workspaceDisplayName: "Example",
    workspaceName: "example",
  });
  const [computer] = await client.database.insert(computers).values({ id: crypto.randomUUID() }).returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const [workspaceComputer] = await client.database
    .insert(workspaceComputers)
    .values({
      workspaceId: bootstrap.workspaceId,
      computerId: computer.id,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
      enrolledByUserId: bootstrap.userId,
    })
    .returning();
  if (!workspaceComputer) throw new Error("Workspace Computer fixture was not created");
  await client.database.insert(accountComputers).values({
    id: workspaceComputer.id,
    ownerAccountId: bootstrap.userId,
    currentInstallationId: computer.id,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.1",
  });
  const [agent] = await client.database
    .insert(agents)
    .values({
      workspaceId: bootstrap.workspaceId,
      createdByUserId: bootstrap.userId,
      workspaceComputerId: workspaceComputer.id,
      computerId: workspaceComputer.id,
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

describe("Task debug queries", () => {
  it("projects a top-level Session and its stored Turn report", async () => {
    const value = await fixture();
    try {
      const listed = await value.service.list(value.bootstrap.workspaceId, { limit: 50 });
      expect(listed).toMatchObject({
        nextCursor: null,
        tasks: [
          {
            id: value.session.id,
            title: "Please debug this Turn.",
            status: "completed",
            agent: { id: value.agent.id, displayName: "Atlas" },
            source: { provider: "feishu", channelId: "oc_debug" },
          },
        ],
      });

      const detail = await value.service.get(value.bootstrap.workspaceId, value.session.id, { limit: 50 });
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

      const listed = await value.service.list(value.bootstrap.workspaceId, { limit: 50 });
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

      const listed = await value.service.list(value.bootstrap.workspaceId, { limit: 50 });
      expect(listed.tasks[0]?.title).toBe("ask @Alice to review");
    } finally {
      await value.sql.end();
    }
  });

  it("titles a Session from a follow-up message that no longer addresses the Agent", async () => {
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

      const listed = await value.service.list(value.bootstrap.workspaceId, { limit: 50 });
      expect(listed.tasks[0]?.title).toBe("@Alice take another look at the regression");
    } finally {
      await value.sql.end();
    }
  });

  it("isolates Workspace data and rejects malformed cursors", async () => {
    const value = await fixture();
    try {
      await expect(value.service.list(crypto.randomUUID(), { limit: 50 })).resolves.toEqual({
        tasks: [],
        nextCursor: null,
      });
      await expect(value.service.get(crypto.randomUUID(), value.session.id, { limit: 50 })).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        value.service.list(value.bootstrap.workspaceId, { cursor: "invalid", limit: 50 }),
      ).rejects.toBeInstanceOf(TaskQueryError);
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

      const listed = await value.service.list(value.bootstrap.workspaceId, { limit: 50 });
      expect(listed.tasks[0]).toMatchObject({
        status: "completed",
        title: "Use the newer requirement.",
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
      const detail = await value.service.get(value.bootstrap.workspaceId, value.session.id, { limit: 50 });
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
