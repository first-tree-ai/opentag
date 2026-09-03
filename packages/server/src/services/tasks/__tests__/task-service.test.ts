import type { ImContentV1, TaskTurn, TurnReportRequest } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../../__tests__/support/unit-database.js";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../../../admin/bootstrap.js";
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
const GROUP = "oc_group";
const DM = "oc_dm";
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

function minutes(offset: number): Date {
  return new Date(BASE_TIME.getTime() + offset * 60_000);
}

async function fixture() {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Task User",
    email: "task@example.com",
  });
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
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
  // Deliveries in these fixtures expire a week after BASE_TIME; pin the clock so that never passes.
  const service = new TaskService(unitDatabase.database, { now: () => BASE_TIME });
  return { agent, binding, bootstrap, service };
}

async function createSession(
  bindingId: string,
  options: {
    channelId?: string;
    conversationKind?: "channel" | "dm";
    kind?: "channel" | "thread" | "internal";
    threadKey?: string;
    createdBySessionId?: string;
    endedAt?: Date | null;
    createdAt?: Date;
    manualTitle?: string | null;
    generatedTitle?: string | null;
  } = {},
) {
  const kind = options.kind ?? "channel";
  const [session] = await unitDatabase.database
    .insert(sessions)
    .values({
      imBindingId: bindingId,
      channelId: options.channelId ?? GROUP,
      conversationKind: options.conversationKind ?? "channel",
      kind,
      threadKey:
        kind === "thread" ? (options.threadKey ?? `thread-${crypto.randomUUID()}`) : (options.threadKey ?? null),
      createdBySessionId: options.createdBySessionId,
      runtimeModel: kind === "internal" ? "claude-sonnet" : null,
      runtimeReasoningEffort: kind === "internal" ? "medium" : null,
      runtimeMaxDurationMs: kind === "internal" ? 20_000 : null,
      manualTitle: options.manualTitle,
      generatedTitle: options.generatedTitle,
      endedAt: options.endedAt,
      createdAt: options.createdAt ?? BASE_TIME,
    })
    .returning();
  if (!session) throw new Error("Session fixture was not created");
  return session;
}

async function createMessage(
  bindingId: string,
  options: {
    channelId?: string;
    externalMessageId?: string;
    threadKey?: string | null;
    text?: string;
    blocks?: ImContentV1["blocks"];
    occurredAt?: Date;
    authorDisplayName?: string | null;
    revisionKey?: string;
    providerContext?: { provider: "feishu"; chatType?: string; threadId?: string; rootId?: string };
  } = {},
) {
  const [message] = await unitDatabase.database
    .insert(imMessages)
    .values({
      imBindingId: bindingId,
      providerEventId: `event-${crypto.randomUUID()}`,
      channelId: options.channelId ?? GROUP,
      externalMessageId: options.externalMessageId ?? `om-${crypto.randomUUID()}`,
      providerRevisionKey: options.revisionKey ?? "1",
      operation: "created",
      direction: "inbound",
      threadKey: options.threadKey ?? null,
      authorKind: "human",
      authorExternalId: "ou_human",
      authorDisplayName: options.authorDisplayName === undefined ? "Mia" : options.authorDisplayName,
      content: {
        version: 1,
        fallbackText: options.text ?? "Task input",
        blocks: options.blocks ?? [],
        truncated: false,
      },
      providerContext: options.providerContext ?? { provider: "feishu", chatType: "group" },
      occurredAt: options.occurredAt ?? BASE_TIME,
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

type DeliveryState = TaskTurn["delivery"]["state"];

interface DeliveryOptions {
  attention?: "direct" | "ambient";
  state?: DeliveryState;
  at?: Date;
  reported?: boolean;
  outcome?: "completed" | "failed" | "cancelled" | "unknown";
  absorbedByDeliveryId?: string;
  reason?: string;
  expiresAt?: Date;
}

/** The custody columns the schema check requires for each delivery state. */
function custodyColumns(state: DeliveryState, at: Date, absorbedByDeliveryId: string | undefined) {
  if (state === "accepted") {
    return {
      inputHash: "c".repeat(64),
      turnId: `turn-${crypto.randomUUID()}`,
      reportOwnerInstanceId: crypto.randomUUID(),
      acceptedAt: at,
    };
  }
  if (state === "steered") {
    return {
      inputHash: "c".repeat(64),
      steeredAt: new Date(at.getTime() + 1_000),
      steerTargetDeliveryId: absorbedByDeliveryId,
    };
  }
  return {};
}

function reportColumns(state: DeliveryState, at: Date, options: DeliveryOptions) {
  if (state !== "accepted" || !options.reported) return {};
  return {
    reportedAt: new Date(at.getTime() + 1_000),
    turnReport: report({ outcome: options.outcome ?? "completed" }),
    resultHash: "b".repeat(64),
  };
}

async function createDelivery(sessionId: string, messageId: string, options: DeliveryOptions = {}) {
  const state = options.state ?? "accepted";
  const at = options.at ?? BASE_TIME;
  const rejected = state === "terminal_rejected";
  const [delivery] = await unitDatabase.database
    .insert(imMessageDeliveries)
    .values({
      messageId,
      sessionId,
      attention: options.attention ?? "direct",
      state,
      placementGeneration: 1,
      expiresAt: options.expiresAt ?? new Date(BASE_TIME.getTime() + 7 * 24 * 60 * 60_000),
      reason: options.reason ?? (rejected ? "No connected computer" : null),
      lastErrorCode: rejected ? "RUNTIME_UNAVAILABLE" : null,
      ...custodyColumns(state, at, options.absorbedByDeliveryId),
      ...reportColumns(state, at, options),
    })
    .returning();
  if (!delivery) throw new Error("Delivery fixture was not created");
  return delivery;
}

/** A group with the root request delivered to the channel Session and one reply owned by a thread Session. */
async function groupTopic(bindingId: string, rootExternalId = "om_root") {
  const channel = await createSession(bindingId, { channelId: GROUP });
  const thread = await createSession(bindingId, { channelId: GROUP, kind: "thread", threadKey: rootExternalId });
  const root = await createMessage(bindingId, {
    externalMessageId: rootExternalId,
    text: "Root request",
    occurredAt: minutes(0),
  });
  const reply = await createMessage(bindingId, {
    threadKey: rootExternalId,
    text: "Reply in the chain",
    occurredAt: minutes(10),
  });
  return { channel, thread, root, reply };
}

describe("TaskService", () => {
  it("groups a root message and its reply chain into one Task keyed by the earliest message", async () => {
    const { agent, binding, bootstrap, service } = await fixture();
    const { channel, thread, root, reply } = await groupTopic(binding.id);
    await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(11) });

    const page = await service.list(bootstrap.userId, { limit: 50 });
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({
      id: root.id,
      title: "Root request",
      status: "running",
      sessionKind: "thread",
      source: { provider: "feishu", channelId: GROUP, threadKey: "om_root", conversationKind: "channel" },
      agent: { id: agent.id, displayName: "Atlas" },
      createdAt: minutes(0).toISOString(),
      lastActivityAt: minutes(11).toISOString(),
    });
  });

  it("lists a top-level request that nobody replied to as its own Task", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const alone = await createMessage(binding.id, { text: "Nobody replied", occurredAt: minutes(0) });
    await createDelivery(channel.id, alone.id, { at: minutes(1), reported: true });

    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [
        {
          id: alone.id,
          title: "Nobody replied",
          status: "completed",
          sessionKind: "channel",
          source: { conversationKind: "channel", threadKey: null },
        },
      ],
    });
  });

  it("lists a topic only after someone addressed the Agent directly", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const overheard = await createMessage(binding.id, { text: "Lunch?", occurredAt: minutes(0) });
    await createDelivery(channel.id, overheard.id, { attention: "ambient", at: minutes(1), reported: true });
    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toEqual({ tasks: [], nextCursor: null });

    const addressed = await createMessage(binding.id, { text: "@Atlas summarize", occurredAt: minutes(5) });
    await createDelivery(channel.id, addressed.id, { at: minutes(6) });
    const page = await service.list(bootstrap.userId, { limit: 50 });
    expect(page.tasks.map((task) => task.id)).toEqual([addressed.id]);
  });

  it("keeps the channel observer copy out of a topic the thread Session owns", async () => {
    const { binding, bootstrap, service } = await fixture();
    const { channel, thread, root, reply } = await groupTopic(binding.id);
    await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(11), reported: true, outcome: "completed" });
    await createDelivery(channel.id, reply.id, {
      attention: "ambient",
      at: minutes(12),
      reported: true,
      outcome: "failed",
    });

    const page = await service.list(bootstrap.userId, { limit: 50 });
    expect(page.tasks[0]).toMatchObject({ id: root.id, status: "completed" });
    const detail = await service.get(bootstrap.userId, root.id, { limit: 50 });
    expect(detail.turns.filter((turn) => turn.message.id === reply.id)).toHaveLength(1);
    expect(detail.turns.find((turn) => turn.message.id === reply.id)?.attention).toBe("direct");
  });

  it("shows a mention by its label in a Turn instead of the provider placeholder", async () => {
    const { binding, bootstrap, service } = await fixture();
    const dm = await createSession(binding.id, { channelId: DM, conversationKind: "dm" });
    const message = await createMessage(binding.id, {
      channelId: DM,
      text: "@_user_1 帮我关掉 446;",
      blocks: [
        { type: "mention", externalId: "ou_bot", label: "@Atlas" },
        { type: "text", text: " 帮我关掉 446;" },
      ],
    });
    await createDelivery(dm.id, message.id, { at: minutes(1), reported: true });

    const detail = await service.get(bootstrap.userId, message.id, { limit: 10 });
    expect(detail.turns.map((turn) => turn.message.fallbackText)).toEqual(["@Atlas 帮我关掉 446;"]);
  });

  it("treats a private chat as one Task regardless of reply chains", async () => {
    const { binding, bootstrap, service } = await fixture();
    const dm = await createSession(binding.id, { channelId: DM, conversationKind: "dm" });
    const first = await createMessage(binding.id, {
      channelId: DM,
      externalMessageId: "om_dm_first",
      text: "First private request",
      occurredAt: minutes(0),
    });
    const quoted = await createSession(binding.id, {
      channelId: DM,
      conversationKind: "dm",
      kind: "thread",
      threadKey: "om_dm_first",
    });
    const replyToFirst = await createMessage(binding.id, {
      channelId: DM,
      threadKey: "om_dm_first",
      text: "Quoted reply",
      occurredAt: minutes(5),
    });
    const later = await createMessage(binding.id, { channelId: DM, text: "Another ask", occurredAt: minutes(20) });
    await createDelivery(dm.id, first.id, { at: minutes(1), reported: true });
    await createDelivery(quoted.id, replyToFirst.id, { at: minutes(6), reported: true });
    await createDelivery(dm.id, later.id, { at: minutes(21), reported: true });

    const page = await service.list(bootstrap.userId, { limit: 50 });
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({
      id: first.id,
      title: "First private request",
      sessionKind: "channel",
      source: { channelId: DM, threadKey: null, conversationKind: "dm" },
      // The last execution reported one second after it was accepted; reporting counts as activity.
      lastActivityAt: new Date(minutes(21).getTime() + 1_000).toISOString(),
    });
    const detail = await service.get(bootstrap.userId, first.id, { limit: 50 });
    expect(detail.turns.map((turn) => turn.message.id)).toEqual([later.id, replyToFirst.id, first.id]);
  });

  it("filters by Agent and by kind", async () => {
    const { agent, binding, bootstrap, service } = await fixture();
    const dm = await createSession(binding.id, { channelId: DM, conversationKind: "dm" });
    const privateMessage = await createMessage(binding.id, { channelId: DM, text: "Private", occurredAt: minutes(0) });
    await createDelivery(dm.id, privateMessage.id, { at: minutes(1), reported: true });
    const channel = await createSession(binding.id, { channelId: GROUP });
    const groupMessage = await createMessage(binding.id, {
      externalMessageId: "om_group",
      text: "Group",
      occurredAt: minutes(2),
    });
    await createDelivery(channel.id, groupMessage.id, { at: minutes(3), reported: true });
    const groupReply = await createMessage(binding.id, {
      threadKey: "om_group",
      text: "Reply",
      occurredAt: minutes(4),
    });
    await createDelivery(channel.id, groupReply.id, { at: minutes(5), reported: true });
    const alone = await createMessage(binding.id, { text: "Alone", occurredAt: minutes(6) });
    await createDelivery(channel.id, alone.id, { at: minutes(7), reported: true });

    await expect(service.list(bootstrap.userId, { limit: 50, kind: "channel" })).resolves.toMatchObject({
      tasks: [
        { id: alone.id, sessionKind: "channel" },
        { id: privateMessage.id, sessionKind: "channel" },
      ],
    });
    await expect(service.list(bootstrap.userId, { limit: 50, kind: "thread" })).resolves.toMatchObject({
      tasks: [{ id: groupMessage.id, sessionKind: "thread", source: { threadKey: "om_group" } }],
    });
    await expect(service.list(bootstrap.userId, { limit: 50, agentId: agent.id })).resolves.toMatchObject({
      tasks: [{ id: alone.id }, { id: groupMessage.id }, { id: privateMessage.id }],
    });
    await expect(service.list(bootstrap.userId, { limit: 50, agentId: crypto.randomUUID() })).resolves.toEqual({
      tasks: [],
      nextCursor: null,
    });
  });

  it("derives the status from execution precedence, not from the latest message", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const make = async (text: string, offset: number) =>
      createMessage(binding.id, { text, externalMessageId: `om_${text}`, occurredAt: minutes(offset) });

    const queued = await make("queued", 0);
    await createDelivery(channel.id, queued.id, { state: "pending" });

    const completed = await make("completed", 3);
    await createDelivery(channel.id, completed.id, { at: minutes(3), reported: true, outcome: "completed" });
    const failed = await make("failed", 4);
    await createDelivery(channel.id, failed.id, { at: minutes(4), reported: true, outcome: "failed" });

    // A Session runs one Turn at a time, so the running one is the Session's latest acceptance.
    const running = await make("running", 9);
    await createDelivery(channel.id, running.id, { at: minutes(9) });
    const queuedBehindRunning = await createMessage(binding.id, {
      threadKey: "om_running",
      text: "follow-up",
      occurredAt: minutes(10),
    });
    await createDelivery(channel.id, queuedBehindRunning.id, { state: "pending" });
    const rejected = await make("rejected", 5);
    await createDelivery(channel.id, rejected.id, { state: "terminal_rejected" });
    const expired = await make("expired", 6);
    await createDelivery(channel.id, expired.id, { state: "expired", reason: "ttl" });
    const superseded = await make("superseded", 7);
    await createDelivery(channel.id, superseded.id, { state: "expired", reason: "superseded_revision" });

    const endedChannel = await createSession(binding.id, { channelId: "oc_ended", endedAt: minutes(30) });
    const ended = await createMessage(binding.id, { channelId: "oc_ended", text: "ended", occurredAt: minutes(8) });
    await createDelivery(endedChannel.id, ended.id, { at: minutes(8), reported: true });

    const result = await service.list(bootstrap.userId, { limit: 50 });
    expect(new Map(result.tasks.map((task) => [task.id, task.status]))).toEqual(
      new Map([
        [queued.id, "queued"],
        [running.id, "running"],
        [completed.id, "completed"],
        [failed.id, "failed"],
        [rejected.id, "failed"],
        [expired.id, "expired"],
        [ended.id, "ended"],
      ]),
    );
  });

  it("stops counting an accepted delivery as running once a later Turn ran in the same Session or its deadline passed", async () => {
    const { binding, bootstrap } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const orphaned = await createMessage(binding.id, {
      externalMessageId: "om_orphan",
      text: "Crashed",
      occurredAt: minutes(0),
    });
    await createDelivery(channel.id, orphaned.id, { at: minutes(1) });
    const retry = await createMessage(binding.id, { threadKey: "om_orphan", text: "Again", occurredAt: minutes(5) });
    await createDelivery(channel.id, retry.id, { at: minutes(6), reported: true });

    const stale = await createMessage(binding.id, { text: "Past deadline", occurredAt: minutes(10) });
    await createDelivery(channel.id, stale.id, { at: minutes(11), expiresAt: minutes(20) });

    const late = new TaskService(unitDatabase.database, { now: () => minutes(30) });
    const statuses = new Map(
      (await late.list(bootstrap.userId, { limit: 50 })).tasks.map((task) => [task.id, task.status]),
    );
    expect(statuses.get(orphaned.id)).toBe("completed");
    expect(statuses.get(stale.id)).toBe("expired");
  });

  it("resolves manual over generated over derived titles through the topic's thread Session", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const thread = await createSession(binding.id, {
      channelId: GROUP,
      kind: "thread",
      threadKey: "om_root",
      manualTitle: "Manual title",
      generatedTitle: "Generated title",
    });
    const root = await createMessage(binding.id, {
      externalMessageId: "om_root",
      text: "Derived from the root",
      occurredAt: minutes(0),
    });
    const reply = await createMessage(binding.id, {
      threadKey: "om_root",
      text: "Latest reply",
      occurredAt: minutes(5),
    });
    await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(6), reported: true });

    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [{ id: root.id, title: "Manual title" }],
    });
    await service.updateTitle(bootstrap.userId, thread.id, null);
    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [{ id: root.id, title: "Generated title" }],
    });
    await expect(service.saveGeneratedTitle(thread.id, "Replacement title")).resolves.toBe(true);
    await service.updateTitle(bootstrap.userId, thread.id, "  Final title  ");
    await expect(service.saveGeneratedTitle(thread.id, "Ignored title")).resolves.toBe(false);
    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [{ id: root.id, title: "Final title" }],
    });
    await service.updateTitle(bootstrap.userId, thread.id, null);
    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [{ id: root.id, title: "Replacement title" }],
    });
  });

  it("returns merged Turns, absorbed steering, internal Sessions and collaboration messages for a topic", async () => {
    const { binding, bootstrap, service } = await fixture();
    const { channel, thread, root, reply } = await groupTopic(binding.id);
    // Internal Sessions inherit the creator's channel and thread key, as SessionService does.
    const child = await createSession(binding.id, {
      kind: "internal",
      threadKey: "om_root",
      createdBySessionId: thread.id,
      createdAt: minutes(12),
    });
    const grandchild = await createSession(binding.id, {
      kind: "internal",
      threadKey: "om_root",
      createdBySessionId: child.id,
      createdAt: minutes(13),
      endedAt: minutes(14),
    });
    const rootDelivery = await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    const steeredMessage = await createMessage(binding.id, {
      threadKey: "om_root",
      text: "Also include last week",
      occurredAt: minutes(2),
    });
    const steered = await createDelivery(channel.id, steeredMessage.id, {
      state: "steered",
      at: minutes(2),
      absorbedByDeliveryId: rootDelivery.id,
    });
    await createDelivery(thread.id, reply.id, { at: minutes(11), reported: true });
    await unitDatabase.database.insert(sessionMessages).values({
      id: crypto.randomUUID(),
      sourceSessionId: thread.id,
      targetSessionId: child.id,
      content: "Please inspect the failing test.",
      contentHash: "d".repeat(64),
      lastOutcome: "accepted",
      attemptCount: 1,
      lastAttemptAt: BASE_TIME,
    });

    const detail = await service.get(bootstrap.userId, root.id, { limit: 10 });
    expect(detail.task).toMatchObject({ id: root.id, status: "completed" });
    expect(detail.turns.map((turn) => turn.message.id)).toEqual([reply.id, steeredMessage.id, root.id]);
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
      message: { fallbackText: "Root request", authorDisplayName: "Mia" },
    });
    expect(detail.internalSessions).toEqual([
      expect.objectContaining({ id: child.id, createdBySessionId: thread.id, runtimeModel: "claude-sonnet" }),
      expect.objectContaining({ id: grandchild.id, endedAt: minutes(14).toISOString() }),
    ]);
    expect(detail.collaborationMessages).toEqual([
      expect.objectContaining({ sourceSessionId: thread.id, targetSessionId: child.id, outcome: "accepted" }),
    ]);
    // Any message in the topic opens the same Task under its canonical id.
    await expect(service.get(bootstrap.userId, reply.id, { limit: 10 })).resolves.toMatchObject({
      task: { id: root.id },
    });
  });

  it("unifies a Feishu topic whose replies carry a thread id different from the root message", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const thread = await createSession(binding.id, {
      channelId: GROUP,
      kind: "thread",
      threadKey: "omt_topic",
      manualTitle: "Topic title",
    });
    const root = await createMessage(binding.id, {
      externalMessageId: "om_root",
      text: "Topic root",
      occurredAt: minutes(0),
      providerContext: { provider: "feishu", chatType: "group" },
    });
    const reply = await createMessage(binding.id, {
      threadKey: "omt_topic",
      text: "Reply inside the topic",
      occurredAt: minutes(5),
      providerContext: { provider: "feishu", chatType: "group", threadId: "omt_topic", rootId: "om_root" },
    });
    await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(6) });

    const page = await service.list(bootstrap.userId, { limit: 50 });
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({ id: root.id, title: "Topic title", status: "running" });
    const detail = await service.get(bootstrap.userId, reply.id, { limit: 50 });
    expect(detail.task.id).toBe(root.id);
    expect(detail.turns.map((turn) => turn.message.id)).toEqual([reply.id, root.id]);
  });

  it("renames a Task through its own id and refuses a topic that has no titleable Session", async () => {
    const { binding, bootstrap, service } = await fixture();
    const { channel, thread, root, reply } = await groupTopic(binding.id);
    await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(11), reported: true });
    await expect(service.updateTitle(bootstrap.userId, root.id, "Renamed by Task id")).resolves.toMatchObject({
      id: root.id,
      title: "Renamed by Task id",
    });
    await expect(service.updateTitle(bootstrap.userId, thread.id, "Renamed by Session id")).resolves.toMatchObject({
      id: root.id,
      title: "Renamed by Session id",
    });

    const alone = await createMessage(binding.id, { text: "Nobody replied", occurredAt: minutes(20) });
    await createDelivery(channel.id, alone.id, { at: minutes(21), reported: true });
    await expect(service.updateTitle(bootstrap.userId, alone.id, "No home")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.updateTitle(crypto.randomUUID(), root.id, "Not mine")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("attributes internal Sessions the channel Session spawned during a topic's Turn to that topic", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const first = await createMessage(binding.id, { text: "First request", occurredAt: minutes(0) });
    const second = await createMessage(binding.id, { text: "Second request", occurredAt: minutes(30) });
    await createDelivery(channel.id, first.id, { at: minutes(1), reported: true });
    await createDelivery(channel.id, second.id, { at: minutes(31), reported: true });
    // The report helper stamps reportedAt one second after acceptance, so these windows are narrow.
    const duringFirst = await createSession(binding.id, {
      kind: "internal",
      channelId: GROUP,
      createdBySessionId: channel.id,
      createdAt: new Date(minutes(1).getTime() + 500),
    });
    const grandchild = await createSession(binding.id, {
      kind: "internal",
      channelId: GROUP,
      createdBySessionId: duringFirst.id,
      createdAt: minutes(10),
    });
    await createSession(binding.id, {
      kind: "internal",
      channelId: GROUP,
      createdBySessionId: channel.id,
      createdAt: minutes(20),
    });

    const detail = await service.get(bootstrap.userId, first.id, { limit: 10 });
    expect(detail.internalSessions.map((session) => session.id)).toEqual([duringFirst.id, grandchild.id]);
    const other = await service.get(bootstrap.userId, second.id, { limit: 10 });
    expect(other.internalSessions).toEqual([]);
  });

  it("reports a topic as ended when its thread Session ended", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const thread = await createSession(binding.id, {
      channelId: GROUP,
      kind: "thread",
      threadKey: "om_root",
      endedAt: minutes(30),
    });
    const root = await createMessage(binding.id, {
      externalMessageId: "om_root",
      text: "Root",
      occurredAt: minutes(0),
    });
    const reply = await createMessage(binding.id, { threadKey: "om_root", text: "Reply", occurredAt: minutes(5) });
    await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(6), reported: true });
    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [{ id: root.id, status: "ended", endedAt: minutes(30).toISOString() }],
    });
  });

  it("keeps another topic's collaboration messages out of a root-only Task", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const spawnDuring = async (text: string, offset: number) => {
      const root = await createMessage(binding.id, { text, occurredAt: minutes(offset) });
      await createDelivery(channel.id, root.id, { at: minutes(offset + 1), reported: true });
      const child = await createSession(binding.id, {
        kind: "internal",
        channelId: GROUP,
        createdBySessionId: channel.id,
        createdAt: new Date(minutes(offset + 1).getTime() + 500),
      });
      await unitDatabase.database.insert(sessionMessages).values({
        id: crypto.randomUUID(),
        sourceSessionId: channel.id,
        targetSessionId: child.id,
        content: `Delegate: ${text}`,
        contentHash: "d".repeat(64),
        lastOutcome: "accepted",
        attemptCount: 1,
        lastAttemptAt: BASE_TIME,
      });
      return { root, child };
    };
    const first = await spawnDuring("First request", 0);
    const second = await spawnDuring("Second request", 30);

    const detail = await service.get(bootstrap.userId, first.root.id, { limit: 10 });
    expect(detail.internalSessions.map((session) => session.id)).toEqual([first.child.id]);
    expect(detail.collaborationMessages.map((message) => message.targetSessionId)).toEqual([first.child.id]);
    const other = await service.get(bootstrap.userId, second.root.id, { limit: 10 });
    expect(other.collaborationMessages.map((message) => message.targetSessionId)).toEqual([second.child.id]);
  });

  it("prefers a live thread Session over an ended channel Session in a private chat", async () => {
    const { binding, bootstrap, service } = await fixture();
    await createSession(binding.id, {
      channelId: DM,
      conversationKind: "dm",
      endedAt: minutes(0),
      createdAt: minutes(-60),
    });
    const revived = await createSession(binding.id, {
      channelId: DM,
      conversationKind: "dm",
      kind: "thread",
      threadKey: "om_quoted",
      createdAt: minutes(5),
    });
    const quoted = await createMessage(binding.id, {
      channelId: DM,
      threadKey: "om_quoted",
      text: "Quoted after reauthorization",
      occurredAt: minutes(5),
    });
    await createDelivery(revived.id, quoted.id, { at: minutes(6) });

    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [{ id: quoted.id, status: "running", endedAt: null, sessionKind: "channel" }],
    });
    await service.updateTitle(bootstrap.userId, quoted.id, "Still alive");
    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [{ id: quoted.id, title: "Still alive" }],
    });
  });

  it("closes a crashed Turn's attribution window at the Session's next acceptance", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const crashed = await createMessage(binding.id, { text: "Crashed", occurredAt: minutes(0) });
    await createDelivery(channel.id, crashed.id, { at: minutes(1) });
    const next = await createMessage(binding.id, { text: "Next", occurredAt: minutes(30) });
    await createDelivery(channel.id, next.id, { at: minutes(31), reported: true });
    const child = await createSession(binding.id, {
      kind: "internal",
      channelId: GROUP,
      createdBySessionId: channel.id,
      createdAt: new Date(minutes(31).getTime() + 500),
    });

    const crashedDetail = await service.get(bootstrap.userId, crashed.id, { limit: 10 });
    expect(crashedDetail.internalSessions).toEqual([]);
    const nextDetail = await service.get(bootstrap.userId, next.id, { limit: 10 });
    expect(nextDetail.internalSessions.map((session) => session.id)).toEqual([child.id]);
  });

  it("lists the first page of a busy group in bounded time", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    // 2,500 topics of a root plus one reply, every delivery accepted and reported in one Session:
    // the shape that made the correlated running check quadratic.
    const messageRows: (typeof imMessages.$inferInsert)[] = [];
    for (let index = 0; index < 2_500; index += 1) {
      const rootId = `om_scale_${index}`;
      const at = new Date(BASE_TIME.getTime() + index * 60_000);
      for (const [suffix, threadKey, offset] of [
        ["root", null, 0],
        ["reply", rootId, 30_000],
      ] as const) {
        messageRows.push({
          id: crypto.randomUUID(),
          imBindingId: binding.id,
          providerEventId: `event-${rootId}-${suffix}`,
          channelId: GROUP,
          externalMessageId: suffix === "root" ? rootId : `${rootId}_reply`,
          providerRevisionKey: "1",
          operation: "created",
          direction: "inbound",
          threadKey,
          authorKind: "human",
          authorExternalId: "ou_human",
          authorDisplayName: "Mia",
          content: { version: 1, fallbackText: `Request ${index} ${suffix}`, blocks: [], truncated: false },
          providerContext: { provider: "feishu", chatType: "group" },
          occurredAt: new Date(at.getTime() + offset),
        });
      }
    }
    for (let start = 0; start < messageRows.length; start += 500) {
      await unitDatabase.database.insert(imMessages).values(messageRows.slice(start, start + 500));
    }
    const deliveryRows = messageRows.map((message, index) => ({
      messageId: message.id as string,
      sessionId: channel.id,
      attention: "direct" as const,
      state: "accepted" as const,
      placementGeneration: 1,
      inputHash: "c".repeat(64),
      turnId: `turn-scale-${index}`,
      reportOwnerInstanceId: crypto.randomUUID(),
      acceptedAt: new Date((message.occurredAt as Date).getTime() + 1_000),
      expiresAt: new Date(BASE_TIME.getTime() + 30 * 24 * 60 * 60_000),
      reportedAt: new Date((message.occurredAt as Date).getTime() + 2_000),
      turnReport: report(),
      resultHash: "b".repeat(64),
    }));
    for (let start = 0; start < deliveryRows.length; start += 500) {
      await unitDatabase.database.insert(imMessageDeliveries).values(deliveryRows.slice(start, start + 500));
    }

    const startedAt = Date.now();
    const page = await service.list(bootstrap.userId, { limit: 50 });
    const elapsedMs = Date.now() - startedAt;
    expect(page.tasks).toHaveLength(50);
    expect(page.tasks[0]?.title).toBe("Request 2499 root");
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await service.list(bootstrap.userId, { limit: 50, cursor: page.nextCursor ?? undefined });
    expect(second.tasks[0]?.title).toBe("Request 2449 root");
    // The seed itself takes well under a second; the projection must stay in the same order of magnitude.
    expect(elapsedMs).toBeLessThan(5_000);
  }, 60_000);

  it("paginates the list and the Turns, and rejects unknown ids or malformed cursors", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const older = await createMessage(binding.id, { text: "Older", occurredAt: minutes(0) });
    await createDelivery(channel.id, older.id, { at: minutes(1), reported: true });
    const newer = await createMessage(binding.id, {
      externalMessageId: "om_newer",
      text: "Newer",
      occurredAt: minutes(5),
    });
    await createDelivery(channel.id, newer.id, { at: minutes(6), reported: true });
    const newerReply = await createMessage(binding.id, {
      threadKey: "om_newer",
      text: "Reply",
      occurredAt: minutes(7),
    });
    await createDelivery(channel.id, newerReply.id, { at: minutes(8) });

    const first = await service.list(bootstrap.userId, { limit: 1 });
    expect(first.tasks.map((task) => task.id)).toEqual([newer.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.list(bootstrap.userId, { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.tasks.map((task) => task.id)).toEqual([older.id]);
    expect(second.nextCursor).toBeNull();

    const firstTurns = await service.get(bootstrap.userId, newer.id, { limit: 1 });
    expect(firstTurns.turns.map((turn) => turn.message.id)).toEqual([newerReply.id]);
    expect(firstTurns.nextCursor).toEqual(expect.any(String));
    const secondTurns = await service.get(bootstrap.userId, newer.id, {
      limit: 1,
      cursor: firstTurns.nextCursor ?? undefined,
    });
    expect(secondTurns.turns.map((turn) => turn.message.id)).toEqual([newer.id]);
    expect(secondTurns.nextCursor).toBeNull();

    await expect(service.get(bootstrap.userId, crypto.randomUUID(), { limit: 1 })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
    await expect(service.get(crypto.randomUUID(), newer.id, { limit: 1 })).rejects.toMatchObject({ statusCode: 404 });
    const badCursor = Buffer.from(JSON.stringify({ at: "not-a-date", id: "bad" }), "utf8").toString("base64url");
    await expect(service.list(bootstrap.userId, { limit: 1, cursor: badCursor })).rejects.toBeInstanceOf(
      TaskQueryError,
    );
    await expect(service.get(bootstrap.userId, newer.id, { limit: 1, cursor: "%%%" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
  });
});
