import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type SessionMessageOutcomeReport } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConnectionState } from "../runtime/runtime-connection.js";
import { MemoryRuntimeDurabilityStore } from "../runtime/runtime-durability.js";
import {
  type SessionMessageOutcomeInput,
  SessionMessageOutcomeReporter,
} from "../runtime/session-message-outcome-reporter.js";

function fakeConnection(version: number | undefined, state: RuntimeConnectionState = "registered") {
  const sent: SessionMessageOutcomeReport[] = [];
  const listeners = new Set<(state: RuntimeConnectionState) => void>();
  const connection = {
    state,
    version,
    capabilityVersion: vi.fn((capability: string) =>
      capability === RUNTIME_CAPABILITY.sessionCollaboration ? connection.version : undefined,
    ),
    send: vi.fn(async (frame: unknown) => {
      sent.push(frame as SessionMessageOutcomeReport);
    }),
    subscribeState(listener: (state: RuntimeConnectionState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(next: RuntimeConnectionState) {
      connection.state = next;
      for (const listener of listeners) listener(next);
    },
  };
  return { connection, sent };
}

function manualScheduler() {
  const tasks: { delay: number; task: () => void; cancelled: boolean }[] = [];
  return {
    tasks,
    schedule(delay: number, task: () => void) {
      const entry = { delay, task, cancelled: false };
      tasks.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
    /** Run the pending tasks scheduled with the given delay predicate. */
    run(predicate: (delay: number) => boolean) {
      for (const entry of tasks.splice(0)) {
        if (!entry.cancelled && predicate(entry.delay)) entry.task();
        else if (!entry.cancelled) tasks.push(entry);
      }
    },
  };
}

function outcome(overrides: Partial<SessionMessageOutcomeInput> = {}): SessionMessageOutcomeInput {
  return {
    messageId: randomUUID(),
    targetSessionId: randomUUID(),
    agentId: randomUUID(),
    placementGeneration: 1,
    outcome: "timed_out",
    reason: "turn_timeout",
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SessionMessageOutcomeReporter", () => {
  it("sends one report on a v4 connection and finalizes it on a notified answer", async () => {
    const { connection, sent } = fakeConnection(4);
    const persistence = new MemoryRuntimeDurabilityStore();
    const reporter = new SessionMessageOutcomeReporter({ connection, persistence, scheduler: manualScheduler() });
    const input = outcome();
    await reporter.report(input);
    await reporter.report(input);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "session:message:outcome", ...input });
    expect(reporter.pendingCount).toBe(1);

    reporter.handleResult({
      type: "session:message:outcome:result",
      requestId: sent[0]?.requestId ?? "",
      messageId: input.messageId,
      status: "notified",
    });
    await flush();
    expect(reporter.pendingCount).toBe(0);
    expect((await persistence.list("session-message-outcome"))[0]).toMatchObject({ status: "succeeded" });
    reporter.stop();
  });

  it("never sends the frame to a peer below collaboration v4 and keeps the report pending", async () => {
    const { connection, sent } = fakeConnection(3);
    const scheduler = manualScheduler();
    const reporter = new SessionMessageOutcomeReporter({ connection, scheduler });
    await reporter.report(outcome());
    await flush();
    expect(sent).toHaveLength(0);
    expect(reporter.pendingCount).toBe(1);
    // After an upgrade the next registration sends it.
    connection.version = 4;
    connection.emit("registered");
    await flush();
    expect(sent).toHaveLength(1);
    reporter.stop();
  });

  it("resends with a fresh correlation id after a retry answer and ignores stale answers", async () => {
    const { connection, sent } = fakeConnection(4);
    const scheduler = manualScheduler();
    const reporter = new SessionMessageOutcomeReporter({ connection, scheduler });
    const input = outcome();
    await reporter.report(input);
    const first = sent[0]?.requestId ?? "";
    reporter.handleResult({
      type: "session:message:outcome:result",
      requestId: first,
      messageId: input.messageId,
      status: "retry",
    });
    await flush();
    scheduler.run((delay) => delay < 120_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.requestId).not.toBe(first);
    // The answer to the superseded send cannot finalize the report.
    reporter.handleResult({
      type: "session:message:outcome:result",
      requestId: first,
      messageId: input.messageId,
      status: "notified",
    });
    await flush();
    expect(reporter.pendingCount).toBe(1);
    reporter.handleResult({
      type: "session:message:outcome:result",
      requestId: sent[1]?.requestId ?? "",
      messageId: input.messageId,
      status: "ignored",
    });
    await flush();
    expect(reporter.pendingCount).toBe(0);
    reporter.stop();
  });

  it("resends after an acknowledgement timeout", async () => {
    const { connection, sent } = fakeConnection(4);
    const scheduler = manualScheduler();
    const reporter = new SessionMessageOutcomeReporter({ connection, scheduler });
    await reporter.report(outcome());
    scheduler.run((delay) => delay === 120_000);
    await flush();
    scheduler.run((delay) => delay < 120_000);
    expect(sent).toHaveLength(2);
    reporter.stop();
  });

  it("recovers pending durable reports after restart and leaves final ones alone", async () => {
    const persistence = new MemoryRuntimeDurabilityStore();
    const pending = outcome();
    const done = outcome();
    const now = Date.now();
    await persistence.write({
      acceptedAt: now,
      attempts: 1,
      key: `${pending.targetSessionId}:${pending.messageId}`,
      kind: "session-message-outcome",
      payload: pending,
      status: "retryable",
      updatedAt: now,
    });
    await persistence.write({
      acceptedAt: now,
      attempts: 0,
      key: `${done.targetSessionId}:${done.messageId}`,
      kind: "session-message-outcome",
      payload: done,
      status: "succeeded",
      updatedAt: now,
    });
    const { connection, sent } = fakeConnection(4);
    const reporter = new SessionMessageOutcomeReporter({ connection, persistence, scheduler: manualScheduler() });
    await reporter.ready();
    expect(sent.map((frame) => frame.messageId)).toEqual([pending.messageId]);
    reporter.stop();
  });

  it("still sends a report it could not persist but rejects so the caller keeps its intent", async () => {
    const { connection, sent } = fakeConnection(4);
    const persistence = new MemoryRuntimeDurabilityStore();
    vi.spyOn(persistence, "write").mockRejectedValueOnce(new Error("disk full"));
    const reporter = new SessionMessageOutcomeReporter({
      connection,
      logger: { warn: vi.fn() },
      persistence,
      scheduler: manualScheduler(),
    });
    const report = outcome();
    await expect(reporter.report(report)).rejects.toThrow("disk full");
    expect(sent.map((frame) => frame.messageId)).toEqual([report.messageId]);
    // A repeated hand-off in the same process is already known and resolves without resending.
    await expect(reporter.report(report)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    reporter.stop();
  });

  it("rejects a report after stop", async () => {
    const { connection, sent } = fakeConnection(4);
    const reporter = new SessionMessageOutcomeReporter({ connection, scheduler: manualScheduler() });
    reporter.stop();
    await expect(reporter.report(outcome())).rejects.toThrow("stopped");
    expect(sent).toEqual([]);
  });

  it("still attempts a report that aged past the limit while the Computer was off", async () => {
    const now = 1_000 + 25 * 60 * 60 * 1_000;
    const persistence = new MemoryRuntimeDurabilityStore();
    await persistence.write({
      acceptedAt: 1_000,
      attempts: 0,
      key: "target:message",
      kind: "session-message-outcome",
      payload: {
        messageId: randomUUID(),
        targetSessionId: randomUUID(),
        agentId: randomUUID(),
        placementGeneration: 1,
        outcome: "failed",
        reason: "provider_failed",
      },
      status: "accepted",
      updatedAt: 1_000,
    } as never);
    const send = vi.fn(async () => undefined);
    const reporter = new SessionMessageOutcomeReporter({
      connection: {
        state: "registered",
        capabilityVersion: () => 4,
        send,
        subscribeState: () => () => undefined,
      } as never,
      now: () => now,
      persistence,
    });
    await reporter.ready();
    expect(send).toHaveBeenCalledOnce();
    expect((await persistence.list("session-message-outcome"))[0]?.status).not.toBe("dead-letter");
    reporter.stop();
  });

  it("keeps retrying with the default policy until one day has passed", async () => {
    const day = 24 * 60 * 60 * 1_000;
    let now = 0;
    const warn = vi.fn();
    // A registered v3 peer answers every attempt with an immediate back-off, the fastest path to the attempt count.
    const { connection } = fakeConnection(3);
    const scheduler = manualScheduler();
    const persistence = new MemoryRuntimeDurabilityStore();
    const reporter = new SessionMessageOutcomeReporter({
      connection,
      logger: { warn },
      now: () => now,
      persistence,
      scheduler,
    });
    await reporter.report(outcome());
    await flush();
    const deadline = day - 60_000;
    let retries = 0;
    for (;;) {
      const next = scheduler.tasks.find((entry) => !entry.cancelled);
      if (!next || now + next.delay > deadline) break;
      scheduler.tasks.splice(scheduler.tasks.indexOf(next), 1);
      now += next.delay;
      next.task();
      await flush();
      retries += 1;
    }
    // 23h59m in: well past any 200-attempt cap, still pending and not dead-lettered.
    expect(retries).toBeGreaterThan(200);
    expect(reporter.pendingCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    const [stored] = await persistence.list("session-message-outcome");
    expect(stored?.status).toBe("retryable");

    now = day;
    scheduler.run(() => true);
    await flush();
    expect(reporter.pendingCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_MESSAGE_OUTCOME_UNDELIVERED" }),
      expect.any(String),
    );
    expect((await persistence.list("session-message-outcome"))[0]?.status).toBe("dead-letter");
    reporter.stop();
  });

  it("gives up on a custom attempt cap before the retry age", async () => {
    let now = 0;
    const warn = vi.fn();
    const { connection } = fakeConnection(3);
    const scheduler = manualScheduler();
    const reporter = new SessionMessageOutcomeReporter({
      connection,
      logger: { warn },
      now: () => now,
      retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2, maxAgeMs: 24 * 60 * 60 * 1_000 },
      scheduler,
    });
    await reporter.report(outcome());
    await flush();
    expect(reporter.pendingCount).toBe(1);
    now = 10;
    scheduler.run(() => true);
    await flush();
    expect(reporter.pendingCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_MESSAGE_OUTCOME_UNDELIVERED" }),
      expect.any(String),
    );
    reporter.stop();
  });
});
