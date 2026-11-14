import type { DirectImMessageDeliveryRequest, TurnQuotaWaitRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { QuotaWaitNotifier } from "../runtime/quota-wait-notifier.js";

const request = {
  deliveryId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  placementGeneration: 4,
} as DirectImMessageDeliveryRequest;

function fixture(options: { enabled?: boolean; send?: () => Promise<void> } = {}) {
  let now = 1_000;
  const frames: TurnQuotaWaitRequest[] = [];
  const warn = vi.fn();
  const notifier = new QuotaWaitNotifier({
    enabled: () => options.enabled ?? true,
    send: options.send ?? ((frame) => void frames.push(frame)),
    logger: { warn },
    now: () => now,
  });
  return { notifier, frames, warn, tick: (ms: number) => (now += ms) };
}

describe("QuotaWaitNotifier", () => {
  it("sends the reset once per time, a moved reset again, and the end, in a clock-based order", async () => {
    const f = fixture();
    f.notifier.waiting(request, "turn-1", "2026-11-13T12:00:00.000Z");
    f.notifier.waiting(request, "turn-1", "2026-11-13T12:00:00.000Z");
    f.notifier.waiting(request, "turn-1", "2026-11-13T13:00:00.000Z");
    f.tick(5_000);
    f.notifier.ended(request, "turn-1");
    await vi.waitFor(() => expect(f.frames).toHaveLength(3));
    expect(f.frames[0]).toMatchObject({
      type: "turn:quota-wait",
      deliveryId: request.deliveryId,
      sessionId: request.sessionId,
      agentId: request.agentId,
      placementGeneration: 4,
      turnId: "turn-1",
      sequence: 1_000,
      resetAt: "2026-11-13T12:00:00.000Z",
    });
    expect(f.frames.map((frame) => frame.sequence)).toEqual([1_000, 1_001, 6_000]);
    expect(f.frames[2]).toMatchObject({ ended: true });
    expect(f.frames[2]?.resetAt).toBeUndefined();
  });

  it("keeps sequences increasing through a reset update, the end and the next wait within one millisecond", async () => {
    const f = fixture();
    f.notifier.waiting(request, "turn-1", "2026-11-13T12:00:00.000Z");
    f.notifier.waiting(request, "turn-1", "2026-11-13T13:00:00.000Z");
    f.notifier.ended(request, "turn-1");
    f.notifier.waiting(request, "turn-1", "2026-11-13T13:00:00.000Z");
    f.notifier.ended(request, "turn-1");
    await vi.waitFor(() => expect(f.frames).toHaveLength(5));
    expect(f.frames.map((frame) => frame.sequence)).toEqual([1_000, 1_001, 1_002, 1_003, 1_004]);
    expect(f.frames.map((frame) => frame.ended ?? frame.resetAt)).toEqual([
      "2026-11-13T12:00:00.000Z",
      "2026-11-13T13:00:00.000Z",
      true,
      "2026-11-13T13:00:00.000Z",
      true,
    ]);
  });

  it.each([
    ["the Server did not negotiate it", { enabled: false }, {}],
    ["the Bot only observes the conversation", {}, { replyRole: "observer" }],
  ] as const)("sends nothing when %s", async (_name, options, fields) => {
    const f = fixture(options);
    f.notifier.waiting({ ...request, ...fields } as DirectImMessageDeliveryRequest, "turn-1", "2026-11-13T12:00:00Z");
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.frames).toEqual([]);
  });

  it("only logs a frame it could not send, or a notice the Server could not write", async () => {
    const f = fixture({ send: async () => Promise.reject(new Error("closed")) });
    f.notifier.waiting(request, "turn-1", "2026-11-13T12:00:00.000Z");
    await vi.waitFor(() =>
      expect(f.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: "TURN_QUOTA_WAIT_NOTICE_UNSENT" }),
        expect.any(String),
      ),
    );
    const result = { type: "turn:quota-wait:result" as const, requestId: "r", turnId: "turn-1", sequence: 1 };
    f.notifier.handleResult({ ...result, status: "recorded" });
    f.notifier.handleResult({ ...result, status: "stale_generation" });
    expect(f.warn).toHaveBeenCalledOnce();
    f.notifier.handleResult({ ...result, status: "failed" });
    expect(f.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "TURN_QUOTA_WAIT_NOTICE_FAILED", status: "failed" }),
      expect.any(String),
    );
  });
});
