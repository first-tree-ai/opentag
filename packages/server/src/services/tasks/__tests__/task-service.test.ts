import {
  agentAvatarPath,
  type ImContentV1,
  TASK_SECTION_DEFAULT_LIMIT,
  TASK_SECTION_MAX_LIMIT,
  type TaskTurn,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../../__tests__/support/unit-database.js";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../../../admin/bootstrap.js";
import type { DatabaseClient } from "../../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessions,
} from "../../../db/schema/index.js";
import { hasLinkableSessionTask } from "../../im/im-session-link.js";
import { TaskQueryError, TaskService } from "../index.js";
import { type LockedDeliveryRow, withdrawalRefusal } from "../task-service.js";

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

async function fixture(options: { now?: () => Date } = {}) {
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
  const service = new TaskService(unitDatabase.database, { now: options.now ?? (() => BASE_TIME) });
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
    resources?: ImContentV1["resources"];
    providerContext?: {
      provider: "feishu";
      chatType?: string;
      chatMode?: "group" | "topic" | "p2p";
      groupMessageType?: "chat" | "thread";
      threadId?: string;
      rootId?: string;
    };
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
        ...(options.resources ? { resources: options.resources } : {}),
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
  turnReport?: TurnReportRequest;
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
    turnReport: options.turnReport ?? report({ outcome: options.outcome ?? "completed" }),
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

async function deliveryRow(deliveryId: string) {
  const [row] = await unitDatabase.database
    .select()
    .from(imMessageDeliveries)
    .where(eq(imMessageDeliveries.id, deliveryId));
  if (!row) throw new Error("Delivery row disappeared");
  return row;
}

/** Mark a pending delivery the way the worker does while it dispatches it: a claim token with a lease. */
async function claimDelivery(deliveryId: string, leaseUntil: Date) {
  await unitDatabase.database
    .update(imMessageDeliveries)
    .set({
      lastErrorCode: `IM_DELIVERY_CLAIM_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`,
      nextAttemptAt: leaseUntil,
    })
    .where(eq(imMessageDeliveries.id, deliveryId));
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

async function titleOf(service: TaskService, accountId: string, taskId: string) {
  return (await service.list(accountId, { limit: 50 })).tasks.find((task) => task.id === taskId)?.title;
}

describe("TaskService", () => {
  it("projects the current agent logo through the same-origin avatar path in lists and conversations", async () => {
    const { agent, binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: DM, conversationKind: "dm" });
    const message = await createMessage(binding.id, { channelId: DM, text: "Hello" });
    await createDelivery(channel.id, message.id, { at: minutes(1), reported: true });

    const readAgent = async () => [
      (await service.list(bootstrap.userId, { limit: 50 })).tasks[0]?.agent,
      (await service.get(bootstrap.userId, message.id, { limit: 50 })).task.agent,
    ];
    for (const summary of await readAgent()) expect(summary?.avatarPath).toBeUndefined();

    await unitDatabase.database
      .update(imBindings)
      .set({ botAvatarUrl: "https://example.com/private-agent-logo.png" })
      .where(eq(imBindings.id, binding.id));
    for (const summary of await readAgent()) {
      expect(summary?.avatarPath).toBe(agentAvatarPath(agent.id));
      expect(summary).not.toHaveProperty("avatarSourceUrl");
    }

    await unitDatabase.database.update(imBindings).set({ botAvatarUrl: null }).where(eq(imBindings.id, binding.id));
    for (const summary of await readAgent()) expect(summary?.avatarPath).toBeUndefined();
  });

  it("lists a group's channel Session and its thread Session as one Task each, keyed by the Session", async () => {
    const { agent, binding, bootstrap, service } = await fixture();
    const { channel, thread, root, reply } = await groupTopic(binding.id);
    await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(11) });

    const page = await service.list(bootstrap.userId, { limit: 50 });
    expect(page.tasks).toHaveLength(2);
    expect(page.tasks[0]).toMatchObject({
      id: thread.id,
      // A thread Task is titled from its root message, which the channel Session received.
      title: "Root request",
      status: "running",
      sessionKind: "thread",
      source: { provider: "feishu", channelId: GROUP, threadKey: "om_root", conversationKind: "channel" },
      agent: { id: agent.id, displayName: "Atlas" },
      createdAt: minutes(0).toISOString(),
      lastActivityAt: minutes(11).toISOString(),
    });
    expect(page.tasks[1]).toMatchObject({
      id: channel.id,
      title: "Root request",
      status: "completed",
      sessionKind: "channel",
      source: { channelId: GROUP, threadKey: null, conversationKind: "channel" },
    });
    // Any message of a Session, and the Session itself, open that Session's Task.
    expect((await service.get(bootstrap.userId, root.id, { limit: 50 })).task.id).toBe(channel.id);
    expect((await service.get(bootstrap.userId, reply.id, { limit: 50 })).task.id).toBe(thread.id);
    expect(
      (await service.get(bootstrap.userId, thread.id, { limit: 50 })).turns.map((turn) => turn.message.id),
    ).toEqual([reply.id]);
  });

  it("lists every top-level request of a group channel Session as one Task", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const first = await createMessage(binding.id, { text: "Nobody replied", occurredAt: minutes(0) });
    await createDelivery(channel.id, first.id, { at: minutes(1), reported: true });
    const second = await createMessage(binding.id, { text: "Another request", occurredAt: minutes(2) });
    await createDelivery(channel.id, second.id, { at: minutes(3), reported: true });

    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [
        {
          id: channel.id,
          title: "Nobody replied",
          status: "completed",
          sessionKind: "channel",
          source: { conversationKind: "channel", threadKey: null },
        },
      ],
    });
  });

  it("lists a channel Session only after someone addressed the Agent directly", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const overheard = await createMessage(binding.id, { text: "Lunch?", occurredAt: minutes(0) });
    await createDelivery(channel.id, overheard.id, { attention: "ambient", at: minutes(1), reported: true });
    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toEqual({ tasks: [], nextCursor: null });

    const addressed = await createMessage(binding.id, { text: "@Atlas summarize", occurredAt: minutes(5) });
    await createDelivery(channel.id, addressed.id, { at: minutes(6) });
    const page = await service.list(bootstrap.userId, { limit: 50 });
    expect(page.tasks.map((task) => task.id)).toEqual([channel.id]);
    expect(page.tasks[0]?.title).toBe("@Atlas summarize");
  });

  it("keeps the channel observer copy out of the channel Session's Task", async () => {
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
    expect(new Map(page.tasks.map((task) => [task.id, task.status]))).toEqual(
      new Map([
        [thread.id, "completed"],
        [channel.id, "completed"],
      ]),
    );
    const channelDetail = await service.get(bootstrap.userId, channel.id, { limit: 50 });
    expect(channelDetail.turns.map((turn) => turn.message.id)).toEqual([root.id]);
    // The reply's id opens the thread Session that owns it, not the observer copy's channel Session.
    const detail = await service.get(bootstrap.userId, reply.id, { limit: 50 });
    expect(detail.task.id).toBe(thread.id);
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
      id: dm.id,
      title: "First private request",
      sessionKind: "channel",
      source: { channelId: DM, threadKey: null, conversationKind: "dm" },
      // The last execution reported one second after it was accepted; reporting counts as activity.
      lastActivityAt: new Date(minutes(21).getTime() + 1_000).toISOString(),
    });
    for (const id of [first.id, replyToFirst.id, quoted.id, dm.id]) {
      const detail = await service.get(bootstrap.userId, id, { limit: 50 });
      expect(detail.task.id).toBe(dm.id);
      expect(detail.turns.map((turn) => turn.message.id)).toEqual([later.id, replyToFirst.id, first.id]);
    }
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
    const thread = await createSession(binding.id, { channelId: GROUP, kind: "thread", threadKey: "om_group" });
    const groupReply = await createMessage(binding.id, {
      threadKey: "om_group",
      text: "Reply",
      occurredAt: minutes(4),
    });
    await createDelivery(thread.id, groupReply.id, { at: minutes(5), reported: true });
    const alone = await createMessage(binding.id, { text: "Alone", occurredAt: minutes(6) });
    await createDelivery(channel.id, alone.id, { at: minutes(7), reported: true });

    await expect(service.list(bootstrap.userId, { limit: 50, kind: "channel" })).resolves.toMatchObject({
      tasks: [
        { id: channel.id, sessionKind: "channel" },
        { id: dm.id, sessionKind: "channel" },
      ],
    });
    await expect(service.list(bootstrap.userId, { limit: 50, kind: "thread" })).resolves.toMatchObject({
      tasks: [{ id: thread.id, sessionKind: "thread", source: { threadKey: "om_group" } }],
    });
    await expect(service.list(bootstrap.userId, { limit: 50, agentId: agent.id })).resolves.toMatchObject({
      tasks: [{ id: channel.id }, { id: thread.id }, { id: dm.id }],
    });
    await expect(service.list(bootstrap.userId, { limit: 50, agentId: crypto.randomUUID() })).resolves.toEqual({
      tasks: [],
      nextCursor: null,
    });
  });

  it("derives the status from execution precedence, not from the latest message", async () => {
    const { binding, bootstrap, service } = await fixture();
    /** One group channel Session per case, so each status is its own Task. */
    const make = async (text: string, offset: number, options: { endedAt?: Date } = {}) => {
      const session = await createSession(binding.id, { channelId: `oc_${text}`, ...options });
      const message = await createMessage(binding.id, {
        channelId: `oc_${text}`,
        text,
        externalMessageId: `om_${text}`,
        occurredAt: minutes(offset),
      });
      return { session, message };
    };

    const queued = await make("queued", 0);
    await createDelivery(queued.session.id, queued.message.id, { state: "pending" });

    const completed = await make("completed", 3);
    await createDelivery(completed.session.id, completed.message.id, {
      at: minutes(3),
      reported: true,
      outcome: "completed",
    });
    const failed = await make("failed", 4);
    await createDelivery(failed.session.id, failed.message.id, { at: minutes(4), reported: true, outcome: "failed" });

    // A running Turn outranks the follow-up queued behind it in the same Session, and an earlier
    // completed Turn of that Session does not decide the status either.
    const running = await make("running", 9);
    const earlier = await createMessage(binding.id, {
      channelId: "oc_running",
      text: "earlier",
      occurredAt: minutes(1),
    });
    await createDelivery(running.session.id, earlier.id, { at: minutes(1), reported: true });
    await createDelivery(running.session.id, running.message.id, { at: minutes(9) });
    const queuedBehindRunning = await createMessage(binding.id, {
      channelId: "oc_running",
      text: "follow-up",
      occurredAt: minutes(10),
    });
    await createDelivery(running.session.id, queuedBehindRunning.id, { state: "pending" });
    const rejected = await make("rejected", 5);
    await createDelivery(rejected.session.id, rejected.message.id, { state: "terminal_rejected" });
    const expired = await make("expired", 6);
    await createDelivery(expired.session.id, expired.message.id, { state: "expired", reason: "ttl" });
    // A superseded revision is not an execution, so the expired one before it decides the status.
    const superseded = await createMessage(binding.id, {
      channelId: "oc_expired",
      text: "superseded",
      occurredAt: minutes(7),
    });
    await createDelivery(expired.session.id, superseded.id, { state: "expired", reason: "superseded_revision" });

    const ended = await make("ended", 8, { endedAt: minutes(30) });
    await createDelivery(ended.session.id, ended.message.id, { at: minutes(8), reported: true });

    const result = await service.list(bootstrap.userId, { limit: 50 });
    expect(new Map(result.tasks.map((task) => [task.id, task.status]))).toEqual(
      new Map([
        [queued.session.id, "queued"],
        [running.session.id, "running"],
        [completed.session.id, "completed"],
        [failed.session.id, "failed"],
        [rejected.session.id, "failed"],
        [expired.session.id, "expired"],
        [ended.session.id, "ended"],
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

    const staleChannel = await createSession(binding.id, { channelId: "oc_stale" });
    const stale = await createMessage(binding.id, {
      channelId: "oc_stale",
      text: "Past deadline",
      occurredAt: minutes(10),
    });
    await createDelivery(staleChannel.id, stale.id, { at: minutes(11), expiresAt: minutes(20) });

    const late = new TaskService(unitDatabase.database, { now: () => minutes(30) });
    const statuses = new Map(
      (await late.list(bootstrap.userId, { limit: 50 })).tasks.map((task) => [task.id, task.status]),
    );
    expect(statuses.get(channel.id)).toBe("completed");
    expect(statuses.get(staleChannel.id)).toBe("expired");
    const oldDetail = await late.get(bootstrap.userId, orphaned.id, { limit: 50 });
    expect(oldDetail.turns.find((turn) => turn.message.id === orphaned.id)?.delivery).toMatchObject({
      state: "accepted",
      isRunning: false,
    });
    const expiredDetail = await late.get(bootstrap.userId, stale.id, { limit: 50 });
    expect(expiredDetail.turns[0]?.delivery).toMatchObject({ state: "accepted", isRunning: false });
  });

  it.each([false, true])(
    "projects effective running state for an unreported Turn with ended Session %s",
    async (ended) => {
      const { binding, bootstrap, service } = await fixture();
      const session = await createSession(binding.id, {
        channelId: DM,
        conversationKind: "dm",
        endedAt: ended ? minutes(-1) : null,
      });
      const message = await createMessage(binding.id, { channelId: DM });
      await createDelivery(session.id, message.id, { at: minutes(-2) });
      const detail = await service.get(bootstrap.userId, message.id, { limit: 50 });
      expect(detail.task.status).toBe(ended ? "ended" : "running");
      expect(detail.turns[0]).toMatchObject({
        delivery: { state: "accepted", isRunning: !ended },
        report: null,
      });
    },
  );

  it("resolves manual over generated over derived titles through the Task's own Session", async () => {
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
    // The channel Session's Task keeps its own derived title.
    await expect(titleOf(service, bootstrap.userId, channel.id)).resolves.toBe("Derived from the root");

    await expect(titleOf(service, bootstrap.userId, thread.id)).resolves.toBe("Manual title");
    await service.updateTitle(bootstrap.userId, thread.id, null);
    await expect(titleOf(service, bootstrap.userId, thread.id)).resolves.toBe("Generated title");
    await expect(service.saveGeneratedTitle(thread.id, "Replacement title")).resolves.toBe(true);
    await service.updateTitle(bootstrap.userId, thread.id, "  Final title  ");
    await expect(service.saveGeneratedTitle(thread.id, "Ignored title")).resolves.toBe(false);
    await expect(titleOf(service, bootstrap.userId, thread.id)).resolves.toBe("Final title");
    await service.updateTitle(bootstrap.userId, thread.id, null);
    await expect(titleOf(service, bootstrap.userId, thread.id)).resolves.toBe("Replacement title");
  });

  it("returns a Session's Turns, absorbed steering, internal Sessions and collaboration messages", async () => {
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
    expect(detail.task).toMatchObject({ id: channel.id, status: "completed" });
    expect(detail.turns.map((turn) => turn.message.id)).toEqual([steeredMessage.id, root.id]);
    expect(detail.turns.find((turn) => turn.deliveryId === steered.id)).toMatchObject({
      delivery: { state: "steered" },
      absorbedBy: { deliveryId: rootDelivery.id },
    });
    expect(detail.turns.find((turn) => turn.deliveryId === rootDelivery.id)).toMatchObject({
      report: {
        outcome: "completed",
        finalText: "Done",
        outgoingReplies: null,
        usage: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 4 },
      },
      message: { fallbackText: "Root request", authorDisplayName: "Mia" },
    });
    // The thread Session created the internal Sessions, so they belong to its Task alone.
    expect(detail.internalSessions).toEqual([]);
    expect(detail.collaborationMessages).toEqual([]);
    const threadDetail = await service.get(bootstrap.userId, reply.id, { limit: 10 });
    expect(threadDetail.task.id).toBe(thread.id);
    expect(threadDetail.turns.map((turn) => turn.message.id)).toEqual([reply.id]);
    expect(threadDetail.internalSessions).toEqual([
      expect.objectContaining({ id: child.id, createdBySessionId: thread.id, runtimeModel: "claude-sonnet" }),
      expect.objectContaining({ id: grandchild.id, endedAt: minutes(14).toISOString() }),
    ]);
    expect(threadDetail.collaborationMessages).toEqual([
      expect.objectContaining({ sourceSessionId: thread.id, targetSessionId: child.id, outcome: "accepted" }),
    ]);
    // An internal Session's id opens the Task of the chat Session at the root of its creator chain.
    await expect(service.get(bootstrap.userId, grandchild.id, { limit: 10 })).resolves.toMatchObject({
      task: { id: thread.id },
    });
  });

  it("projects browser-safe attachment metadata and tolerates legacy messages", async () => {
    const { binding, bootstrap, service } = await fixture();
    const session = await createSession(binding.id, { channelId: DM, conversationKind: "dm" });
    const legacy = await createMessage(binding.id, { channelId: DM, occurredAt: minutes(0) });
    await createDelivery(session.id, legacy.id);
    const message = await createMessage(binding.id, {
      channelId: DM,
      occurredAt: minutes(1),
      resources: [
        {
          providerResourceKey: "private-provider-key",
          kind: "file",
          filename: "requirements.pdf",
          mediaType: "application/pdf",
          sizeBytes: 1234,
        },
        {
          providerResourceKey: "private-image-key",
          ordinal: 1,
          kind: "image",
          filename: null,
          mediaType: null,
          sizeBytes: 30_000_000,
          availability: "too_large",
        },
      ],
    });
    await createDelivery(session.id, message.id);
    const detail = await service.get(bootstrap.userId, message.id, { limit: 10 });
    expect(detail.turns.find((turn) => turn.message.id === message.id)?.message.attachments).toEqual([
      {
        ordinal: 0,
        kind: "file",
        filename: "requirements.pdf",
        mediaType: "application/pdf",
        sizeBytes: 1234,
        availability: "available",
      },
      { ordinal: 1, kind: "image", filename: null, mediaType: null, sizeBytes: 30_000_000, availability: "too_large" },
    ]);
    expect(detail.turns.find((turn) => turn.message.id === legacy.id)?.message.attachments).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain("private-provider-key");
    expect(JSON.stringify(detail)).not.toContain("private-image-key");
    await expect(service.get(crypto.randomUUID(), message.id, { limit: 10 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("projects captured outgoing replies and keeps legacy reports null", async () => {
    const { binding, bootstrap, service } = await fixture();
    const session = await createSession(binding.id, { channelId: DM, kind: "channel", conversationKind: "dm" });
    const message = await createMessage(binding.id, { text: "hello", occurredAt: minutes(0) });
    const snapshot = {
      status: "complete" as const,
      replies: [
        {
          provider: "feishu" as const,
          teamBrand: "lark" as const,
          messageId: "om_sent",
          chatId: "oc_dm",
          content: { msgType: "text" as const, text: "actual reply" },
        },
      ],
    };
    await createDelivery(session.id, message.id, {
      at: minutes(1),
      reported: true,
      turnReport: report({ outgoingReplies: snapshot, finalText: "summary" }),
    });
    const detail = await service.get(bootstrap.userId, message.id, { limit: 10 });
    expect(detail.turns[0]?.report?.outgoingReplies).toEqual(snapshot);
    expect(detail.turns[0]?.report?.finalText).toBe("summary");
  });

  it("titles a Feishu thread Task from the root message its replies name by root id", async () => {
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
      text: "Reply inside the Task",
      occurredAt: minutes(5),
      providerContext: { provider: "feishu", chatType: "group", threadId: "omt_topic", rootId: "om_root" },
    });
    await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(6) });

    const page = await service.list(bootstrap.userId, { limit: 50 });
    expect(page.tasks).toHaveLength(2);
    expect(page.tasks[0]).toMatchObject({ id: thread.id, title: "Topic title", status: "running" });
    await service.updateTitle(bootstrap.userId, thread.id, null);
    await expect(titleOf(service, bootstrap.userId, thread.id)).resolves.toBe("Topic root");
    const detail = await service.get(bootstrap.userId, reply.id, { limit: 50 });
    expect(detail.task.id).toBe(thread.id);
    expect(detail.turns.map((turn) => turn.message.id)).toEqual([reply.id]);
  });

  it("distinguishes Feishu topic chats, regular group chats, and legacy records without stored chatMode", async () => {
    const { binding, bootstrap, service } = await fixture();
    const topicChannel = await createSession(binding.id, { channelId: "oc_topic" });
    const groupChannel = await createSession(binding.id, { channelId: "oc_regular_group" });
    const legacyChannel = await createSession(binding.id, { channelId: "oc_legacy" });

    const legacyMsg = await createMessage(binding.id, {
      channelId: "oc_legacy",
      text: "Legacy message",
      occurredAt: minutes(0),
      providerContext: { provider: "feishu", chatType: "group" },
    });
    const groupMsg = await createMessage(binding.id, {
      channelId: "oc_regular_group",
      text: "Regular group message",
      occurredAt: minutes(5),
      providerContext: {
        provider: "feishu",
        chatType: "group",
        chatMode: "group",
        groupMessageType: "thread",
      },
    });
    const topicMsg = await createMessage(binding.id, {
      channelId: "oc_topic",
      text: "Topic chat message",
      occurredAt: minutes(10),
      providerContext: { provider: "feishu", chatType: "group", chatMode: "topic", threadId: "omt_1" },
    });

    await createDelivery(legacyChannel.id, legacyMsg.id, { at: minutes(1), reported: true });
    await createDelivery(groupChannel.id, groupMsg.id, { at: minutes(6), reported: true });
    await createDelivery(topicChannel.id, topicMsg.id, { at: minutes(11), reported: true });

    const page = await service.list(bootstrap.userId, { limit: 50 });
    expect(page.tasks.map((task) => [task.id, task.source.chatMode, task.source.groupMessageType])).toEqual([
      [topicChannel.id, "topic", null],
      [groupChannel.id, "group", "thread"],
      [legacyChannel.id, null, null],
    ]);

    const topicDetail = await service.detail(bootstrap.userId, topicMsg.id, { sections: ["turns"] });
    const groupDetail = await service.detail(bootstrap.userId, groupMsg.id, { sections: ["turns"] });
    const legacyDetail = await service.detail(bootstrap.userId, legacyMsg.id, { sections: ["turns"] });
    expect(topicDetail.task.source).toMatchObject({ chatMode: "topic", groupMessageType: null });
    expect(groupDetail.task.source).toMatchObject({ chatMode: "group", groupMessageType: "thread" });
    expect(legacyDetail.task.source).toMatchObject({ chatMode: null, groupMessageType: null });
  });

  it("renames a Task through any id that resolves to it, including a group channel Session", async () => {
    const { binding, bootstrap, service } = await fixture();
    const { channel, thread, root, reply } = await groupTopic(binding.id);
    await createDelivery(channel.id, root.id, { at: minutes(1), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(11), reported: true });
    await expect(service.updateTitle(bootstrap.userId, reply.id, "Renamed by message id")).resolves.toMatchObject({
      id: thread.id,
      title: "Renamed by message id",
    });
    await expect(service.updateTitle(bootstrap.userId, thread.id, "Renamed by Session id")).resolves.toMatchObject({
      id: thread.id,
      title: "Renamed by Session id",
    });
    await expect(service.updateTitle(bootstrap.userId, root.id, "Channel title")).resolves.toMatchObject({
      id: channel.id,
      title: "Channel title",
    });
    await expect(titleOf(service, bootstrap.userId, thread.id)).resolves.toBe("Renamed by Session id");
    await expect(service.updateTitle(crypto.randomUUID(), root.id, "Not mine")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("attributes every internal Session a group channel Session created to that Session's Task", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const first = await createMessage(binding.id, { text: "First request", occurredAt: minutes(0) });
    const second = await createMessage(binding.id, { text: "Second request", occurredAt: minutes(30) });
    await createDelivery(channel.id, first.id, { at: minutes(1), reported: true });
    await createDelivery(channel.id, second.id, { at: minutes(31), reported: true });
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
    // Created between two Turns: no Turn window decides attribution any more, the creator does.
    const betweenTurns = await createSession(binding.id, {
      kind: "internal",
      channelId: GROUP,
      createdBySessionId: channel.id,
      createdAt: minutes(20),
    });

    for (const id of [first.id, second.id, channel.id, grandchild.id]) {
      const detail = await service.get(bootstrap.userId, id, { limit: 10 });
      expect(detail.task.id).toBe(channel.id);
      expect(detail.internalSessions.map((session) => session.id)).toEqual([
        duringFirst.id,
        grandchild.id,
        betweenTurns.id,
      ]);
    }
  });

  it("never lets a Session created later claim a message stored before it", async () => {
    const { binding, bootstrap, service } = await fixture();
    // Stored with no delivery while no Session existed in the channel.
    const orphan = await createMessage(binding.id, { text: "Before any Session", occurredAt: minutes(0) });
    const [stored] = await unitDatabase.database.select().from(imMessages).where(eq(imMessages.id, orphan.id));
    if (!stored) throw new Error("The orphan message disappeared");
    const later = await createSession(binding.id, {
      channelId: GROUP,
      createdAt: new Date(stored.receivedAt.getTime() + 5 * 60_000),
    });
    const request = await createMessage(binding.id, { text: "Later request", occurredAt: minutes(10) });
    await createDelivery(later.id, request.id, { at: minutes(11), reported: true });

    for (const read of [
      () => service.detail(bootstrap.userId, orphan.id),
      () => service.listReplies(bootstrap.userId, orphan.id, { limit: 10 }),
      () => service.cancel(bootstrap.userId, orphan.id),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
    }
    expect((await service.detail(bootstrap.userId, request.id)).task.id).toBe(later.id);
  });

  it("does not list an ambient-only thread whose only direct root delivery was superseded", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const thread = await createSession(binding.id, { channelId: GROUP, kind: "thread", threadKey: "om_root" });
    const root = await createMessage(binding.id, { externalMessageId: "om_root", occurredAt: minutes(0) });
    await createDelivery(channel.id, root.id, { state: "expired", reason: "superseded_revision" });
    const reply = await createMessage(binding.id, { threadKey: "om_root", occurredAt: minutes(5) });
    await createDelivery(thread.id, reply.id, { attention: "ambient", state: "pending" });
    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toEqual({ tasks: [], nextCursor: null });

    // The root's current revision, delivered directly, makes the same thread a Task.
    const revised = await createMessage(binding.id, {
      externalMessageId: "om_root",
      revisionKey: "2",
      occurredAt: minutes(0),
    });
    await createDelivery(channel.id, revised.id, { at: minutes(1), reported: true });
    const listed = await service.list(bootstrap.userId, { limit: 50 });
    expect(listed.tasks.map((task) => [task.id, task.status])).toEqual([
      [thread.id, "queued"],
      [channel.id, "completed"],
    ]);
  });

  it("decides footer eligibility exactly as the list qualifies Tasks, without the rollup", async () => {
    const { binding, bootstrap, service } = await fixture();
    /** Every Session paired with the Task id the routes resolve it to. */
    const cases: { name: string; sessionId: string; taskId: string }[] = [];
    const track = (name: string, sessionId: string, taskId: string) => cases.push({ name, sessionId, taskId });
    async function agreement() {
      const listed = new Set((await service.list(bootstrap.userId, { limit: 100 })).tasks.map((task) => task.id));
      const decided = new Map<string, boolean>();
      for (const { name, sessionId, taskId } of cases) {
        const linkable = await service.hasLinkableTask(sessionId);
        expect({ name, linkable }).toEqual({ name, linkable: listed.has(taskId) });
        decided.set(name, linkable);
      }
      return decided;
    }

    // An ambient-only group channel Session, and internal Sessions rooted at it.
    const ambient = await createSession(binding.id, { channelId: "oc_ambient" });
    const overheard = await createMessage(binding.id, { channelId: "oc_ambient", occurredAt: minutes(0) });
    await createDelivery(ambient.id, overheard.id, { attention: "ambient", at: minutes(1), reported: true });
    const ambientInternal = await createSession(binding.id, {
      channelId: "oc_ambient",
      kind: "internal",
      createdBySessionId: ambient.id,
    });
    const ambientNested = await createSession(binding.id, {
      channelId: "oc_ambient",
      kind: "internal",
      createdBySessionId: ambientInternal.id,
    });
    track("ambient channel", ambient.id, ambient.id);
    track("internal under ambient channel", ambientInternal.id, ambient.id);
    track("nested internal under ambient channel", ambientNested.id, ambient.id);

    // A channel Session whose only direct delivery was superseded by a newer revision.
    const superseded = await createSession(binding.id, { channelId: "oc_superseded" });
    const old = await createMessage(binding.id, { channelId: "oc_superseded", occurredAt: minutes(0) });
    await createDelivery(superseded.id, old.id, { state: "expired", reason: "superseded_revision" });
    track("superseded-only channel", superseded.id, superseded.id);

    // The negative superseded-only range in both attentions, and expired deliveries on each side of
    // the superseded reason, which the bounded probes must still count as executions; an expired
    // delivery without a reason is no execution for the list either.
    const supersededMixed = await createSession(binding.id, { channelId: "oc_superseded_mixed" });
    for (const attention of ["direct", "ambient"] as const) {
      const message = await createMessage(binding.id, { channelId: "oc_superseded_mixed", occurredAt: minutes(0) });
      await createDelivery(supersededMixed.id, message.id, {
        attention,
        state: "expired",
        reason: "superseded_revision",
      });
    }
    track("superseded-only channel in both attentions", supersededMixed.id, supersededMixed.id);
    for (const [name, reason] of [
      ["expired channel without a reason", null],
      ["expired channel cancelled", "cancelled"],
      ["expired channel timed out", "turn_timeout"],
    ] as const) {
      const channelId = `oc_${name.replaceAll(" ", "_")}`;
      const session = await createSession(binding.id, { channelId });
      const message = await createMessage(binding.id, { channelId, occurredAt: minutes(0) });
      await createDelivery(session.id, message.id, { state: "expired", ...(reason ? { reason } : {}) });
      track(name, session.id, session.id);
    }

    // A thread whose root was addressed but whose own deliveries were all superseded: the thread
    // branch's execution probe meets only superseded rows in both attentions.
    const supersededRootChannel = await createSession(binding.id, { channelId: "oc_superseded_thread" });
    const supersededThread = await createSession(binding.id, {
      channelId: "oc_superseded_thread",
      kind: "thread",
      threadKey: "om_t3",
    });
    const addressedRoot = await createMessage(binding.id, {
      channelId: "oc_superseded_thread",
      externalMessageId: "om_t3",
    });
    await createDelivery(supersededRootChannel.id, addressedRoot.id, { at: minutes(1), reported: true });
    for (const attention of ["direct", "ambient"] as const) {
      const message = await createMessage(binding.id, {
        channelId: "oc_superseded_thread",
        threadKey: "om_t3",
        occurredAt: minutes(2),
      });
      await createDelivery(supersededThread.id, message.id, {
        attention,
        state: "expired",
        reason: "superseded_revision",
      });
    }
    track("addressed-root thread with only superseded executions", supersededThread.id, supersededThread.id);

    // A thread whose root revision was superseded and whose only own delivery is ambient; a second
    // thread whose root was addressed but which has no execution of its own; the channel Session
    // that only holds the ambient observer copy of a thread reply.
    const topicChannel = await createSession(binding.id, { channelId: "oc_topic" });
    const thread = await createSession(binding.id, { channelId: "oc_topic", kind: "thread", threadKey: "om_t1" });
    const root = await createMessage(binding.id, { channelId: "oc_topic", externalMessageId: "om_t1" });
    await createDelivery(topicChannel.id, root.id, { state: "expired", reason: "superseded_revision" });
    const reply = await createMessage(binding.id, {
      channelId: "oc_topic",
      threadKey: "om_t1",
      occurredAt: minutes(5),
    });
    await createDelivery(thread.id, reply.id, { attention: "ambient", state: "pending" });
    await createDelivery(topicChannel.id, reply.id, { attention: "ambient", at: minutes(6), reported: true });
    const idle = await createSession(binding.id, { channelId: "oc_idle" });
    const idleThread = await createSession(binding.id, { channelId: "oc_idle", kind: "thread", threadKey: "om_t2" });
    const idleRoot = await createMessage(binding.id, { channelId: "oc_idle", externalMessageId: "om_t2" });
    await createDelivery(idle.id, idleRoot.id, { at: minutes(1), reported: true });
    const threadInternal = await createSession(binding.id, {
      channelId: "oc_topic",
      kind: "internal",
      createdBySessionId: thread.id,
    });
    track("observer-copy channel", topicChannel.id, topicChannel.id);
    track("thread with superseded root", thread.id, thread.id);
    track("internal under that thread", threadInternal.id, thread.id);
    track("channel with addressed root", idle.id, idle.id);
    track("addressed-root thread without an execution", idleThread.id, idleThread.id);

    // A private chat: the live thread is canonical; the ended channel Session and an internal
    // Session it created resolve to it.
    const dmChannel = await createSession(binding.id, {
      channelId: DM,
      conversationKind: "dm",
      endedAt: minutes(2),
    });
    const dmThread = await createSession(binding.id, {
      channelId: DM,
      conversationKind: "dm",
      kind: "thread",
      threadKey: "om_dm",
    });
    const dmMessage = await createMessage(binding.id, { channelId: DM, occurredAt: minutes(1) });
    await createDelivery(dmChannel.id, dmMessage.id, { at: minutes(1), reported: true });
    const dmInternal = await createSession(binding.id, {
      channelId: DM,
      kind: "internal",
      conversationKind: "dm",
      createdBySessionId: dmChannel.id,
    });
    track("ended private-chat Session", dmChannel.id, dmThread.id);
    track("canonical private-chat Session", dmThread.id, dmThread.id);
    track("internal under the private chat", dmInternal.id, dmThread.id);

    expect(Object.fromEntries(await agreement())).toEqual({
      "ambient channel": false,
      "internal under ambient channel": false,
      "nested internal under ambient channel": false,
      "superseded-only channel": false,
      "superseded-only channel in both attentions": false,
      "expired channel without a reason": false,
      "expired channel cancelled": true,
      "expired channel timed out": true,
      "addressed-root thread with only superseded executions": false,
      "observer-copy channel": false,
      "thread with superseded root": false,
      "internal under that thread": false,
      "channel with addressed root": true,
      "addressed-root thread without an execution": false,
      "ended private-chat Session": true,
      "canonical private-chat Session": true,
      "internal under the private chat": true,
    });

    // The root's current revision, addressed to the Agent, makes the thread a Task through its root,
    // and a direct message makes the ambient channel one.
    const revised = await createMessage(binding.id, {
      channelId: "oc_topic",
      externalMessageId: "om_t1",
      revisionKey: "2",
    });
    await createDelivery(topicChannel.id, revised.id, { at: minutes(7), reported: true });
    const addressed = await createMessage(binding.id, { channelId: "oc_ambient", occurredAt: minutes(8) });
    await createDelivery(ambient.id, addressed.id, { at: minutes(9) });
    const after = await agreement();
    for (const name of [
      "ambient channel",
      "internal under ambient channel",
      "nested internal under ambient channel",
      "observer-copy channel",
      "thread with superseded root",
      "internal under that thread",
    ]) {
      expect({ name, linkable: after.get(name) }).toEqual({ name, linkable: true });
    }
    expect(await service.hasLinkableTask(crypto.randomUUID())).toBe(false);
  });

  it("reports a thread Task as ended when its thread Session ended", async () => {
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
    const tasks = (await service.list(bootstrap.userId, { limit: 50 })).tasks;
    expect(tasks.find((task) => task.id === thread.id)).toMatchObject({
      status: "ended",
      endedAt: minutes(30).toISOString(),
    });
    expect(tasks.find((task) => task.id === channel.id)).toMatchObject({ status: "completed", endedAt: null });
  });

  it("keeps another Session's internal Sessions and collaboration messages out of a Task", async () => {
    const { binding, bootstrap, service } = await fixture();
    const spawnIn = async (channelId: string, text: string, offset: number) => {
      const channel = await createSession(binding.id, { channelId });
      const root = await createMessage(binding.id, { channelId, text, occurredAt: minutes(offset) });
      await createDelivery(channel.id, root.id, { at: minutes(offset + 1), reported: true });
      const child = await createSession(binding.id, {
        kind: "internal",
        channelId,
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
    const first = await spawnIn(GROUP, "First request", 0);
    const second = await spawnIn("oc_other_group", "Second request", 30);

    const detail = await service.get(bootstrap.userId, first.root.id, { limit: 10 });
    expect(detail.internalSessions.map((session) => session.id)).toEqual([first.child.id]);
    expect(detail.collaborationMessages.map((message) => message.targetSessionId)).toEqual([first.child.id]);
    const other = await service.get(bootstrap.userId, second.root.id, { limit: 10 });
    expect(other.internalSessions.map((session) => session.id)).toEqual([second.child.id]);
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
      tasks: [{ id: revived.id, status: "running", endedAt: null, sessionKind: "channel" }],
    });
    await service.updateTitle(bootstrap.userId, quoted.id, "Still alive");
    await expect(service.list(bootstrap.userId, { limit: 50 })).resolves.toMatchObject({
      tasks: [{ id: revived.id, title: "Still alive" }],
    });
  });

  it("lists the first page of a busy group in bounded time", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    // 2,500 roots in the channel Session, each answered in its own thread Session, every delivery
    // accepted and reported: 2,501 Tasks and the shape that made the correlated running check quadratic.
    const messageRows: (typeof imMessages.$inferInsert)[] = [];
    const threadRows: (typeof sessions.$inferInsert)[] = [];
    const threadOf = new Map<string, string>();
    for (let index = 0; index < 2_500; index += 1) {
      const rootId = `om_scale_${index}`;
      const threadId = crypto.randomUUID();
      threadOf.set(rootId, threadId);
      threadRows.push({
        id: threadId,
        imBindingId: binding.id,
        channelId: GROUP,
        conversationKind: "channel",
        kind: "thread",
        threadKey: rootId,
        createdAt: BASE_TIME,
      });
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
      await unitDatabase.database.insert(sessions).values(threadRows.slice(start / 2, start / 2 + 250));
    }
    const deliveryRows = messageRows.map((message, index) => ({
      messageId: message.id as string,
      sessionId: message.threadKey ? (threadOf.get(message.threadKey) as string) : channel.id,
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
    // Thread Tasks are titled from their roots; the channel Session's latest report lands second.
    expect(page.tasks[0]).toMatchObject({ id: threadOf.get("om_scale_2499"), title: "Request 2499 root" });
    expect(page.tasks[1]).toMatchObject({ id: channel.id, title: "Request 0 root" });
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await service.list(bootstrap.userId, { limit: 50, cursor: page.nextCursor ?? undefined });
    expect(second.tasks[0]?.title).toBe("Request 2450 root");
    // The seed itself takes well under a second; the projection must stay in the same order of magnitude.
    expect(elapsedMs).toBeLessThan(5_000);
  }, 60_000);

  it("paginates the list and the Turns, and rejects unknown ids or malformed cursors", async () => {
    const { binding, bootstrap, service } = await fixture();
    const olderChannel = await createSession(binding.id, { channelId: "oc_older" });
    const older = await createMessage(binding.id, { channelId: "oc_older", text: "Older", occurredAt: minutes(0) });
    await createDelivery(olderChannel.id, older.id, { at: minutes(1), reported: true });
    const channel = await createSession(binding.id, { channelId: GROUP });
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
    expect(first.tasks.map((task) => task.id)).toEqual([channel.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.list(bootstrap.userId, { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.tasks.map((task) => task.id)).toEqual([olderChannel.id]);
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

  it("cancels a queued Task, records why the delivery expired, and repeats as a no-op", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const request = await createMessage(binding.id, { text: "Please wait in line", occurredAt: minutes(0) });
    const queued = await createDelivery(channel.id, request.id, { state: "pending" });

    await expect(service.cancel(bootstrap.userId, request.id)).resolves.toMatchObject({
      id: channel.id,
      status: "cancelled",
    });
    // Stored the way the worker never reads: it claims only pending rows, and recovers expired
    // ones only while they carry a dispatch correlation.
    expect(await deliveryRow(queued.id)).toMatchObject({
      state: "expired",
      reason: "cancelled",
      dispatchRequestId: null,
    });
    const list = await service.list(bootstrap.userId, { limit: 10 });
    expect(list.tasks.map((task) => [task.id, task.status])).toEqual([[channel.id, "cancelled"]]);
    const detail = await service.get(bootstrap.userId, request.id, { limit: 10 });
    expect(detail.turns.map((turn) => turn.delivery)).toMatchObject([{ state: "expired", reason: "cancelled" }]);

    // Idempotent: the second cancel finds nothing queued and nothing to complain about.
    await expect(service.cancel(bootstrap.userId, request.id)).resolves.toMatchObject({ status: "cancelled" });

    // A private chat cancels through its Session id as well as through its Task id.
    const dm = await createSession(binding.id, { channelId: DM, conversationKind: "dm" });
    const dmRequest = await createMessage(binding.id, {
      channelId: DM,
      text: "Direct request",
      occurredAt: minutes(5),
      providerContext: { provider: "feishu", chatType: "p2p" },
    });
    await createDelivery(dm.id, dmRequest.id, { state: "pending" });
    await expect(service.cancel(bootstrap.userId, dm.id)).resolves.toMatchObject({
      id: dm.id,
      status: "cancelled",
    });
  });

  it("reads cancelled after withdrawing a follow-up queued behind a Turn that finished later", async () => {
    // The user cancels at minute 6, after the first Turn finished; the Server's clock is the cancel instant.
    const { binding, bootstrap, service } = await fixture({ now: () => minutes(6) });
    const channel = await createSession(binding.id, { channelId: GROUP });

    // The root request arrives, then the user queues a follow-up while it is still running.
    const root = await createMessage(binding.id, { externalMessageId: "om_root", occurredAt: minutes(0) });
    const followUp = await createMessage(binding.id, { threadKey: "om_root", occurredAt: minutes(2) });
    const queued = await createDelivery(channel.id, followUp.id, { state: "pending" });
    // The first Turn only finishes at minute 5, after the follow-up was already queued.
    await createDelivery(channel.id, root.id, { at: minutes(5), reported: true });
    expect((await service.get(bootstrap.userId, root.id, { limit: 5 })).task.status).toBe("queued");

    const cancelled = await service.cancel(bootstrap.userId, root.id);
    expect(await deliveryRow(queued.id)).toMatchObject({
      state: "expired",
      reason: "cancelled",
      expiresAt: minutes(6),
    });
    // The withdrawal is the Task's latest activity, so the finished Turn does not outrank it.
    expect(cancelled).toMatchObject({ status: "cancelled", lastActivityAt: minutes(6).toISOString() });
    const list = await service.list(bootstrap.userId, { limit: 10 });
    expect(list.tasks.map((task) => task.status)).toEqual(["cancelled"]);
    expect((await service.get(bootstrap.userId, root.id, { limit: 5 })).task.status).toBe("cancelled");

    // Idempotent: the second cancel is the same no-op success as for any cancelled Task.
    await expect(service.cancel(bootstrap.userId, root.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("refuses to cancel a Task that has started or finished, and leaves a running Task's queue alone", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });

    const running = await createMessage(binding.id, { externalMessageId: "om_running", occurredAt: minutes(0) });
    await createDelivery(channel.id, running.id, { at: minutes(1) });
    const followUp = await createMessage(binding.id, { threadKey: "om_running", occurredAt: minutes(2) });
    const queuedBehind = await createDelivery(channel.id, followUp.id, { state: "pending" });
    await expect(service.cancel(bootstrap.userId, running.id)).rejects.toMatchObject({
      code: "TASK_NOT_QUEUED",
      statusCode: 409,
    });
    expect(await deliveryRow(queuedBehind.id)).toMatchObject({ state: "pending", reason: null });

    const finishedChannel = await createSession(binding.id, { channelId: "oc_finished" });
    const completed = await createMessage(binding.id, { channelId: "oc_finished", occurredAt: minutes(10) });
    await createDelivery(finishedChannel.id, completed.id, { at: minutes(11), reported: true });
    await expect(service.cancel(bootstrap.userId, completed.id)).rejects.toMatchObject({
      code: "TASK_NOT_QUEUED",
      statusCode: 409,
    });

    const queuedChannel = await createSession(binding.id, { channelId: "oc_queued" });
    const queued = await createMessage(binding.id, { channelId: "oc_queued", occurredAt: minutes(20) });
    await createDelivery(queuedChannel.id, queued.id, { state: "pending" });
    await expect(service.cancel(crypto.randomUUID(), queued.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.cancel(bootstrap.userId, crypto.randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.get(bootstrap.userId, queued.id, { limit: 1 })).task.status).toBe("queued");
  });

  it("withdraws nothing when one of two pending deliveries is being dispatched", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });

    const root = await createMessage(binding.id, { externalMessageId: "om_root", occurredAt: minutes(0) });
    const inFlight = await createDelivery(channel.id, root.id, { state: "pending" });
    await claimDelivery(inFlight.id, new Date(BASE_TIME.getTime() + 10_000));
    const followUp = await createMessage(binding.id, { threadKey: "om_root", occurredAt: minutes(2) });
    const queuedBehind = await createDelivery(channel.id, followUp.id, { state: "pending" });
    expect((await service.get(bootstrap.userId, root.id, { limit: 5 })).task.status).toBe("queued");

    // All or nothing: the follow-up could be withdrawn, but the root is on its way to the Runtime,
    // so neither is, and the Task never reads as cancelled while part of it is still queued.
    await expect(service.cancel(bootstrap.userId, root.id)).rejects.toMatchObject({
      code: "TASK_NOT_QUEUED",
      statusCode: 409,
    });
    expect(await deliveryRow(inFlight.id)).toMatchObject({ state: "pending", reason: null });
    expect(await deliveryRow(queuedBehind.id)).toMatchObject({ state: "pending", reason: null });
    expect((await service.get(bootstrap.userId, root.id, { limit: 5 })).task.status).toBe("queued");

    // Once the worker's lease lapses without an acceptance, both rows are withdrawn together.
    await claimDelivery(inFlight.id, new Date(BASE_TIME.getTime() - 1_000));
    await expect(service.cancel(bootstrap.userId, root.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(await deliveryRow(inFlight.id)).toMatchObject({ state: "expired", reason: "cancelled" });
    expect(await deliveryRow(queuedBehind.id)).toMatchObject({ state: "expired", reason: "cancelled" });
  });

  it("leaves a delivery a worker is dispatching alone and takes back one whose claim lapsed", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });

    const inFlight = await createMessage(binding.id, { occurredAt: minutes(0) });
    const claimed = await createDelivery(channel.id, inFlight.id, { state: "pending" });
    await claimDelivery(claimed.id, new Date(BASE_TIME.getTime() + 10_000));
    // The Task still reads as queued, but the only thing queued is already on its way to the Runtime.
    expect((await service.get(bootstrap.userId, inFlight.id, { limit: 1 })).task.status).toBe("queued");
    await expect(service.cancel(bootstrap.userId, inFlight.id)).rejects.toMatchObject({
      code: "TASK_NOT_QUEUED",
      statusCode: 409,
    });
    const untouched = await deliveryRow(claimed.id);
    expect(untouched.state).toBe("pending");
    expect(untouched.lastErrorCode).toMatch(/^IM_DELIVERY_CLAIM_/);

    const abandonedChannel = await createSession(binding.id, { channelId: "oc_abandoned" });
    const abandoned = await createMessage(binding.id, { channelId: "oc_abandoned", occurredAt: minutes(5) });
    const lapsed = await createDelivery(abandonedChannel.id, abandoned.id, { state: "pending" });
    await claimDelivery(lapsed.id, new Date(BASE_TIME.getTime() - 1_000));
    await expect(service.cancel(bootstrap.userId, abandoned.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(await deliveryRow(lapsed.id)).toMatchObject({ state: "expired", reason: "cancelled" });
  });

  it("refuses to withdraw a delivery handed to a Computer that has not answered, and says so", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });

    // The worker released the row as deferred: the dispatch correlation stays, the claim lease is gone.
    const request = await createMessage(binding.id, { occurredAt: minutes(0) });
    const dispatched = await createDelivery(channel.id, request.id, { state: "pending" });
    await unitDatabase.database
      .update(imMessageDeliveries)
      .set({
        dispatchRequestId: crypto.randomUUID(),
        dispatchInputHash: "d".repeat(64),
        dispatchPayload: {} as never,
        lastErrorCode: null,
        nextAttemptAt: BASE_TIME,
      })
      .where(eq(imMessageDeliveries.id, dispatched.id));
    expect((await service.get(bootstrap.userId, request.id, { limit: 1 })).task.status).toBe("queued");

    await expect(service.cancel(bootstrap.userId, request.id)).rejects.toMatchObject({
      code: "TASK_NOT_QUEUED",
      statusCode: 409,
      message:
        "The Task's queued message was handed to a Computer that has not reported back yet, so there is nothing to cancel",
    });
    expect(await deliveryRow(dispatched.id)).toMatchObject({ state: "pending", reason: null });
  });

  it("treats a queue withdrawn before the transaction as the no-op path", async () => {
    const { binding, bootstrap } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    const request = await createMessage(binding.id, { occurredAt: minutes(0) });
    const queued = await createDelivery(channel.id, request.id, { state: "pending" });

    // A Server whose transaction starts only after a concurrent cancel of the same Task committed:
    // the locked read no longer sees the row as pending, so nothing is locked and the re-read
    // summary answers. A cancel that waits *under* the lock for the other one is a PostgreSQL race
    // that PGlite's single connection cannot stage; the integration suite covers that branch.
    const database = unitDatabase.database;
    const racing = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof database.transaction>) => {
          await database
            .update(imMessageDeliveries)
            .set({ state: "expired", reason: "cancelled", expiresAt: BASE_TIME })
            .where(eq(imMessageDeliveries.id, queued.id));
          return database.transaction(...args);
        };
      },
    }) as DatabaseClient;
    const service = new TaskService(racing, { now: () => BASE_TIME });

    await expect(service.cancel(bootstrap.userId, request.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(await deliveryRow(queued.id)).toMatchObject({ state: "expired", reason: "cancelled" });
  });

  it("classifies the locked rows by what is still pending after a concurrent cancel, rejection, or lapse", () => {
    const row = (overrides: Partial<LockedDeliveryRow>): LockedDeliveryRow => ({
      id: crypto.randomUUID(),
      state: "pending",
      reason: null,
      claimed: false,
      dispatched: false,
      taskRunning: false,
      ...overrides,
    });
    const withdrawn = { state: "expired", reason: "cancelled" } as const;

    const rejected = { state: "terminal_rejected", reason: "No connected computer" } as const;

    // A lock that waited behind another cancel sees every row withdrawn: already cancelled, not running.
    expect(withdrawalRefusal([row(withdrawn), row(withdrawn)])).toBe("already_cancelled");
    // When nothing is pending and the rows left the queue any other way, the Task is no longer
    // queued, and is never called running.
    expect(withdrawalRefusal([row(rejected)])).toBe("left_queue");
    expect(withdrawalRefusal([row({ state: "expired", reason: null })])).toBe("left_queue");
    expect(withdrawalRefusal([row(withdrawn), row(rejected)])).toBe("left_queue");
    // An accepted or steered row is not an exit from the queue: a Turn took the message while the
    // cancel waited, so the Task is running, and the sibling still pending is left in place.
    expect(withdrawalRefusal([row({ state: "accepted" }), row({})])).toBe("running");
    expect(withdrawalRefusal([row({ state: "steered" }), row({})])).toBe("running");
    expect(withdrawalRefusal([row(withdrawn), row({ state: "accepted" })])).toBe("running");
    // Rows that left the queue are set aside: the verdict is about the rows still pending, which
    // are withdrawn when no worker holds them.
    expect(withdrawalRefusal([row(withdrawn), row({})])).toBeUndefined();
    expect(withdrawalRefusal([row(rejected), row({})])).toBeUndefined();
    expect(withdrawalRefusal([row(rejected), row({ claimed: true })])).toBe("in_flight");
    expect(withdrawalRefusal([row(withdrawn), row({ dispatched: true })])).toBe("awaiting_computer");
    // A running Turn refuses before anything else; a live claim outranks a bare dispatch correlation.
    expect(withdrawalRefusal([row({ taskRunning: true, ...withdrawn })])).toBe("running");
    expect(withdrawalRefusal([row({ claimed: true }), row({ dispatched: true })])).toBe("in_flight");
    expect(withdrawalRefusal([row({ dispatched: true }), row({})])).toBe("awaiting_computer");
    expect(withdrawalRefusal([row({}), row({})])).toBeUndefined();
    expect(withdrawalRefusal([])).toBe("nothing");
  });
});

/** A section the request named; a missing one is a contract failure, not an empty page. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The requested Task section was not returned");
  return value;
}

describe("TaskService bounded detail", () => {
  /** One private chat with one Turn per message, all accepted and reported, in its channel Session. */
  async function turnsFor(bindingId: string, channelId: string, count: number) {
    const channel = await createSession(bindingId, { channelId, conversationKind: "dm" });
    const messages = [];
    for (let index = 0; index < count; index += 1) {
      const message = await createMessage(bindingId, {
        channelId,
        externalMessageId: `om_bounded_${index}`,
        occurredAt: minutes(index),
      });
      await createDelivery(channel.id, message.id, { at: minutes(index), reported: true });
      messages.push(message);
    }
    return { channel, messages };
  }

  it("returns one page of each section with its own cursor and no unrequested history", async () => {
    const { binding, bootstrap, service } = await fixture();
    const { channel } = await turnsFor(binding.id, DM, 45);
    const root = await unitDatabase.database
      .select()
      .from(imMessages)
      .where(eq(imMessages.externalMessageId, "om_bounded_0"));
    const taskId = root[0]?.id;
    if (!taskId) throw new Error("The bounded fixture lost its Task");

    const first = await service.detail(bootstrap.userId, taskId, { sections: ["turns"] });
    expect(first.task.id).toBe(channel.id);
    expect(present(first.turns).items).toHaveLength(TASK_SECTION_DEFAULT_LIMIT);
    expect(present(first.turns).nextCursor).toEqual(expect.any(String));
    // A selective read returns the sections it named and nothing else.
    expect(first.internalSessions).toBeUndefined();
    expect(first.collaborationMessages).toBeUndefined();
    // The default page is 20 because that is what one screen of a conversation needs.
    expect(TASK_SECTION_DEFAULT_LIMIT).toBe(20);

    const secondTurns = await service.listTurns(bootstrap.userId, taskId, {
      cursor: present(first.turns).nextCursor ?? undefined,
    });
    const firstIds = new Set(present(first.turns).items.map((turn) => turn.message.id));
    expect(secondTurns.items).toHaveLength(TASK_SECTION_DEFAULT_LIMIT);
    expect(secondTurns.items.every((turn) => !firstIds.has(turn.message.id))).toBe(true);
    expect(secondTurns.items[0]?.message.occurredAt).toBe(minutes(24).toISOString());

    // The legacy detail still answers the requested Turn page completely.
    const legacy = await service.get(bootstrap.userId, taskId, { limit: 5 });
    expect(legacy.turns).toHaveLength(5);
    expect(legacy.nextCursor).toEqual(expect.any(String));
  });

  it("pages internal Sessions earliest first and keeps ended ones in the history", async () => {
    const { binding, bootstrap, service } = await fixture();
    const { channel } = await turnsFor(binding.id, DM, 1);
    const taskId = (await unitDatabase.database.select().from(imMessages))[0]?.id;
    if (!taskId) throw new Error("The bounded fixture lost its Task");
    const created = [];
    for (let index = 0; index < 25; index += 1) {
      created.push(
        await createSession(binding.id, {
          channelId: DM,
          conversationKind: "dm",
          kind: "internal",
          createdBySessionId: channel.id,
          createdAt: minutes(index),
          // Half of the history has ended; ended Sessions stay readable.
          endedAt: index % 2 === 0 ? minutes(index + 1) : null,
        }),
      );
    }

    const first = await service.listInternalSessions(bootstrap.userId, taskId, { limit: 10 });
    expect(first.items.map((session) => session.id)).toEqual(created.slice(0, 10).map((session) => session.id));
    expect(first.items[0]?.endedAt).toBe(minutes(1).toISOString());
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.listInternalSessions(bootstrap.userId, taskId, {
      cursor: first.nextCursor ?? undefined,
      limit: 10,
    });
    expect(second.items.map((session) => session.id)).toEqual(created.slice(10, 20).map((session) => session.id));
    const third = await service.listInternalSessions(bootstrap.userId, taskId, {
      cursor: second.nextCursor ?? undefined,
      limit: 10,
    });
    expect(third.items.map((session) => session.id)).toEqual(created.slice(20).map((session) => session.id));
    expect(third.nextCursor).toBeNull();
  });

  it("titles each internal Session by what it was asked to do and dates it by its latest activity", async () => {
    const { binding, bootstrap, service } = await fixture();
    const { channel } = await turnsFor(binding.id, DM, 1);
    const internal = (createdAt: Date, options: { manualTitle?: string; endedAt?: Date } = {}) =>
      createSession(binding.id, {
        channelId: DM,
        conversationKind: "dm",
        kind: "internal",
        createdBySessionId: channel.id,
        createdAt,
        ...options,
      });
    const asked = await internal(minutes(1));
    const named = await internal(minutes(2), { manualTitle: "Stored title" });
    const silent = await internal(minutes(3), { endedAt: minutes(4) });
    const padded = await internal(minutes(3));
    const spaced = await internal(minutes(3));
    const nbsp = await internal(minutes(3));
    const unicodeSpaced = await internal(minutes(3));
    const blank = await internal(minutes(3));
    const message = (source: string | null, target: string, content: string, at: Date) => ({
      id: crypto.randomUUID(),
      sourceSessionId: source,
      targetSessionId: target,
      content,
      contentHash: "d".repeat(64),
      lastOutcome: "accepted" as const,
      attemptCount: 1,
      lastAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    });
    await unitDatabase.database.insert(sessionMessages).values([
      message(channel.id, asked.id, `  Review the failing\n\ndeployment ${"and more ".repeat(30)}`, minutes(5)),
      message(channel.id, asked.id, "A later instruction", minutes(6)),
      message(asked.id, channel.id, "Done", minutes(7)),
      message(channel.id, named.id, "Not the title", minutes(8)),
      // More than the title budget of leading whitespace before the actual request.
      message(channel.id, padded.id, `${" \n\t".repeat(100)}Summarize the incident\n\n  timeline`, minutes(9)),
      // Repeated whitespace between words collapses before the cap, so it does not spend the budget.
      message(channel.id, spaced.id, Array.from({ length: 40 }, (_, i) => `word${i}`).join(" \n\t  "), minutes(10)),
      // PostgreSQL's POSIX classes do not treat NBSP as whitespace, JavaScript does: 300 leading NBSP
      // must collapse away rather than fill the whole title budget.
      message(channel.id, nbsp.id, `${"\u00a0".repeat(300)}Rotate the\u00a0\u00a0signing key`, minutes(11)),
      // Ideographic, em, thin and line-separator spaces collapse like ASCII whitespace before the cap.
      message(
        channel.id,
        unicodeSpaced.id,
        `\u3000\u2003${Array.from({ length: 40 }, (_, i) => `word${i}`).join("\u3000\u2003\u2009\u2028\u00a0")}\u3000`,
        minutes(12),
      ),
      // A body of Unicode whitespace alone is no title at all.
      message(channel.id, blank.id, "\u00a0\u3000\u2003 \n\u00a0", minutes(13)),
    ]);

    const page = await service.listInternalSessions(bootstrap.userId, channel.id, { limit: 10 });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    const askedTitle = byId.get(asked.id)?.title ?? "";
    // The first message it received, on one line and bounded.
    expect(askedTitle.startsWith("Review the failing deployment and more")).toBe(true);
    expect(askedTitle.length).toBeLessThanOrEqual(120);
    expect(byId.get(asked.id)?.lastActivityAt).toBe(minutes(7).toISOString());
    expect(byId.get(named.id)).toMatchObject({ title: "Stored title", lastActivityAt: minutes(8).toISOString() });
    expect(byId.get(silent.id)).toMatchObject({ title: null, lastActivityAt: minutes(4).toISOString() });
    expect(byId.get(padded.id)?.title).toBe("Summarize the incident timeline");
    const collapsed = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(byId.get(spaced.id)?.title).toBe(collapsed.slice(0, 120));
    expect(byId.get(nbsp.id)?.title).toBe("Rotate the signing key");
    expect(byId.get(unicodeSpaced.id)?.title).toBe(collapsed.slice(0, 120));
    expect(byId.get(blank.id)?.title).toBeNull();
  });

  it("reads scheduled collaboration messages and deduplicates a message whose two ends are both related", async () => {
    const { binding, bootstrap, service } = await fixture();
    const { channel } = await turnsFor(binding.id, DM, 1);
    const taskId = (await unitDatabase.database.select().from(imMessages))[0]?.id;
    if (!taskId) throw new Error("The bounded fixture lost its Task");
    const child = await createSession(binding.id, {
      channelId: DM,
      conversationKind: "dm",
      kind: "internal",
      createdBySessionId: channel.id,
      createdAt: minutes(1),
    });
    const internal = await createSession(binding.id, {
      channelId: DM,
      conversationKind: "dm",
      kind: "internal",
      createdBySessionId: child.id,
      createdAt: minutes(2),
    });
    const scheduledOrigin = {
      scheduleId: crypto.randomUUID(),
      scheduledFor: minutes(3).toISOString(),
      timezone: "UTC",
      name: "Nightly review",
    };
    await unitDatabase.database.insert(sessionMessages).values([
      {
        id: crypto.randomUUID(),
        sourceSessionId: channel.id,
        targetSessionId: child.id,
        content: "Both ends belong to the Task.",
        contentHash: "d".repeat(64),
        lastOutcome: "accepted",
        attemptCount: 1,
        lastAttemptAt: BASE_TIME,
        createdAt: minutes(3),
        updatedAt: minutes(3),
      },
      {
        id: crypto.randomUUID(),
        sourceSessionId: child.id,
        targetSessionId: internal.id,
        content: "One end outside the page.",
        contentHash: "e".repeat(64),
        lastOutcome: "unknown",
        createdAt: minutes(4),
        updatedAt: minutes(4),
      },
      {
        id: crypto.randomUUID(),
        sourceSessionId: null,
        scheduledOrigin,
        targetSessionId: internal.id,
        content: "A scheduled message has no source Session.",
        contentHash: "f".repeat(64),
        lastOutcome: "unknown",
        createdAt: minutes(5),
        updatedAt: minutes(5),
      },
    ]);

    const page = await service.listCollaborationMessages(bootstrap.userId, taskId, { limit: 10 });
    expect(page.items.map((message) => message.content)).toEqual([
      "Both ends belong to the Task.",
      "One end outside the page.",
      "A scheduled message has no source Session.",
    ]);
    expect(page.items[0]?.attemptCount).toBe(1);
    expect(page.items[2]).toMatchObject({ sourceSessionId: null, scheduledOrigin });
    expect(page.nextCursor).toBeNull();

    const limited = await service.listCollaborationMessages(bootstrap.userId, taskId, { limit: 1 });
    expect(limited.items).toHaveLength(1);
    const rest = await service.listCollaborationMessages(bootstrap.userId, taskId, {
      cursor: limited.nextCursor ?? undefined,
      limit: 1,
    });
    expect(rest.items.map((message) => message.content)).toEqual(["One end outside the page."]);
  });

  it("keeps another Account out of every section and rejects a malformed cursor", async () => {
    const { binding, bootstrap, service } = await fixture();
    const { channel } = await turnsFor(binding.id, DM, 3);
    const taskId = (await unitDatabase.database.select().from(imMessages))[0]?.id;
    if (!taskId) throw new Error("The bounded fixture lost its Task");
    const other = crypto.randomUUID();
    for (const read of [
      () => service.detail(other, taskId),
      () => service.listTurns(other, taskId, { limit: 5 }),
      () => service.listInternalSessions(other, taskId, { limit: 5 }),
      () => service.listCollaborationMessages(other, taskId, { limit: 5 }),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
    }
    expect((await service.detail(bootstrap.userId, taskId)).task.id).toBe(channel.id);
    const badCursor = Buffer.from(JSON.stringify({ at: "not-a-date", id: "bad" }), "utf8").toString("base64url");
    for (const read of [
      () => service.listTurns(bootstrap.userId, taskId, { cursor: badCursor }),
      () => service.listInternalSessions(bootstrap.userId, taskId, { cursor: badCursor }),
      () => service.listCollaborationMessages(bootstrap.userId, taskId, { cursor: badCursor }),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    }
  });

  it("clamps a section limit to the contract maximum and never to an unbounded page", async () => {
    const { binding, bootstrap, service } = await fixture();
    await turnsFor(binding.id, DM, 3);
    const taskId = (await unitDatabase.database.select().from(imMessages))[0]?.id;
    if (!taskId) throw new Error("The bounded fixture lost its Task");
    const page = await service.detail(bootstrap.userId, taskId, { limit: 10_000, sections: ["turns"] });
    expect(TASK_SECTION_MAX_LIMIT).toBe(100);
    expect(present(page.turns).items).toHaveLength(3);
    const clamped = await service.listTurns(bootstrap.userId, taskId, { limit: 10_000 });
    expect(clamped.items).toHaveLength(3);
  });

  it("breaks a latest-execution tie by execution id and keeps the direct delivery's attention", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: GROUP });
    // Two deliveries of the same message: a thread Session's direct one and the channel's ambient
    // copy. Both carry the same activity instant, so only the id ordering decides.
    const thread = await createSession(binding.id, { channelId: GROUP, kind: "thread", threadKey: "om_tie" });
    const root = await createMessage(binding.id, { externalMessageId: "om_tie", occurredAt: minutes(0) });
    const direct = await createDelivery(thread.id, root.id, { at: minutes(1), reported: true, outcome: "completed" });
    const ambient = await createDelivery(channel.id, root.id, {
      at: minutes(1),
      attention: "ambient",
      reported: true,
      outcome: "failed",
    });
    const listed = await service.list(bootstrap.userId, { limit: 10 });
    expect(listed.tasks).toHaveLength(1);
    // The ambient copy is not an execution of the channel Session, so only the thread is a Task.
    expect(listed.tasks[0]?.status).toBe("completed");
    const detail = await service.detail(bootstrap.userId, root.id, { sections: ["turns"] });
    expect(present(detail.turns).items.map((turn) => turn.deliveryId)).toEqual([direct.id]);
    expect(detail.task.status).toBe("completed");
    expect(ambient.id).toEqual(expect.any(String));
  });
});

describe("TaskService bounded detail at scale", () => {
  it("answers one page of a Task with thousands of Internal Sessions and collaboration messages", async () => {
    const { binding, bootstrap, service } = await fixture();
    const channel = await createSession(binding.id, { channelId: DM, conversationKind: "dm" });
    const root = await createMessage(binding.id, { channelId: DM, occurredAt: minutes(0) });
    await createDelivery(channel.id, root.id, { at: minutes(0), reported: true });

    const count = 5_000;
    for (let start = 0; start < count; start += 500) {
      const batch = Array.from({ length: 500 }, (_, offset) => {
        const index = start + offset;
        return {
          id: crypto.randomUUID(),
          imBindingId: binding.id,
          channelId: DM,
          conversationKind: "dm" as const,
          kind: "internal" as const,
          createdBySessionId: channel.id,
          runtimeModel: "claude-sonnet",
          runtimeReasoningEffort: "medium",
          runtimeMaxDurationMs: 20_000,
          createdAt: new Date(minutes(index).getTime() + 1_000),
        };
      });
      await unitDatabase.database.insert(sessions).values(batch);
      await unitDatabase.database.insert(sessionMessages).values(
        batch.map((session, offset) => ({
          id: crypto.randomUUID(),
          sourceSessionId: channel.id,
          targetSessionId: session.id,
          content: `Collaboration message ${start + offset}`,
          contentHash: "d".repeat(64),
          lastOutcome: "accepted" as const,
          attemptCount: 1,
          lastAttemptAt: BASE_TIME,
          createdAt: new Date(minutes(start + offset).getTime() + 2_000),
          updatedAt: new Date(minutes(start + offset).getTime() + 2_000),
        })),
      );
    }

    const startedAt = Date.now();
    const first = await service.detail(bootstrap.userId, root.id);
    const elapsedMs = Date.now() - startedAt;
    // The page is the page size whatever the history holds; nothing here reads 5,000 rows into memory.
    expect(first.task.id).toBe(channel.id);
    expect(present(first.internalSessions).items).toHaveLength(TASK_SECTION_DEFAULT_LIMIT);
    expect(present(first.collaborationMessages).items).toHaveLength(TASK_SECTION_DEFAULT_LIMIT);
    expect(present(first.internalSessions).nextCursor).toEqual(expect.any(String));
    expect(present(first.collaborationMessages).nextCursor).toEqual(expect.any(String));
    // The seed itself takes seconds in the embedded engine; the read must stay far below it.
    expect(elapsedMs).toBeLessThan(10_000);

    const secondPage = await service.listInternalSessions(bootstrap.userId, root.id, {
      cursor: present(first.internalSessions).nextCursor ?? undefined,
    });
    const firstIds = new Set(present(first.internalSessions).items.map((session) => session.id));
    expect(secondPage.items).toHaveLength(TASK_SECTION_DEFAULT_LIMIT);
    expect(secondPage.items.every((session) => !firstIds.has(session.id))).toBe(true);
    // The cursor continues strictly after the last Session of the previous page.
    expect(
      (secondPage.items[0]?.createdAt ?? "") > (present(first.internalSessions).items.at(-1)?.createdAt ?? ""),
    ).toBe(true);

    const secondMessages = await service.listCollaborationMessages(bootstrap.userId, root.id, {
      cursor: present(first.collaborationMessages).nextCursor ?? undefined,
    });
    const firstMessageIds = new Set(present(first.collaborationMessages).items.map((message) => message.id));
    expect(secondMessages.items).toHaveLength(TASK_SECTION_DEFAULT_LIMIT);
    expect(secondMessages.items.every((message) => !firstMessageIds.has(message.id))).toBe(true);

    // The legacy complete detail still answers with every related Session.
    const legacy = await service.get(bootstrap.userId, root.id, { limit: 5 });
    expect(legacy.internalSessions).toHaveLength(count);
    expect(legacy.collaborationMessages).toHaveLength(count);
  }, 180_000);

  it("resolves every Task read by Session id, internal Session id, or message id, and links every footer to its Session", async () => {
    const { binding, bootstrap, service } = await fixture();

    // 1. DM Session
    const dmSession = await createSession(binding.id, { channelId: DM, conversationKind: "dm" });
    const dmMsg = await createMessage(binding.id, {
      channelId: DM,
      text: "DM question",
      occurredAt: minutes(0),
      providerContext: { provider: "feishu", chatType: "p2p" },
    });
    await createDelivery(dmSession.id, dmMsg.id, { at: minutes(1), reported: true });
    await unitDatabase.database.insert(imMessages).values({
      imBindingId: binding.id,
      providerEventId: null,
      channelId: DM,
      externalMessageId: "om_dm_reply",
      providerRevisionKey: "outbound:created:v1",
      operation: "created",
      direction: "outbound",
      threadKey: null,
      authorKind: "bot",
      authorExternalId: "ou_bot",
      content: {
        version: 1,
        fallbackText: "DM answer",
        blocks: [{ type: "text", text: "DM answer" }],
        truncated: false,
        outbound: { messageType: "text", contentAvailable: true, timeSource: "provider" },
      },
      providerContext: { provider: "feishu" },
      occurredAt: minutes(2),
    });

    expect(await hasLinkableSessionTask(unitDatabase.database, dmSession.id)).toBe(true);
    expect((await service.detail(bootstrap.userId, dmSession.id)).task.id).toBe(dmSession.id);
    expect((await service.get(bootstrap.userId, dmSession.id, { limit: 10 })).task.id).toBe(dmSession.id);
    expect((await service.listTurns(bootstrap.userId, dmSession.id, {})).items.map((t) => t.message.id)).toEqual([
      dmMsg.id,
    ]);
    expect((await service.listReplies(bootstrap.userId, dmSession.id, { limit: 10 })).items[0]?.fallbackText).toBe(
      "DM answer",
    );

    // 2. Group thread Session
    const { channel, thread, root, reply } = await groupTopic(binding.id, "om_thread_root");
    await createDelivery(channel.id, root.id, { at: minutes(3), reported: true });
    await createDelivery(thread.id, reply.id, { at: minutes(11), reported: true });
    const internal = await createSession(binding.id, {
      channelId: GROUP,
      kind: "internal",
      threadKey: "om_thread_root",
      createdBySessionId: thread.id,
      createdAt: minutes(12),
    });
    await unitDatabase.database.insert(sessionMessages).values({
      id: crypto.randomUUID(),
      sourceSessionId: thread.id,
      targetSessionId: internal.id,
      content: "Check thread",
      contentHash: "a".repeat(64),
      lastOutcome: "accepted",
      attemptCount: 1,
      lastAttemptAt: BASE_TIME,
    });
    await unitDatabase.database.insert(imMessages).values({
      imBindingId: binding.id,
      providerEventId: null,
      channelId: GROUP,
      externalMessageId: "om_thread_reply",
      providerRevisionKey: "outbound:created:v1",
      operation: "created",
      direction: "outbound",
      threadKey: "om_thread_root",
      authorKind: "bot",
      authorExternalId: "ou_bot",
      content: {
        version: 1,
        fallbackText: "Thread answer",
        blocks: [{ type: "text", text: "Thread answer" }],
        truncated: false,
        outbound: { messageType: "text", contentAvailable: true, timeSource: "provider" },
      },
      providerContext: { provider: "feishu", rootId: "om_thread_root" },
      occurredAt: minutes(13),
    });

    expect(await hasLinkableSessionTask(unitDatabase.database, thread.id)).toBe(true);
    expect((await service.detail(bootstrap.userId, thread.id)).task.id).toBe(thread.id);
    expect((await service.get(bootstrap.userId, thread.id, { limit: 10 })).task.id).toBe(thread.id);
    expect((await service.listTurns(bootstrap.userId, thread.id, {})).items.map((t) => t.message.id)).toEqual([
      reply.id,
    ]);
    // An internal Session's footer links by its own id, which opens its creator's Task.
    expect(await hasLinkableSessionTask(unitDatabase.database, internal.id)).toBe(true);
    expect((await service.detail(bootstrap.userId, internal.id)).task.id).toBe(thread.id);
    expect((await service.listInternalSessions(bootstrap.userId, thread.id, {})).items.map((s) => s.id)).toEqual([
      internal.id,
    ]);
    expect(
      (await service.listCollaborationMessages(bootstrap.userId, thread.id, {})).items.map((m) => m.content),
    ).toEqual(["Check thread"]);
    expect((await service.listReplies(bootstrap.userId, thread.id, { limit: 10 })).items[0]?.fallbackText).toBe(
      "Thread answer",
    );

    // 3. Group channel Session with two top-level requests A (minute 20) and B (minute 30),
    // including out-of-order sends where execution A sends after delivery B was accepted:
    const requestA = await createMessage(binding.id, {
      channelId: GROUP,
      externalMessageId: "om_group_req_a",
      text: "Top-level group request A",
      occurredAt: minutes(20),
    });
    await createDelivery(channel.id, requestA.id, { at: minutes(21), reported: true });
    await unitDatabase.database.insert(imMessages).values({
      imBindingId: binding.id,
      providerEventId: null,
      channelId: GROUP,
      externalMessageId: "om_group_req_a_reply",
      providerRevisionKey: "outbound:created:v1",
      operation: "created",
      direction: "outbound",
      threadKey: "om_group_req_a",
      authorKind: "bot",
      authorExternalId: "ou_bot",
      content: {
        version: 1,
        fallbackText: "Answer for A",
        blocks: [{ type: "text", text: "Answer for A" }],
        truncated: false,
        outbound: { messageType: "text", contentAvailable: true, timeSource: "provider" },
      },
      providerContext: { provider: "feishu", rootId: "om_group_req_a" },
      occurredAt: minutes(22),
    });

    const requestB = await createMessage(binding.id, {
      channelId: GROUP,
      externalMessageId: "om_group_req_b",
      text: "Top-level group request B",
      occurredAt: minutes(30),
    });
    await createDelivery(channel.id, requestB.id, { at: minutes(31), reported: true });

    // A group channel Session with addressed requests links its Session ID to its Task.
    expect(await hasLinkableSessionTask(unitDatabase.database, channel.id)).toBe(true);
    expect(await hasLinkableSessionTask(unitDatabase.database, crypto.randomUUID())).toBe(false);

    // A DB lookup failure logs IM_FEEDBACK_SESSION_LINK_LOOKUP_FAILED and keeps the plain ID.
    const warnings: unknown[] = [];
    const failedLookup = await hasLinkableSessionTask(unitDatabase.database, "not-a-uuid", {
      warn: (fields) => warnings.push(fields),
    });
    expect(failedLookup).toBe(false);
    expect(warnings).toMatchObject([{ code: "IM_FEEDBACK_SESSION_LINK_LOOKUP_FAILED", sessionId: "not-a-uuid" }]);

    // Reply footers sent before Tasks became Sessions anchored on a request's message id; those links
    // keep opening the Task of the Session that received the request.
    for (const anchor of [requestA.id, requestB.id, root.id, channel.id]) {
      expect((await service.detail(bootstrap.userId, anchor)).task.id).toBe(channel.id);
    }
    expect((await service.listTurns(bootstrap.userId, requestA.id, {})).items.map((t) => t.message.id)).toEqual([
      requestB.id,
      requestA.id,
      root.id,
    ]);
    // The reply A sent into its request's thread stays with the channel Session: no thread Session
    // of that thread existed.
    expect(
      (await service.listReplies(bootstrap.userId, channel.id, { limit: 10 })).items.map((item) => item.fallbackText),
    ).toEqual(["Answer for A"]);
    await expect(service.updateTitle(bootstrap.userId, channel.id, "Group channel")).resolves.toMatchObject({
      id: channel.id,
      title: "Group channel",
    });
  });
});
