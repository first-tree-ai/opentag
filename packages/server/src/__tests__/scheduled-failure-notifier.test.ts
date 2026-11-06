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
import { scheduledMissKind } from "../services/schedules/scheduled-failure-notifier.js";
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
  const runOutcomes = { notifyRunOutcome: vi.fn(async () => "notified" as const) };
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
    expect(requestId).toBe(messageId);
    expect(text).toContain("failed before finishing");
    expect(text).toContain("Some of its work may already have happened");
    expect(text).toContain("2026-09-28 09:00:00 +08:00 (Asia/Shanghai)");
    expect(text).toContain("Code: provider_unavailable");
    expect(text).toContain(`Details: ${PUBLIC_URL}/`);
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
    expect(texts[0]).toContain("reached its maximum Run duration");
    expect(texts[1]).toContain("its result is unknown");

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
      runOutcomes: { notifyRunOutcome: vi.fn() },
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

async function insertEverySchedule(value: Seed, nextTriggerAt = T0): Promise<string> {
  const [row] = await db.database
    .insert(agentSchedules)
    .values({
      agentId: value.agentId,
      targetSessionId: value.sessionId,
      name: "Hourly check",
      prompt: "Check the build.",
      schedule: { kind: "every", intervalSeconds: 3600, anchorAt: T0.toISOString() },
      timezone: "UTC",
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
    expect(text).toContain('Scheduled task "Hourly check" did not run. The Agent never received it');
    expect(text).toContain("Code: configuration_unsupported");
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
    expect((h.post.mock.calls[1] as unknown as [unknown, string])[1]).toContain("Code: dispatch_failed");
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
    expect((h.post.mock.calls[0] as unknown as [unknown, string])[1]).toContain("Code: late");
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
      scheduleId: randomUUID(),
      scheduledFor: T0.toISOString(),
      targetSessionId: value.sessionId,
      timezone: "UTC",
    };
    const input = { occurrence: occurrenceFacts, kind: "missed" as const, code: "late", requestId: randomUUID() };
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
