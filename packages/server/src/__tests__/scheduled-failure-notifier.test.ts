import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentSchedules,
  agents,
  computers,
  imBindings,
  imMessages,
  sessionMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
  users,
} from "../db/schema/index.js";
import { FeedbackProviderError } from "../services/im/im-feedback-messenger.js";
import type { ScheduleClock } from "../services/schedules/index.js";
import { ScheduledFailureNotifier, ScheduleScheduler } from "../services/schedules/index.js";
import {
  renderMiss,
  renderRunFailure,
  type ScheduledOccurrence,
  scheduledMissKind,
} from "../services/schedules/scheduled-failure-notifier.js";
import { SessionService } from "../services/sessions/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/*
 * Issue #1352: the Agent no longer posts a start message, so these prove what the conversation
 * hears instead. A scheduled occurrence that worked says nothing; one whose Run failed, one the
 * Client rejected, and one that never started each reach the Session's chat or thread.
 */

const T0 = new Date("2026-09-28T01:00:00.000Z");
const PUBLIC_URL = "https://opentag.example.com";

let db: UnitDatabase;
let currentTime = T0;
const clock: ScheduleClock = { now: async () => currentTime };

beforeAll(async () => {
  db = await createUnitDatabase();
}, 60_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.reset();
  currentTime = T0;
  route = { kind: "route", route: {} };
});

interface Seed {
  agentId: string;
  bindingId: string;
  computerId: string;
  sessionId: string;
}

async function seed(options: { provider?: "feishu" | "slack"; threadKey?: string } = {}): Promise<Seed> {
  const accountId = randomUUID();
  const computerId = randomUUID();
  await db.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "Owner" });
  await db.database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    kind: "local",
    currentInstallationId: randomUUID(),
    currentInstanceId: randomUUID(),
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const agentId = randomUUID();
  await db.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
  });
  const bindingId = randomUUID();
  const common = {
    agentId,
    status: "active" as const,
    externalAppId: `app-${randomUUID()}`,
    externalBotId: "ou_bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    activatedAt: new Date(),
  };
  if (options.provider === "slack") {
    const slackInstallationId = randomUUID();
    await db.database.insert(slackInstallations).values({
      ...common,
      id: slackInstallationId,
      externalTeamId: "T1",
      encryptedCredential: "test-only",
    });
    await db.database.insert(imBindings).values({
      ...common,
      id: bindingId,
      provider: "slack",
      externalTeamId: "T1",
      slackInstallationId,
      slackRouteKind: "default",
    } as never);
  } else {
    await db.database
      .insert(imBindings)
      .values({ ...common, id: bindingId, provider: "feishu", encryptedCredential: "test-only" });
  }
  const sessionId = randomUUID();
  await db.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "oc_channel",
    conversationKind: options.threadKey ? "channel" : "dm",
    kind: options.threadKey ? "thread" : "channel",
    threadKey: options.threadKey ?? null,
  });
  await db.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  return { agentId, bindingId, computerId, sessionId };
}

async function scheduledMessage(value: Seed): Promise<string> {
  const id = randomUUID();
  await db.database.insert(sessionMessages).values({
    id,
    scheduledOrigin: {
      scheduleId: randomUUID(),
      scheduledFor: T0.toISOString(),
      timezone: "Asia/Shanghai",
      name: 'Hourly <at user_id="all">check</at>',
    },
    targetSessionId: value.sessionId,
    content: "Check the build.",
    contentHash: "a".repeat(64),
    lastOutcome: "accepted",
  });
  return id;
}

function harness(post = vi.fn(async () => "native-id")) {
  const runOutcomes = {
    notifyRunOutcome: vi.fn(async () => "notified" as const),
    notifyRunOutcomeInBackground: vi.fn(async () => "retry" as const),
  };
  const logger = { warn: vi.fn() };
  const notifier = new ScheduledFailureNotifier({
    database: db.database,
    logger,
    messenger: { postConversationText: post },
    publicUrl: PUBLIC_URL,
    retryDelayMs: 1,
    runOutcomes,
  });
  return { logger, notifier, post, runOutcomes };
}

function report(value: Seed, messageId: string, overrides: Record<string, unknown> = {}) {
  return {
    childSessionId: value.sessionId,
    messageId,
    outcome: "failed" as const,
    reason: "provider_unavailable",
    source: { computerId: value.computerId, connectionInstanceId: randomUUID(), placementGeneration: 1 },
    ...overrides,
  };
}

describe("a scheduled Run that failed", () => {
  it("reaches the Session's conversation with the cause, the effects warning, and the details link", async () => {
    const value = await seed();
    const messageId = await scheduledMessage(value);
    const h = harness();

    await expect(h.notifier.notifyRunOutcome(report(value, messageId))).resolves.toBe("notified");

    expect(h.runOutcomes.notifyRunOutcome).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledOnce();
    const [target, text, requestId] = h.post.mock.calls[0] as unknown as [Record<string, unknown>, string, string];
    expect(target).toMatchObject({ bindingId: value.bindingId, channelId: "oc_channel", threadKey: null });
    expect(requestId).not.toBe(messageId);
    expect(text).toContain("The model service is temporarily unavailable, so the task didn't finish.");
    expect(text).toContain("Some operations may already have run");
    expect(text).toContain("2026-09-28 09:00:00 +08:00 (Asia/Shanghai)");
    expect(text).not.toContain("provider_unavailable");
    expect(text).toMatch(/\[View details\]\(https:\/\/opentag\.example\.com\/agents\/[^)]+\?schedule=[^)]+\)$/u);
    // Schedule names are untrusted: no provider mention syntax survives.
    expect(text).not.toMatch(/<at|<\/at>/u);
  });

  it("names a timeout and an interrupted Run, and stays quiet about a Run someone stopped", async () => {
    const value = await seed();
    const messageId = await scheduledMessage(value);
    const h = harness();
    await h.notifier.notifyRunOutcome(report(value, messageId, { outcome: "timed_out", reason: "turn_timeout" }));
    await h.notifier.notifyRunOutcome(report(value, messageId, { outcome: "unknown", reason: "turn_state_unknown" }));
    const texts = h.post.mock.calls.map((call) => (call as unknown as [unknown, string])[1]);
    expect(texts[0]).toContain("This task hit its time limit");
    expect(texts[1]).toContain("We can't confirm whether the task finished.");

    h.post.mockClear();
    await expect(
      h.notifier.notifyRunOutcome(report(value, messageId, { outcome: "cancelled", reason: "turn_cancelled" })),
    ).resolves.toBe("ignored");
    expect(h.post).not.toHaveBeenCalled();
  });

  it("ignores a report from a Computer or placement that no longer holds the Session", async () => {
    const value = await seed();
    const messageId = await scheduledMessage(value);
    const h = harness();
    const source = { computerId: randomUUID(), connectionInstanceId: randomUUID(), placementGeneration: 1 };
    await expect(h.notifier.notifyRunOutcome(report(value, messageId, { source }))).resolves.toBe("ignored");
    await expect(
      h.notifier.notifyRunOutcome(
        report(value, messageId, {
          source: { computerId: value.computerId, connectionInstanceId: randomUUID(), placementGeneration: 2 },
        }),
      ),
    ).resolves.toBe("ignored");
    expect(h.post).not.toHaveBeenCalled();
  });

  it("leaves every other report to the existing notifier", async () => {
    const value = await seed();
    const h = harness();
    await expect(h.notifier.notifyRunOutcome(report(value, randomUUID()))).resolves.toBe("notified");
    expect(h.runOutcomes.notifyRunOutcome).toHaveBeenCalledOnce();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("asks the durable reporter to retry only when another send cannot duplicate on Slack", async () => {
    const answers: [FeedbackProviderError, "feishu" | "slack", string][] = [
      [new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, 1_000), "slack", "retry"],
      [new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false), "feishu", "retry"],
      [new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false), "slack", "ignored"],
      [new FeedbackProviderError("IM_FEEDBACK_SEND_REJECTED", true, true), "feishu", "ignored"],
    ];
    for (const [error, provider, expected] of answers) {
      const value = await seed({ provider });
      const messageId = await scheduledMessage(value);
      const h = harness(vi.fn().mockRejectedValue(error));
      await expect(h.notifier.notifyRunOutcome(report(value, messageId))).resolves.toBe(expected);
    }
  });

  it("retries after a read failure and drops a report once its Bot is gone", async () => {
    const value = await seed();
    const messageId = await scheduledMessage(value);
    const broken = new ScheduledFailureNotifier({
      database: {
        select: () => {
          throw new Error("database down");
        },
      } as never,
      messenger: { postConversationText: vi.fn() },
      publicUrl: PUBLIC_URL,
      runOutcomes: { notifyRunOutcome: vi.fn(), notifyRunOutcomeInBackground: vi.fn() },
    });
    await expect(broken.notifyRunOutcome(report(value, messageId))).resolves.toBe("retry");

    await db.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, value.bindingId));
    const h = harness();
    await expect(h.notifier.notifyRunOutcome(report(value, messageId))).resolves.toBe("ignored");
    expect(h.post).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SCHEDULED_FAILURE_NOTICE_NO_CONVERSATION" }),
      expect.any(String),
    );
  });

  it("skips a recalled Feishu message when choosing the thread reply target", async () => {
    const value = await seed({ threadKey: "omt_thread" });
    const messageId = await scheduledMessage(value);
    const revision = (externalMessageId: string, operation: string, minutes: number) => ({
      id: randomUUID(),
      imBindingId: value.bindingId,
      channelId: "oc_channel",
      externalMessageId,
      providerRevisionKey: operation,
      operation,
      direction: "inbound",
      threadKey: "omt_thread",
      authorKind: "human",
      authorExternalId: "ou_user",
      content: { version: 1, fallbackText: "hello", blocks: [], truncated: false },
      providerContext: { provider: "feishu" },
      occurredAt: new Date(T0.getTime() + minutes * 60_000),
    });
    await db.database
      .insert(imMessages)
      .values([
        revision("om_live", "created", 0),
        revision("om_recalled", "created", 1),
        revision("om_recalled", "deleted", 2),
      ] as never);
    const h = harness();
    await expect(h.notifier.notifyRunOutcome(report(value, messageId))).resolves.toBe("notified");
    expect(h.post.mock.calls[0]?.[0 as never]).toMatchObject({ replyToExternalId: "om_live" });
  });

  it("stays in a Feishu thread by replying to its latest message", async () => {
    const value = await seed({ threadKey: "omt_thread" });
    const messageId = await scheduledMessage(value);
    const h = harness();
    // No message known in the thread: it must not leak into the chat.
    await expect(h.notifier.notifyRunOutcome(report(value, messageId))).resolves.toBe("ignored");
    expect(h.post).not.toHaveBeenCalled();

    await db.database.insert(imMessages).values({
      id: randomUUID(),
      imBindingId: value.bindingId,
      channelId: "oc_channel",
      externalMessageId: "om_latest",
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      threadKey: "omt_thread",
      authorKind: "human",
      authorExternalId: "ou_user",
      content: { version: 1, fallbackText: "hello", blocks: [], truncated: false },
      providerContext: { provider: "feishu" },
      occurredAt: T0,
    } as never);
    await expect(h.notifier.notifyRunOutcome(report(value, messageId))).resolves.toBe("notified");
    expect(h.post.mock.calls[0]?.[0 as never]).toMatchObject({ replyToExternalId: "om_latest" });
  });
});

describe("the failure reason behind the details link", () => {
  async function delivered(value: Seed, last: { outcome: string; code: string | null; scheduledFor?: string }) {
    const scheduleId = await insertEverySchedule(value);
    const messageId = randomUUID();
    const scheduledFor = T0.toISOString();
    await db.database
      .update(agentSchedules)
      .set({
        lastDispatch: {
          scheduledFor: last.scheduledFor ?? scheduledFor,
          attemptedAt: scheduledFor,
          messageId,
          outcome: last.outcome,
          code: last.code,
        } as never,
      })
      .where(eq(agentSchedules.id, scheduleId));
    await db.database.insert(sessionMessages).values({
      id: messageId,
      scheduledOrigin: { scheduleId, scheduledFor, timezone: "UTC", name: "Hourly check" },
      targetSessionId: value.sessionId,
      content: "Check the build.",
      contentHash: "a".repeat(64),
      lastOutcome: "accepted",
    });
    return { messageId, scheduleId };
  }
  const summary = async (scheduleId: string) =>
    (await db.database.select().from(agentSchedules).where(eq(agentSchedules.id, scheduleId)))[0]?.lastDispatch;

  it.each(["notifyRunOutcome", "notifyRunOutcomeInBackground"] as const)(
    "tells two different failures apart on the schedule through %s, and stays out of the message",
    async (entry) => {
      for (const reason of ["provider_start_failed", "provider_process_exited"]) {
        const value = await seed();
        const { messageId, scheduleId } = await delivered(value, { outcome: "accepted", code: null });
        const h = harness();
        await h.notifier[entry](report(value, messageId, { reason }));
        expect(await summary(scheduleId)).toMatchObject({ outcome: "accepted", code: reason });
        await vi.waitFor(() => expect(h.post).toHaveBeenCalledOnce());
        expect((h.post.mock.calls[0] as unknown as [unknown, string])[1]).not.toContain(reason);
      }
    },
  );

  it("settles an unconfirmed hand-off, because a Run proves it landed", async () => {
    const value = await seed();
    const { messageId, scheduleId } = await delivered(value, { outcome: "unknown", code: "delivery_uncertain" });
    const h = harness();
    await h.notifier.notifyRunOutcome(report(value, messageId));
    expect(await summary(scheduleId)).toMatchObject({ outcome: "accepted", code: "provider_unavailable" });
  });

  describe.each(["notifyRunOutcome", "notifyRunOutcomeInBackground"] as const)(
    "when the hand-off's result arrives after the final answer from %s",
    (entry) => {
      /** Reports until the reporter would delete its durable copy, so no later report can repair anything. */
      async function failed(value: Seed, messageId: string): Promise<void> {
        const h = harness();
        await vi.waitFor(async () => expect(await h.notifier[entry](report(value, messageId))).toBe("notified"));
      }

      it("keeps the reason through the scheduled receipt", async () => {
        const value = await seed();
        const { messageId, scheduleId } = await delivered(value, { outcome: "unknown", code: null });
        await failed(value, messageId);
        const scheduledFor = T0.toISOString();
        await expect(
          new SessionService(db.database).recordMessageOutcome({
            messageId,
            attemptCount: 0,
            outcome: "accepted",
            scheduleSummary: { scheduleId, scheduledFor, attemptedAt: scheduledFor },
          }),
        ).resolves.toBe(true);
        expect(await summary(scheduleId)).toMatchObject({ outcome: "accepted", code: "provider_unavailable" });
      });

      it("keeps the reason through Cloud's accepted custody write", async () => {
        const value = await seed();
        const { messageId, scheduleId } = await delivered(value, { outcome: "unknown", code: null });
        await failed(value, messageId);
        await new SessionService(db.database).recordMessageOutcome({ messageId, attemptCount: 0, outcome: "accepted" });
        expect(await summary(scheduleId)).toMatchObject({ outcome: "accepted", code: "provider_unavailable" });
      });

      it("isn't replaced by a late timeout", async () => {
        const value = await seed();
        const { messageId, scheduleId } = await delivered(value, { outcome: "unknown", code: null });
        await db.database
          .update(sessionMessages)
          .set({ lastOutcome: "unknown" })
          .where(eq(sessionMessages.id, messageId));
        await failed(value, messageId);
        const scheduledFor = T0.toISOString();
        await new SessionService(db.database).recordMessageOutcome({
          messageId,
          attemptCount: 0,
          outcome: "unreachable",
          errorCode: "delivery_timeout",
          scheduleSummary: { scheduleId, scheduledFor, attemptedAt: scheduledFor },
        });
        expect(await summary(scheduleId)).toMatchObject({ outcome: "accepted", code: "provider_unavailable" });
      });
    },
  );

  it("still lets a receipt write an occurrence that has no Run failure", async () => {
    const value = await seed();
    const { messageId, scheduleId } = await delivered(value, { outcome: "unknown", code: "delivery_uncertain" });
    await new SessionService(db.database).recordMessageOutcome({ messageId, attemptCount: 0, outcome: "accepted" });
    expect(await summary(scheduleId)).toMatchObject({ outcome: "accepted", code: null });
    // A later receipt on a healthy summary, and the failure arriving after it, both still apply.
    const h = harness();
    await h.notifier.notifyRunOutcome(report(value, messageId));
    expect(await summary(scheduleId)).toMatchObject({ outcome: "accepted", code: "provider_unavailable" });
  });

  it("leaves a later occurrence's summary, a cancelled Run, and a foreign report alone", async () => {
    const value = await seed();
    const h = harness();
    const later = await delivered(value, { outcome: "accepted", code: null, scheduledFor: "2026-09-28T02:00:00.000Z" });
    await h.notifier.notifyRunOutcome(report(value, later.messageId));
    expect(await summary(later.scheduleId)).toMatchObject({ code: null });

    const current = await delivered(await seed(), { outcome: "accepted", code: null });
    const owner = await db.database.select().from(sessionMessages).where(eq(sessionMessages.id, current.messageId));
    const session = owner[0]?.targetSessionId as string;
    const [placement] = await db.database
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, session));
    const base = { childSessionId: session, messageId: current.messageId };
    const source = {
      computerId: placement?.computerId as string,
      connectionInstanceId: randomUUID(),
      placementGeneration: 1,
    };
    await h.notifier.notifyRunOutcome({ ...base, outcome: "cancelled", reason: "turn_cancelled", source });
    await h.notifier.notifyRunOutcome({
      ...base,
      outcome: "failed",
      reason: "provider_failed",
      source: { ...source, computerId: randomUUID() },
    });
    expect(await summary(current.scheduleId)).toMatchObject({ code: null });
  });
});

describe("the failure message's wording", () => {
  const occurrence = (overrides: Partial<ScheduledOccurrence> = {}): ScheduledOccurrence => ({
    agentId: "agent",
    name: "Hourly check",
    prompt: "Check the build.",
    scheduleId: "schedule",
    scheduledFor: T0.toISOString(),
    targetSessionId: "session",
    timezone: "UTC",
    ...overrides,
  });

  it("links the schedule in each provider's syntax and shows no raw URL or code", () => {
    const url = `${PUBLIC_URL}/agents/agent?schedule=schedule`;
    const slack = renderMiss(occurrence(), "missed", PUBLIC_URL, "slack");
    const feishu = renderRunFailure(occurrence(), "failed", "provider_quota_exceeded", PUBLIC_URL, "feishu");
    expect(slack.endsWith(`<${url}|View details>`)).toBe(true);
    expect(feishu.endsWith(`[View details](${url})`)).toBe(true);
    expect(feishu).not.toContain("provider_quota_exceeded");
    expect(feishu.split("\n\n")).toHaveLength(3);
  });

  it("follows the language of the schedule's task", () => {
    const zh = occurrence({ prompt: "检查构建" });
    expect(renderRunFailure(zh, "failed", "provider_unavailable", PUBLIC_URL, "feishu")).toContain(
      "模型服务暂时不可用，任务没有完成。",
    );
    expect(renderRunFailure(zh, "timed_out", "x", PUBLIC_URL, "feishu")).toContain("超过了时间上限");
    expect(renderMiss(zh, "missed", PUBLIC_URL, "slack")).toContain("定时任务“Hourly check”");
    expect(renderMiss(zh, "unconfirmed", PUBLIC_URL, "slack")).toContain("可能没有运行。");
    expect(renderMiss(zh, "disabled", PUBLIC_URL, "feishu")).toContain("[查看详情](");
  });

  it("keeps link and mention syntax in a schedule name inert, leaving only the details link", () => {
    const name = 'x [click](http://evil.example) <http://evil.example|click> <at user_id="all">y</at> <!channel>';
    const feishu = renderMiss(occurrence({ name }), "missed", PUBLIC_URL, "feishu");
    const slack = renderMiss(occurrence({ name }), "missed", PUBLIC_URL, "slack");
    expect(feishu.match(/\]\(/gu)).toHaveLength(1);
    expect(feishu).toContain("［click］(http://evil.example)");
    expect(slack.match(/</gu)).toHaveLength(1);
    expect(feishu).not.toContain("<at");
    expect(slack).not.toContain("<!channel>");
  });
});

describe("a scheduled Run failure reported by a Local Computer", () => {
  function deferredPost() {
    const resolvers: { resolve(value: string): void; reject(error: unknown): void }[] = [];
    const post = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          resolvers.push({ resolve, reject });
        }),
    );
    return { post, resolvers };
  }

  it("answers retry before the IM send finishes, sends once, and reports notified afterwards", async () => {
    const value = await seed();
    const messageId = await scheduledMessage(value);
    const { post, resolvers } = deferredPost();
    const h = harness(post);
    const input = report(value, messageId);

    // The send has not settled, so a frame that waited for it would never resolve here.
    await expect(h.notifier.notifyRunOutcomeInBackground(input)).resolves.toBe("retry");
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    await expect(h.notifier.notifyRunOutcomeInBackground(input)).resolves.toBe("retry");
    expect(post).toHaveBeenCalledOnce();

    resolvers[0]?.resolve("native-id");
    await vi.waitFor(async () => expect(await h.notifier.notifyRunOutcomeInBackground(input)).toBe("notified"));
    // A report whose answer was lost gets the same answer, not a second message.
    await expect(h.notifier.notifyRunOutcomeInBackground(input)).resolves.toBe("notified");
    expect(post).toHaveBeenCalledOnce();
    expect(h.runOutcomes.notifyRunOutcomeInBackground).not.toHaveBeenCalled();
  });

  it("sends again on the next report after a retryable failure, and ends on a permanent one", async () => {
    const value = await seed();
    const messageId = await scheduledMessage(value);
    const post = vi
      .fn()
      .mockRejectedValueOnce(new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, 1_000))
      .mockRejectedValueOnce(new FeedbackProviderError("IM_FEEDBACK_SEND_REJECTED", true, true));
    const h = harness(post);
    const input = report(value, messageId);

    await h.notifier.notifyRunOutcomeInBackground(input);
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      await h.notifier.notifyRunOutcomeInBackground(input);
      expect(post).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(async () => expect(await h.notifier.notifyRunOutcomeInBackground(input)).toBe("ignored"));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("limits concurrent sends and leaves the excess with the reporter", async () => {
    const value = await seed();
    const { post, resolvers } = deferredPost();
    const h = harness(post);
    const inputs = [];
    for (let index = 0; index < 17; index += 1) inputs.push(report(value, await scheduledMessage(value)));
    for (const input of inputs) await expect(h.notifier.notifyRunOutcomeInBackground(input)).resolves.toBe("retry");
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(16));

    await new Promise((resolve) => setImmediate(resolve));
    expect(post).toHaveBeenCalledTimes(16);
    for (const resolver of resolvers) resolver.resolve("native-id");
    await h.notifier.close();
  });

  it("drains running sends on close and starts no new one", async () => {
    const value = await seed();
    const { post, resolvers } = deferredPost();
    const h = harness(post);
    await h.notifier.notifyRunOutcomeInBackground(report(value, await scheduledMessage(value)));
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());

    let closed = false;
    const closing = h.notifier.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    resolvers[0]?.resolve("native-id");
    await closing;

    await expect(h.notifier.notifyRunOutcomeInBackground(report(value, await scheduledMessage(value)))).resolves.toBe(
      "retry",
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(post).toHaveBeenCalledOnce();
  });

  it("routes unscheduled reports to the collaboration service's background path, not its synchronous one", async () => {
    const value = await seed();
    const h = harness();
    await expect(h.notifier.notifyRunOutcomeInBackground(report(value, randomUUID()))).resolves.toBe("retry");
    expect(h.runOutcomes.notifyRunOutcomeInBackground).toHaveBeenCalledOnce();
    expect(h.runOutcomes.notifyRunOutcome).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("gives a final answer without a send for a cancelled Run or a stale placement", async () => {
    const value = await seed();
    const messageId = await scheduledMessage(value);
    const h = harness();
    await expect(
      h.notifier.notifyRunOutcomeInBackground(
        report(value, messageId, { outcome: "cancelled", reason: "turn_cancelled" }),
      ),
    ).resolves.toBe("ignored");
    await expect(
      h.notifier.notifyRunOutcomeInBackground(
        report(value, messageId, {
          source: { computerId: value.computerId, connectionInstanceId: randomUUID(), placementGeneration: 2 },
        }),
      ),
    ).resolves.toBe("ignored");
    expect(h.post).not.toHaveBeenCalled();
  });
});

let route: { kind: "route"; route: object } | { kind: "permanent" | "temporary"; code: string } = {
  kind: "route",
  route: {},
};

function makeScheduler(notifier: ScheduledFailureNotifier, dispatch: ReturnType<typeof vi.fn>) {
  return new ScheduleScheduler({
    clock,
    database: db.database,
    dispatch: { dispatchScheduledMessage: dispatch as never },
    missNotices: notifier,
    publicUrl: PUBLIC_URL,
    sessions: { resolveScheduledMessageRoute: vi.fn(async () => route) as never },
  });
}

async function insertEverySchedule(value: Seed, nextTriggerAt = T0, timezone = "UTC"): Promise<string> {
  const [row] = await db.database
    .insert(agentSchedules)
    .values({
      agentId: value.agentId,
      targetSessionId: value.sessionId,
      name: "Hourly check",
      prompt: "Check the build.",
      schedule: { kind: "every", intervalSeconds: 3600, anchorAt: T0.toISOString() },
      timezone,
      enabled: true,
      nextTriggerAt,
      revision: 1,
    })
    .returning();
  if (!row) throw new Error("schedule fixture missing");
  return row.id;
}

/** Run the next hourly occurrence and let its notice finish. */
async function occurrence(scheduler: ScheduleScheduler, index: number): Promise<void> {
  currentTime = new Date(T0.getTime() + index * 3_600_000);
  await scheduler.scanNow();
  await vi.waitFor(() => expect(scheduler.inFlightCount).toBe(0));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("a scheduled occurrence that never ran", () => {
  it("posts nothing when the hand-off is accepted", async () => {
    const value = await seed();
    await insertEverySchedule(value);
    const h = harness();
    const dispatch = vi.fn(async () => ({ outcome: "accepted", code: null }));
    const scheduler = makeScheduler(h.notifier, dispatch);
    await occurrence(scheduler, 0);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(h.post).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("tells the conversation when the Client rejects it", async () => {
    const value = await seed();
    await insertEverySchedule(value);
    const h = harness();
    const scheduler = makeScheduler(
      h.notifier,
      vi.fn(async () => ({ outcome: "rejected", code: "configuration_unsupported" })),
    );
    await occurrence(scheduler, 0);
    expect(h.post).toHaveBeenCalledOnce();
    const text = (h.post.mock.calls[0] as unknown as [unknown, string])[1];
    expect(text).toContain('Scheduled task "Hourly check" (scheduled for ');
    expect(text).toContain("didn't run.");
    expect(text).toContain("The Agent never received it, so no operations were run");
    expect(text).not.toContain("configuration_unsupported");
    await scheduler.stop();
  });

  it("posts once per cause while the Computer stays offline, and again after it recovers", async () => {
    const value = await seed();
    await insertEverySchedule(value);
    const h = harness();
    const dispatch = vi.fn(async () => ({ outcome: "unreachable", code: "runtime_unavailable" }));
    const scheduler = makeScheduler(h.notifier, dispatch);

    await occurrence(scheduler, 0);
    await db.database
      .update(agentSchedules)
      .set({
        lastDispatch: {
          scheduledFor: T0.toISOString(),
          attemptedAt: T0.toISOString(),
          messageId: null,
          outcome: "unreachable",
          code: "runtime_unavailable",
        },
      })
      .where(eq(agentSchedules.agentId, value.agentId));
    await occurrence(scheduler, 1);
    expect(h.post).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledTimes(2);

    await db.database
      .update(agentSchedules)
      .set({
        lastDispatch: {
          scheduledFor: T0.toISOString(),
          attemptedAt: T0.toISOString(),
          messageId: null,
          outcome: "accepted",
          code: null,
        },
      })
      .where(eq(agentSchedules.agentId, value.agentId));
    await occurrence(scheduler, 2);
    expect(h.post).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("says an unconfirmed hand-off may not have run, and reports a dispatch that threw", async () => {
    const value = await seed();
    await insertEverySchedule(value);
    const h = harness();
    const dispatch = vi.fn(async () => ({ outcome: "unknown", code: "delivery_timeout" }));
    const scheduler = makeScheduler(h.notifier, dispatch);
    await occurrence(scheduler, 0);
    expect((h.post.mock.calls[0] as unknown as [unknown, string])[1]).toContain("may not have run");

    dispatch.mockRejectedValueOnce(new Error("boom"));
    await occurrence(scheduler, 1);
    expect((h.post.mock.calls[1] as unknown as [unknown, string])[1]).toContain("may not have run");
    await scheduler.stop();
  });

  it("reports an occurrence missed while the Server was down", async () => {
    const value = await seed();
    await insertEverySchedule(value);
    const h = harness();
    const dispatch = vi.fn();
    const scheduler = makeScheduler(h.notifier, dispatch);
    currentTime = new Date(T0.getTime() + 60_000);
    await scheduler.scanNow();
    await new Promise((resolve) => setImmediate(resolve));
    await vi.waitFor(() => expect(h.post).toHaveBeenCalledOnce());
    expect(dispatch).not.toHaveBeenCalled();
    expect((h.post.mock.calls[0] as unknown as [unknown, string])[1]).toContain("didn't run.");
    await scheduler.stop();
  });

  it("says when the schedule turned itself off", async () => {
    const value = await seed();
    const scheduleId = await insertEverySchedule(value);
    route = { kind: "permanent", code: "target_invalid" };
    const h = harness();
    const scheduler = makeScheduler(h.notifier, vi.fn());
    await scheduler.scanNow();
    await vi.waitFor(() => expect(h.post).toHaveBeenCalledOnce());
    expect((h.post.mock.calls[0] as unknown as [unknown, string])[1]).toContain("the schedule has been turned off");
    const [row] = await db.database.select().from(agentSchedules).where(eq(agentSchedules.id, scheduleId));
    expect(row?.enabled).toBe(false);
    await scheduler.stop();
  });

  it("still reports a schedule turned off for a timezone that cannot be formatted", async () => {
    const value = await seed();
    await insertEverySchedule(value, T0, "Mars/Olympus_Mons");
    const h = harness();
    const dispatch = vi.fn();
    const scheduler = makeScheduler(h.notifier, dispatch);
    await scheduler.scanNow();
    await vi.waitFor(() => expect(h.post).toHaveBeenCalledOnce());
    const text = (h.post.mock.calls[0] as unknown as [unknown, string])[1];
    expect(text).toContain("the schedule has been turned off");
    expect(text).toContain(`${T0.toISOString()} (UTC)`);
    expect(dispatch).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("reports both an unconfirmed hand-off and its later Run failure under distinct Feishu identities", async () => {
    const value = await seed();
    await insertEverySchedule(value);
    const h = harness();
    const scheduler = makeScheduler(
      h.notifier,
      vi.fn(async () => ({ outcome: "unknown", code: "delivery_timeout" })),
    );
    await occurrence(scheduler, 0);
    expect(h.post).toHaveBeenCalledOnce();
    const missRequestId = (h.post.mock.calls[0] as unknown as [unknown, string, string])[2];

    // The hand-off in doubt had landed, and that Run now fails. Its report carries the same message.
    await db.database
      .insert(sessionMessages)
      .values({
        id: missRequestId,
        scheduledOrigin: {
          scheduleId: randomUUID(),
          scheduledFor: T0.toISOString(),
          timezone: "UTC",
          name: "Hourly check",
        },
        targetSessionId: value.sessionId,
        content: "Check the build.",
        contentHash: "a".repeat(64),
        lastOutcome: "unknown",
      })
      .onConflictDoNothing();
    await expect(h.notifier.notifyRunOutcome(report(value, missRequestId))).resolves.toBe("notified");
    expect(h.post).toHaveBeenCalledTimes(2);
    const failureRequestId = (h.post.mock.calls[1] as unknown as [unknown, string, string])[2];
    expect(failureRequestId).not.toBe(missRequestId);
    // Report retries keep one identity, so Feishu still drops a repeat of the failure itself.
    await h.notifier.notifyRunOutcome(report(value, missRequestId));
    expect((h.post.mock.calls[2] as unknown as [unknown, string, string])[2]).toBe(failureRequestId);
    await scheduler.stop();
  });

  it("posts once for a dispatch that keeps throwing, because the summary records the cause", async () => {
    const value = await seed();
    const scheduleId = await insertEverySchedule(value);
    const h = harness();
    const scheduler = makeScheduler(
      h.notifier,
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    await occurrence(scheduler, 0);
    expect(h.post).toHaveBeenCalledOnce();
    const [row] = await db.database.select().from(agentSchedules).where(eq(agentSchedules.id, scheduleId));
    expect(row?.lastDispatch).toMatchObject({ outcome: "unknown", code: "dispatch_failed" });
    await occurrence(scheduler, 1);
    await occurrence(scheduler, 2);
    expect(h.post).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it("stays quiet about a pause or edit, and about hand-offs a stopping Server aborted", async () => {
    const value = await seed();
    await insertEverySchedule(value);
    const h = harness();
    const scheduler = makeScheduler(
      h.notifier,
      vi.fn(async () => ({ outcome: "rejected", code: "schedule_disabled" })),
    );
    await occurrence(scheduler, 0);
    expect(h.post).not.toHaveBeenCalled();
    await scheduler.stop();

    const secondValue = await seed();
    await insertEverySchedule(secondValue);
    let release: (value: unknown) => void = () => undefined;
    const stopping = makeScheduler(
      h.notifier,
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    );
    currentTime = T0;
    await stopping.scanNow();
    const stop = stopping.stop();
    release({ outcome: "unreachable", code: "delivery_timeout" });
    await stop;
    expect(h.post).not.toHaveBeenCalled();
  });

  it("retries a missed notice a bounded number of times, then logs it", async () => {
    const value = await seed();
    const h = harness(vi.fn().mockRejectedValue(new FeedbackProviderError("IM_PROVIDER_CIRCUIT_OPEN", true, false, 5)));
    const occurrenceFacts = {
      agentId: value.agentId,
      name: "Hourly check",
      prompt: "Check the build.",
      scheduleId: randomUUID(),
      scheduledFor: T0.toISOString(),
      targetSessionId: value.sessionId,
      timezone: "UTC",
    };
    const input = { occurrence: occurrenceFacts, kind: "missed" as const, requestId: randomUUID() };
    await h.notifier.notifyMissed(input, new AbortController().signal);
    expect(h.post).toHaveBeenCalledTimes(3);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SCHEDULED_FAILURE_NOTICE_UNDELIVERED" }),
      expect.any(String),
    );

    h.post.mockClear();
    const aborted = new AbortController();
    aborted.abort();
    await h.notifier.notifyMissed(input, aborted.signal);
    expect(h.post).toHaveBeenCalledOnce();
  });
  it("sends and logs nothing for a miss on an internal Session, which has no conversation", async () => {
    const value = await seed();
    const internalId = randomUUID();
    const [visible] = await db.database.select().from(sessions).where(eq(sessions.id, value.sessionId));
    await db.database.insert(sessions).values({
      id: internalId,
      imBindingId: visible?.imBindingId as string,
      channelId: visible?.channelId as string,
      conversationKind: visible?.conversationKind as "dm",
      kind: "internal",
      createdBySessionId: value.sessionId,
    });
    const h = harness(vi.fn());
    const occurrenceFacts = {
      agentId: value.agentId,
      name: "Hourly check",
      prompt: "Check the build.",
      scheduleId: randomUUID(),
      scheduledFor: T0.toISOString(),
      targetSessionId: internalId,
      timezone: "UTC",
    };
    for (const kind of ["missed", "disabled"] as const) {
      await h.notifier.notifyMissed(
        { occurrence: occurrenceFacts, kind, requestId: randomUUID() },
        new AbortController().signal,
      );
    }
    expect(h.post).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });
});

describe("scheduledMissKind", () => {
  const previous = (outcome: string, code: string | null) =>
    ({ scheduledFor: T0.toISOString(), attemptedAt: null, messageId: null, outcome, code }) as never;

  it("treats a duplicate dispatcher (unknown without a code) as no failure", () => {
    expect(scheduledMissKind({ outcome: "unknown", code: null, previous: null })).toBeUndefined();
  });

  it("does not call an occurrence missed while the Server still holds it for delivery", () => {
    expect(scheduledMissKind({ outcome: "unknown", code: "delivery_held", previous: null })).toBeUndefined();
  });

  it("repeats for a new cause and for a new outcome", () => {
    expect(
      scheduledMissKind({ outcome: "unreachable", code: "client_busy", previous: previous("unreachable", "late") }),
    ).toBe("missed");
    expect(scheduledMissKind({ outcome: "unknown", code: "late", previous: previous("unreachable", "late") })).toBe(
      "unconfirmed",
    );
  });
});
