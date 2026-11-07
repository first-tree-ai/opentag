import { randomUUID } from "node:crypto";
import type { SessionMessageDeliveryRequestV3 } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult, AgentSteerOutcome } from "../agent-runtime/types.js";
import { AdmissionController } from "../runtime/admission-controller.js";
import { MAX_AUTOMATIC_RETRIES, MAX_RECORDED_STEERS } from "../runtime/interruption-retry.js";
import {
  type DurableWorkRecord,
  MemoryRuntimeDurabilityStore,
  type RuntimeDurabilityStore,
  type RuntimeRetryScheduler,
} from "../runtime/runtime-durability.js";
import { SessionMessageInbox, type SessionMessageRunOutcomeEvent } from "../runtime/session-message-inbox.js";
import { SessionMessageRun, sessionMessageOfRun, sessionMessageRunId } from "../runtime/session-message-run.js";

type Items = readonly { text: string }[];

interface Attempt {
  texts: string[];
  finish(result?: Partial<AgentRunResult> | Error): void;
}

const inboxes: SessionMessageInbox[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const inbox of inboxes.splice(0)) inbox.stop();
});

const rateLimited = { status: "failed", error: { code: "provider_rate_limited", message: "429" } } as const;

/** A runtime whose Runs end when a test says so, and whose steers follow the Run they joined. */
function harness(options: { steer?: "supported" | "unsupported" } = {}) {
  const state: { phase: string; activeRunId?: string } = { phase: "idle" };
  const attempts: Attempt[] = [];
  const steers: Array<{ runId: string; texts: string[] }> = [];
  let runEnded: Array<(outcome: AgentSteerOutcome) => void> = [];
  let lastEnd: AgentSteerOutcome = "processed";
  const steerOutcomes = new Map<string, AgentSteerOutcome | Error | Promise<void>>();
  const runtime = {
    capabilities: { steer: options.steer ?? "supported" },
    state,
    waitForIdle: async () => undefined,
    steer: vi.fn(async (request: { expectedRunId: string; input: { items: Items } }) => {
      const text = request.input.items.at(-1)?.text ?? "";
      const scripted = steerOutcomes.get(text);
      if (scripted instanceof Error) throw scripted;
      if (scripted instanceof Promise) await scripted;
      steers.push({ runId: request.expectedRunId, texts: request.input.items.map((item) => item.text) });
      const outcome = new Promise<AgentSteerOutcome>((resolve) => {
        const end = (ran: AgentSteerOutcome) => resolve(typeof scripted === "string" ? scripted : ran);
        // Acknowledged after the Run ended: the outcome is known already.
        if (state.activeRunId) runEnded.push(end);
        else end(lastEnd);
      });
      return { outcome };
    }),
    prompt: vi.fn(
      (request: { runId: string; input: { items: Items } }) =>
        new Promise((resolve, reject) => {
          state.phase = "running";
          state.activeRunId = request.runId;
          attempts.push({
            texts: request.input.items.map((item) => item.text),
            finish(result = {}) {
              state.phase = "idle";
              delete state.activeRunId;
              const failed = result instanceof Error || (result.status ?? "completed") !== "completed";
              lastEnd = failed ? "interrupted" : "processed";
              for (const end of runEnded.splice(0)) end(lastEnd);
              runEnded = [];
              if (result instanceof Error) reject(result);
              else resolve({ runId: request.runId, status: "completed", output: [], ...result });
            },
          });
        }),
    ),
  };
  return { attempts, runtime, state, steerOutcomes, steers };
}

function makeInbox(
  runtime: ReturnType<typeof harness>["runtime"],
  options: {
    persistence?: RuntimeDurabilityStore;
    outcomes?: SessionMessageRunOutcomeEvent[];
    now?: () => number;
    rateLimitRetryDelayMs?: number;
    maxRememberedMessages?: number;
    timeoutScheduler?: RuntimeRetryScheduler;
  } = {},
) {
  const inbox = new SessionMessageInbox({
    admission: new AdmissionController(),
    credentialEnvironment: {
      cleanup: vi.fn(async () => undefined),
      prepare: vi.fn(async () => {
        throw new Error("Internal Sessions do not prepare credentials");
      }),
    },
    imCredentialGrantVersion: () => 2,
    sessionCollaborationVersion: () => 4,
    onRunOutcome: async (outcome) => {
      options.outcomes?.push(outcome);
    },
    persistence: options.persistence ?? new MemoryRuntimeDurabilityStore(),
    rateLimitRetryDelayMs: options.rateLimitRetryDelayMs ?? 1,
    reconciler: {
      checkSessionMessageDelivery: () => undefined,
      clearActivity: () => true,
      setActivity: () => undefined,
      withAgentLock: async <T>(_agentId: string, task: () => Promise<T>) => task(),
    },
    runtimeManager: {
      ensureRuntime: vi.fn(async () => runtime as never),
      runtime: vi.fn(() => runtime as never),
      sessionKind: vi.fn(() => "internal" as const),
    },
    steerRetryMs: 2,
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxRememberedMessages ? { maxRememberedMessages: options.maxRememberedMessages } : {}),
    ...(options.timeoutScheduler ? { timeoutScheduler: options.timeoutScheduler } : {}),
  });
  inboxes.push(inbox);
  return inbox;
}

function conversation() {
  const targetSessionId = randomUUID();
  const agentId = randomUUID();
  const message = (text: string): SessionMessageDeliveryRequestV3 =>
    ({
      type: "session:message:deliver",
      requestId: randomUUID(),
      messageId: randomUUID(),
      sourceSessionId: randomUUID(),
      targetSessionId,
      agentId,
      placementGeneration: 1,
      runtime: {
        contextTrees: [],
        revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
        agentId,
        provider: "codex",
        instructions: { platform: "platform", agent: "agent" },
        execution: { approvalPolicy: "never", networkAccess: true },
        workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
      },
      content: { kind: "text", text },
    }) as unknown as SessionMessageDeliveryRequestV3;
  return { message };
}

function record(
  request: SessionMessageDeliveryRequestV3,
  status: DurableWorkRecord["status"],
  fields: Partial<DurableWorkRecord<SessionMessageDeliveryRequestV3>> = {},
): DurableWorkRecord<SessionMessageDeliveryRequestV3> {
  return {
    acceptedAt: 1_000,
    attempts: 0,
    key: `${request.targetSessionId}:${request.messageId}`,
    kind: "session-message",
    payload: request,
    status,
    updatedAt: 1_000,
    ...fields,
  };
}

/** The user-authored text of each message in a Run's input. */
function bodies(texts: readonly string[], ...expected: string[]): string[] {
  return texts.filter((text) => expected.includes(text));
}

async function started(attempts: Attempt[], count: number): Promise<Attempt> {
  await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(count));
  return attempts[count - 1] as Attempt;
}

const NOTICE = "Your previous turn was interrupted";

describe("a Session message steered into a Session message Run", () => {
  it("settles with the Run, in order, without a Run of its own", async () => {
    const { attempts, runtime, steers, state } = harness();
    const inbox = makeInbox(runtime);
    const { message } = conversation();
    const [first, second, third] = [message("first"), message("second"), message("third")];
    await inbox.accept(first);
    const attempt = await started(attempts, 1);
    await inbox.accept(second);
    await inbox.accept(third);
    await vi.waitFor(() => expect(steers).toHaveLength(2));
    expect(steers.map((steer) => steer.texts.at(-1))).toEqual(["second", "third"]);
    expect(steers[0]?.runId).toBe(state.activeRunId);
    await vi.waitFor(() => expect(inbox.getState(third.messageId)?.status).toBe("running"));
    expect(inbox.getState(second.messageId)).toMatchObject({ status: "running", joinedRunId: state.activeRunId });
    await vi.waitFor(() => expect(inbox.queuedCount).toBe(0));
    attempt.finish();
    await inbox.settled();
    expect(attempts).toHaveLength(1);
    for (const request of [first, second, third]) {
      expect(inbox.getState(request.messageId)?.status).toBe("succeeded");
    }
    expect(inbox.pendingCount).toBe(0);
  });

  it("stays in the FIFO and runs after the Run when the runtime cannot steer", async () => {
    const { attempts, runtime } = harness({ steer: "unsupported" });
    const inbox = makeInbox(runtime);
    const { message } = conversation();
    const second = message("second");
    await inbox.accept(message("first"));
    const attempt = await started(attempts, 1);
    await inbox.accept(second);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.steer).not.toHaveBeenCalled();
    expect(inbox.queuedCount).toBe(1);
    attempt.finish();
    const own = await started(attempts, 2);
    expect(own.texts.at(-1)).toBe("second");
    own.finish();
    await inbox.settled();
    expect(inbox.getState(second.messageId)?.status).toBe("succeeded");
  });

  it("stays in the FIFO when the steer is refused, and re-checks", async () => {
    const { attempts, runtime, steerOutcomes, steers } = harness();
    const inbox = makeInbox(runtime);
    const { message } = conversation();
    steerOutcomes.set("second", new Error("run mismatch"));
    await inbox.accept(message("first"));
    const attempt = await started(attempts, 1);
    const second = message("second");
    await inbox.accept(second);
    await vi.waitFor(() => expect(runtime.steer.mock.calls.length).toBeGreaterThan(1));
    expect(inbox.queuedCount).toBe(1);
    steerOutcomes.delete("second");
    await vi.waitFor(() => expect(steers).toHaveLength(1));
    await vi.waitFor(() => expect(inbox.queuedCount).toBe(0));
    attempt.finish();
    await inbox.settled();
    expect(attempts).toHaveLength(1);
    expect(inbox.getState(second.messageId)?.status).toBe("succeeded");
  });

  it("stays in the FIFO past the Run's limit", async () => {
    const { attempts, runtime, steers } = harness();
    const inbox = makeInbox(runtime);
    const { message } = conversation();
    await inbox.accept(message("first"));
    const attempt = await started(attempts, 1);
    for (let index = 0; index < MAX_RECORDED_STEERS + 1; index += 1) await inbox.accept(message(`steered ${index}`));
    await vi.waitFor(() => expect(steers).toHaveLength(MAX_RECORDED_STEERS));
    expect(inbox.queuedCount).toBe(1);
    attempt.finish();
    const own = await started(attempts, 2);
    expect(own.texts.at(-1)).toBe(`steered ${MAX_RECORDED_STEERS}`);
    own.finish();
    await inbox.settled();
  });

  it("returns to its place in the FIFO when the provider never began it", async () => {
    const { attempts, runtime, steerOutcomes } = harness();
    const inbox = makeInbox(runtime);
    const { message } = conversation();
    const [second, third] = [message("second"), message("third")];
    steerOutcomes.set("second", "not_started");
    await inbox.accept(message("first"));
    const attempt = await started(attempts, 1);
    await inbox.accept(second);
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("running"));
    // The next one cannot steer, so it waits in the FIFO behind which `second` must return.
    steerOutcomes.set("third", new Error("run mismatch"));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await inbox.accept(third);
    await vi.waitFor(() => expect(inbox.queuedCount).toBe(1));
    attempt.finish();
    const own = await started(attempts, 2);
    expect(own.texts.at(-1)).toBe("second");
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.joinedRunId).toBeUndefined());
    steerOutcomes.delete("third");
    await vi.waitFor(() => expect(inbox.getState(third.messageId)?.status).toBe("running"));
    own.finish();
    await inbox.settled();
    expect(attempts).toHaveLength(2);
    expect(inbox.getState(second.messageId)?.status).toBe("succeeded");
    expect(inbox.getState(third.messageId)?.status).toBe("succeeded");
  });
});

describe("background work left at the end of a Session message Run", () => {
  it("reports for the Run's own message, and a message steered into it succeeds without a report", async () => {
    const { attempts, runtime, steers } = harness();
    const outcomes: SessionMessageRunOutcomeEvent[] = [];
    const inbox = makeInbox(runtime, { outcomes });
    const { message } = conversation();
    const [first, second] = [message("first"), message("second")];
    await inbox.accept(first);
    const attempt = await started(attempts, 1);
    await inbox.accept(second);
    await vi.waitFor(() => expect(steers).toHaveLength(1));
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("running"));
    attempt.finish({ abandonedBackgroundWork: ["background shell"] });
    await inbox.settled();
    expect(inbox.getState(first.messageId)?.status).toBe("succeeded");
    expect(inbox.getState(second.messageId)?.status).toBe("succeeded");
    expect(outcomes).toEqual([
      expect.objectContaining({
        messageId: first.messageId,
        outcome: "unknown",
        reason: "background_work_possibly_stopped",
      }),
    ]);
    expect(attempts).toHaveLength(1);
  });
});

describe("the FIFO when acceptance times tie", () => {
  it("returns a message the provider never began ahead of one accepted after it in the same millisecond", async () => {
    const { attempts, runtime, steerOutcomes, steers } = harness();
    const inbox = makeInbox(runtime, { now: () => 1_000 });
    const { message } = conversation();
    const [second, third] = [message("second"), message("third")];
    steerOutcomes.set("second", "not_started");
    steerOutcomes.set("third", new Error("run mismatch"));
    await inbox.accept(message("first"));
    const attempt = await started(attempts, 1);
    await inbox.accept(second);
    await vi.waitFor(() => expect(steers).toHaveLength(1));
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("running"));
    await inbox.accept(third);
    await vi.waitFor(() => expect(inbox.queuedCount).toBe(1));
    expect(inbox.getState(second.messageId)?.acceptedAt).toBe(inbox.getState(third.messageId)?.acceptedAt);
    attempt.finish();
    const next = await started(attempts, 2);
    expect(next.texts.at(-1)).toBe("second");
    steerOutcomes.delete("third");
    await vi.waitFor(() => expect(inbox.getState(third.messageId)?.status).toBe("running"));
    next.finish();
    await inbox.settled();
    expect(attempts).toHaveLength(2);
    expect(inbox.getState(third.messageId)?.status).toBe("succeeded");
  });

  it("keeps the durable order after a restart, when a tied message comes back from a Run", async () => {
    const { message } = conversation();
    const [lead, second, third] = [message("lead"), message("second"), message("third")];
    const persistence = new MemoryRuntimeDurabilityStore();
    for (const stored of [record(lead, "running"), record(second, "accepted"), record(third, "accepted")]) {
      await persistence.write(stored);
    }
    const { attempts, runtime, steerOutcomes } = harness();
    steerOutcomes.set("second", "not_started");
    steerOutcomes.set("third", new Error("run mismatch"));
    const inbox = makeInbox(runtime, { persistence });
    await inbox.ready();
    const resumed = await started(attempts, 1);
    expect(resumed.texts.at(-1)).toBe("lead");
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("running"));
    await vi.waitFor(() => expect(inbox.queuedCount).toBe(1));
    resumed.finish();
    const next = await started(attempts, 2);
    expect(next.texts.at(-1)).toBe("second");
    steerOutcomes.delete("third");
    await vi.waitFor(() => expect(inbox.getState(third.messageId)?.status).toBe("running"));
    next.finish();
    await inbox.settled();
    expect(inbox.getState(third.messageId)?.status).toBe("succeeded");
  });
});

describe("a message accepted while the drain is running", () => {
  it("is not taken before its record is durable, so its steer is tracked", async () => {
    const { attempts, runtime, steers } = harness();
    let finishWrite: () => void = () => undefined;
    let holdWrites = false;
    const store = new MemoryRuntimeDurabilityStore();
    const persistence: RuntimeDurabilityStore = {
      list: (kind) => store.list(kind),
      write: async (written) => {
        if (holdWrites && written.status === "accepted") {
          await new Promise<void>((resolve) => {
            finishWrite = resolve;
          });
        }
        await store.write(written);
      },
    };
    const inbox = makeInbox(runtime, { persistence });
    const { message } = conversation();
    const [first, second, third] = [message("first"), message("second"), message("third")];
    await inbox.accept(first);
    const attempt = await started(attempts, 1);
    await inbox.accept(second);
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("running"));
    holdWrites = true;
    const accepted = inbox.accept(third);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(steers).toHaveLength(1);
    finishWrite();
    await accepted;
    await vi.waitFor(() => expect(inbox.getState(third.messageId)?.status).toBe("running"));
    attempt.finish();
    await inbox.settled();
    expect(inbox.getState(third.messageId)?.status).toBe("succeeded");
  });

  it("gives up its queue place when it cannot be persisted", async () => {
    const { runtime } = harness();
    const inbox = makeInbox(runtime, {
      persistence: {
        list: async () => [],
        write: async () => {
          throw new Error("disk full");
        },
      },
    });
    const { message } = conversation();
    await expect(inbox.accept(message("lost"))).resolves.toMatchObject({
      status: "rejected",
      reason: "provider_unavailable",
    });
    expect(inbox.queuedCount).toBe(0);
    expect(inbox.pendingCount).toBe(0);
  });
});

describe("the retry of a Session message Run", () => {
  it("carries the messages steered into it, in order, and new ones join the next attempt", async () => {
    const { attempts, runtime, steers } = harness();
    const inbox = makeInbox(runtime);
    const { message } = conversation();
    const [first, second, third, fourth] = [message("first"), message("second"), message("third"), message("fourth")];
    await inbox.accept(first);
    const attempt = await started(attempts, 1);
    await inbox.accept(second);
    await inbox.accept(third);
    await vi.waitFor(() => expect(steers).toHaveLength(2));
    await vi.waitFor(() => expect(inbox.getState(third.messageId)?.status).toBe("running"));
    attempt.finish(rateLimited);
    const retry = await started(attempts, 2);
    expect(retry.texts[0]).toContain(NOTICE);
    expect(bodies(retry.texts, "first", "second", "third")).toEqual(["first", "second", "third"]);
    // Still the Run's messages, not queued again and not counted on their own.
    expect(inbox.getState(second.messageId)).toMatchObject({ status: "running", attempts: 0 });
    expect(inbox.getState(first.messageId)?.attempts).toBe(1);
    expect(inbox.queuedCount).toBe(0);
    await inbox.accept(fourth);
    await vi.waitFor(() => expect(steers).toHaveLength(3));
    await vi.waitFor(() => expect(inbox.getState(fourth.messageId)?.status).toBe("running"));
    retry.finish(rateLimited);
    const last = await started(attempts, 3);
    expect(bodies(last.texts, "first", "second", "third", "fourth")).toEqual(["first", "second", "third", "fourth"]);
    last.finish();
    await inbox.settled();
    for (const request of [first, second, third, fourth]) {
      expect(inbox.getState(request.messageId)?.status).toBe("succeeded");
    }
  });

  it("steers a message that arrives during the backoff into the retry, instead of letting it run ahead", async () => {
    const { attempts, runtime, steers, state } = harness();
    const inbox = makeInbox(runtime, { rateLimitRetryDelayMs: 200 });
    const { message } = conversation();
    const [first, second] = [message("first"), message("second")];
    await inbox.accept(first);
    const attempt = await started(attempts, 1);
    attempt.finish(rateLimited);
    await vi.waitFor(() => expect(inbox.getState(first.messageId)?.status).toBe("retryable"));
    await inbox.accept(second);
    const retry = await started(attempts, 2);
    expect(bodies(retry.texts, "first", "second")).toEqual(["first"]);
    await vi.waitFor(() => expect(steers).toHaveLength(1));
    expect(steers[0]?.runId).toBe(state.activeRunId);
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("running"));
    retry.finish();
    await inbox.settled();
    expect(attempts).toHaveLength(2);
    expect(inbox.getState(second.messageId)?.status).toBe("succeeded");
  });

  it("shares the Run's actual run time: a retry keeps the remaining budget, and a long one resets the count", async () => {
    // The run time tracker samples the clock once a minute, so this retry really runs at that cadence.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = 1_000;
    const budgets: number[] = [];
    const timeoutScheduler: RuntimeRetryScheduler = {
      schedule(delay) {
        // The waiting message re-checks on its own short timer.
        if (delay > 2) budgets.push(delay);
        return { cancel: () => undefined };
      },
    };
    const { attempts, runtime, steers } = harness();
    const inbox = makeInbox(runtime, { now: () => now, timeoutScheduler });
    const { message } = conversation();
    const first = {
      ...message("first"),
      runtime: { ...message("first").runtime, budget: { maxDurationMs: 3_600_000 } },
    } as SessionMessageDeliveryRequestV3;
    await inbox.accept(first);
    const attempt = await started(attempts, 1);
    const second = message("second");
    await inbox.accept(second);
    await vi.waitFor(() => expect(steers).toHaveLength(1));
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("running"));
    now += 60_000;
    attempt.finish(rateLimited);
    const retry = await started(attempts, 2);
    expect(budgets).toEqual([3_600_000, 3_540_000]);
    expect(inbox.getState(first.messageId)).toMatchObject({ attempts: 1, ranMs: 60_000 });
    // The steered message has no run time or count of its own while it is in the Run.
    expect(inbox.getState(second.messageId)?.ranMs).toBeUndefined();
    for (let minute = 0; minute < 5; minute += 1) {
      now += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
    }
    retry.finish(rateLimited);
    const third = await started(attempts, 3);
    expect(budgets.at(-1)).toBe(3_240_000);
    // The second retry ran five minutes, so this failure starts the count again rather than spending it.
    expect(inbox.getState(first.messageId)?.attempts).toBe(1);
    expect(bodies(third.texts, "first", "second")).toEqual(["first", "second"]);
    third.finish();
    await inbox.settled();
    expect(inbox.getState(second.messageId)?.status).toBe("succeeded");
    vi.useRealTimers();
  });

  it("answers a replay during the backoff without queueing the message or resetting its count", async () => {
    const { attempts, runtime, steers } = harness();
    const inbox = makeInbox(runtime, { rateLimitRetryDelayMs: 200 });
    const first = conversation().message("first");
    await inbox.accept(first);
    (await started(attempts, 1)).finish(rateLimited);
    await vi.waitFor(() => expect(inbox.getState(first.messageId)?.status).toBe("retryable"));
    await expect(inbox.accept({ ...first, requestId: randomUUID() })).resolves.toMatchObject({ status: "accepted" });
    expect(inbox.queuedCount).toBe(0);
    expect(inbox.getState(first.messageId)).toMatchObject({ status: "retryable", attempts: 1 });
    const retry = await started(attempts, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(steers).toHaveLength(0);
    retry.finish();
    await inbox.settled();
    expect(attempts).toHaveLength(2);
    expect(inbox.getState(first.messageId)?.status).toBe("succeeded");
  });

  it("answers from the record once the bounded cache has evicted the message", async () => {
    const { attempts, runtime, steers } = harness();
    const inbox = makeInbox(runtime, { rateLimitRetryDelayMs: 200, maxRememberedMessages: 1 });
    const { message } = conversation();
    const [first, other] = [message("first"), message("other")];
    await inbox.accept(first);
    (await started(attempts, 1)).finish(rateLimited);
    await vi.waitFor(() => expect(inbox.getState(first.messageId)?.status).toBe("retryable"));
    // The other message takes the cache's one place.
    await inbox.accept(other);
    await expect(inbox.accept({ ...first, requestId: randomUUID() })).resolves.toMatchObject({ status: "accepted" });
    expect(inbox.getState(first.messageId)).toMatchObject({ status: "retryable", attempts: 1 });
    expect(inbox.queuedCount).toBe(1);
    // A different payload under that ID still conflicts.
    await expect(
      inbox.accept({ ...first, requestId: randomUUID(), content: { kind: "text", text: "different" } }),
    ).resolves.toMatchObject({ status: "rejected", reason: "input_conflict" });
    const retry = await started(attempts, 2);
    await vi.waitFor(() => expect(steers.map((steer) => steer.texts.at(-1))).toEqual(["other"]));
    await vi.waitFor(() => expect(inbox.getState(other.messageId)?.status).toBe("running"));
    retry.finish();
    await inbox.settled();
    expect(attempts).toHaveLength(2);
    expect(inbox.getState(first.messageId)?.status).toBe("succeeded");
    // Terminal outcomes survive eviction as well: a replay does not run it again.
    await inbox.accept(message("evicts"));
    (await started(attempts, 3)).finish();
    await inbox.settled();
    await expect(inbox.accept({ ...first, requestId: randomUUID() })).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    expect(attempts).toHaveLength(3);
  });

  it("answers a replay of an evicted failed message as rejected, without running it", async () => {
    const { attempts, runtime } = harness();
    const inbox = makeInbox(runtime, { maxRememberedMessages: 1 });
    const { message } = conversation();
    const failed = message("failed");
    await inbox.accept(failed);
    (await started(attempts, 1)).finish(new Error("the provider broke"));
    await vi.waitFor(() => expect(inbox.getState(failed.messageId)?.status).toBe("failed"));
    await inbox.settled();
    await inbox.accept(message("evicts"));
    (await started(attempts, 2)).finish();
    await inbox.settled();
    await expect(inbox.accept({ ...failed, requestId: randomUUID() })).resolves.toMatchObject({
      status: "rejected",
      reason: "provider_unavailable",
    });
    expect(attempts).toHaveLength(2);
  });

  it("answers a replay after a restart without resetting the count of the message it recovered", async () => {
    const first = conversation().message("first");
    const persistence = new MemoryRuntimeDurabilityStore();
    await persistence.write(record(first, "running", { attempts: 1 }));
    const { attempts, runtime } = harness();
    const inbox = makeInbox(runtime, { persistence });
    await inbox.ready();
    const resumed = await started(attempts, 1);
    await expect(inbox.accept({ ...first, requestId: randomUUID() })).resolves.toMatchObject({ status: "accepted" });
    expect(inbox.getState(first.messageId)?.attempts).toBe(2);
    expect(inbox.queuedCount).toBe(0);
    resumed.finish();
    await inbox.settled();
    expect(attempts).toHaveLength(1);
  });

  it("fails every message with the Run when the shared count runs out", async () => {
    const { attempts, runtime, steers } = harness();
    const outcomes: SessionMessageRunOutcomeEvent[] = [];
    const inbox = makeInbox(runtime, { outcomes });
    const { message } = conversation();
    const [first, second] = [message("first"), message("second")];
    await inbox.accept(first);
    const attempt = await started(attempts, 1);
    await inbox.accept(second);
    await vi.waitFor(() => expect(steers).toHaveLength(1));
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("running"));
    attempt.finish(rateLimited);
    for (let index = 2; index <= MAX_AUTOMATIC_RETRIES + 1; index += 1) {
      (await started(attempts, index)).finish(rateLimited);
    }
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("failed"));
    await inbox.settled();
    expect(attempts).toHaveLength(MAX_AUTOMATIC_RETRIES + 1);
    expect(inbox.getState(first.messageId)).toMatchObject({
      status: "failed",
      lastError: { code: "provider_rate_limited" },
    });
    expect(outcomes.map(({ messageId, reason }) => [messageId, reason])).toEqual([
      [first.messageId, "provider_rate_limited"],
      [second.messageId, "session_message_steer_interrupted"],
    ]);
    expect(inbox.pendingCount).toBe(0);
  });

  it("fails every message with the Run, without a retry, when the failure is not recoverable", async () => {
    const { attempts, runtime, steers } = harness();
    const inbox = makeInbox(runtime);
    const { message } = conversation();
    const [first, second, carriedLate] = [message("first"), message("second"), message("late")];
    await inbox.accept(first);
    const attempt = await started(attempts, 1);
    await inbox.accept(second);
    await vi.waitFor(() => expect(steers).toHaveLength(1));
    await vi.waitFor(() => expect(inbox.getState(second.messageId)?.status).toBe("running"));
    attempt.finish(rateLimited);
    const retry = await started(attempts, 2);
    await inbox.accept(carriedLate);
    await vi.waitFor(() => expect(inbox.getState(carriedLate.messageId)?.status).toBe("running"));
    retry.finish(new Error("the provider broke"));
    await inbox.settled();
    expect(attempts).toHaveLength(2);
    for (const request of [first, second, carriedLate]) {
      expect(inbox.getState(request.messageId)?.status).toBe("failed");
    }
  });

  it("waits for a message still being steered before it decides what the retry carries", async () => {
    const { attempts, runtime, steerOutcomes, state } = harness();
    const inbox = makeInbox(runtime);
    const { message } = conversation();
    const second = message("second");
    let acknowledge!: () => void;
    steerOutcomes.set(
      "second",
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    await inbox.accept(message("first"));
    const attempt = await started(attempts, 1);
    expect(state.phase).toBe("running");
    await inbox.accept(second);
    await vi.waitFor(() => expect(runtime.steer).toHaveBeenCalled());
    attempt.finish(rateLimited);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(attempts).toHaveLength(1);
    acknowledge();
    const retry = await started(attempts, 2);
    expect(bodies(retry.texts, "first", "second")).toEqual(["first", "second"]);
    retry.finish();
    await inbox.settled();
    expect(inbox.getState(second.messageId)?.status).toBe("succeeded");
  });

  it("gives a retry up when a steer never finishes, and that message follows its own receipt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = new SessionMessageRun(sessionMessageRunId("lead"), async (message, outcome) => {
      settled.push([message.messageId, outcome]);
    });
    const settled: Array<[string, AgentSteerOutcome]> = [];
    const message = conversation().message("late");
    expect(run.reserve(message)).toBe(true);
    const ended = run.endAttempt();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(ended).resolves.toBe(false);
    await run.settle(false);
    expect(run.reserve(conversation().message("after"))).toBe(false);
    run.steered(message, run.id, { outcome: Promise.resolve("interrupted") });
    await vi.waitFor(() => expect(settled).toEqual([[message.messageId, "interrupted"]]));
  });
});

describe("a Session message Run after a crash or restart", () => {
  async function crashed(records: DurableWorkRecord<SessionMessageDeliveryRequestV3>[]) {
    const persistence = new MemoryRuntimeDurabilityStore();
    for (const stored of records) await persistence.write(stored);
    return persistence;
  }

  it("resumes the Run, then steers its messages back with the notice and queued ones without it", async () => {
    const { message } = conversation();
    const [lead, steered, queued] = [message("lead"), message("steered"), message("queued")];
    const runId = sessionMessageRunId(lead.messageId);
    const persistence = await crashed([
      record(lead, "running", { attempts: 1 }),
      record(steered, "running", { joinedRunId: runId }),
      record(queued, "accepted"),
    ]);
    const { attempts, runtime, steers } = harness();
    const inbox = makeInbox(runtime, { persistence });
    await inbox.ready();
    const attempt = await started(attempts, 1);
    expect(attempt.texts[0]).toContain(NOTICE);
    expect(attempt.texts.at(-1)).toBe("lead");
    expect(inbox.getState(lead.messageId)?.attempts).toBe(2);
    await vi.waitFor(() => expect(steers).toHaveLength(2));
    expect(steers.map((steer) => steer.texts.at(-1))).toEqual(["steered", "queued"]);
    expect(steers[0]?.texts[0]).toContain(NOTICE);
    expect(steers[1]?.texts[0]).not.toContain(NOTICE);
    await vi.waitFor(() => expect(inbox.getState(queued.messageId)?.status).toBe("running"));
    expect(inbox.getState(steered.messageId)).toMatchObject({ attempts: 0, joinedRunId: runId });
    attempt.finish();
    await inbox.settled();
    expect(attempts).toHaveLength(1);
    for (const request of [lead, steered, queued]) {
      expect(inbox.getState(request.messageId)?.status).toBe("succeeded");
    }
  });

  it("fails the messages steered into the Run when the crash spends its last retry; queued ones run", async () => {
    const { message } = conversation();
    const [lead, steered, queued] = [message("lead"), message("steered"), message("queued")];
    const persistence = await crashed([
      record(lead, "running", { attempts: MAX_AUTOMATIC_RETRIES }),
      record(steered, "running", { joinedRunId: sessionMessageRunId(lead.messageId) }),
      record(queued, "accepted"),
    ]);
    const outcomes: SessionMessageRunOutcomeEvent[] = [];
    const { attempts, runtime } = harness();
    const inbox = makeInbox(runtime, { persistence, outcomes, now: () => 2_000 });
    await inbox.ready();
    expect(inbox.getState(lead.messageId)?.status).toBe("failed");
    expect(inbox.getState(steered.messageId)).toMatchObject({
      status: "failed",
      lastError: { code: "run_interrupted" },
    });
    expect(outcomes.map(({ messageId }) => messageId).sort()).toEqual([lead.messageId, steered.messageId].sort());
    const own = await started(attempts, 1);
    expect(own.texts.at(-1)).toBe("queued");
    expect(own.texts[0]).not.toContain(NOTICE);
    own.finish();
    await inbox.settled();
    expect(inbox.getState(queued.messageId)?.status).toBe("succeeded");
  });

  it("fails a steered message whose Run already failed before the crash reached it", async () => {
    const { message } = conversation();
    const [lead, steered] = [message("lead"), message("steered")];
    const persistence = await crashed([
      record(lead, "failed", { outcomeReport: "published" }),
      record(steered, "running", { joinedRunId: sessionMessageRunId(lead.messageId) }),
    ]);
    const { attempts, runtime } = harness();
    const inbox = makeInbox(runtime, { persistence });
    await inbox.ready();
    expect(inbox.getState(steered.messageId)?.status).toBe("failed");
    expect(attempts).toHaveLength(0);
  });

  it("runs a steered message on its own, with the notice and a fresh count, when its Run already ended", async () => {
    const { message } = conversation();
    const [lead, steered] = [message("lead"), message("steered")];
    const persistence = await crashed([
      record(lead, "succeeded", { attempts: MAX_AUTOMATIC_RETRIES }),
      record(steered, "running", { joinedRunId: sessionMessageRunId(lead.messageId) }),
    ]);
    const { attempts, runtime } = harness();
    const inbox = makeInbox(runtime, { persistence });
    await inbox.ready();
    const own = await started(attempts, 1);
    expect(own.texts[0]).toContain(NOTICE);
    expect(own.texts.at(-1)).toBe("steered");
    expect(inbox.getState(steered.messageId)).toMatchObject({ status: "running", attempts: 0 });
    expect(inbox.getState(steered.messageId)?.joinedRunId).toBeUndefined();
    // Its own count starts now: it gets the full two retries.
    own.finish(rateLimited);
    (await started(attempts, 2)).finish(rateLimited);
    const last = await started(attempts, 3);
    expect(inbox.getState(steered.messageId)?.attempts).toBe(2);
    last.finish();
    await inbox.settled();
    expect(inbox.getState(steered.messageId)?.status).toBe("succeeded");
  });

  it("runs the messages after the resumed Run, with the notice, when the runtime cannot steer", async () => {
    const { message } = conversation();
    const [lead, steered] = [message("lead"), message("steered")];
    const persistence = await crashed([
      record(lead, "running"),
      record(steered, "running", { joinedRunId: sessionMessageRunId(lead.messageId) }),
    ]);
    const { attempts, runtime } = harness({ steer: "unsupported" });
    const inbox = makeInbox(runtime, { persistence });
    await inbox.ready();
    const resumed = await started(attempts, 1);
    expect(resumed.texts.at(-1)).toBe("lead");
    resumed.finish();
    const own = await started(attempts, 2);
    expect(own.texts[0]).toContain(NOTICE);
    expect(own.texts.at(-1)).toBe("steered");
    own.finish();
    await inbox.settled();
    expect(inbox.getState(steered.messageId)?.status).toBe("succeeded");
  });

  it("leaves steered messages for the next start when the daemon stops, and resumes them there", async () => {
    const persistence = new MemoryRuntimeDurabilityStore();
    const { message } = conversation();
    const [lead, steered] = [message("lead"), message("steered")];
    const before = harness();
    const stopping = makeInbox(before.runtime, { persistence });
    await stopping.accept(lead);
    const attempt = await started(before.attempts, 1);
    await stopping.accept(steered);
    await vi.waitFor(() => expect(stopping.getState(steered.messageId)?.status).toBe("running"));
    stopping.stop();
    attempt.finish(new Error("aborted"));
    await stopping.settled();
    expect(stopping.getState(steered.messageId)?.status).toBe("running");
    expect(stopping.getState(lead.messageId)?.interruption?.reason).toBe("client_shutdown");

    const after = harness();
    const restarted = makeInbox(after.runtime, { persistence });
    await restarted.ready();
    const resumed = await started(after.attempts, 1);
    expect(resumed.texts[0]).toContain("restarted or upgraded");
    await vi.waitFor(() => expect(after.steers).toHaveLength(1));
    expect(after.steers[0]?.texts.at(-1)).toBe("steered");
    await vi.waitFor(() => expect(restarted.getState(steered.messageId)?.interruption).toBeUndefined());
    resumed.finish();
    await restarted.settled();
    expect(restarted.getState(steered.messageId)?.status).toBe("succeeded");
  });

  it("leaves the retry for the next start when the daemon stops during its backoff", async () => {
    const persistence = new MemoryRuntimeDurabilityStore();
    const { message } = conversation();
    const lead = message("lead");
    const before = harness();
    const stopping = makeInbox(before.runtime, { persistence, rateLimitRetryDelayMs: 60_000 });
    await stopping.accept(lead);
    (await started(before.attempts, 1)).finish(rateLimited);
    await vi.waitFor(() => expect(stopping.getState(lead.messageId)?.status).toBe("retryable"));
    stopping.stop();
    await stopping.settled();
    expect(before.attempts).toHaveLength(1);
    expect(stopping.getState(lead.messageId)?.status).toBe("retryable");
  });
});

describe("the ids of a Session message Run", () => {
  it("names the message whose Run it is, and nothing for another kind of Run", () => {
    expect(sessionMessageOfRun(sessionMessageRunId("m1"))).toBe("m1");
    expect(sessionMessageOfRun("turn-1")).toBeUndefined();
  });
});
