import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DirectImMessageDeliveryRequest,
  RUNTIME_CAPABILITY,
  type RuntimeImSteerRequest,
  type SessionMessageDeliveryRequestV3,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const homes: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
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
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2), { timeout: 2_000 });
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
    await vi.waitFor(() => expect(s.prompt).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    const late = s.message("into the retry");
    await s.steer(late);
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
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledTimes(2), { timeout: 2_000 });

    const second = await system({ home: first.home, request: first.request });
    await second.inbox.ready();
    await vi.waitFor(() => expect(second.inbox.getState(message.messageId)?.status).toBe("failed"));
    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.runtime.steer).not.toHaveBeenCalled();
    await second.stop();
    await first.stop();
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
    await expect(s.inbox.spendJoinedRetry(s.message("x"), { reason: "turn_timeout", at: "T" })).resolves.toBe(true);
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
        s.endAttempt = () => undefined;
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
    sessionKind?: "internal" | "visible";
  } = {},
) {
  const home = options.home ?? (await newHome());
  const request = options.request ?? imDelivery();
  const admission = new AdmissionController();
  const retries = new TurnRetryStore(home);
  const durable = new FileRuntimeDurabilityStore(home);
  let failingWrites = 0;
  const persistence = {
    list: durable.list.bind(durable),
    write: async (record: Parameters<FileRuntimeDurabilityStore["write"]>[0]) => {
      if (failingWrites > 0) {
        failingWrites -= 1;
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
  });
  const bindingRead = vi.fn(async () => ({
    recentRecordedInputs: receipts,
    unresolvedTurn: { turnId: TURN_ID, deliveryId: request.deliveryId, phase: "running" },
  }));
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
    restartRetryAvailable: () => false,
    sessionMessages: {
      input: (message, processedAt) => inbox.joinedRunInput(message, processedAt),
      spendRetry: (message, interruption) => inbox.spendJoinedRetry(message, interruption),
      settle: async (message, outcome) => {
        await inbox.settleJoined(message, outcome);
        order.push("settled");
      },
    },
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
    onRunOutcome,
    outbox,
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
      request.runtime.budget = { maxDurationMs: 400 };
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
