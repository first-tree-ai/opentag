import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DirectImMessageDeliveryRequest,
  RUNTIME_CAPABILITY,
  type RuntimeImSteerRequest,
  type SessionRecoverRequest,
} from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../agent-runtime/types.js";
import { AdmissionController } from "../runtime/admission-controller.js";
import { AgentTurnRunner, buildRetryAgentInput } from "../runtime/agent-turn-runner.js";
import { InterruptedWorkRecovery, type InterruptedWorkRecoveryOptions } from "../runtime/interrupted-work-recovery.js";
import {
  buildContinuationNotice,
  MAX_AUTOMATIC_RETRIES,
  MAX_RECORDED_STEERS,
  parseTurnRetryRecord,
  RATE_LIMIT_RETRY_DELAY_MS,
  RETRY_RESET_AFTER_MS,
  RUN_TIME_RECORD_INTERVAL_MS,
  recoverableFailure,
  type TurnRetryRecord,
  TurnRetryStore,
  trackRunTime,
  turnRetryRecord,
} from "../runtime/interruption-retry.js";
import type { RuntimeConnectionState } from "../runtime/runtime-connection.js";
import type { SessionBindingStore } from "../runtime/session-binding-store.js";
import { conversationIdentity } from "../runtime/session-message-run.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import type { SessionRuntimeManager } from "../runtime/session-runtime-manager.js";
import { type LiveTurnOwner, TurnCustodyOwner } from "../runtime/turn-custody-owner.js";
import type { TurnReportOwner } from "../runtime/turn-report-owner.js";
import { UpdateManager, type UpdaterStateSnapshot } from "../runtime/update-manager.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";

const homes: string[] = [];
const realSetTimeout = globalThis.setTimeout;
/** The 429 backoff is short here, unless a test uses fake timers or its own delay. */
let rateLimitDelayMs = 1;

beforeEach(() => {
  rateLimitDelayMs = 1;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(
      handler,
      ms === RATE_LIMIT_RETRY_DELAY_MS ? rateLimitDelayMs : ms,
      ...(rest as []),
    )) as typeof setTimeout);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("interruption classification and continuation", () => {
  it("retries only the recoverable classes", () => {
    for (const reason of ["provider_rate_limited", "client_shutdown", "daemon_crash"]) {
      expect(recoverableFailure(reason)).toBe(reason);
    }
    for (const reason of [
      undefined,
      "turn_timeout",
      "provider_failed",
      "provider_quota_exceeded",
      "provider_authentication_failed",
      "credential_unavailable",
      "provider_start_failed",
      "turn_state_unknown",
    ]) {
      expect(recoverableFailure(reason)).toBeUndefined();
    }
  });

  it("states the reason and how to continue", () => {
    expect(buildContinuationNotice({ reason: "client_shutdown", at: "2026-11-05T01:00:00.000Z" })).toBe(
      "[OpenTag] Your previous turn was interrupted at 2026-11-05T01:00:00.000Z because the OpenTag daemon was restarted or upgraded (automatic retry). Before continuing, check your history and the work already done in this conversation, including replies already sent, then continue the original request. The original request follows; it may duplicate a message already in your history. Do not repeat replies or side effects that already happened.",
    );
    expect(buildContinuationNotice({ reason: "daemon_crash", at: "T" })).toContain(
      "interrupted at or before T because the OpenTag daemon stopped (crash, power loss, restart, or upgrade) (automatic retry).",
    );
    expect(buildContinuationNotice({ reason: "provider_rate_limited", at: "T" })).toContain(
      "(HTTP 429) (automatic retry).",
    );
  });

  it("re-includes the original input and steered messages after the notice", () => {
    const request = delivery();
    const steer = steerRequest(request, "and also this");
    const input = buildRetryAgentInput(request, [steer], { reason: "provider_rate_limited", at: "T" }, new Date(0));
    const texts = input.items.map((item) => (item.type === "text" ? item.text : ""));
    expect(texts[0]).toContain("because the model API rate-limited the request");
    expect(texts).toContain("hello");
    expect(texts.at(-2)).toContain("Messages that arrived during the interrupted turn");
    expect(texts.at(-1)).toContain("and also this");
  });
});

describe("trackRunTime", () => {
  it("records actual running time, and does not count the Computer sleeping", async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const recorded: number[] = [];
    const tracker = trackRunTime(
      () => clock,
      async (ranMs) => {
        recorded.push(ranMs);
      },
    );
    clock += RUN_TIME_RECORD_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(RUN_TIME_RECORD_INTERVAL_MS);
    expect(recorded).toEqual([RUN_TIME_RECORD_INTERVAL_MS]);
    // Eight hours with the lid closed: the next tick arrives that late.
    clock += 8 * 60 * 60_000;
    await vi.advanceTimersByTimeAsync(RUN_TIME_RECORD_INTERVAL_MS);
    expect(recorded[1]).toBeLessThanOrEqual(2 * RUN_TIME_RECORD_INTERVAL_MS);
    // A clock moved backwards adds nothing.
    clock -= 60 * 60_000;
    expect(await tracker.finish()).toBe(0);
  });
});

describe("TurnRetryStore", () => {
  it("keeps one record per Session, updates it for the same Turn, and removes it", async () => {
    const store = new TurnRetryStore(await home());
    expect(await store.list()).toEqual([]);
    const request = delivery();
    expect(await store.appendSteer(steerRequest(request, "before"))).toBe("missing");
    await store.write(turnRetryRecord(request, "turn-1"));
    expect(await store.appendSteer(steerRequest(request, "steered"))).toBe("appended");
    expect(await store.appendSteer(steerRequest(request, "steered"))).toBe("appended");
    expect(
      await store.update(request.sessionId, "other-turn", (record) => ({ ...record, retries: 9 })),
    ).toBeUndefined();
    await store.update(request.sessionId, "turn-1", (record) => ({
      ...record,
      interruption: { reason: "client_shutdown", at: "T" },
    }));
    const [stored] = await store.list();
    expect(stored).toMatchObject({
      turnId: "turn-1",
      retries: 0,
      interruption: { reason: "client_shutdown", at: "T" },
      steers: [expect.objectContaining({ deliveryId: "steer-delivery" })],
    });
    await store.remove(request.sessionId, "other-turn");
    expect(await store.read(request.sessionId)).toBeDefined();
    await store.remove(request.sessionId, "turn-1");
    await store.remove(request.sessionId, "turn-1");
    expect(await store.list()).toEqual([]);
  });
});

describe("TurnRetryStore steer capture", () => {
  it("refuses a steer beyond the bound instead of dropping it, and never reads a partial record", async () => {
    const path = await home();
    const store = new TurnRetryStore(path);
    const request = delivery();
    await store.write(turnRetryRecord(request, "turn-1"));
    for (let index = 0; index < MAX_RECORDED_STEERS; index += 1) {
      expect(await store.appendSteer({ ...steerRequest(request, `s${index}`), deliveryId: randomUUID() })).toBe(
        "appended",
      );
    }
    expect(await store.appendSteer({ ...steerRequest(request, "overflow"), deliveryId: randomUUID() })).toBe("full");
    expect((await store.read(request.sessionId))?.steers).toHaveLength(MAX_RECORDED_STEERS);
    expect(() => parseTurnRetryRecord({ ...turnRetryRecord(request, "t"), steers: [{ type: "im:steer" }] })).toThrow();
    expect(() =>
      parseTurnRetryRecord({
        ...turnRetryRecord(request, "t"),
        steers: Array.from({ length: MAX_RECORDED_STEERS + 1 }, () => steerRequest(request, "x")),
      }),
    ).toThrow();
  });
});

describe("AgentTurnRunner automatic retry", () => {
  it("retries a rate-limited Turn in place with the continuation notice and reports the retry", async () => {
    const h = runnerHarness();
    const acknowledged = steerRequest(h.request, "steered in");
    const deferred = { ...steerRequest(h.request, "deferred, still the Server's"), deliveryId: randomUUID() };
    h.records.set(h.request.sessionId, { ...turnRetryRecord(h.request, "turn-1"), steers: [acknowledged, deferred] });
    h.receipts.push({ kind: "steer", deliveryId: acknowledged.deliveryId, turnId: "turn-1" });
    h.prompt
      .mockImplementationOnce(rateLimited)
      .mockImplementationOnce(async () => ({ runId: "turn-1", status: "completed", output: [] }));
    h.runner.start(owner(h.request));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    const retryItems = promptItems(h.prompt, 1);
    expect(retryItems[0]?.text).toContain("(HTTP 429) (automatic retry)");
    expect(retryItems.at(-1)?.text).toContain("steered in");
    expect(retryItems.at(-1)?.text).not.toContain("deferred, still the Server's");
    expect(h.records.get(h.request.sessionId)).toMatchObject({ retries: 1 });
    expect(h.records.get(h.request.sessionId)?.interruption).toBeUndefined();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), 3);
    expect(h.submit).toHaveBeenCalledOnce();
  });

  it.each([
    ["cannot be read", "unreadable"],
    ["is missing", "missing"],
    ["no longer holds the Turn", "replaced"],
  ] as const)("reports the failure instead of retrying when the Session binding %s", async (_name, scenario) => {
    const h = runnerHarness();
    const steer = steerRequest(h.request, "steered in");
    h.records.set(h.request.sessionId, { ...turnRetryRecord(h.request, "turn-1"), steers: [steer] });
    h.receipts.push({ kind: "steer", deliveryId: steer.deliveryId, turnId: "turn-1" });
    if (scenario === "unreadable") h.bindingRead.mockRejectedValueOnce(new Error("disk"));
    if (scenario === "missing") h.bindingRead.mockResolvedValueOnce(undefined);
    if (scenario === "replaced") {
      h.bindingRead.mockResolvedValueOnce({ recentRecordedInputs: [], unresolvedTurn: undefined });
    }
    h.prompt.mockImplementationOnce(rateLimited);
    h.runner.start(owner(h.request));
    await h.runner.settled();
    // The attempt that held the steer is the only one: no retry can run without the acknowledged input.
    expect(h.prompt).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", errorReason: "provider_rate_limited" }),
      3,
    );
    expect(h.logs).toContainEqual(
      expect.objectContaining({ fields: expect.objectContaining({ code: "TURN_RETRY_STEER_RECEIPTS_UNAVAILABLE" }) }),
    );
  });

  it("retries without consulting the binding when no steer was captured", async () => {
    const h = runnerHarness();
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    h.bindingRead.mockRejectedValue(new Error("disk"));
    h.prompt
      .mockImplementationOnce(rateLimited)
      .mockImplementationOnce(async () => ({ runId: "turn-1", status: "completed", output: [] }));
    h.runner.start(owner(h.request));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(h.bindingRead).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), 3);
  });

  it("retries without a captured steer whose receipt is absent from a readable binding", async () => {
    const h = runnerHarness();
    const steer = steerRequest(h.request, "deferred, still the Server's");
    h.records.set(h.request.sessionId, { ...turnRetryRecord(h.request, "turn-1"), steers: [steer] });
    h.prompt
      .mockImplementationOnce(rateLimited)
      .mockImplementationOnce(async () => ({ runId: "turn-1", status: "completed", output: [] }));
    h.runner.start(owner(h.request));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(promptItems(h.prompt, 1).at(-1)?.text).not.toContain("deferred, still the Server's");
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), 3);
  });

  it.each(["provider steer", "receipt write"] as const)(
    "replays a steer still acknowledging its %s when the Run hits a 429",
    async (slow) => {
      const h = runnerHarness();
      h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
      h.retries.appendSteer = async (steer) => {
        const record = h.records.get(h.request.sessionId) as TurnRetryRecord;
        h.records.set(h.request.sessionId, { ...record, steers: [...record.steers, steer as RuntimeImSteerRequest] });
        return "appended";
      };
      // The steer stays in flight past the Run's end, until the retry starts or a grace period passes.
      let release: () => void = () => undefined;
      const inFlight = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hold = async () => {
        await inFlight;
        return undefined;
      };
      if (slow === "provider steer") h.runtime.steer.mockImplementationOnce(hold);
      else {
        const record = h.recordSteer.getMockImplementation() as (steer: RuntimeImSteerRequest) => Promise<void>;
        h.recordSteer.mockImplementationOnce(async (steer) => {
          await hold();
          await record(steer);
        });
      }
      let endRun: () => void = () => undefined;
      h.prompt
        .mockImplementationOnce(() => {
          h.emit({ type: "run_started", runId: "turn-1" });
          return new Promise<AgentRunResult>((resolve) => {
            endRun = () => {
              setTimeout(release, 30);
              void rateLimited().then(resolve);
            };
          });
        })
        .mockImplementationOnce(async () => {
          release();
          return { runId: "turn-1", status: "completed", output: [] };
        });
      h.runner.start(owner(h.request));
      await vi.waitFor(() =>
        expect(h.updateUnresolved).toHaveBeenCalledWith(expect.anything(), expect.anything(), "turn-1", "running"),
      );
      const answer = h.runner.steer(steerRequest(h.request, "more"));
      await vi.waitFor(() =>
        slow === "provider steer"
          ? expect(h.runtime.steer).toHaveBeenCalled()
          : expect(h.recordSteer).toHaveBeenCalled(),
      );
      endRun();
      await h.runner.settled();
      await expect(answer).resolves.toMatchObject({ status: "steered" });
      expect(h.prompt).toHaveBeenCalledTimes(2);
      expect(promptItems(h.prompt, 1).at(-1)?.text).toContain("more");
    },
  );

  it("reports the failure when an in-flight steer never settles", async () => {
    vi.useFakeTimers();
    const h = runnerHarness();
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    h.runtime.steer.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    let endRun: () => void = () => undefined;
    h.prompt.mockImplementationOnce(() => {
      h.emit({ type: "run_started", runId: "turn-1" });
      return new Promise<AgentRunResult>((resolve) => {
        endRun = () => void rateLimited().then(resolve);
      });
    });
    h.runner.start(owner(h.request));
    await vi.advanceTimersByTimeAsync(0);
    void h.runner.steer(steerRequest(h.request, "more"));
    await vi.advanceTimersByTimeAsync(0);
    endRun();
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_DELAY_MS + 9_999);
    expect(h.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", errorReason: "provider_rate_limited" }),
      3,
    );
    expect(h.logs).toContainEqual(
      expect.objectContaining({ fields: expect.objectContaining({ code: "TURN_RETRY_STEER_UNSETTLED" }) }),
    );
  });

  it("reports the failure when two retries in a row also hit a 429", async () => {
    const h = runnerHarness();
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    h.prompt.mockImplementation(rateLimited);
    h.runner.start(owner(h.request));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(1 + MAX_AUTOMATIC_RETRIES);
    expect(h.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", errorReason: "provider_rate_limited" }),
      3,
    );
  });

  it("waits before retrying a rate-limited Turn", async () => {
    vi.useFakeTimers();
    const h = runnerHarness();
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    h.prompt
      .mockImplementationOnce(async () => ({
        runId: "turn-1",
        status: "failed",
        output: [],
        error: { code: "provider_rate_limited", message: "429" },
      }))
      .mockImplementationOnce(async () => ({ runId: "turn-1", status: "completed", output: [] }));
    h.runner.start(owner(h.request));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.prompt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.prompt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), 3);
  });

  it("does not retry a timeout, non-recoverable failures, spent retries, or Turns without durable input", async () => {
    const providerFailed = async (): Promise<AgentRunResult> => ({
      runId: "turn-1",
      status: "failed",
      output: [],
      error: { code: "provider_error", message: "no" },
    });
    const prompts = {
      turn_timeout: abortedOnSignal,
      provider_failed: providerFailed,
      spent: rateLimited,
      "no-record": rateLimited,
    };
    for (const scenario of ["turn_timeout", "provider_failed", "spent", "no-record"] as const) {
      const h = runnerHarness();
      if (scenario === "turn_timeout") h.request.runtime.budget = { maxDurationMs: 20 };
      if (scenario !== "no-record")
        h.records.set(h.request.sessionId, {
          ...turnRetryRecord(h.request, "turn-1"),
          retries: scenario === "spent" ? MAX_AUTOMATIC_RETRIES : 0,
        });
      h.prompt.mockImplementation(prompts[scenario]);
      h.runner.start(owner(h.request));
      await h.runner.settled();
      expect(h.prompt).toHaveBeenCalledOnce();
      expect(h.create).toHaveBeenCalledOnce();
    }
  });

  it("reports the original failure when the retry state cannot be written", async () => {
    for (const failing of ["interruption", "claim", "removed"] as const) {
      const h = runnerHarness();
      h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
      let writes = 0;
      const update = h.retries.update;
      h.retries.update = async (...args: Parameters<typeof update>) => {
        writes += 1;
        if ((failing === "interruption" && writes === 1) || (failing === "claim" && writes === 2)) {
          throw new Error("disk full");
        }
        if (failing === "removed" && writes === 2) return undefined;
        return update(...args);
      };
      h.prompt.mockImplementation(rateLimited);
      h.runner.start(owner(h.request));
      await h.runner.settled();
      expect(h.prompt).toHaveBeenCalledOnce();
      expect(h.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "failed", errorReason: "provider_rate_limited" }),
        3,
      );
    }
  });

  it("reports a rate-limited Turn when the runner has no durable Turn input at all", async () => {
    const h = runnerHarness({ withoutRetries: true });
    h.prompt.mockImplementationOnce(rateLimited);
    h.runner.start(owner(h.request));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", errorReason: "provider_rate_limited" }),
      3,
    );
  });

  it("does not let the 429 backoff count as run time toward resetting the count", async () => {
    vi.useFakeTimers();
    const h = runnerHarness();
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    // Every attempt runs just short of five minutes, then hits a 429: backoff must not fill the gap.
    const runsFor = 4 * 60_000 + 50_000;
    h.prompt.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, runsFor));
      return rateLimited();
    });
    h.runner.start(owner(h.request));
    await vi.advanceTimersByTimeAsync(10 * (runsFor + RATE_LIMIT_RETRY_DELAY_MS));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(1 + MAX_AUTOMATIC_RETRIES);
    expect(h.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", errorReason: "provider_rate_limited" }),
      3,
    );
  });

  it("resets the count after a retry that actually ran for five minutes", async () => {
    vi.useFakeTimers();
    const h = runnerHarness();
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    const runs = [0, RETRY_RESET_AFTER_MS, 0, 0];
    h.prompt.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, runs.shift() ?? 0));
      return rateLimited();
    });
    h.runner.start(owner(h.request));
    await vi.advanceTimersByTimeAsync(RETRY_RESET_AFTER_MS + 10 * RATE_LIMIT_RETRY_DELAY_MS);
    await h.runner.settled();
    // Retry 1 ran five minutes, so the next failure is retry 1 again, then retry 2, then it is over.
    expect(h.prompt).toHaveBeenCalledTimes(4);
  });

  it("counts run time across attempts against the Run's budget", async () => {
    vi.useFakeTimers();
    const h = runnerHarness();
    h.request.runtime.budget = { maxDurationMs: 100_000 };
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    h.prompt
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return rateLimited();
      })
      .mockImplementationOnce(abortedOnSignal);
    h.runner.start(owner(h.request));
    await vi.advanceTimersByTimeAsync(60_000 + RATE_LIMIT_RETRY_DELAY_MS);
    expect(h.prompt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(h.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await h.runner.settled();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", errorReason: "turn_timeout" }),
      3,
    );
  });

  it("does not let an unreadable record stop a retry's budget", async () => {
    const h = runnerHarness();
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    const update = h.retries.update;
    let reads = 0;
    h.retries.update = async (...args: Parameters<typeof update>) => {
      reads += 1;
      if (reads === 3) throw new Error("disk");
      return update(...args);
    };
    h.prompt.mockImplementationOnce(rateLimited).mockImplementationOnce(async () => ({
      runId: "turn-1",
      status: "completed",
      output: [],
    }));
    h.runner.start(owner(h.request));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
  });

  it("gives a retry its budget even after the ingress deadline passed", async () => {
    rateLimitDelayMs = 30;
    const h = runnerHarness();
    h.request.runtime.budget = { maxDurationMs: 2_000 };
    // The ingress deadline bounds only the first attempt, and passes during the backoff.
    h.request.deadlineAt = new Date(Date.now() + 15).toISOString();
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    h.prompt.mockImplementationOnce(rateLimited).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { runId: "turn-1", status: "completed", output: [] };
    });
    h.runner.start(owner(h.request));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), 3);
  });

  it("leaves a rate-limited Turn for the restarted daemon when the daemon stops during the wait", async () => {
    rateLimitDelayMs = 60_000;
    for (const stopBeforeWait of [false, true]) {
      const h = runnerHarness({ restartRetry: true });
      h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
      h.prompt.mockImplementation(async () => {
        if (stopBeforeWait) h.runner.stop();
        return {
          runId: "turn-1",
          status: "failed",
          output: [],
          error: { code: "provider_rate_limited", message: "429" },
        };
      });
      h.runner.start(owner(h.request));
      await vi.waitFor(() => expect(h.records.get(h.request.sessionId)?.interruption).toBeDefined());
      h.runner.stop();
      await h.runner.settled();
      expect(h.prompt).toHaveBeenCalledOnce();
      expect(h.create).not.toHaveBeenCalled();
      expect(h.records.get(h.request.sessionId)).toMatchObject({
        // A 429 is counted when it fails; a process interruption is counted by the restarted daemon.
        retries: stopBeforeWait ? 0 : 1,
        interruption: { reason: stopBeforeWait ? "client_shutdown" : "provider_rate_limited" },
      });
    }
  });

  it("leaves a Turn interrupted by an orderly stop for the restarted daemon", async () => {
    // Shutdown disconnects (clearing negotiation) before the Turn settles: the start-time answer counts.
    let negotiated = true;
    const h = runnerHarness({ restartRetry: () => negotiated });
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.prompt.mockImplementation((input) => {
      started();
      return abortedOnSignal(input);
    });
    h.runner.start(owner(h.request));
    await running;
    negotiated = false;
    h.runner.stop();
    await h.runner.settled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.markReporting).not.toHaveBeenCalled();
    expect(h.records.get(h.request.sessionId)).toMatchObject({
      retries: 0,
      interruption: { reason: "client_shutdown" },
    });
  });

  it("reports an orderly stop as cancelled when the Server cannot recover Sessions", async () => {
    const h = runnerHarness({ restartRetry: false });
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.prompt.mockImplementation((input) => {
      started();
      return abortedOnSignal(input);
    });
    h.runner.start(owner(h.request));
    await running;
    h.runner.stop();
    await h.runner.settled();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "cancelled", errorReason: "client_shutdown" }),
      3,
    );
  });

  it("starts a restart retry with the continuation notice and without moving the custody phase back", async () => {
    const h = runnerHarness();
    h.records.set(h.request.sessionId, { ...turnRetryRecord(h.request, "turn-1"), retries: 1 });
    h.runner.start(owner(h.request), { continuation: { reason: "daemon_crash", at: "T" } });
    await h.runner.settled();
    const items = promptItems(h.prompt, 0);
    expect(items[0]?.text).toContain("interrupted at or before T");
    expect(h.updateUnresolved).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "turn-1", "starting");
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), 3);
  });
});

describe("an automatic upgrade interrupting an IM Turn", () => {
  it("stops the running Turn without a report, and the restarted daemon resumes it with the upgrade notice", async () => {
    const h = runnerHarness({ restartRetry: true });
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.prompt.mockImplementation((input) => {
      started();
      return abortedOnSignal(input);
    });
    h.runner.start(owner(h.request));
    await running;

    let state: UpdaterStateSnapshot | undefined;
    const handedOff = new Promise<void>((resolve) => {
      const updater = new UpdateManager({
        channel: "staging",
        currentVersion: "0.0.2",
        canInterruptWork: () => true,
        protectedWork: () => ({ total: h.runner.activeCount }),
        executeUpdate: async () => undefined,
        onHandoff: () => {
          h.runner.stop();
          updater.stop();
          resolve();
        },
        loadState: async () => state,
        saveState: async (next) => {
          state = structuredClone(next);
        },
      });
      updater.observe({ channel: "staging", version: "0.0.3" });
    });
    await handedOff;
    await h.runner.settled();
    expect(state?.state).toBe("installed");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.markReporting).not.toHaveBeenCalled();
    const interrupted = h.records.get(h.request.sessionId);
    expect(interrupted).toMatchObject({ retries: 0, interruption: { reason: "client_shutdown" } });

    const restarted = recoveryFixture();
    restarted.records.set(h.request.sessionId, interrupted as TurnRetryRecord);
    restarted.unresolved.set(h.request.sessionId, {
      turnId: "turn-1",
      deliveryId: h.request.deliveryId,
      phase: "running",
    });
    await restarted.recovery.start();
    restarted.version = 1;
    restarted.setState("registered");
    const frame = restarted.sent[0] as SessionRecoverRequest;
    restarted.recovery.handleResult({
      type: "session:recover:result",
      requestId: frame.requestId,
      sessionId: h.request.sessionId,
      status: "scheduled",
    });
    const turn = { deliveryId: h.request.deliveryId, turnId: "turn-1" };
    expect(await restarted.recovery.resume(h.request.sessionId, turn)).toBe(true);
    expect(restarted.custody.resume).toHaveBeenCalledExactlyOnceWith(h.request, "turn-1", {
      continuation: expect.objectContaining({ reason: "client_shutdown" }),
      steers: [],
    });
    restarted.recovery.stop();
  });
});

describe("TurnCustodyOwner automatic retry custody", () => {
  it("records durable input on acceptance, resumes the Turn, and removes the input when recorded", async () => {
    const request = delivery();
    const retries = { write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
    const start = vi.fn();
    const reconciler = new SessionReconciler({ installationId: "installation" });
    const recordResult = vi.fn(async () => undefined);
    const custody = new TurnCustodyOwner({
      bindingStore: { recordResult } as unknown as SessionBindingStore,
      reconciler,
      retries,
      start,
    });
    expect(custody.resume(request, "turn-1", { continuation: { reason: "daemon_crash", at: "T" } })).toBe(true);
    expect(start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ turnId: "turn-1", request }),
      expect.objectContaining({ continuation: { reason: "daemon_crash", at: "T" } }),
    );
    expect(reconciler.protectedWorkSnapshot().activities).toEqual([
      expect.objectContaining({ sessionId: request.sessionId, turnId: "turn-1", phase: "running" }),
    ]);
    // A second resume of the same Turn, or another Turn in a busy Session, does not start.
    expect(custody.resume(request, "turn-1", { continuation: { reason: "daemon_crash", at: "T" } })).toBe(false);
    expect(
      custody.resume({ ...request, deliveryId: "other" }, "turn-2", {
        continuation: { reason: "daemon_crash", at: "T" },
      }),
    ).toBe(false);
    await custody.recordResult("turn-1", "a".repeat(64));
    expect(retries.remove).toHaveBeenCalledExactlyOnceWith(request.sessionId, "turn-1");
    expect(custody.admission.snapshot().sessions).toBe(0);
  });
});

describe("AgentTurnRunner steer capture", () => {
  it("captures a steer in the retry input before steering, and leaves it with the Server otherwise", async () => {
    for (const capture of ["appended", "full", "missing", "failed"] as const) {
      const h = runnerHarness();
      h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
      const order: string[] = [];
      h.retries.appendSteer = async () => {
        order.push("capture");
        if (capture === "failed") throw new Error("disk full");
        return capture;
      };
      let finish: () => void = () => undefined;
      h.prompt.mockImplementation(
        () =>
          new Promise<AgentRunResult>((resolve) => {
            finish = () => resolve({ runId: "turn-1", status: "completed", output: [] });
            h.emit({ type: "run_started", runId: "turn-1" } as never);
          }),
      );
      h.runtime.steer.mockImplementation(async () => {
        order.push("steer");
      });
      h.runner.start(owner(h.request));
      await vi.waitFor(() => expect(h.prompt).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(h.updateUnresolved).toHaveBeenCalledWith(expect.anything(), expect.anything(), "turn-1", "running"),
      );
      const result = await h.runner.steer(steerRequest(h.request, "more"));
      finish();
      await h.runner.settled();
      if (capture === "appended") {
        expect(result).toMatchObject({ status: "steered" });
        expect(order).toEqual(["capture", "steer"]);
      } else {
        expect(result).toMatchObject({
          status: "deferred",
          reason: capture === "full" ? "steer_unsupported" : "turn_not_running",
        });
        expect(order).toEqual(["capture"]);
      }
    }
  });
});

describe("AgentTurnRunner steer custody", () => {
  it.each(["provider", "receipt"] as const)(
    "drops a captured steer whose %s step failed, so a later retry never replays it",
    async (failing) => {
      const h = runnerHarness();
      h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
      const captured: RuntimeImSteerRequest[] = [];
      h.retries.appendSteer = async (steer?: RuntimeImSteerRequest) => {
        if (steer) captured.push(steer);
        return "appended";
      };
      // Even when removal fails too, the missing receipt keeps the steer out of the retry input.
      h.retries.removeSteer.mockRejectedValueOnce(new Error("disk full"));
      if (failing === "provider") h.runtime.steer.mockRejectedValueOnce(new Error("provider closed"));
      else h.recordSteer.mockRejectedValueOnce(new Error("disk full"));
      let finish: () => void = () => undefined;
      h.prompt.mockImplementation(
        () =>
          new Promise<AgentRunResult>((resolve) => {
            finish = () => resolve({ runId: "turn-1", status: "completed", output: [] });
            h.emit({ type: "run_started", runId: "turn-1" } as never);
          }),
      );
      h.runner.start(owner(h.request));
      await vi.waitFor(() =>
        expect(h.updateUnresolved).toHaveBeenCalledWith(expect.anything(), expect.anything(), "turn-1", "running"),
      );
      const steer = steerRequest(h.request, "more");
      await expect(h.runner.steer(steer)).resolves.toMatchObject({ status: "deferred", reason: "steer_state_unknown" });
      expect(h.retries.removeSteer).toHaveBeenCalledWith(steer);
      finish();
      await h.runner.settled();
      // Crash after the deferred answer: the restart keeps only acknowledged steers.
      const f = recoveryFixture();
      f.records.set(h.request.sessionId, { ...turnRetryRecord(h.request, "turn-1"), steers: captured });
      f.unresolved.set(h.request.sessionId, {
        turnId: "turn-1",
        deliveryId: h.request.deliveryId,
        phase: "running",
        recentRecordedInputs: h.receipts,
      });
      await f.recovery.start();
      f.version = 1;
      await f.recovery.resume(h.request.sessionId, { deliveryId: h.request.deliveryId, turnId: "turn-1" });
      expect(f.custody.resume).toHaveBeenCalledWith(h.request, "turn-1", expect.objectContaining({ steers: [] }));
      f.recovery.stop();
    },
  );

  it("leaves the Turn to report recovery when a restart cannot read its Session binding", async () => {
    const request = delivery();
    const steer = steerRequest(request, "acknowledged");
    const f = recoveryFixture();
    f.records.set(request.sessionId, { ...turnRetryRecord(request, "turn-1"), steers: [steer] });
    f.unresolved.set(request.sessionId, {
      turnId: "turn-1",
      deliveryId: request.deliveryId,
      phase: "running",
      recentRecordedInputs: [{ kind: "steer", deliveryId: steer.deliveryId, turnId: "turn-1" }],
    });
    vi.spyOn(f.unresolved, "has").mockImplementationOnce(() => {
      throw new Error("disk");
    });
    await f.recovery.start();
    f.version = 1;
    expect(f.recovery.isPendingRetry(request.sessionId, "turn-1")).toBe(false);
    expect(await f.recovery.resume(request.sessionId, { deliveryId: request.deliveryId, turnId: "turn-1" })).toBe(
      false,
    );
    expect(f.custody.resume).not.toHaveBeenCalled();
    expect(f.records.get(request.sessionId)?.retries).toBe(0);
    f.recovery.stop();
  });

  it("does not resume a captured steer's Turn after a restart when its Session binding is missing", async () => {
    const request = delivery();
    const f = recoveryFixture();
    f.records.set(request.sessionId, {
      ...turnRetryRecord(request, "turn-1"),
      steers: [steerRequest(request, "acknowledged")],
    });
    await f.recovery.start();
    f.version = 1;
    expect(await f.recovery.resume(request.sessionId, { deliveryId: request.deliveryId, turnId: "turn-1" })).toBe(
      false,
    );
    expect(f.custody.resume).not.toHaveBeenCalled();
    expect(f.records.has(request.sessionId)).toBe(false);
    f.recovery.stop();
  });

  it("replays an acknowledged steer after a restart", async () => {
    const request = delivery();
    const steer = steerRequest(request, "acknowledged");
    const f = recoveryFixture();
    f.records.set(request.sessionId, { ...turnRetryRecord(request, "turn-1"), steers: [steer] });
    f.unresolved.set(request.sessionId, {
      turnId: "turn-1",
      deliveryId: request.deliveryId,
      phase: "running",
      recentRecordedInputs: [{ kind: "steer", deliveryId: steer.deliveryId, turnId: "turn-1" }],
    });
    await f.recovery.start();
    f.version = 1;
    await f.recovery.resume(request.sessionId, { deliveryId: request.deliveryId, turnId: "turn-1" });
    expect(f.custody.resume).toHaveBeenCalledWith(request, "turn-1", expect.objectContaining({ steers: [steer] }));
    f.recovery.stop();
  });
});

describe("InterruptedWorkRecovery resume refusal", () => {
  it("keeps the pending retry when custody cannot start it, asks again, and resumes later", async () => {
    vi.useFakeTimers();
    const f = recoveryFixture();
    const request = delivery();
    f.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    f.version = 1;
    f.setState("registered");
    const turn = { deliveryId: request.deliveryId, turnId: "turn-1" };
    const frame = f.sent[0] as SessionRecoverRequest;
    f.recovery.handleResult({
      type: "session:recover:result",
      requestId: frame.requestId,
      sessionId: request.sessionId,
      status: "scheduled",
    });
    f.custody.resume.mockReturnValueOnce(false);
    expect(await f.recovery.resume(request.sessionId, turn)).toBe(false);
    // Still pending: the ordinary recovery path does not report it, and another reconcile is requested.
    expect(f.recovery.isPendingRetry(request.sessionId, "turn-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sent).toHaveLength(2);
    expect(await f.recovery.resume(request.sessionId, turn)).toBe(true);
    expect(f.recovery.isPendingRetry(request.sessionId, "turn-1")).toBe(false);
    expect(f.inbox.failAwaitingPreparation).not.toHaveBeenCalled();
    f.recovery.stop();
  });
});

describe("TurnCustodyOwner acceptance with retry input", () => {
  it("rejects and undoes the acceptance when the retry input cannot be written", async () => {
    const home_ = await home();
    const { SessionBindingStore } = await import("../runtime/session-binding-store.js");
    const { AgentWorkspaceManager } = await import("../runtime/agent-workspace.js");
    const bindingStore = new SessionBindingStore({ home: home_, providerArtifactIdentity: () => "a".repeat(64) });
    const reconciler = new SessionReconciler({
      installationId: "00000000-0000-4000-8000-000000000001",
      preparation: new AgentWorkspaceManager({ home: home_, bindingStore }),
    });
    const request = delivery();
    await reconciler.reconcile({
      type: "session:reconcile",
      requestId: randomUUID(),
      installationId: "00000000-0000-4000-8000-000000000001",
      sessionId: request.sessionId,
      agentId: request.agentId,
      placementGeneration: 1,
      desired: "ready",
      runtime: request.runtime,
    });
    const write = vi.fn(async (): Promise<void> => {
      throw new Error("disk full");
    });
    const custody = new TurnCustodyOwner({
      bindingStore,
      reconciler,
      retries: { write, remove: vi.fn(async () => undefined) },
    });
    const decision = await custody.accept(request);
    expect(decision.result).toMatchObject({ status: "rejected", reason: "provider_unavailable" });
    expect(write).toHaveBeenCalledOnce();
    // Nothing is left behind: no unresolved custody, no reservation, and a later redelivery is accepted.
    expect((await bindingStore.read(request.agentId, request.sessionId))?.unresolvedTurn).toBeUndefined();
    expect(custody.admission.snapshot().sessions).toBe(0);
    write.mockImplementation(async () => undefined);
    const again = await custody.accept({ ...request, requestId: randomUUID() });
    expect(again.result).toMatchObject({ status: "accepted" });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it.each(["throws", "refuses"] as const)(
    "keeps and owns the Turn without a retry when the rollback %s",
    async (rollback) => {
      const request = delivery();
      const discardAccepted = vi.fn(async (): Promise<boolean> => {
        if (rollback === "throws") throw new Error("disk full");
        return false;
      });
      const unavailable = vi.fn();
      const reconciler = new SessionReconciler({ installationId: "installation" });
      vi.spyOn(reconciler, "checkDelivery").mockReturnValue(undefined);
      const custody = new TurnCustodyOwner({
        bindingStore: {
          recordAccepted: vi.fn(async () => ({ status: "committed", unresolvedTurn: { turnId: "turn-x" } })),
          discardAccepted,
        } as unknown as SessionBindingStore,
        id: () => "turn-x",
        reconciler,
        retries: {
          write: vi.fn(async () => {
            throw new Error("disk full");
          }),
          remove: vi.fn(async () => undefined),
        },
        onRetryInputUnavailable: unavailable,
      });
      const decision = await custody.accept(request);
      // The durable custody could not be undone, so it is acknowledged and owned, not abandoned.
      expect(decision.result).toMatchObject({ status: "accepted", turnId: "turn-x" });
      expect(discardAccepted).toHaveBeenCalledOnce();
      expect(unavailable).toHaveBeenCalledExactlyOnceWith(request, "turn-x");
      expect(custody.getTurn("turn-x")).toBeDefined();
      expect(custody.admission.snapshot().sessions).toBe(1);
    },
  );
});

describe("InterruptedWorkRecovery", () => {
  it("counts the retry on startup, asks the Server to recover, and resumes on the ready reconcile", async () => {
    const f = recoveryFixture();
    const request = delivery();
    f.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    // Counted, not begun: the record says so until the retry starts.
    expect(f.records.get(request.sessionId)).toMatchObject({
      retries: 1,
      retryNotStarted: true,
      interruption: { reason: "daemon_crash" },
    });
    expect(f.reconciler.setRecovery).toHaveBeenCalledWith(request.sessionId, {
      deliveryId: request.deliveryId,
      turnId: "turn-1",
    });
    const turn = { deliveryId: request.deliveryId, turnId: "turn-1" };
    // Until the connection negotiates recovery, nothing is pending (an older Server reports instead).
    expect(f.recovery.isPendingRetry(request.sessionId, "turn-1")).toBe(false);
    f.version = 1;
    expect(f.recovery.pending(request.sessionId, turn)).toBe(true);
    expect(f.recovery.pendingCount).toBe(1);

    f.inbox.awaiting = [{ sessionId: "child-session", agentId: request.agentId, placementGeneration: 1 }];
    f.setState("registered");
    expect(f.sent).toEqual([
      expect.objectContaining({ type: "session:recover", sessionId: "child-session", agentId: request.agentId }),
      expect.objectContaining({
        type: "session:recover",
        sessionId: request.sessionId,
        deliveryId: request.deliveryId,
        turnId: "turn-1",
      }),
    ]);
    const visibleFrame = f.sent[1] as SessionRecoverRequest;
    f.recovery.handleResult({
      type: "session:recover:result",
      requestId: visibleFrame.requestId,
      sessionId: request.sessionId,
      status: "scheduled",
    });
    expect(await f.recovery.resume(request.sessionId, turn)).toBe(true);
    expect(f.custody.resume).toHaveBeenCalledExactlyOnceWith(request, "turn-1", {
      continuation: expect.objectContaining({ reason: "daemon_crash" }),
      steers: [],
    });
    expect(f.recovery.pending(request.sessionId, turn)).toBe(false);
    // The reason goes to the resumed Turn's notice; on disk it would be taken for what ended that Turn.
    await vi.waitFor(() => expect(f.records.get(request.sessionId)?.retryNotStarted).toBeUndefined());
    expect(f.records.get(request.sessionId)?.interruption).toBeUndefined();
    // Waiting Session messages are released by the resume, to be steered into the resumed Turn.
    expect(f.inbox.sessionPrepared).toHaveBeenCalledWith(request.sessionId);

    const childFrame = f.sent[0] as SessionRecoverRequest;
    f.recovery.handleResult({
      type: "session:recover:result",
      requestId: childFrame.requestId,
      sessionId: "child-session",
      status: "rejected",
      reason: "session_ended",
    });
    await vi.waitFor(() =>
      expect(f.inbox.failAwaitingPreparation).toHaveBeenCalledWith("child-session", "session_ended"),
    );
    f.recovery.stop();
  });

  it("does not spend a retry on restarts while the retry never began", async () => {
    const records = new Map<string, TurnRetryRecord>();
    const request = delivery();
    records.set(request.sessionId, {
      ...turnRetryRecord(request, "turn-1"),
      interruption: { reason: "provider_rate_limited", at: "T" },
      retries: 1,
    });
    for (let start = 0; start < 4; start += 1) {
      const f = recoveryFixture(records);
      f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
      await f.recovery.start();
      expect(f.inbox.failJoinedRun).not.toHaveBeenCalled();
      f.recovery.stop();
    }
    // The reason survives too, for the notice of the retry that finally runs.
    expect(records.get(request.sessionId)).toMatchObject({
      retries: 1,
      interruption: { reason: "provider_rate_limited" },
    });
  });

  it("tells the inbox which conversation a Turn ended in when its retries run out", async () => {
    const records = new Map<string, TurnRetryRecord>();
    const request = delivery();
    records.set(request.sessionId, { ...turnRetryRecord(request, "turn-1"), retries: 3 });
    const f = recoveryFixture(records);
    f.version = 1;
    const runtimeBinding = { providerId: "claude-code", schemaVersion: 1, payload: { sessionId: "session-1" } };
    f.unresolved.set(request.sessionId, {
      turnId: "turn-1",
      deliveryId: request.deliveryId,
      phase: "running",
      runtimeBinding,
    });
    await f.recovery.start();
    expect(f.inbox.failJoinedRun).toHaveBeenCalledWith("turn-1", conversationIdentity(runtimeBinding));
  });

  it("counts an interruption of a retry that began, and stops after the second", async () => {
    const records = new Map<string, TurnRetryRecord>();
    const request = delivery();
    records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    const turn = { deliveryId: request.deliveryId, turnId: "turn-1" };
    for (const retries of [1, 2]) {
      const f = recoveryFixture(records);
      f.version = 1;
      f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
      await f.recovery.start();
      expect(records.get(request.sessionId)?.retries).toBe(retries);
      expect(await f.recovery.resume(request.sessionId, turn)).toBe(true);
      await vi.waitFor(() => expect(records.get(request.sessionId)?.retryNotStarted).toBeUndefined());
      f.recovery.stop();
    }
    const f = recoveryFixture(records);
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    expect(f.inbox.failJoinedRun).toHaveBeenCalledWith("turn-1", undefined);
    f.recovery.stop();
  });

  it("records that the retry began before the Turn starts, so an immediate crash still counts", async () => {
    const records = new Map<string, TurnRetryRecord>();
    const request = delivery();
    records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    const turn = { deliveryId: request.deliveryId, turnId: "turn-1" };
    for (const retries of [1, 2]) {
      const f = recoveryFixture(records);
      f.version = 1;
      f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
      await f.recovery.start();
      expect(records.get(request.sessionId)).toMatchObject({ retries, retryNotStarted: true });
      let onDiskAtStart: TurnRetryRecord | undefined;
      f.custody.resume.mockImplementation(() => {
        onDiskAtStart = records.get(request.sessionId);
        return true;
      });
      expect(await f.recovery.resume(request.sessionId, turn)).toBe(true);
      expect(onDiskAtStart?.retryNotStarted).toBeUndefined();
      f.recovery.stop();
    }
    const f = recoveryFixture(records);
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    expect(f.inbox.failJoinedRun).toHaveBeenCalledWith("turn-1", undefined);
    f.recovery.stop();
  });

  it("does not start a retry whose start can't be recorded, across restarts, and starts it once it can", async () => {
    const records = new Map<string, TurnRetryRecord>();
    const request = delivery();
    records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    const turn = { deliveryId: request.deliveryId, turnId: "turn-1" };
    for (let restart = 0; restart < 2; restart += 1) {
      const f = recoveryFixture(records);
      f.version = 1;
      f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
      await f.recovery.start();
      f.retries.update.mockRejectedValueOnce(new Error("disk full"));
      expect(await f.recovery.resume(request.sessionId, turn)).toBe(false);
      expect(f.custody.resume).not.toHaveBeenCalled();
      expect(f.inbox.failJoinedRun).not.toHaveBeenCalled();
      expect(f.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: "TURN_RETRY_START_NOT_RECORDED" }),
        expect.any(String),
      );
      expect(f.recovery.pending(request.sessionId, turn)).toBe(true);
      f.recovery.stop();
    }
    // It never ran, so the two restarts spent nothing.
    expect(records.get(request.sessionId)).toMatchObject({ retries: 1, retryNotStarted: true });
    const f = recoveryFixture(records);
    f.version = 1;
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    expect(await f.recovery.resume(request.sessionId, turn)).toBe(true);
    expect(records.get(request.sessionId)).toMatchObject({ retries: 1 });
    expect(records.get(request.sessionId)?.retryNotStarted).toBeUndefined();
    f.recovery.stop();
  });

  it("does not start a retry when the real store has no record to update, and keeps it pending", async () => {
    const store = new TurnRetryStore(await home());
    const request = delivery();
    await store.write(turnRetryRecord(request, "turn-1"));
    const f = recoveryFixture();
    f.version = 1;
    f.retries.list = () => store.list();
    f.retries.write = (record) => store.write(record);
    f.retries.update.mockImplementation((sessionId, turnId, change) => store.update(sessionId, turnId, change));
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    await store.remove(request.sessionId);

    const turn = { deliveryId: request.deliveryId, turnId: "turn-1" };
    expect(await f.recovery.resume(request.sessionId, turn)).toBe(false);
    expect(f.custody.resume).not.toHaveBeenCalled();
    expect(f.recovery.pending(request.sessionId, turn)).toBe(true);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TURN_RETRY_START_NOT_RECORDED" }),
      expect.any(String),
    );
    // Another Turn's record is no record for this one, and it stays as it was.
    await store.write(turnRetryRecord(request, "turn-2"));
    expect(await f.recovery.resume(request.sessionId, turn)).toBe(false);
    expect(f.custody.resume).not.toHaveBeenCalled();
    expect(await store.read(request.sessionId)).toEqual(turnRetryRecord(request, "turn-2"));
    f.recovery.stop();
  });

  it("puts a refused retry back to waiting, keeping its reason, so a restart doesn't count it", async () => {
    const f = recoveryFixture();
    f.version = 1;
    const request = delivery();
    f.records.set(request.sessionId, {
      ...turnRetryRecord(request, "turn-1"),
      interruption: { reason: "provider_rate_limited", at: "T" },
      retries: 1,
    });
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    f.custody.resume.mockReturnValue(false);
    const turn = { deliveryId: request.deliveryId, turnId: "turn-1" };
    expect(await f.recovery.resume(request.sessionId, turn)).toBe(false);
    expect(f.records.get(request.sessionId)).toMatchObject({
      retries: 1,
      retryNotStarted: true,
      interruption: { reason: "provider_rate_limited" },
    });
    // If even that write fails, the worst case is one extra count on the next restart.
    f.retries.update.mockImplementationOnce(f.retries.update.getMockImplementation() as never);
    f.retries.update.mockRejectedValueOnce(new Error("disk full"));
    expect(await f.recovery.resume(request.sessionId, turn)).toBe(false);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TURN_RETRY_WAIT_NOT_RECORDED" }),
      expect.any(String),
    );
    f.recovery.stop();
  });

  it("does not start the retry when the daemon stops during the write", async () => {
    const f = recoveryFixture();
    f.version = 1;
    const request = delivery();
    f.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    const resumed = f.recovery.resume(request.sessionId, { deliveryId: request.deliveryId, turnId: "turn-1" });
    f.recovery.stop();
    expect(await resumed).toBe(false);
    expect(f.custody.resume).not.toHaveBeenCalled();
    expect(f.records.get(request.sessionId)).toMatchObject({ retries: 1, retryNotStarted: true });
  });

  it("starts nothing once stopped, and settles only when a write in flight has rolled back", async () => {
    const f = recoveryFixture();
    f.version = 1;
    const request = delivery();
    f.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    const turn = { deliveryId: request.deliveryId, turnId: "turn-1" };
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = f.retries.update.getMockImplementation() as NonNullable<
      ReturnType<typeof f.retries.update.getMockImplementation>
    >;
    f.retries.update.mockImplementationOnce(async (...args) => {
      await blocked;
      return write(...args);
    });
    const resumed = f.recovery.resume(request.sessionId, turn);
    f.recovery.stop();
    let settled = false;
    const settling = f.recovery.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await settling;
    expect(await resumed).toBe(false);
    expect(f.custody.resume).not.toHaveBeenCalled();
    expect(f.records.get(request.sessionId)).toMatchObject({ retries: 1, retryNotStarted: true });
    // Nothing starts after the stop, and the store isn't touched either.
    f.retries.update.mockClear();
    expect(await f.recovery.resume(request.sessionId, turn)).toBe(false);
    expect(f.retries.update).not.toHaveBeenCalled();
  });

  it("stays the owner after `scheduled` until the ready reconcile prepares the Session", async () => {
    vi.useFakeTimers();
    const f = recoveryFixture();
    f.version = 1;
    f.inbox.awaiting = [
      { sessionId: "child-a", agentId: "agent-1", placementGeneration: 1 },
      { sessionId: "child-b", agentId: "agent-1", placementGeneration: 1 },
      { sessionId: "child-c", agentId: "agent-1", placementGeneration: 1 },
    ];
    f.setState("registered");
    const scheduled = (sessionId: string) => {
      const frame = (f.sent as SessionRecoverRequest[]).filter((sent) => sent.sessionId === sessionId).at(-1);
      if (!frame) throw new Error(`no frame for ${sessionId}`);
      f.recovery.handleResult({
        type: "session:recover:result",
        requestId: frame.requestId,
        sessionId,
        status: "scheduled",
      });
    };
    for (const sessionId of ["child-a", "child-b", "child-c"]) scheduled(sessionId);
    // child-a: its ready reconcile prepares it.
    f.recovery.sessionPrepared("child-a");
    expect(f.inbox.sessionPrepared).toHaveBeenCalledWith("child-a");
    // child-b: the ready reconcile is refused.
    f.recovery.reconcileRejected("child-b", "session_binding_conflict");
    await vi.waitFor(() =>
      expect(f.inbox.failAwaitingPreparation).toHaveBeenCalledWith("child-b", "session_binding_conflict"),
    );
    // child-c: the reconcile never arrives, so the request is sent again and finally given up.
    const before = (f.sent as SessionRecoverRequest[]).filter((sent) => sent.sessionId === "child-c").length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect((f.sent as SessionRecoverRequest[]).filter((sent) => sent.sessionId === "child-c").length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(40_000 * 30);
    expect(f.inbox.failAwaitingPreparation).toHaveBeenCalledWith("child-c", "session_recovery_timeout");
    // Settled requests are gone: late reconciles change nothing.
    f.recovery.reconcileRejected("child-a", "late");
    expect(f.inbox.failAwaitingPreparation).not.toHaveBeenCalledWith("child-a", expect.anything());
    f.recovery.stop();
  });

  it("gives waiting Session messages up when the resumed Turn cannot be prepared", async () => {
    const f = recoveryFixture();
    const request = delivery();
    f.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    f.version = 1;
    f.setState("registered");
    f.recovery.abandon(
      request.sessionId,
      { deliveryId: request.deliveryId, turnId: "turn-1" },
      "configuration_conflict",
    );
    await vi.waitFor(() =>
      expect(f.inbox.failAwaitingPreparation).toHaveBeenCalledWith(request.sessionId, "configuration_conflict"),
    );
    expect(f.recovery.isPendingRetry(request.sessionId, "turn-1")).toBe(false);
    f.recovery.stop();
  });

  it("keeps an orderly stop's reason, counts a Turn's retries, and leaves reporting Turns to report recovery", async () => {
    const f = recoveryFixture();
    const stopped = delivery("session-stopped");
    const spent = delivery("session-spent");
    const reporting = delivery("session-reporting");
    const recorded = delivery("session-recorded");
    f.records.set(stopped.sessionId, {
      ...turnRetryRecord(stopped, "turn-stopped"),
      interruption: { reason: "client_shutdown", at: "T" },
    });
    f.records.set(spent.sessionId, { ...turnRetryRecord(spent, "turn-spent"), retries: 1 });
    f.records.set(reporting.sessionId, turnRetryRecord(reporting, "turn-reporting"));
    f.records.set(recorded.sessionId, turnRetryRecord(recorded, "turn-recorded"));
    f.unresolved.set(reporting.sessionId, {
      turnId: "turn-reporting",
      deliveryId: reporting.deliveryId,
      phase: "reporting",
    });
    f.unresolved.set(stopped.sessionId, { turnId: "turn-stopped", deliveryId: stopped.deliveryId, phase: "running" });
    f.unresolved.set(spent.sessionId, { turnId: "turn-spent", deliveryId: spent.deliveryId, phase: "running" });
    await f.recovery.start();
    f.version = 1;
    expect(f.records.get(stopped.sessionId)).toMatchObject({ retries: 1, retryNotStarted: true });
    expect(f.recovery.isPendingRetry(stopped.sessionId, "turn-stopped")).toBe(true);
    expect(f.records.get(spent.sessionId)).toMatchObject({ retries: 2 });
    expect(f.recovery.isPendingRetry(spent.sessionId, "turn-spent")).toBe(true);
    expect(f.recovery.isPendingRetry(reporting.sessionId, "turn-reporting")).toBe(false);
    expect(f.records.has(recorded.sessionId)).toBe(false);
    expect(f.reconciler.setRecovery).toHaveBeenCalledTimes(2);
    // The recorded reason still reaches the resumed Turn's notice.
    await f.recovery.resume(stopped.sessionId, { deliveryId: stopped.deliveryId, turnId: "turn-stopped" });
    expect(f.custody.resume).toHaveBeenCalledWith(
      stopped,
      "turn-stopped",
      expect.objectContaining({ continuation: { reason: "client_shutdown", at: "T" } }),
    );
  });

  it("falls back to failure reporting when the Server cannot recover or never answers", async () => {
    vi.useFakeTimers();
    const f = recoveryFixture();
    const request = delivery();
    f.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "starting" });
    await f.recovery.start();
    // An older Server: nothing pending, every waiting Session message fails with a notice.
    f.inbox.awaiting = [{ sessionId: "child-session", agentId: request.agentId, placementGeneration: 1 }];
    f.setState("registered");
    expect(f.sent).toEqual([]);
    expect(f.inbox.failAwaitingPreparation).toHaveBeenCalledWith("child-session", "session_recovery_unavailable");

    const g = recoveryFixture();
    g.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    g.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "starting" });
    await g.recovery.start();
    g.version = 1;
    g.setState("registered");
    const frame = g.sent[0] as SessionRecoverRequest;
    g.recovery.handleResult({
      type: "session:recover:result",
      requestId: frame.requestId,
      sessionId: request.sessionId,
      status: "retry",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.sent).toHaveLength(2);
    // Every later attempt goes unanswered until the bounded attempts run out.
    await vi.advanceTimersByTimeAsync(40_000 * 30);
    expect(g.recovery.isPendingRetry(request.sessionId, "turn-1")).toBe(false);
    expect(g.inbox.failAwaitingPreparation).toHaveBeenCalledWith(request.sessionId, "session_recovery_timeout");
    g.recovery.stop();
  });
});

function recoveryFixture(records = new Map<string, TurnRetryRecord>()) {
  const unresolved = new Map<
    string,
    {
      turnId: string;
      deliveryId: string;
      phase: string;
      recentRecordedInputs?: Array<{ kind: string; deliveryId: string; turnId: string }>;
      runtimeBinding?: { providerId: string; schemaVersion: number; payload: unknown };
    }
  >();
  const sent: unknown[] = [];
  let listener: (state: RuntimeConnectionState) => void = () => undefined;
  const fixture = {
    records,
    unresolved,
    sent,
    version: undefined as number | undefined,
    inbox: {
      awaiting: [] as Array<{ sessionId: string; agentId: string; placementGeneration: number }>,
      sessionsAwaitingPreparation: () => fixture.inbox.awaiting,
      failAwaitingPreparation: vi.fn(async () => undefined),
      failJoinedRun: vi.fn(async () => undefined),
      sessionPrepared: vi.fn(),
    },
    custody: { resume: vi.fn(() => true) },
    reconciler: { setRecovery: vi.fn(), clearRecovery: vi.fn(() => true) },
    logger: { info: vi.fn(), warn: vi.fn() },
    retries: {
      list: async () => [...records.values()],
      write: async (record) => {
        records.set(record.sessionId, record);
      },
      update: vi.fn(async (sessionId: string, turnId: string, change: (record: TurnRetryRecord) => TurnRetryRecord) => {
        const current = records.get(sessionId);
        if (!current || current.turnId !== turnId) return undefined;
        const next = change(current);
        records.set(sessionId, next);
        return next;
      }),
      remove: async (sessionId) => {
        records.delete(sessionId);
      },
    } satisfies InterruptedWorkRecoveryOptions["retries"],
    setState: (state: RuntimeConnectionState) => listener(state),
    recovery: undefined as unknown as InterruptedWorkRecovery,
  };
  fixture.recovery = new InterruptedWorkRecovery({
    bindingStore: {
      read: async (_agentId: string, sessionId: string) =>
        (unresolved.has(sessionId)
          ? {
              unresolvedTurn: unresolved.get(sessionId),
              recentRecordedInputs: unresolved.get(sessionId)?.recentRecordedInputs ?? [],
              runtimeBinding: unresolved.get(sessionId)?.runtimeBinding,
            }
          : undefined) as never,
    },
    connection: {
      capabilityVersion: (capability) =>
        capability === RUNTIME_CAPABILITY.sessionRecovery ? fixture.version : undefined,
      send: vi.fn(async (frame: unknown) => {
        sent.push(frame);
      }),
      subscribeState: (next) => {
        listener = next;
        return () => undefined;
      },
    },
    custody: fixture.custody,
    inbox: fixture.inbox,
    logger: fixture.logger,
    now: () => Date.parse("2026-11-05T00:00:00.000Z"),
    reconciler: fixture.reconciler,
    retries: fixture.retries,
  });
  return fixture;
}

function runnerHarness(options: { restartRetry?: boolean | (() => boolean); withoutRetries?: boolean } = {}) {
  const request = delivery();
  const records = new Map<string, TurnRetryRecord>();
  const retries = {
    update: async (sessionId: string, turnId: string, change: (record: TurnRetryRecord) => TurnRetryRecord) => {
      const current = records.get(sessionId);
      if (!current || current.turnId !== turnId) return undefined;
      const next = change(current);
      records.set(sessionId, next);
      return next;
    },
    appendSteer: async (_steer?: RuntimeImSteerRequest): Promise<"appended" | "full" | "missing"> => "appended",
    removeSteer: vi.fn(async (_steer: RuntimeImSteerRequest) => undefined),
  };
  const create = vi.fn((input: Parameters<TurnReportOwner["create"]>[0]) => ({
    ...input,
    type: "turn:report" as const,
    requestId: randomUUID(),
    resultHash: "c".repeat(64),
  }));
  const markReporting = vi.fn(async () => undefined);
  const submit = vi.fn(async () => undefined);
  const updateUnresolved = vi.fn(async () => undefined);
  const prompt = vi.fn(
    async (_input: { signal?: AbortSignal }): Promise<AgentRunResult> => ({
      runId: "turn-1",
      status: "completed",
      output: [],
    }),
  );
  const logs: RecordedLog[] = [];
  let sink: ((event: unknown) => Promise<void> | void) | undefined;
  const runtime = {
    prompt,
    steer: vi.fn(async (_input: unknown) => undefined),
    capabilities: { steer: "supported" },
    state: { phase: "running", activeRunId: "turn-1" },
  };
  const receipts: Array<{ kind: "steer"; deliveryId: string; turnId: string }> = [];
  const recordSteer = vi.fn(async (steer: RuntimeImSteerRequest) => {
    receipts.push({ kind: "steer", deliveryId: steer.deliveryId, turnId: steer.expectedTurnId });
  });
  const bindingRead = vi.fn<
    () => Promise<{ recentRecordedInputs: typeof receipts; unresolvedTurn: { turnId: string } | undefined } | undefined>
  >(async () => ({ recentRecordedInputs: receipts, unresolvedTurn: { turnId: "turn-1" } }));
  const runner = new AgentTurnRunner({
    bindingStore: {
      updateUnresolved,
      getSteerReceipt: vi.fn(async () => undefined),
      recordSteer,
      read: bindingRead,
    } as unknown as SessionBindingStore,
    connection: { send: vi.fn(async () => undefined), capabilityVersion: () => 3 },
    custody: { markReporting, recordResult: vi.fn() } as unknown as TurnCustodyOwner,
    reportOwner: { create, submit } as unknown as TurnReportOwner,
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
    logger: recordingLogger(logs),
    ...(options.withoutRetries ? {} : { retries }),
    restartRetryAvailable:
      typeof options.restartRetry === "function" ? options.restartRetry : () => options.restartRetry === true,
  });
  const emit = (event: unknown) => void sink?.(event);
  return {
    request,
    records,
    retries,
    receipts,
    bindingRead,
    logs,
    recordSteer,
    runner,
    runtime,
    emit,
    prompt,
    create,
    markReporting,
    submit,
    updateUnresolved,
  };
}

function promptItems(prompt: { mock: { calls: unknown[][] } }, call: number): Array<{ text: string }> {
  const request = prompt.mock.calls[call]?.[0] as { input: { items: Array<{ text: string }> } } | undefined;
  if (!request) throw new Error(`prompt call ${call} is missing`);
  return request.input.items;
}

async function rateLimited(): Promise<AgentRunResult> {
  return { runId: "turn-1", status: "failed", output: [], error: { code: "provider_rate_limited", message: "429" } };
}

function abortedOnSignal(input: { signal?: AbortSignal }): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    input.signal?.addEventListener("abort", () => resolve({ runId: "turn-1", status: "aborted", output: [] }), {
      once: true,
    });
  });
}

function owner(request: DirectImMessageDeliveryRequest): LiveTurnOwner {
  const admission = new AdmissionController().reserve(request.sessionId, request.agentId);
  if (!admission.accepted) throw new Error("reservation");
  return { inputHash: "a".repeat(64), request, reservation: admission.reservation, turnId: "turn-1" };
}

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opentag-turn-retry-"));
  homes.push(path);
  return path;
}

function delivery(sessionId: string = randomUUID()): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    sessionId,
    agentId: "agent-1",
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
      agentId: "agent-1",
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    },
  };
}

function steerRequest(root: DirectImMessageDeliveryRequest, text: string): RuntimeImSteerRequest {
  return {
    type: "im:steer",
    requestId: randomUUID(),
    deliveryId: "steer-delivery",
    imMessageId: randomUUID(),
    rootDeliveryId: root.deliveryId,
    expectedTurnId: "turn-1",
    sessionId: root.sessionId,
    agentId: root.agentId,
    placementGeneration: root.placementGeneration,
    attention: "direct",
    content: { ...root.content, text },
  } as RuntimeImSteerRequest;
}
