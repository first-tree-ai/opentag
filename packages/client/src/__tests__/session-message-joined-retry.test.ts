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
import { MAX_RECORDED_STEERS, TurnRetryStore, turnRetryRecord } from "../runtime/interruption-retry.js";
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
const homes: string[] = [];
let expireBudget: () => void = () => undefined;

beforeEach(() => {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== BUDGET_MS) return realSetTimeout(handler, ms, ...(rest as []));
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
  it.each([
    ["the Run timeout", "turn_timeout"],
    ["a model HTTP 429", "provider_rate_limited"],
  ] as const)("joins the one retry after %s and settles with it", async (_name, reason) => {
    const s = await system();
    if (reason === "provider_rate_limited") vi.useFakeTimers({ shouldAdvanceTime: true });
    s.prompt.mockImplementationOnce(attempt(s, reason)).mockImplementationOnce(s.finishes);
    await s.startTurn();
    const message = s.message("do the steered thing");
    await s.steer(message);
    expect(s.inbox.getState(message.messageId)?.status).toBe("running");
    s.endAttempt();
    if (reason === "provider_rate_limited") {
      // `vi.waitFor` would advance the fake clock itself; poll until the Turn is waiting out the delay.
      while (!(await s.retries.read(s.request.sessionId))?.interruption) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await s.runner.settled();

    expect(s.prompt).toHaveBeenCalledTimes(2);
    expect(s.promptText(1)).toContain("automatic retry 1/1");
    expect(s.promptText(1)).toContain("do the steered thing");
    expect(s.promptText(1)).toContain(`Message ID: ${message.messageId}`);
    expect(s.inbox.getState(message.messageId)?.status).toBe("succeeded");
    expect(s.onRunOutcome).not.toHaveBeenCalled();
    // Settled before the report, and never written to the Turn's durable retry input.
    expect(s.settledBeforeReport()).toBe(true);
    expect((await s.retries.read(s.request.sessionId))?.steers).toEqual([]);
    await s.stop();
  });

  it("keeps IM and Session messages in their original order", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(s.finishes);
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
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(
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

  it("fails once, with one notice, when the one retry also fails", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(aborted);
    await s.startTurn();
    const message = s.message("steered");
    await s.steer(message);
    s.endAttempt();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2));
    expireBudget();
    await s.runner.settled();
    s.releaseTurn();
    await s.inbox.settled();
    expect(s.prompt).toHaveBeenCalledTimes(2);
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

  it("gets no further retry when steered into the retry itself", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(attempt(s, "turn_timeout"));
    await s.startTurn();
    const first = s.message("before the retry");
    await s.steer(first);
    s.endAttempt();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2));
    const late = s.message("into the retry");
    await s.steer(late);
    s.endAttempt();
    await s.runner.settled();
    s.releaseTurn();
    await s.inbox.settled();
    expect(s.prompt).toHaveBeenCalledTimes(2);
    expect(s.inbox.getState(first.messageId)?.status).toBe("failed");
    expect(s.inbox.getState(late.messageId)?.status).toBe("failed");
    expect(s.onRunOutcome).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it("returns to the FIFO instead of joining the retry when the provider never began it", async () => {
    const s = await system();
    s.steerOutcome = "not_started";
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementation(s.finishes);
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

  it("fails the message when its retry cannot be recorded, and retries the Turn without it", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(s.finishes);
    await s.startTurn();
    const message = s.message("not carried");
    await s.steer(message);
    s.failNextWrite();
    s.endAttempt();
    await s.runner.settled();
    expect(s.prompt).toHaveBeenCalledTimes(2);
    expect(s.promptText(1)).not.toContain("not carried");
    expect(s.inbox.getState(message.messageId)?.status).toBe("failed");
    await s.stop();
  });

  it("fails the message when the Turn cannot retry at all", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout"));
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await s.startTurn();
    const message = s.message("in flight");
    await s.inbox.accept(message);
    await vi.waitFor(() => expect(s.runtime.steer).toHaveBeenCalledOnce());
    s.endAttempt();
    while (!(await s.retries.read(s.request.sessionId))?.interruption) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await vi.advanceTimersByTimeAsync(30_000);
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
      expect(s.runner.reserveSessionMessage(s.message("filler"), TURN_ID)).toBe("first_attempt");
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
    expect(s.runner.reserveSessionMessage(message, "no-such-turn")).toBe("refused");
    s.prompt.mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    expect(s.runner.reserveSessionMessage({ ...message, targetSessionId: randomUUID() }, TURN_ID)).toBe("refused");
    s.endAttempt();
    await s.runner.settled();
    await s.stop();
  });

  it("follows its own receipt when acknowledged after the Turn was decided", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    const message = s.message("late");
    expect(s.runner.reserveSessionMessage(message, TURN_ID)).toBe("first_attempt");
    s.endAttempt();
    await s.runner.settled();
    const settle = vi.spyOn(s.inbox, "settleJoined");
    const receipt: AgentSteerReceipt = { outcome: Promise.resolve("processed") };
    s.runner.sessionMessageSteered(message, TURN_ID, receipt);
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith(message, "processed"));
    await s.stop();
  });
});

describe("a Session message's one retry when it joins a Run with none left", () => {
  it("is spent before the provider has it, so a crash during an in-place retry fails the message", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(attempt(first, "turn_timeout")).mockImplementationOnce(hangs(first));
    await first.startTurn();
    first.endAttempt();
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledTimes(2));
    const fresh = first.message("joined the retry");
    let attemptsAtSteer: number | undefined;
    first.runtime.steer.mockImplementationOnce(async () => {
      attemptsAtSteer = (await first.stored(fresh))?.attempts;
      return { outcome: new Promise<AgentSteerOutcome>(() => undefined) };
    });
    await first.steer(fresh);
    expect(attemptsAtSteer).toBe(1);

    const second = await system({ home: first.home, request: first.request });
    await second.inbox.ready();
    await vi.waitFor(() => expect(second.inbox.getState(fresh.messageId)?.status).toBe("failed"));
    expect(second.onRunOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "run_interrupted" }));
    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.runtime.steer).not.toHaveBeenCalled();
    await second.stop();
    await first.stop();
  });

  it("is spent when a queued message joins a resumed Turn, so a second crash fails the message", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    first.runtime.state.phase = "idle";
    const queued = first.message("queued before the crash");
    await first.inbox.accept(queued);
    expect((await first.stored(queued))?.attempts).toBe(0);

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(hangs(second));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.inbox.getState(queued.messageId)?.status).toBe("running"));
    expect(second.steerText(0)).not.toContain("Your previous turn was interrupted");
    expect((await second.stored(queued))?.attempts).toBe(1);

    const third = await system({ home: first.home, request: first.request });
    await third.inbox.ready();
    await vi.waitFor(() => expect(third.inbox.getState(queued.messageId)?.status).toBe("failed"));
    expect(third.prompt).not.toHaveBeenCalled();
    await third.stop();
    await second.stop();
    await first.stop();
  });

  it("does not spend it twice for a message already retried after a crash", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("steered before the crash");
    await first.steer(message);

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(hangs(second));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("running"));
    expect((await second.stored(message))?.attempts).toBe(1);
    await second.stop();
    await first.stop();
  });

  it("is steered anyway, with a warning, when the spend cannot be written", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    s.endAttempt();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2));
    // Queued first, so the write that fails is the spend, not the acceptance.
    s.runtime.state.phase = "idle";
    const message = s.message("spend failed");
    await s.inbox.accept(message);
    s.failNextWrite();
    s.runtime.state.phase = "running";
    await vi.waitFor(() => expect(s.inbox.getState(message.messageId)?.status).toBe("running"));
    expect(s.writeFailures()).toBe(1);
    expect(s.runtime.steer).toHaveBeenCalledOnce();
    expect(s.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_MESSAGE_RETRY_SPEND_FAILED", messageId: message.messageId }),
      expect.any(String),
    );
    // The `running` write that follows carries the spend, so nothing further is lost.
    expect((await s.stored(message))?.attempts).toBe(1);
    await s.stop();
  });

  it("can get one more delivery after a crash when neither write reached the disk, the accepted cost", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(attempt(first, "turn_timeout")).mockImplementationOnce(hangs(first));
    await first.startTurn();
    first.endAttempt();
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledTimes(2));
    first.runtime.state.phase = "idle";
    const message = first.message("nothing written");
    await first.inbox.accept(message);
    first.failWrites(2);
    first.runtime.state.phase = "running";
    await vi.waitFor(() => expect(first.writeFailures()).toBe(2));
    expect(first.runtime.steer).toHaveBeenCalledOnce();
    expect((await first.stored(message))?.attempts).toBe(0);

    const second = await system({ home: first.home, request: first.request });
    second.prompt.mockImplementation(second.finishes);
    await second.inbox.ready();
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("succeeded"));
    expect(second.prompt).toHaveBeenCalledOnce();
    await second.stop();
    await first.stop();
  });

  it("gives the retry back when the steer is refused after the spend", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    s.endAttempt();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2));
    s.runtime.steer.mockRejectedValue(new Error("run_mismatch"));
    const message = s.message("refused");
    await s.inbox.accept(message);
    await vi.waitFor(() => expect(s.runtime.steer).toHaveBeenCalled());
    s.endAttempt();
    await s.runner.settled();
    await vi.waitFor(async () => expect((await s.stored(message))?.attempts).toBe(0));
    expect(s.inbox.getState(message.messageId)?.status).toBe("accepted");
    await s.stop();
  });
});

describe("giving a refused steer's retry back", () => {
  it("is not steered again until the refund is written", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(attempt(s, "completed"));
    await s.startTurn();
    s.endAttempt();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2));
    const message = s.message("refused");
    let failuresAtSecondSteer: number | undefined;
    s.runtime.steer
      .mockImplementationOnce(async () => {
        s.failWrites(3);
        throw new Error("run_mismatch");
      })
      .mockImplementationOnce(async () => {
        failuresAtSecondSteer = s.writeFailures();
        return { outcome: new Promise<AgentSteerOutcome>(() => undefined) };
      });
    await s.inbox.accept(message);
    await vi.waitFor(() => expect(s.runtime.steer).toHaveBeenCalledTimes(2));
    expect(failuresAtSecondSteer).toBe(3);
    await vi.waitFor(async () => expect((await s.stored(message))?.status).toBe("running"));
    // The second steer spent the returned retry again: not lost and not counted twice.
    expect((await s.stored(message))?.attempts).toBe(1);
    await s.stop();
  });

  it("keeps the promised retry when the message runs on its own with the refund unwritten", async () => {
    const s = await system();
    s.prompt
      .mockImplementationOnce(attempt(s, "turn_timeout"))
      .mockImplementationOnce(attempt(s, "completed"))
      .mockImplementationOnce(async () => ({
        runId: "own",
        status: "failed",
        output: [],
        error: { code: "provider_rate_limited", message: "429" },
      }))
      .mockImplementationOnce(s.finishes);
    await s.startTurn();
    s.endAttempt();
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2));
    const message = s.message("refused");
    s.runtime.steer.mockImplementationOnce(async () => {
      s.failNextWrite();
      s.releaseTurn();
      throw new Error("run_mismatch");
    });
    await s.inbox.accept(message);
    await vi.waitFor(() => expect(s.inbox.getState(message.messageId)?.status).toBe("succeeded"));
    expect(s.writeFailures()).toBe(1);
    expect(s.prompt).toHaveBeenCalledTimes(4);
    expect(s.promptText(3)).toContain("automatic retry 1/1");
    await s.stop();
  });
});

describe("the interruption a joined message reports after an orderly stop", () => {
  it("keeps client_shutdown from the Turn, with the production stop order", async () => {
    const first = await system({ restartRetry: true });
    first.prompt.mockImplementationOnce(attempt(first, "turn_timeout"));
    await first.startTurn();
    const message = first.message("steered before the stop");
    await first.steer(message);
    first.inbox.stop();
    first.runner.stop();
    await first.runner.settled();
    expect((await first.retries.read(first.request.sessionId))?.interruption?.reason).toBe("client_shutdown");

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(attempt(second, "completed"));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.runtime.steer).toHaveBeenCalledOnce());
    expect(second.promptText(0)).toContain("restarted or upgraded");
    expect(second.steerText(0)).toContain("restarted or upgraded");
    expect(second.steerText(0)).not.toContain("stopped unexpectedly");
    second.endAttempt();
    await second.runner.settled();
    await second.stop();
    await first.stop();
  });

  it("keeps the 429 when the stop comes during its backoff", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = await system({ restartRetry: true });
    first.prompt.mockImplementationOnce(attempt(first, "provider_rate_limited"));
    await first.startTurn();
    const message = first.message("steered before the 429");
    await first.steer(message);
    first.endAttempt();
    while (!(await first.retries.read(first.request.sessionId))?.interruption) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    first.inbox.stop();
    first.runner.stop();
    await first.runner.settled();
    vi.useRealTimers();

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(attempt(second, "completed"));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.runtime.steer).toHaveBeenCalledOnce());
    expect(second.promptText(0)).toContain("HTTP 429");
    expect(second.steerText(0)).toContain("HTTP 429");
    second.endAttempt();
    await second.runner.settled();
    await second.stop();
    await first.stop();
  });

  it.each([
    ["no longer holds any unresolved Turn", null],
    ["holds a different unresolved Turn", "turn-2"],
  ] as const)("ignores a leftover retry record when the binding %s", async (_name, unresolved) => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("steered");
    await first.steer(message);
    await first.retries.update(first.request.sessionId, TURN_ID, (record) => ({
      ...record,
      interruption: { reason: "turn_timeout", at: "T" },
    }));

    const second = await system({ home: first.home, request: first.request, prepared: false, unresolved });
    await second.inbox.ready();
    expect((await second.stored(message))?.interruption?.reason).toBe("daemon_crash");
    await second.stop();
    await first.stop();
  });

  it("ignores a leftover retry record for another delivery, and one its binding cannot confirm", async () => {
    const store = new TurnRetryStore(await newHome());
    const request = imDelivery();
    await store.write({ ...turnRetryRecord(request, TURN_ID), interruption: { reason: "turn_timeout", at: "T" } });
    const held = { turnId: TURN_ID, deliveryId: randomUUID() };
    await expect(store.interruptions({ read: async () => ({ unresolvedTurn: held }) as never })).resolves.toEqual(
      new Map(),
    );
    await expect(store.interruptions({ read: async () => Promise.reject(new Error("disk")) })).resolves.toEqual(
      new Map(),
    );
    await expect(
      store.interruptions({
        read: async () => ({ unresolvedTurn: { turnId: TURN_ID, deliveryId: request.deliveryId } }) as never,
      }),
    ).resolves.toEqual(new Map([[request.sessionId, { reason: "turn_timeout", at: "T" }]]));
  });

  it("reports a crash, not the restart that started it, when a resumed Turn crashes", async () => {
    const first = await system({ restartRetry: true });
    first.prompt.mockImplementationOnce(attempt(first, "turn_timeout"));
    await first.startTurn();
    const message = first.message("steered");
    await first.steer(message);
    first.inbox.stop();
    first.runner.stop();
    await first.runner.settled();

    const second = await system({ home: first.home, request: first.request, prepared: false });
    second.prompt.mockImplementationOnce(hangs(second));
    await second.inbox.ready();
    await second.recovery.start();
    second.prepare();
    expect(second.recovery.resume(second.request.sessionId, second.identity)).toBe(true);
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("running"));
    expect(second.steerText(0)).toContain("restarted or upgraded");

    const third = await system({ home: first.home, request: first.request });
    await third.inbox.ready();
    await vi.waitFor(() => expect(third.inbox.getState(message.messageId)?.status).toBe("failed"));
    expect(third.onRunOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "run_interrupted" }));
    await third.stop();
    await second.stop();
    await first.stop();
  });

  it("reports the stop, not the timeout that started the retry, when a stop interrupts that retry", async () => {
    const first = await system({ restartRetry: true });
    first.prompt.mockImplementationOnce(attempt(first, "turn_timeout")).mockImplementationOnce(aborted);
    await first.startTurn();
    const message = first.message("carried");
    await first.steer(message);
    first.endAttempt();
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledTimes(2));
    first.inbox.stop();
    first.runner.stop();
    await first.runner.settled();

    const second = await system({ home: first.home, request: first.request });
    await second.inbox.ready();
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("failed"));
    expect(second.onRunOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "client_shutdown" }));
    await second.stop();
    await first.stop();
  });

  it("falls back to a crash when the Turn's interruption cannot be read", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("steered");
    await first.steer(message);
    const list = vi.spyOn(TurnRetryStore.prototype, "list").mockRejectedValueOnce(new Error("disk"));
    const second = await system({ home: first.home, request: first.request, prepared: false });
    await second.inbox.ready();
    list.mockRestore();
    expect((await second.stored(message))?.interruption?.reason).toBe("daemon_crash");
    await second.stop();
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
    expect(second.promptText(0)).toContain("automatic retry 1/1");
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

  it("fails a message whose in-place retry the crash interrupted, instead of retrying it twice", async () => {
    const first = await system();
    first.prompt.mockImplementationOnce(attempt(first, "turn_timeout")).mockImplementationOnce(hangs(first));
    await first.startTurn();
    const message = first.message("steered");
    await first.steer(message);
    first.endAttempt();
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledTimes(2));

    const second = await system({ home: first.home, request: first.request });
    await second.inbox.ready();
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("failed"));
    // The crash ended the retry; the timeout that started it is not what is reported.
    expect(second.onRunOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "run_interrupted" }));
    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.runtime.steer).not.toHaveBeenCalled();
    await second.stop();
    await first.stop();
  });
});

describe("a Turn whose joined messages meet other paths", () => {
  it("orders messages without a recorded arrival first", async () => {
    const s = await system();
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(s.finishes);
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
    expect(s.runner.reserveSessionMessage(message, TURN_ID)).toBe("first_attempt");
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

  it("has no owner to carry a message when the runner is built without one", async () => {
    const s = await system({ withoutOwner: true });
    s.prompt.mockImplementationOnce(attempt(s, "turn_timeout")).mockImplementationOnce(s.finishes);
    await s.startTurn();
    const message = s.message("nobody owns this");
    expect(s.runner.reserveSessionMessage(message, TURN_ID)).toBe("first_attempt");
    s.runner.sessionMessageSteered(message, TURN_ID, { outcome: Promise.resolve("interrupted") });
    s.endAttempt();
    await s.runner.settled();
    expect(s.prompt).toHaveBeenCalledTimes(2);
    expect(s.promptText(1)).not.toContain("nobody owns this");
    await s.stop();
  });
});

describe("the input of a Session message in a retry", () => {
  it("refuses to render a Session message without its owner", () => {
    const request = imDelivery();
    expect(() =>
      buildRetryAgentInput(request, [sessionMessage(request, "x")], { reason: "turn_timeout", at: "T" }, new Date(0)),
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

  it("does not spend the retry of a message the inbox has no record of", async () => {
    const s = await system();
    await expect(s.inbox.spendJoinedRetry(s.message("x"))).resolves.toBe(true);
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
    /** The Turn the binding holds as unresolved; null for none. */
    unresolved?: string | null;
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
    unresolvedTurn:
      options.unresolved === null
        ? undefined
        : { turnId: options.unresolved ?? TURN_ID, deliveryId: request.deliveryId, phase: "running" },
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
    turnInterruptions: () => retries.interruptions({ read: bindingRead as never }),
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
            spendRetry: (message: SessionMessageDeliveryRequestV3) => inbox.spendJoinedRetry(message),
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
