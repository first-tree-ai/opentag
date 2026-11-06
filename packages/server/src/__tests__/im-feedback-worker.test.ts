import { afterEach, describe, expect, it, vi } from "vitest";
import { createPerformanceLogger } from "../observability/performance-logger.js";
import { instrumentWorker } from "../observability/service-instrumentation.js";
import { FeedbackCooldownStorageError, FeedbackProviderError } from "../services/im/im-feedback-messenger.js";
import type { FeedbackTarget } from "../services/im/im-feedback-store.js";
import { ImFeedbackWorker } from "../services/im/im-feedback-worker.js";
import { deferred } from "./support/deferred.js";

function target(id: number, inputExternalId = String(id)): FeedbackTarget {
  return {
    id: String(id),
    bindingId: "binding",
    channelId: "channel",
    inputExternalId,
    state: "working",
    desiredReaction: "working",
    appliedReaction: "none",
    cardState: "none",
    cardMessageId: null,
    attemptCount: 0,
  } as FeedbackTarget;
}

function harness(targets = Array.from({ length: 8 }, (_, i) => target(i))) {
  const pending = [...targets];
  const store = {
    claim: vi.fn(async (excluded: readonly FeedbackTarget[] = []) => {
      const index = pending.findIndex(
        (t) =>
          !excluded.some(
            (e) =>
              e.bindingId === t.bindingId && e.channelId === t.channelId && e.inputExternalId === t.inputExternalId,
          ),
      );
      return index < 0 ? undefined : pending.splice(index, 1)[0];
    }),
    refreshQueued: vi.fn(async (t: FeedbackTarget) => t),
    isCurrent: vi.fn(async () => true),
    desiredReaction: vi.fn(async () => "working" as const),
    latestAction: vi.fn(async () => undefined),
    markSending: vi.fn(async () => true),
    settle: vi.fn(async () => {}),
  };
  const transport = {
    reaction: vi.fn(async (_t: FeedbackTarget) => {}),
    post: vi.fn(async () => "card"),
    update: vi.fn(async () => {}),
    find: vi.fn(async () => ({ ids: [] })),
  };
  const warn = vi.fn();
  return { store, transport, warn, worker: new ImFeedbackWorker({ store, transport, logger: { warn } }) };
}

afterEach(() => vi.useRealTimers());

describe("feedback pass scheduling", () => {
  it("bounds concurrency to four and starts the eighth independent input after one RTT", async () => {
    vi.useFakeTimers();
    const h = harness(Array.from({ length: 9 }, (_, i) => target(i)));
    const starts: number[] = [];
    let active = 0;
    let peak = 0;
    h.transport.reaction.mockImplementation(async () => {
      starts.push(Date.now());
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      active--;
    });
    const start = Date.now();
    const pass = h.worker.runOnce();
    await vi.runAllTimersAsync();
    await pass;
    expect(peak).toBe(4);
    expect(starts.map((time) => time - start)).toEqual([0, 0, 0, 0, 2_000, 2_000, 2_000, 2_000]);
    expect(Date.now() - start).toBe(4_000);
    expect(h.store.settle).toHaveBeenCalledTimes(8);
    expect(active).toBe(0);
  });

  it("serializes attempts for one native input while independent inputs keep moving", async () => {
    vi.useFakeTimers();
    const h = harness([target(0, "same"), target(1, "same"), target(2), target(3), target(4)]);
    const starts: string[] = [];
    let sameActive = 0;
    let samePeak = 0;
    h.transport.reaction.mockImplementation(async (t) => {
      starts.push(t.id);
      if (t.inputExternalId === "same") samePeak = Math.max(samePeak, ++sameActive);
      await new Promise((resolve) => setTimeout(resolve, t.id === "0" ? 3_000 : 1_000));
      if (t.inputExternalId === "same") sameActive--;
    });
    const pass = h.worker.runOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts).toEqual(["0", "2", "3", "4"]);
    await vi.runAllTimersAsync();
    await pass;
    expect(starts).toEqual(["0", "2", "3", "4", "1"]);
    expect(samePeak).toBe(1);
    expect(sameActive).toBe(0);
  });

  it.each([false, true])(
    "records one actual pass for duplicate callers and timer ticks (failed=%s)",
    async (failed) => {
      vi.useFakeTimers();
      const h = harness([target(0)]);
      const gate = deferred();
      h.transport.reaction.mockImplementation(() => gate.promise);
      if (failed) h.store.claim.mockResolvedValueOnce(target(0)).mockRejectedValueOnce(new Error("claim failed"));
      const records: Record<string, unknown>[] = [];
      const log = (record: Record<string, unknown>) => records.push(record);
      const perfLogger = createPerformanceLogger(
        () => ({ isLevelEnabled: () => true, debug: log, info: log, warn: log, error: log }) as never,
      );
      instrumentWorker(h.worker, {
        workerName: "ImFeedbackWorker",
        perfLogger,
      });
      h.worker.start();
      const pass = h.worker.runOnce();
      expect(h.worker.runOnce()).toBe(pass);
      await vi.advanceTimersByTimeAsync(4_000);
      gate.resolve();
      await pass;
      await h.worker.stop();
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ operation: "ImFeedbackWorker.runPass", outcome: "started" });
      expect(records[1]).toMatchObject({
        operation: "ImFeedbackWorker.runPass",
        outcome: failed ? "failed" : "completed",
        callId: records[0]?.callId,
      });
      expect(h.transport.reaction).toHaveBeenCalledOnce();
    },
  );

  it("keeps other targets progressing after a reaction fails or times out", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.transport.reaction.mockImplementation(async (t) => {
      await new Promise((resolve) => setTimeout(resolve, t.id === "0" ? 8_000 : 1_000));
      if (t.id === "0") throw new FeedbackProviderError("TIMEOUT", false);
    });
    const pass = h.worker.runOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.transport.reaction).toHaveBeenCalledTimes(8);
    expect(h.store.settle).toHaveBeenCalledTimes(7);
    await vi.runAllTimersAsync();
    await pass;
    expect(h.store.settle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "0" }),
      expect.objectContaining({ reaction: null, errorCode: "IM_FEEDBACK_REACTION_FAILED" }),
    );
  });

  it("isolates a failed settlement and drains admitted work after a claim failure", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.store.settle.mockRejectedValueOnce(new Error("one target's settlement failed"));
    h.transport.reaction.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    });
    h.store.claim
      .mockImplementationOnce(async () => target(0))
      .mockImplementationOnce(async () => target(1))
      .mockRejectedValueOnce(new Error("claim storage unavailable"));
    let finished = false;
    const pass = h.worker.runOnce().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    await vi.runAllTimersAsync();
    await pass;
    expect(h.store.claim).toHaveBeenCalledTimes(3);
    expect(h.transport.reaction).toHaveBeenCalledTimes(2);
    expect(h.store.settle).toHaveBeenCalledTimes(3);
  });

  it("stops admission on an unrepairable settlement and leaves the remaining work for another pass", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.transport.reaction.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    });
    h.store.settle.mockImplementation(async (t?: FeedbackTarget) => {
      if (t?.id === "0") throw new Error("target settlement failed");
    });
    const first = h.worker.runOnce();
    await vi.runAllTimersAsync();
    await first;
    expect(h.transport.reaction).toHaveBeenCalledTimes(4);
    const next = h.worker.runOnce();
    await vi.runAllTimersAsync();
    await next;
    expect(h.transport.reaction).toHaveBeenCalledTimes(8);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "IM_FEEDBACK_PUMP_FAILED", feedbackId: "0" }),
      expect.any(String),
    );
  });

  it("drains all admitted work and releases a claim returned after stop", async () => {
    const h = harness();
    const gate = deferred();
    const claimed = deferred<FeedbackTarget>();
    const claiming = deferred();
    h.transport.reaction.mockImplementation(() => gate.promise);
    h.store.claim
      .mockImplementationOnce(async () => target(0))
      .mockImplementationOnce(async () => {
        claiming.resolve();
        return claimed.promise;
      });
    const pass = h.worker.runOnce();
    await claiming.promise;
    let stopped = false;
    const stop = h.worker.stop().then(() => {
      stopped = true;
    });
    claimed.resolve(target(1));
    await vi.waitFor(() =>
      expect(h.store.settle).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }), { delayMs: 0 }),
    );
    expect(stopped).toBe(false);
    expect(h.transport.reaction).toHaveBeenCalledOnce();
    gate.resolve();
    await Promise.all([pass, stop]);
    expect(stopped).toBe(true);
    expect(h.store.claim).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "stops claiming on cooldown-storage failure and joins the other in-flight calls (settlement failed=%s)",
    async (settlementFailed) => {
      vi.useFakeTimers();
      const h = harness();
      if (settlementFailed)
        h.store.settle.mockImplementation(async (t?: FeedbackTarget) => {
          if (t?.id === "0") throw new Error("cooldown settlement failed");
        });
      h.transport.reaction.mockImplementation(async (t) => {
        await new Promise((resolve) => setTimeout(resolve, t.id === "0" ? 1_000 : 2_000));
        if (t.id === "0") throw new FeedbackCooldownStorageError();
      });
      let finished = false;
      const pass = h.worker.runOnce().then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(finished).toBe(false);
      expect(h.transport.reaction).toHaveBeenCalledTimes(4);
      await vi.runAllTimersAsync();
      await pass;
      expect(h.store.claim).toHaveBeenCalledTimes(4);
      expect(h.store.settle).toHaveBeenCalledTimes(4);
    },
  );
});
