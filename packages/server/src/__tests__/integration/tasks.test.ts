import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessions,
  workspaceComputers,
} from "../../db/schema/index.js";
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
  const [agent] = await client.database
    .insert(agents)
    .values({
      workspaceId: bootstrap.workspaceId,
      createdByUserId: bootstrap.userId,
      workspaceComputerId: workspaceComputer.id,
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
  return { ...client, agent, bootstrap, service: new TaskService(client.database), session };
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
});
