import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DirectImMessageDeliveryRequest,
  RUNTIME_CAPABILITY,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
  type RuntimeImSteerRequest,
  type SessionMessageDeliveryRequestV3,
} from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult, AgentSteerOutcome, AgentSteerReceipt } from "../agent-runtime/types.js";
import { AdmissionController } from "../runtime/admission-controller.js";
import { AgentTurnRunner, buildRetryAgentInput } from "../runtime/agent-turn-runner.js";
import { InterruptedWorkRecovery } from "../runtime/interrupted-work-recovery.js";
import {
  MAX_AUTOMATIC_RETRIES,
  MAX_RECORDED_STEERS,
  nextRetry,
  RATE_LIMIT_RETRY_DELAY_MS,
  RETRY_RESET_AFTER_MS,
  RUN_TIME_RECORD_INTERVAL_MS,
  TurnRetryStore,
  trackRunTime,
  turnRetryRecord,
} from "../runtime/interruption-retry.js";
import { FileRuntimeDurabilityStore } from "../runtime/runtime-durability.js";
import type { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionMessageInbox } from "../runtime/session-message-inbox.js";
import type { SessionRuntimeManager } from "../runtime/session-runtime-manager.js";
import type { LiveTurnOwner, TurnCustodyOwner } from "../runtime/turn-custody-owner.js";
import type { TurnReportOwner } from "../runtime/turn-report-owner.js";

const TURN_ID = "turn-1";
/** The Turn's budget timer never fires on its own: a test expires it, so no test races it. */
const BUDGET_MS = 987_654;
const realSetTimeout = globalThis.setTimeout;
/** The 429 backoff is short here, unless a test needs to stop during it. */
let rateLimitDelayMs = 1;
const homes: string[] = [];
let expireBudget: () => void = () => undefined;

beforeEach(() => {
  rateLimitDelayMs = 1;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === RATE_LIMIT_RETRY_DELAY_MS) return realSetTimeout(handler, rateLimitDelayMs);
    // The Turn's budget timer: what is left of its budget.
    if (ms === undefined || ms > BUDGET_MS || ms < BUDGET_MS - RETRY_RESET_AFTER_MS) {
      return realSetTimeout(handler, ms, ...(rest as []));
    }
    expireBudget = handler;
    return realSetTimeout(() => undefined, 2_147_483_647).unref();
  }) as typeof setTimeout);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("a Session message steered into an IM Turn that retries in place", () => {
  it("joins the retry after a model HTTP 429 and settles with it", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "provider_rate_limited")).mockImplementationOnce(s.finishes);
    await s.startTurn();
    const message = s.message("do the steered thing");
    await s.steer(message);
    expect(s.inbox.getState(message.messageId)?.status).toBe("running");
    s.endAttempt();
    await s.runner.settled();

    expect(s.prompt).toHaveBeenCalledTimes(2);
    expect(s.promptText(1)).toContain("(automatic retry)");
    expect(s.promptText(1)).toContain("do the steered thing");
    expect(s.promptText(1)).toContain(`Message ID: ${message.messageId}`);
    expect(s.inbox.getState(message.messageId)?.status).toBe("succeeded");
    expect(s.onRunOutcome).not.toHaveBeenCalled();
    // Settled before the report, and never written to the Turn's durable retry input.
    expect(s.settledBeforeReport()).toBe(true);
    expect((await s.retries.read(s.request.sessionId))?.steers).toEqual([]);
    await s.stop();
  });

  it("fails with the Turn, without a retry, when the Turn reaches its duration limit", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout"));
    await s.startTurn();
    const message = s.message("steered");
    await s.steer(message);
    s.endAttempt();
    await s.runner.settled();
    expect(s.prompt).toHaveBeenCalledOnce();
    expect(s.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", errorReason: "turn_timeout" }),
      3,
    );
    expect(s.inbox.getState(message.messageId)?.status).toBe("failed");
    await s.stop();
  });

  it("keeps IM and Session messages in their original order", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "provider_rate_limited")).mockImplementationOnce(s.finishes);
    await s.startTurn();
    await expect(s.runner.steer(s.imSteer("im first"))).resolves.toMatchObject({ status: "steered" });
    await s.steer(s.message("session second"));
    await expect(s.runner.steer(s.imSteer("im third"))).resolves.toMatchObject({ status: "steered" });
    await s.steer(s.message("session fourth"));
    s.endAttempt();
    await s.runner.settled();
    const text = s.promptText(1);
    const positions = ["im first", "session second", "im third", "session fourth"].map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    await s.stop();
  });

  it("stays running until the retry ends, and runs only inside it", async () => {
    const s = await system();
    let endRetry: () => void = () => undefined;
    s.prompt.mockImplementationOnce(attempt(s, "provider_rate_limited")).mockImplementationOnce(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          endRetry = () => resolve({ runId: TURN_ID, status: "completed", output: [] });
        }),
    );
    await s.startTurn();
    const message = s.message("steered");
    await s.steer(message);
    s.endAttempt();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2));
    expect(s.inbox.getState(message.messageId)?.status).toBe("running");
    endRetry();
    await s.runner.settled();
    s.releaseTurn();
    await s.inbox.settled();
    expect(s.prompt).toHaveBeenCalledTimes(2);
    expect(s.inbox.getState(message.messageId)?.status).toBe("succeeded");
    await s.stop();
  });

  it("fails once when the Turn's retries run out", async () => {
    const s = await system();
    s.prompt
      .mockImplementationOnce(attempt(s, "provider_rate_limited"))
      .mockImplementationOnce(attempt(s, "provider_rate_limited"))
      .mockImplementationOnce(attempt(s, "provider_rate_limited"));
    await s.startTurn();
    const message = s.message("steered");
    await s.steer(message);
    for (const call of [1, 2, 3]) {
      await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(call));
      if (call > 1) expect(s.promptText(call - 1)).toContain("steered");
      await new Promise((resolve) => setTimeout(resolve, 0));
      s.endAttempt();
    }
    await s.runner.settled();
    expect(s.prompt).toHaveBeenCalledTimes(1 + MAX_AUTOMATIC_RETRIES);
    expect(s.inbox.getState(message.messageId)?.status).toBe("failed");
    expect(s.onRunOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ messageId: message.messageId, reason: "session_message_steer_interrupted" }),
    );
    await s.stop();
  });

  it("fails without a retry when the Turn's failure is not recoverable", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "provider_error"));
    await s.startTurn();
    const message = s.message("steered");
    await s.steer(message);
    s.endAttempt();
    await s.runner.settled();
    expect(s.prompt).toHaveBeenCalledOnce();
    expect(s.inbox.getState(message.messageId)?.status).toBe("failed");
    expect(s.onRunOutcome).toHaveBeenCalledOnce();
    await s.stop();
  });

  it("shares the Turn's count when steered into a retry", async () => {
    const s = await system();
    s.prompt
      .mockImplementationOnce(attempt(s, "provider_rate_limited"))
      .mockImplementationOnce(attempt(s, "provider_rate_limited"))
      .mockImplementationOnce(attempt(s, "provider_error"));
    await s.startTurn();
    s.endAttempt();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const late = s.message("into the retry");
    await s.steer(late);
    s.endAttempt();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(3));
    expect(s.promptText(2)).toContain("into the retry");
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.endAttempt();
    await s.runner.settled();
    expect(s.inbox.getState(late.messageId)?.status).toBe("failed");
    await s.stop();
  });

  it("returns to the FIFO instead of joining the retry when the provider never began it", async () => {
    const s = await system();
    s.steerOutcome = "not_started";
    s.prompt.mockImplementationOnce(attempt(s, "provider_rate_limited")).mockImplementation(s.finishes);
    await s.startTurn();
    const message = s.message("never began");
    await s.steer(message);
    s.endAttempt();
    await s.runner.settled();
    expect(s.promptText(1)).not.toContain("never began");
    s.releaseTurn();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(3));
    expect(s.promptText(2)).toContain("never began");
    await vi.waitFor(() => expect(s.inbox.getState(message.messageId)?.status).toBe("succeeded"));
    await s.stop();
  });

  it("succeeds when the Turn completes without a retry", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    const message = s.message("steered");
    await s.steer(message);
    s.endAttempt();
    await s.runner.settled();
    expect(s.prompt).toHaveBeenCalledOnce();
    expect(s.inbox.getState(message.messageId)?.status).toBe("succeeded");
    await s.stop();
  });

  it("fails the message when the Turn cannot retry at all", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "provider_rate_limited"));
    await s.startTurn();
    const message = s.message("steered");
    await s.steer(message);
    await s.retries.remove(s.request.sessionId);
    s.endAttempt();
    await s.runner.settled();
    expect(s.prompt).toHaveBeenCalledOnce();
    expect(s.inbox.getState(message.messageId)?.status).toBe("failed");
    await s.stop();
  });

  it("waits for a Session message still being steered when the Run ends", async () => {
    const s = await system();
    let releaseSteer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    s.runtime.steer.mockImplementationOnce(async () => {
      await held;
      return { outcome: Promise.resolve("interrupted" as const) };
    });
    s.prompt.mockImplementationOnce(attempt(s, "provider_rate_limited")).mockImplementationOnce(s.finishes);
    await s.startTurn();
    const message = s.message("in flight");
    await s.inbox.accept(message);
    await vi.waitFor(() => expect(s.runtime.steer).toHaveBeenCalledOnce());
    s.endAttempt();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.prompt).toHaveBeenCalledOnce();
    releaseSteer();
    await s.runner.settled();
    expect(s.promptText(1)).toContain("in flight");
    expect(s.inbox.getState(message.messageId)?.status).toBe("succeeded");
    await s.stop();
  });

  it("stays queued, unsteered, past the Turn's in-memory bound", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "completed")).mockImplementation(s.finishes);
    await s.startTurn();
    for (let index = 0; index < MAX_RECORDED_STEERS; index += 1) {
      expect(s.runner.reserveSessionMessage(s.message("filler"), TURN_ID)).toBe(true);
    }
    const message = s.message("overflow");
    await s.inbox.accept(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.runtime.steer).not.toHaveBeenCalled();
    expect(s.inbox.getState(message.messageId)?.status).toBe("accepted");
    await s.stop();
  });

  it("stays queued when the steer is refused, and runs after the Turn", async () => {
    const s = await system();
    s.runtime.steer.mockRejectedValue(new Error("run_mismatch"));
    s.prompt.mockImplementationOnce(attempt(s, "completed")).mockImplementation(s.finishes);
    await s.startTurn();
    const message = s.message("refused");
    await s.inbox.accept(message);
    await vi.waitFor(() => expect(s.runtime.steer).toHaveBeenCalled());
    expect(s.inbox.getState(message.messageId)?.status).toBe("accepted");
    s.endAttempt();
    await s.runner.settled();
    s.releaseTurn();
    await vi.waitFor(() => expect(s.inbox.getState(message.messageId)?.status).toBe("succeeded"));
    await s.stop();
  });

  it("cannot be reserved by a Turn that is not running or belongs to another Session", async () => {
    const s = await system();
    const message = s.message("x");
    expect(s.runner.reserveSessionMessage(message, "no-such-turn")).toBe(false);
    s.prompt.mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    expect(s.runner.reserveSessionMessage({ ...message, targetSessionId: randomUUID() }, TURN_ID)).toBe(false);
    s.endAttempt();
    await s.runner.settled();
    await s.stop();
  });

  it("follows its own receipt when acknowledged after the Turn was decided", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    const message = s.message("late");
    expect(s.runner.reserveSessionMessage(message, TURN_ID)).toBe(true);
    s.endAttempt();
    await s.runner.settled();
    const settle = vi.spyOn(s.inbox, "settleJoined");
    const receipt: AgentSteerReceipt = { outcome: Promise.resolve("processed") };
    s.runner.sessionMessageSteered(message, TURN_ID, receipt);
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith(message, "processed"));
    await s.stop();
  });
});

describe("the retry count shared by process interruptions and model 429", () => {
  const MINUTE = 60_000;

  it("allows two retries, resets after a retry that actually ran long, and stays exhausted", () => {
    expect(nextRetry({ count: 0, ranMs: 0 })).toEqual({ count: 1, exhausted: false });
    expect(nextRetry({ count: 1, ranMs: MINUTE })).toEqual({ count: 2, exhausted: false });
    expect(nextRetry({ count: 2, ranMs: RETRY_RESET_AFTER_MS - 1 })).toEqual({ count: 3, exhausted: true });
    expect(nextRetry({ count: 2, ranMs: RETRY_RESET_AFTER_MS })).toEqual({ count: 1, exhausted: false });
    // Once exhausted, nothing revives it.
    expect(nextRetry({ count: 3, ranMs: 100 * RETRY_RESET_AFTER_MS }).exhausted).toBe(true);
  });

  it("records run time periodically, keeps what could not be written, and reports the rest", async () => {
    vi.useFakeTimers();
    let now = 0;
    const record = vi.fn(async (_ranMs: number) => undefined);
    const clock = trackRunTime(() => now, record);
    now = RUN_TIME_RECORD_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(RUN_TIME_RECORD_INTERVAL_MS);
    expect(record).toHaveBeenCalledExactlyOnceWith(RUN_TIME_RECORD_INTERVAL_MS);
    record.mockRejectedValueOnce(new Error("disk full"));
    now = 2 * RUN_TIME_RECORD_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(RUN_TIME_RECORD_INTERVAL_MS);
    now = 2 * RUN_TIME_RECORD_INTERVAL_MS + 5;
    await expect(clock.finish()).resolves.toBe(RUN_TIME_RECORD_INTERVAL_MS + 5);
    now += RUN_TIME_RECORD_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(RUN_TIME_RECORD_INTERVAL_MS);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("does not count run time twice when a slow write fails across later ticks", async () => {
    vi.useFakeTimers();
    let now = 0;
    let failWrite: (error: Error) => void = () => undefined;
    const record = vi.fn(
      (_ranMs: number) =>
        new Promise<void>((_resolve, reject) => {
          failWrite = reject;
        }),
    );
    const clock = trackRunTime(() => now, record);
    now = RUN_TIME_RECORD_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(RUN_TIME_RECORD_INTERVAL_MS);
    // A later tick while the write is pending starts no second write.
    now = 2 * RUN_TIME_RECORD_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(RUN_TIME_RECORD_INTERVAL_MS);
    expect(record).toHaveBeenCalledOnce();
    failWrite(new Error("disk full"));
    now = 130_000;
    // Nothing was committed, so all 130 seconds are still to be recorded, and no more than that.
    await expect(clock.finish()).resolves.toBe(130_000);
  });

  it("waits for a slow write and then reports only what it did not cover", async () => {
    vi.useFakeTimers();
    let now = 0;
    let finishWrite: () => void = () => undefined;
    const record = vi.fn(
      (_ranMs: number) =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const clock = trackRunTime(() => now, record);
    now = RUN_TIME_RECORD_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(RUN_TIME_RECORD_INTERVAL_MS);
    now = 130_000;
    const finished = clock.finish();
    finishWrite();
    await expect(finished).resolves.toBe(130_000 - RUN_TIME_RECORD_INTERVAL_MS);
    expect(record).toHaveBeenCalledExactlyOnceWith(RUN_TIME_RECORD_INTERVAL_MS);
  });

  it("does not resume a Turn after a crash once its last 429 ran out of retries", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("steered");
    await first.steer(message);
    // The final 429 committed its count, then the daemon died before the failure was reported.
    await first.retries.update(first.request.sessionId, TURN_ID, (record) => ({
      ...record,
      retries: MAX_AUTOMATIC_RETRIES + 1,
      interruption: { reason: "provider_rate_limited", at: "T" },
    }));
    const second = await system({ home: first.home, request: first.request, prepared: false });
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.isPendingRetry(second.request.sessionId, TURN_ID)).toBe(false);
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(false);
    expect(second.prompt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("failed"));
    await second.stop();
    await first.stop();
  });

  it("still does not count a 429 twice when its retry is waiting", async () => {
    const first = await system();
    await first.retries.write({
      ...turnRetryRecord(first.request, TURN_ID),
      retries: MAX_AUTOMATIC_RETRIES,
      interruption: { reason: "provider_rate_limited", at: "T" },
    });
    const second = await system({ home: first.home, request: first.request, prepared: false });
    await second.inbox.ready();
    await second.recovery.start();
    expect(second.recovery.isPendingRetry(second.request.sessionId, TURN_ID)).toBe(true);
    expect((await second.retries.read(second.request.sessionId))?.retries).toBe(MAX_AUTOMATIC_RETRIES);
    await second.stop();
    await first.stop();
  });

  it("resumes after a crash during an in-place retry, with the message delivered again", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(attempt(first, "provider_rate_limited")).mockImplementationOnce(hangs(first));
    await first.startTurn();
    const carried = first.message("carried into the retry");
    await first.steer(carried);
    first.endAttempt();
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fresh = first.message("joined the retry");
    await first.steer(fresh);
    expect((await first.retries.read(first.request.sessionId))?.retries).toBe(1);

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(attempt(second, "completed"));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.runtime.steer).toHaveBeenCalledTimes(2));
    expect(second.steerText(0)).toContain("carried into the retry");
    expect(second.steerText(0)).toContain("Your previous turn was interrupted");
    expect(second.steerText(1)).toContain("joined the retry");
    expect((await second.retries.read(second.request.sessionId))?.retries).toBe(2);
    expect((await second.retries.read(second.request.sessionId))?.retryRanMs).toBe(0);
    second.endAttempt();
    await second.runner.settled();
    await vi.waitFor(() => expect(second.inbox.getState(fresh.messageId)?.status).toBe("succeeded"));
    expect(second.onRunOutcome).not.toHaveBeenCalled();
    await second.stop();
    await first.stop();
  });

  it("counts a crash and a 429 together, and fails the Turn and its message when they run out", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("steered before the crash");
    await first.steer(message);

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt
      .mockImplementationOnce(attempt(second, "provider_rate_limited"))
      .mockImplementationOnce(attempt(second, "provider_rate_limited"));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.runtime.steer).toHaveBeenCalledOnce());
    second.endAttempt();
    await vi.waitFor(() => expect(second.prompt).toHaveBeenCalledTimes(2));
    expect(second.promptText(1)).toContain("steered before the crash");
    await new Promise((resolve) => setTimeout(resolve, 0));
    second.endAttempt();
    await second.runner.settled();
    expect(second.prompt).toHaveBeenCalledTimes(2);
    expect(second.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", errorReason: "provider_rate_limited" }),
      3,
    );
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("failed"));
    await second.stop();
    await first.stop();
  });

  it("leaves a Turn for the restarted daemon when a stop interrupts its retry, instead of reporting", async () => {
    const first = await system({ restartRetry: true });
    first.prompt.mockImplementationOnce(attempt(first, "provider_rate_limited")).mockImplementationOnce(aborted);
    await first.startTurn();
    await first.steer(first.message("carried"));
    first.endAttempt();
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledTimes(2));
    first.inbox.stop();
    first.runner.stop();
    await first.runner.settled();
    expect(first.create).not.toHaveBeenCalled();

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(attempt(second, "completed"));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.runtime.steer).toHaveBeenCalledOnce());
    expect(second.promptText(0)).toContain("restarted or upgraded");
    expect(second.steerText(0)).toContain("the OpenTag daemon stopped (crash, power loss, restart, or upgrade)");
    second.endAttempt();
    await second.runner.settled();
    await second.stop();
    await first.stop();
  });

  it("keeps the 429 as the Turn's notice when the stop comes during its backoff", async () => {
    rateLimitDelayMs = 60_000;
    const first = await system({ restartRetry: true });
    first.prompt.mockImplementationOnce(attempt(first, "provider_rate_limited"));
    await first.startTurn();
    await first.steer(first.message("steered before the 429"));
    first.endAttempt();
    await vi.waitFor(async () =>
      expect((await first.retries.read(first.request.sessionId))?.interruption).toBeDefined(),
    );
    first.inbox.stop();
    first.runner.stop();
    await first.runner.settled();
    rateLimitDelayMs = 1;

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(attempt(second, "completed"));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.runtime.steer).toHaveBeenCalledOnce());
    expect(second.promptText(0)).toContain("HTTP 429");
    // The 429 was counted when it failed; the restart starts that retry without counting it again.
    expect((await second.retries.read(second.request.sessionId))?.retries).toBe(1);
    second.endAttempt();
    await second.runner.settled();
    await second.stop();
    await first.stop();
  });

  async function restartTurn(first: System, at: number) {
    const next = await system({ home: first.home, request: first.request, prepared: false, now: () => at });
    await next.inbox.ready();
    await next.recovery.start();
    const pending = next.recovery.isPendingRetry(next.request.sessionId, TURN_ID);
    return { next, pending };
  }

  /** What `resume` records when the retry begins. */
  function retryBegan(first: System, ranMs = 0) {
    return first.retries.update(first.request.sessionId, TURN_ID, ({ retryNotStarted: _waiting, ...record }) => ({
      ...record,
      retryRanMs: ranMs,
    }));
  }

  it("stops resuming a Turn after two retries in a row, and fails the messages steered into it", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const steered = first.message("steered");
    await first.steer(steered);
    first.runtime.state.phase = "idle";
    const queued = first.message("queued");
    await first.inbox.accept(queued);

    const daemons = [first];
    // Long outages between the restarts: none of it is run time, so the count does not reset.
    for (const at of [0, 60 * MINUTE]) {
      const { next, pending } = await restartTurn(first, at);
      daemons.push(next);
      expect(pending).toBe(true);
      await retryBegan(first);
    }
    const { next: last, pending } = await restartTurn(first, 120 * MINUTE);
    daemons.push(last);
    expect(pending).toBe(false);
    expect(last.inbox.getState(steered.messageId)?.status).toBe("failed");
    expect(last.inbox.getState(queued.messageId)?.status).toBe("accepted");
    expect(last.onRunOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ messageId: steered.messageId }),
    );
    // A later restart cannot revive it: its failure is being reported.
    const { next: later, pending: revived } = await restartTurn(first, 100 * MINUTE);
    daemons.push(later);
    expect(revived).toBe(false);
    for (const daemon of daemons) await daemon.stop();
  });

  it("keeps resuming a Turn whose retries actually run at least five minutes", async () => {
    const first = await system();
    await first.retries.write(turnRetryRecord(first.request, TURN_ID));
    const daemons = [first];
    for (const at of [0, 1, 2, 3, 4]) {
      const { next, pending } = await restartTurn(first, at);
      daemons.push(next);
      expect(pending).toBe(true);
      await retryBegan(first, RETRY_RESET_AFTER_MS);
    }
    for (const daemon of daemons) await daemon.stop();
  });

  it("leaves a resumed Turn only what is left of its Run budget", async () => {
    const first = await system();
    first.request.runtime.budget = { maxDurationMs: BUDGET_MS };
    const spent = RETRY_RESET_AFTER_MS - 1_000;
    await first.retries.write({ ...turnRetryRecord(first.request, TURN_ID), ranMs: spent });
    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(attempt(second, "completed"));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    const timer = vi.mocked(globalThis.setTimeout);
    timer.mockClear();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.prompt).toHaveBeenCalledOnce());
    expect(timer.mock.calls.map((call) => call[1])).toContain(BUDGET_MS - spent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    second.endAttempt();
    await second.runner.settled();
    await second.stop();
    await first.stop();
  });

  /** A daemon whose message's own Run is running when it is abandoned: a process interruption. */
  async function restartMessage(first: System, at: number) {
    const next = await system({ home: first.home, request: first.request, now: () => at });
    next.prompt.mockImplementation(aborted);
    await next.inbox.ready();
    return next;
  }

  it("fails a Session message running on its own after two retries in a row", async () => {
    const first = await system();
    first.prompt.mockImplementation(aborted);
    const message = first.message("crashes the daemon");
    await first.inbox.accept(message);
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalled());
    const daemons = [first];
    for (const at of [0, MINUTE]) {
      const next = await restartMessage(first, at);
      daemons.push(next);
      await vi.waitFor(() => expect(next.prompt).toHaveBeenCalled());
      expect(next.promptText(0)).toContain("Your previous turn was interrupted");
      expect(next.onRunOutcome).not.toHaveBeenCalled();
    }
    const last = await restartMessage(first, 2 * MINUTE);
    daemons.push(last);
    await vi.waitFor(() => expect(last.inbox.getState(message.messageId)?.status).toBe("failed"));
    expect(last.prompt).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(last.onRunOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "run_interrupted" })),
    );
    for (const daemon of daemons) await daemon.stop();
  });

  it("resets a Session message's count after a long retry", async () => {
    const first = await system();
    first.prompt.mockImplementation(aborted);
    const message = first.message("long task");
    await first.inbox.accept(message);
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalled());
    const daemons = [first];
    for (const at of [0, 1, 2, 3]) {
      const next = await restartMessage(first, at);
      daemons.push(next);
      await vi.waitFor(() => expect(next.prompt).toHaveBeenCalled());
      expect((await next.stored(message))?.attempts).toBe(1);
      // This retry ran long enough before the next interruption.
      await first.overwriteRecord(message, { retryRanMs: RETRY_RESET_AFTER_MS });
    }
    for (const daemon of daemons) await daemon.stop();
  });

  it("runs a steered message on its own with a fresh count when its Turn ended first", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("outlives the Turn");
    await first.steer(message);
    expect((await first.stored(message))?.joinedRunId).toBe(TURN_ID);

    // The Turn is gone after the restart: nothing resumes it.
    await first.retries.remove(first.request.sessionId);
    const second = await system({ home: first.home, request: first.request });
    second.prompt.mockImplementation(second.finishes);
    await second.inbox.ready();
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("succeeded"));
    expect(second.promptText(0)).toContain("Your previous turn was interrupted");
    expect(second.inbox.getState(message.messageId)?.attempts).toBe(0);
    await second.stop();
    await first.stop();
  });
});

describe("failing the messages of a Turn that ran out of retries", () => {
  async function exhausted(failWrites: number) {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("steered");
    await first.steer(message);
    await first.retries.update(first.request.sessionId, TURN_ID, (record) => ({
      ...record,
      retries: MAX_AUTOMATIC_RETRIES,
    }));
    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementation(second.finishes);
    await second.inbox.ready();
    second.failWrites(failWrites);
    return { first, second, message };
  }

  it("does not hold up startup, run the message, or report it until its failure is written", async () => {
    const { first, second, message } = await exhausted(1 + 2);
    // The retry record write takes one failure's place only if it comes first: it does not fail here.
    await second.recovery.start();
    await vi.waitFor(() => expect(second.writeFailures()).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("failed"), { timeout: 8_000 });
    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.onRunOutcome).toHaveBeenCalledOnce();
    expect(second.inbox.queuedCount).toBe(0);
    await second.stop();
    await first.stop();
  }, 12_000);

  it("reports nothing while the write fails, so a later daemon can run it without a false failure", async () => {
    const { first, second, message } = await exhausted(1_000);
    await second.recovery.start();
    await vi.waitFor(() => expect(second.writeFailures()).toBeGreaterThanOrEqual(1));
    expect(second.onRunOutcome).not.toHaveBeenCalled();
    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.inbox.getState(message.messageId)?.status).toBe("retryable");
    expect(second.inbox.queuedCount).toBe(1);
    await second.stop();

    // The root Turn settled meanwhile. The next daemon finds no retry record, so the Turn ended first.
    await second.retries.remove(second.request.sessionId);
    const third = await system({ home: first.home, request: first.request });
    third.prompt.mockImplementation(third.finishes);
    await third.inbox.ready();
    await vi.waitFor(() => expect(third.inbox.getState(message.messageId)?.status).toBe("succeeded"));
    expect(third.prompt).toHaveBeenCalledOnce();
    expect(third.onRunOutcome).not.toHaveBeenCalled();
    await third.stop();
    await first.stop();
  });
});

describe("Session messages after a crash or restart", () => {
  it("steers earlier and queued messages into the resumed Turn in order, saying which may be repeats", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const earlier = first.message("steered before the crash");
    await first.steer(earlier);
    const earlierToo = first.message("also steered before the crash");
    await first.steer(earlierToo);
    first.runtime.state.phase = "idle";
    const queued = first.message("queued before the crash");
    await first.inbox.accept(queued);

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(attempt(second, "completed"));
    await second.inbox.ready();
    await second.recovery.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.runtime.steer).not.toHaveBeenCalled();

    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.runtime.steer).toHaveBeenCalledTimes(3));
    expect(second.promptText(0)).toContain("Your previous turn was interrupted");
    expect(second.promptText(0)).not.toContain("steered before the crash");
    const steered = [0, 1, 2].map((call) => second.steerText(call));
    expect(steered[0]).toContain("steered before the crash");
    expect(steered[0]).toContain("Your previous turn was interrupted");
    expect(steered[1]).toContain("also steered before the crash");
    expect(steered[1]).toContain("Your previous turn was interrupted");
    expect(steered[2]).toContain("queued before the crash");
    expect(steered[2]).not.toContain("Your previous turn was interrupted");

    second.endAttempt();
    await second.runner.settled();
    await vi.waitFor(() => expect(second.inbox.getState(queued.messageId)?.status).toBe("succeeded"));
    expect(second.inbox.getState(earlier.messageId)?.status).toBe("succeeded");
    second.releaseTurn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.prompt).toHaveBeenCalledOnce();
    await second.stop();
    await first.stop();
  });

  it("fails a message steered into the resumed Turn when that Turn fails, without running it again", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("steered");
    await first.steer(message);

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(attempt(second, "provider_error"));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.runtime.steer).toHaveBeenCalledOnce());
    second.endAttempt();
    await second.runner.settled();
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("failed"));
    second.releaseTurn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.prompt).toHaveBeenCalledOnce();
    expect(second.onRunOutcome).toHaveBeenCalledOnce();
    await second.stop();
    await first.stop();
  });

  it("runs the message on its own, with the notice, after the resumed Turn when the runtime cannot steer", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("steered");
    await first.steer(message);

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.runtime.capabilities.steer = "unsupported";
    second.prompt.mockImplementationOnce(attempt(second, "completed")).mockImplementation(second.finishes);
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.prompt).toHaveBeenCalledOnce());
    second.endAttempt();
    await second.runner.settled();
    expect(second.inbox.getState(message.messageId)?.status).not.toBe("succeeded");
    second.releaseTurn();
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("succeeded"));
    expect(second.prompt).toHaveBeenCalledTimes(2);
    expect(second.promptText(1)).toContain("Your previous turn was interrupted");
    expect(second.promptText(1)).toContain("steered");
    await second.stop();
    await first.stop();
  });
});

describe("a Turn whose joined messages meet other paths", () => {
  it("orders messages without a recorded arrival first", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "provider_rate_limited")).mockImplementationOnce(s.finishes);
    await s.startTurn();
    const recorded = s.imSteer("already in the record");
    s.receipts.push({ kind: "steer", deliveryId: recorded.deliveryId, turnId: TURN_ID });
    await s.retries.write({ ...turnRetryRecord(s.request, TURN_ID), steers: [recorded] });
    await s.steer(s.message("joined later"));
    s.endAttempt();
    await s.runner.settled();
    const text = s.promptText(1);
    expect(text.indexOf("already in the record")).toBeLessThan(text.indexOf("joined later"));
    await s.stop();
  });

  it("fails a message the provider processed when the Turn's own result is a failure", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(async (_input) => {
      s.emit({ type: "run_started", runId: TURN_ID });
      await new Promise<void>((resolve) => {
        s.endAttempt = resolve;
      });
      s.runEnded("processed");
      return {
        runId: TURN_ID,
        status: "completed",
        output: [{ type: "text", text: "x".repeat(RUNTIME_FINAL_TEXT_MAX_BYTES + 1) }],
      };
    });
    await s.startTurn();
    const message = s.message("steered");
    await s.steer(message);
    s.endAttempt();
    await s.runner.settled();
    expect(s.inbox.getState(message.messageId)?.status).toBe("failed");
    await s.stop();
  });

  it("settles a message acknowledged while the Turn is reporting by its own receipt", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    const message = s.message("late");
    expect(s.runner.reserveSessionMessage(message, TURN_ID)).toBe(true);
    const settle = vi.spyOn(s.inbox, "settleJoined");
    s.create.mockImplementationOnce((input) => {
      s.runner.sessionMessageSteered(message, TURN_ID, { outcome: Promise.resolve("processed") });
      return { ...input, type: "turn:report" as const, requestId: randomUUID(), resultHash: "c".repeat(64) };
    });
    s.endAttempt();
    await s.runner.settled();
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith(message, "processed"));
    // Releasing again, or a message that never held a place, is harmless.
    s.runner.releaseSessionMessage(message, TURN_ID);
    await s.stop();
  });

  it("releases a place while the Turn is still running without leaving it in flight", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    const message = s.message("x");
    s.runner.reserveSessionMessage(message, TURN_ID);
    s.runner.releaseSessionMessage(message, TURN_ID);
    s.runner.releaseSessionMessage(message, TURN_ID);
    s.endAttempt();
    await s.runner.settled();
    await s.stop();
  });

  it("fails a retry that must carry a message with no owner to build its input", async () => {
    const s = await system({ withoutOwner: true });
    s.prompt.mockImplementationOnce(attempt(s, "provider_rate_limited"));
    await s.startTurn();
    const message = s.message("nobody owns this");
    expect(s.runner.reserveSessionMessage(message, TURN_ID)).toBe(true);
    s.runner.sessionMessageSteered(message, TURN_ID, { outcome: Promise.resolve("interrupted") });
    s.endAttempt();
    await s.runner.settled();
    expect(s.prompt).toHaveBeenCalledOnce();
    expect(s.create).toHaveBeenCalledOnce();
    await s.stop();
  });
});

describe("the input of a Session message in a retry", () => {
  it("refuses to render a Session message without its owner", () => {
    const request = imDelivery();
    expect(() =>
      buildRetryAgentInput(
        request,
        [sessionMessage(request, "x")],
        { reason: "provider_rate_limited", at: "T" },
        new Date(0),
      ),
    ).toThrow("without an owner");
  });

  it("is built for the retry's live execution, or refused without an outbox target", async () => {
    const s = await system({ sessionKind: "visible" });
    const message = s.message("visible");
    expect(() => s.inbox.joinedRunInput(message, new Date(0))).toThrow("no outbox context");
    s.outbox.current = {
      provider: "slack",
      sessionKind: "channel",
      imBindingId: "binding-1",
      externalChatId: "channel-1",
    } as never;
    expect(s.inbox.joinedRunInput(message, new Date(0)).items.at(-1)).toMatchObject({ text: "visible" });
    await s.stop();
  });
});

/** One attempt of the Turn. A timeout comes from the Turn's real budget; others end on `endAttempt`. */
function attempt(s: System, ending: "turn_timeout" | "provider_rate_limited" | "provider_error" | "completed") {
  return (input: { signal?: AbortSignal }): Promise<AgentRunResult> => {
    s.emit({ type: "run_started", runId: TURN_ID });
    return new Promise<AgentRunResult>((resolve) => {
      const finish = (result: AgentRunResult) => {
        s.runEnded(result.status === "completed" ? "processed" : "interrupted");
        resolve(result);
      };
      if (ending === "turn_timeout") {
        input.signal?.addEventListener("abort", () => finish({ runId: TURN_ID, status: "aborted", output: [] }), {
          once: true,
        });
        s.endAttempt = () => expireBudget();
      } else if (ending === "completed") {
        s.endAttempt = () => finish({ runId: TURN_ID, status: "completed", output: [] });
      } else {
        s.endAttempt = () =>
          finish({ runId: TURN_ID, status: "failed", output: [], error: { code: ending, message: ending } as never });
      }
    });
  };
}

/** A Run the process dies under: it started and never ends. */
function hangs(s: System) {
  return (): Promise<AgentRunResult> => {
    s.emit({ type: "run_started", runId: TURN_ID });
    return new Promise<AgentRunResult>(() => undefined);
  };
}

function aborted(input: { signal?: AbortSignal }): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    input.signal?.addEventListener("abort", () => resolve({ runId: TURN_ID, status: "aborted", output: [] }), {
      once: true,
    });
  });
}

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-joined-retry-"));
  homes.push(home);
  return home;
}

type System = Awaited<ReturnType<typeof system>>;

async function system(
  options: {
    home?: string;
    request?: DirectImMessageDeliveryRequest;
    prepared?: boolean;
    restartRetry?: boolean;
    now?: () => number;
    withoutOwner?: boolean;
    sessionKind?: "internal" | "visible";
  } = {},
) {
  const home = options.home ?? (await newHome());
  const request = options.request ?? imDelivery();
  const admission = new AdmissionController();
  const retries = new TurnRetryStore(home);
  const durable = new FileRuntimeDurabilityStore(home);
  let failingWrites = 0;
  let writeFailures = 0;
  const persistence = {
    list: durable.list.bind(durable),
    write: async (record: Parameters<FileRuntimeDurabilityStore["write"]>[0]) => {
      if (failingWrites > 0) {
        failingWrites -= 1;
        writeFailures += 1;
        throw new Error("disk full");
      }
      await durable.write(record);
    },
  } as unknown as FileRuntimeDurabilityStore;
  const outbox: { current: unknown } = { current: undefined };
  let prepared = options.prepared ?? true;
  let sink: ((event: unknown) => Promise<void> | void) | undefined;
  let runEnded: (outcome: AgentSteerOutcome) => void = () => undefined;
  const runEnd = new Promise<AgentSteerOutcome>((resolve) => {
    runEnded = resolve;
  });
  const fixture = { steerOutcome: undefined as AgentSteerOutcome | undefined };
  const prompt = vi.fn(
    async (_input: { signal?: AbortSignal; input?: unknown }): Promise<AgentRunResult> => ({
      runId: TURN_ID,
      status: "completed",
      output: [],
    }),
  );
  const runtime = {
    capabilities: { steer: "supported" },
    state: { phase: "running", activeRunId: TURN_ID as string | undefined },
    prompt,
    waitForIdle: async () => undefined,
    steer: vi.fn(
      async (_input: unknown): Promise<AgentSteerReceipt> => ({
        outcome: runEnd.then((outcome) => fixture.steerOutcome ?? outcome),
      }),
    ),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const onRunOutcome = vi.fn();
  const order: string[] = [];
  const receipts: Array<{ kind: "steer"; deliveryId: string; turnId: string }> = [];
  const bindingRead = vi.fn(async () => ({
    recentRecordedInputs: receipts,
    unresolvedTurn: { turnId: TURN_ID, deliveryId: request.deliveryId, phase: "running" },
  }));
  const inbox = new SessionMessageInbox({
    admission,
    credentialEnvironment: {
      cleanup: async () => undefined,
      prepare: async () => {
        throw new Error("Internal Sessions must not prepare provider credentials");
      },
      outboxContextForSession: () => outbox.current as never,
    },
    imCredentialGrantVersion: () => 2,
    joinableRuns: {
      reserve: (message, runId) => runner.reserveSessionMessage(message, runId),
      release: (message, runId) => runner.releaseSessionMessage(message, runId),
      steered: (message, runId, receipt) => runner.sessionMessageSteered(message, runId, receipt),
    },
    logger,
    onRunOutcome,
    persistence,
    reconciler: {
      checkSessionMessageDelivery: () => undefined,
      clearActivity: () => true,
      setActivity: () => undefined,
      withAgentLock: async <T>(_agentId: string, task: () => Promise<T>) => task(),
    },
    runtimeManager: {
      ensureRuntime: vi.fn(async () => runtime as never),
      isPrepared: () => prepared,
      runtime: vi.fn(() => runtime as never),
      sessionKind: vi.fn(() => options.sessionKind ?? ("internal" as const)),
    },
    sessionCollaborationVersion: () => 4,
    steerRetryMs: 5,
    rateLimitRetryDelayMs: 1,
    ...(options.now ? { now: options.now } : {}),
  });
  const create = vi.fn((input: Parameters<TurnReportOwner["create"]>[0]) => {
    order.push("report");
    return { ...input, type: "turn:report" as const, requestId: randomUUID(), resultHash: "c".repeat(64) };
  });
  const runner = new AgentTurnRunner({
    bindingStore: {
      updateUnresolved: vi.fn(async () => undefined),
      getSteerReceipt: vi.fn(async () => undefined),
      recordSteer: vi.fn(async (steer: RuntimeImSteerRequest) => {
        receipts.push({ kind: "steer", deliveryId: steer.deliveryId, turnId: steer.expectedTurnId });
      }),
      read: bindingRead,
    } as unknown as SessionBindingStore,
    connection: { send: vi.fn(async () => undefined), capabilityVersion: () => 3 },
    custody: { markReporting: vi.fn(async () => undefined), recordResult: vi.fn() } as unknown as TurnCustodyOwner,
    reportOwner: { create, submit: vi.fn(async () => undefined) } as unknown as TurnReportOwner,
    runtimeManager: {
      sessionKind: () => "internal",
      providerId: () => "codex",
      ensureRuntime: async () => runtime,
      observe: (_sessionId: string, next: (event: unknown) => Promise<void> | void) => {
        sink = next;
        return () => {
          sink = undefined;
        };
      },
    } as unknown as SessionRuntimeManager,
    credentialEnvironment: {
      prepare: vi.fn(async () => ({ path: "/tmp/provider-env.sh" })),
      cleanup: vi.fn(async () => undefined),
    },
    logger: logger as never,
    retries,
    restartRetryAvailable: () => options.restartRetry === true,
    ...(options.withoutOwner
      ? {}
      : {
          sessionMessages: {
            input: (message: SessionMessageDeliveryRequestV3, processedAt: Date) =>
              inbox.joinedRunInput(message, processedAt),
            settle: async (message: SessionMessageDeliveryRequestV3, outcome: AgentSteerOutcome) => {
              await inbox.settleJoined(message, outcome);
              order.push("settled");
            },
          },
        }),
  });
  let reservation: { release(): void } | undefined;
  const start = (startOptions?: Parameters<AgentTurnRunner["start"]>[1]) => {
    const held = admission.reserve(request.sessionId, request.agentId, { acceptedWork: true });
    if (!held.accepted) throw new Error("reservation");
    held.reservation.markActive();
    reservation = held.reservation;
    runner.start(
      { inputHash: "a".repeat(64), request, reservation: held.reservation, turnId: TURN_ID } as LiveTurnOwner,
      startOptions,
    );
  };
  const recovery = new InterruptedWorkRecovery({
    bindingStore: { read: bindingRead as never },
    connection: {
      capabilityVersion: (capability) => (capability === RUNTIME_CAPABILITY.sessionRecovery ? 1 : undefined),
      send: vi.fn(async () => undefined),
      subscribeState: () => () => undefined,
    },
    custody: {
      resume: ((_request: unknown, _turnId: unknown, resumeOptions: Parameters<AgentTurnRunner["start"]>[1]) => {
        start(resumeOptions);
        return true;
      }) as never,
    },
    inbox,
    logger: { info: vi.fn(), warn: vi.fn() },
    ...(options.now ? { now: options.now } : {}),
    reconciler: { setRecovery: vi.fn(), clearRecovery: vi.fn(() => true) },
    retries,
  });
  const s = {
    home,
    request,
    identity: { deliveryId: request.deliveryId, turnId: TURN_ID },
    inbox,
    runner,
    runtime,
    retries,
    recovery,
    prompt,
    logger,
    create,
    receipts,
    onRunOutcome,
    outbox,
    writeFailures: () => writeFailures,
    stored: async (message: SessionMessageDeliveryRequestV3) =>
      (await durable.list("session-message")).find(
        (record) => record.key === `${message.targetSessionId}:${message.messageId}`,
      ),
    get steerOutcome() {
      return fixture.steerOutcome;
    },
    set steerOutcome(value: AgentSteerOutcome | undefined) {
      fixture.steerOutcome = value;
    },
    endAttempt: (): void => undefined,
    runEnded,
    emit: (event: unknown) => void sink?.(event),
    prepare: () => {
      prepared = true;
    },
    failNextWrite: () => {
      failingWrites = 1;
    },
    failWrites: (count: number) => {
      failingWrites = count;
    },
    settledBeforeReport: () => order.includes("settled") && order.indexOf("settled") < order.indexOf("report"),
    message: (text: string) => sessionMessage(request, text),
    imSteer: (text: string): RuntimeImSteerRequest =>
      ({
        type: "im:steer",
        requestId: randomUUID(),
        deliveryId: randomUUID(),
        imMessageId: randomUUID(),
        rootDeliveryId: request.deliveryId,
        expectedTurnId: TURN_ID,
        sessionId: request.sessionId,
        agentId: request.agentId,
        placementGeneration: request.placementGeneration,
        attention: "direct",
        content: { ...request.content, text },
      }) as RuntimeImSteerRequest,
    finishes: async (): Promise<AgentRunResult> => ({ runId: TURN_ID, status: "completed", output: [] }),
    promptText: (call: number) => itemsText(prompt.mock.calls[call]?.[0], `prompt ${call}`),
    steerText: (call: number) => itemsText(runtime.steer.mock.calls[call]?.[0], `steer ${call}`),
    startTurn: async () => {
      await inbox.ready();
      await retries.write(turnRetryRecord(request, TURN_ID));
      request.runtime.budget = { maxDurationMs: BUDGET_MS };
      start();
      await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    steer: async (message: SessionMessageDeliveryRequestV3) => {
      expect((await inbox.accept(message)).status).toBe("accepted");
      await vi.waitFor(() => expect(inbox.getState(message.messageId)?.status).toBe("running"));
    },
    overwriteRecord: async (message: SessionMessageDeliveryRequestV3, fields: Record<string, unknown>) => {
      const stored = (await durable.list("session-message")).find(
        (record) => record.key === `${message.targetSessionId}:${message.messageId}`,
      );
      if (stored) await durable.write({ ...stored, ...fields });
    },
    releaseTurn: () => reservation?.release(),
    stop: async () => {
      inbox.stop();
      runner.stop();
      recovery.stop();
      await inbox.settled();
    },
  };
  return s;
}

function itemsText(call: unknown, name: string): string {
  const argument = call as { input: { items: Array<{ text: string }> } } | undefined;
  if (!argument) throw new Error(`${name} is missing`);
  return argument.input.items.map((item) => item.text).join("\n");
}

function sessionMessage(root: DirectImMessageDeliveryRequest, text: string): SessionMessageDeliveryRequestV3 {
  return {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId: root.sessionId,
    agentId: root.agentId,
    placementGeneration: 1,
    runtime: {
      contextTrees: [],
      revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
      agentId: root.agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: root.agentId, mode: "empty_on_create", sharing: "agent" },
    },
    content: { kind: "text", text },
  } as SessionMessageDeliveryRequestV3;
}

function imDelivery(): DirectImMessageDeliveryRequest {
  const agentId = randomUUID();
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    sessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "team-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
    },
    runtime: {
      contextTrees: [],
      revision: { agent: { sequence: 1, id: "agent-revision" }, session: { sequence: 1, id: "session-revision" } },
      agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    },
  } as DirectImMessageDeliveryRequest;
}
