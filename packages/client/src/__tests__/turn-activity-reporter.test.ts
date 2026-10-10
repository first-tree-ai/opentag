import type { TurnActivityRequest } from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnActivityReporter } from "../runtime/turn-activity-reporter.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture(enabled = true) {
  const request = cloudDeliveryFixture();
  request.content.providerRef = {
    provider: "slack",
    appId: "A1",
    teamId: "T1",
    botUserId: "U1",
    channelId: "C1",
    messageTs: "1.1",
  };
  const frames: TurnActivityRequest[] = [];
  const send = vi.fn((frame: TurnActivityRequest) => {
    frames.push(frame);
  });
  const reporter = new TurnActivityReporter({ enabled: () => enabled, send });
  return { reporter, request, frames, send };
}
function ack(reporter: TurnActivityReporter, frame: TurnActivityRequest) {
  reporter.acknowledge({
    requestId: frame.requestId,
    turnId: frame.turnId,
    sequence: frame.sequence,
    status: "recorded",
    type: "turn:activity:result",
  });
}

describe("Turn execution liveness", () => {
  it("does not publish without explicit negotiation or for observer deliveries", () => {
    const old = fixture(false);
    old.reporter.start(old.request, "t");
    const observer = fixture();
    observer.reporter.start({ ...observer.request, replyRole: "observer" }, "t");
    expect(old.frames).toEqual([]);
    expect(observer.frames).toEqual([]);
  });
  it("does not publish Feishu activity", () => {
    const { reporter, send } = fixture();
    reporter.start(cloudDeliveryFixture(), "t");
    expect(send).not.toHaveBeenCalled();
  });
  it("retries the same sequence until ACK and renews with a new sequence", async () => {
    const { reporter, request, frames } = fixture();
    reporter.start(request, "t");
    const first = frames[0];
    if (!first) throw new Error("missing activity");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(frames).toHaveLength(3);
    expect(frames[2]).toEqual(first);
    ack(reporter, first);
    await vi.advanceTimersByTimeAsync(24_000);
    expect(frames).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames[3]).toMatchObject({ sequence: 2, phase: "running" });
    reporter.close();
  });
  it("terminal supersedes an unacknowledged heartbeat and ignores late ACKs", async () => {
    const { reporter, request, frames } = fixture();
    reporter.start(request, "t");
    const first = frames[0];
    if (!first) throw new Error("missing activity");
    reporter.end("t");
    ack(reporter, first);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames[2]).toMatchObject({ sequence: 2, phase: "terminal" });
    const terminal = frames[2];
    if (!terminal) throw new Error("missing terminal");
    ack(reporter, terminal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frames).toHaveLength(3);
  });
  it("bounds terminal retries and turns deadline expiration into terminal state", async () => {
    const { reporter, request, frames } = fixture();
    reporter.start({ ...request, deadlineAt: new Date(Date.now() + 4_000).toISOString() }, "t");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(frames.at(-1)?.phase).toBe("terminal");
    const count = frames.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frames).toHaveLength(count);
  });
  it("contains synchronous and asynchronous send failures", async () => {
    const { reporter, request, send } = fixture();
    send.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    expect(() => reporter.start(request, "t")).not.toThrow();
    send.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    await vi.advanceTimersByTimeAsync(2_000);
    reporter.close();
  });
});
