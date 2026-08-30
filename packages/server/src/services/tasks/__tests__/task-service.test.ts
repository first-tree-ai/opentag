import type { TurnReportRequest } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../../__tests__/support/unit-database.js";
import { bootstrapTestAccount } from "../../../__tests__/test-account.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessions,
} from "../../../db/schema/index.js";
import { TaskQueryError, TaskService } from "../index.js";

const BASE_TIME = new Date("2026-08-24T12:00:00.000Z");
let unitDatabase: UnitDatabase;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unitDatabase?.close();
});

beforeEach(async () => {
  await unitDatabase.reset();
});

async function fixture() {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Task User",
    email: "task@example.com",
  });
  const installationId = crypto.randomUUID();
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: installationId,
      displayName: "Task Computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const [agent] = await unitDatabase.database
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
  const [binding] = await unitDatabase.database
    .insert(imBindings)
    .values({ agentId: agent.id, provider: "feishu" })
    .returning();
  if (!binding) throw new Error("Binding fixture was not created");
  const service = new TaskService(unitDatabase.database);
  return { agent, binding, bootstrap, service };
}

async function createSession(
  bindingId: string,
  options: {
    kind?: "channel" | "thread" | "internal";
    createdBySessionId?: string;
    endedAt?: Date | null;
    createdAt?: Date;
  } = {},
) {
  const kind = options.kind ?? "channel";
  const [session] = await unitDatabase.database
    .insert(sessions)
    .values({
      imBindingId: bindingId,
      channelId: `channel-${crypto.randomUUID()}`,
      conversationKind: "channel",
      kind,
      threadKey: kind === "thread" ? `thread-${crypto.randomUUID()}` : null,
      createdBySessionId: options.createdBySessionId,
      runtimeModel: kind === "internal" ? "claude-sonnet" : null,
      runtimeReasoningEffort: kind === "internal" ? "medium" : null,
      runtimeMaxDurationMs: kind === "internal" ? 20_000 : null,
      endedAt: options.endedAt,
      createdAt: options.createdAt ?? BASE_TIME,
    })
    .returning();
  if (!session) throw new Error("Session fixture was not created");
  return session;
}

async function createMessage(
  bindingId: string,
  text: string,
  occurredAt = BASE_TIME,
  authorDisplayName: string | null = "Mia",
) {
  const [message] = await unitDatabase.database
    .insert(imMessages)
    .values({
      imBindingId: bindingId,
      providerEventId: `event-${crypto.randomUUID()}`,
      channelId: "channel-fixture",
      externalMessageId: `message-${crypto.randomUUID()}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "human",
      authorDisplayName,
      content: { version: 1, fallbackText: text, blocks: [], truncated: false },
      providerContext: { provider: "feishu", chatType: "group" },
      occurredAt,
    })
    .returning();
  if (!message) throw new Error("Message fixture was not created");
  return message;
}

function report(overrides: Partial<TurnReportRequest> = {}): TurnReportRequest {
  return {
    type: "turn:report",
    requestId: crypto.randomUUID(),
    deliveryId: crypto.randomUUID(),
    turnId: `turn-${crypto.randomUUID()}`,
    sessionId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    placementGeneration: 1,
    outcome: "completed",
    executionEffects: "completed",
    finalText: "Done",
    usage: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 4 },
    traceSummary: { lastSequence: 4, droppedEvents: 0 },
    resultHash: "b".repeat(64),
    ...overrides,
  } as TurnReportRequest;
}

async function createDelivery(
  bindingId: string,
  sessionId: string,
  options: {
    state?: "pending" | "accepted" | "steered" | "terminal_rejected" | "expired";
    occurredAt?: Date;
    reported?: boolean;
    outcome?: "completed" | "failed" | "cancelled" | "unknown";
    absorbedByDeliveryId?: string;
  } = {},
) {
  const state = options.state ?? "accepted";
  const occurredAt = options.occurredAt ?? BASE_TIME;
  const message = await createMessage(bindingId, state === "pending" ? "Queued input" : "Task input", occurredAt);
  const reportedAt = state === "accepted" && options.reported ? new Date(occurredAt.getTime() + 1_000) : null;
  const turnReport = reportedAt ? report({ outcome: options.outcome ?? "completed" }) : null;
  const [delivery] = await unitDatabase.database
    .insert(imMessageDeliveries)
    .values({
      messageId: message.id,
      sessionId,
      attention: "direct",
      state,
      placementGeneration: 1,
      inputHash: state === "accepted" || state === "steered" ? "c".repeat(64) : null,
      turnId: state === "accepted" ? `turn-${crypto.randomUUID()}` : null,
      reportOwnerInstanceId: state === "accepted" ? crypto.randomUUID() : null,
      acceptedAt: state === "accepted" ? occurredAt : null,
      steeredAt: state === "steered" ? new Date(occurredAt.getTime() + 1_000) : null,
      steerTargetDeliveryId: state === "steered" ? options.absorbedByDeliveryId : null,
      expiresAt: new Date(BASE_TIME.getTime() + 60_000),
      reportedAt,
      turnReport,
      resultHash: reportedAt ? "b".repeat(64) : null,
      reason: state === "terminal_rejected" ? "No connected computer" : null,
      lastErrorCode: state === "terminal_rejected" ? "RUNTIME_UNAVAILABLE" : null,
    })
    .returning();
  if (!delivery) throw new Error("Delivery fixture was not created");
  return delivery;
}

describe("TaskService", () => {
  it("lists tasks, filters by Agent and kind, and emits a cursor", async () => {
    const { agent, binding, bootstrap, service } = await fixture();
    const first = await createSession(binding.id, { createdAt: new Date("2026-08-24T10:00:00.000Z") });
    const second = await createSession(binding.id, { kind: "thread", createdAt: new Date("2026-08-24T09:00:00.000Z") });
    await createDelivery(binding.id, first.id, { reported: true });
    const page = await service.list(bootstrap.userId, { limit: 1 });
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({
      id: first.id,
      status: "completed",
      title: "Task input",
      agent: { id: agent.id, displayName: "Atlas" },
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    await expect(
      service.list(bootstrap.userId, { limit: 50, agentId: agent.id, kind: "thread" }),
    ).resolves.toMatchObject({ tasks: [{ id: second.id, sessionKind: "thread", status: "idle" }] });
    await expect(service.list(bootstrap.userId, { limit: 50, kind: "channel" })).resolves.toMatchObject({
      tasks: [{ id: first.id }],
    });
    const next = await service.list(bootstrap.userId, { limit: 1, cursor: page.nextCursor ?? undefined });
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]).toMatchObject({ id: second.id, sessionKind: "thread" });
    expect(next.nextCursor).toBeNull();
  });

  it("maps every task status and normalizes summary dates", async () => {
    const { binding, bootstrap, service } = await fixture();
    const ended = await createSession(binding.id, {
      endedAt: BASE_TIME,
      createdAt: new Date("2026-08-24T01:00:00.000Z"),
    });
    const idle = await createSession(binding.id, { createdAt: new Date("2026-08-24T02:00:00.000Z") });
    const queued = await createSession(binding.id, { createdAt: new Date("2026-08-24T03:00:00.000Z") });
    const expired = await createSession(binding.id, { createdAt: new Date("2026-08-24T04:00:00.000Z") });
    const rejected = await createSession(binding.id, { createdAt: new Date("2026-08-24T05:00:00.000Z") });
    const running = await createSession(binding.id, { createdAt: new Date("2026-08-24T06:00:00.000Z") });
    const failed = await createSession(binding.id, { createdAt: new Date("2026-08-24T07:00:00.000Z") });
    const completed = await createSession(binding.id, { createdAt: new Date("2026-08-24T08:00:00.000Z") });
    await createDelivery(binding.id, queued.id, { state: "pending" });
    await createDelivery(binding.id, expired.id, { state: "expired" });
    await createDelivery(binding.id, rejected.id, { state: "terminal_rejected" });
    await createDelivery(binding.id, running.id, { reported: false });
    await createDelivery(binding.id, failed.id, { reported: true, outcome: "failed" });
    await createDelivery(binding.id, completed.id, { reported: true, outcome: "completed" });
    const result = await service.list(bootstrap.userId, { limit: 50 });
    const statuses = new Map(result.tasks.map((task) => [task.id, task.status]));
    expect(statuses).toEqual(
      new Map([
        [completed.id, "completed"],
        [failed.id, "failed"],
        [running.id, "running"],
        [rejected.id, "failed"],
        [expired.id, "expired"],
        [queued.id, "queued"],
        [idle.id, "idle"],
        [ended.id, "ended"],
      ]),
    );
  });

  it("returns detailed turns, absorbed steering, recursive internal Sessions, and collaboration messages", async () => {
    const { binding, bootstrap, service } = await fixture();
    const root = await createSession(binding.id);
    const child = await createSession(binding.id, {
      kind: "internal",
      createdBySessionId: root.id,
      createdAt: new Date("2026-08-24T13:00:00.000Z"),
    });
    const grandchild = await createSession(binding.id, {
      kind: "internal",
      createdBySessionId: child.id,
      createdAt: new Date("2026-08-24T14:00:00.000Z"),
      endedAt: BASE_TIME,
    });
    const rootDelivery = await createDelivery(binding.id, root.id, { reported: true });
    const steered = await createDelivery(binding.id, root.id, {
      state: "steered",
      absorbedByDeliveryId: rootDelivery.id,
    });
    await unitDatabase.database.insert(sessionMessages).values({
      id: crypto.randomUUID(),
      sourceSessionId: root.id,
      targetSessionId: child.id,
      content: "Please inspect the failing test.",
      contentHash: "d".repeat(64),
      lastOutcome: "accepted",
      attemptCount: 1,
      lastAttemptAt: BASE_TIME,
    });
    const detail = await service.get(bootstrap.userId, root.id, { limit: 10 });
    expect(detail.task).toMatchObject({ id: root.id, status: "completed" });
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns.find((turn) => turn.deliveryId === steered.id)).toMatchObject({
      delivery: { state: "steered" },
      absorbedBy: { deliveryId: rootDelivery.id },
    });
    expect(detail.turns.find((turn) => turn.deliveryId === rootDelivery.id)).toMatchObject({
      report: {
        outcome: "completed",
        finalText: "Done",
        usage: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 4 },
      },
      message: { fallbackText: "Task input", authorDisplayName: "Mia" },
    });
    expect(detail.internalSessions).toEqual([
      expect.objectContaining({ id: child.id, createdBySessionId: root.id, runtimeModel: "claude-sonnet" }),
      expect.objectContaining({ id: grandchild.id, endedAt: BASE_TIME.toISOString() }),
    ]);
    expect(detail.collaborationMessages).toEqual([
      expect.objectContaining({
        sourceSessionId: root.id,
        targetSessionId: child.id,
        outcome: "accepted",
        attemptCount: 1,
      }),
    ]);
  });

  it("paginates turns and rejects missing tasks or malformed cursors", async () => {
    const { binding, bootstrap, service } = await fixture();
    const session = await createSession(binding.id);
    await createDelivery(binding.id, session.id, { occurredAt: new Date("2026-08-24T10:00:00.000Z"), reported: true });
    await createDelivery(binding.id, session.id, { occurredAt: new Date("2026-08-24T09:00:00.000Z"), reported: false });
    const first = await service.get(bootstrap.userId, session.id, { limit: 1 });
    expect(first.turns).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.get(bootstrap.userId, session.id, { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.turns).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    await expect(service.get(bootstrap.userId, crypto.randomUUID(), { limit: 1 })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
    const badCursor = Buffer.from(JSON.stringify({ at: "not-a-date", id: "bad" }), "utf8").toString("base64url");
    await expect(service.list(bootstrap.userId, { limit: 1, cursor: badCursor })).rejects.toBeInstanceOf(
      TaskQueryError,
    );
    await expect(service.get(bootstrap.userId, session.id, { limit: 1, cursor: "%%%" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
  });
});
