import { createHash } from "node:crypto";
import type { AgentTraceBatch, TurnReportHashInput, TurnReportRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConnectionState } from "../runtime/runtime-connection.js";
import { TurnTraceBuffer } from "../runtime/trace-buffer.js";
import { TurnReportOwner } from "../runtime/turn-report-owner.js";

const REPORT_REQUEST_ID = "00000000-0000-4000-8000-000000000001";

describe("TurnTraceBuffer", () => {
  it("D-13/D-14 projects only safe typed fields and never uploads a raw warning", async () => {
    const sender = new FakeConnection("registered");
    const trace = new TurnTraceBuffer({
      sender,
      sessionId: "session-1",
      turnId: "turn-1",
      placementGeneration: 1,
      now: () => Date.parse("2026-08-18T00:00:00.000Z"),
      id: () => "batch-1",
    });
    trace.turnStarted();
    trace.warning("bad code", "canary-secret /absolute/private/path");
    trace.itemCompleted("command", "failed");
    trace.turnCompleted("failed");
    await trace.finish();

    const serialized = JSON.stringify(sender.sent);
    expect(serialized).not.toContain("canary-secret");
    expect(serialized).not.toContain("/absolute/private/path");
    expect(serialized).toContain("Codex reported a provider warning");
    expect(sender.sent.every((entry) => entry.options?.priority === "trace")).toBe(true);
  });

  it("D-15/D-16 remains bounded, preserves a terminal event, and cannot block the result", async () => {
    const sender = new FakeConnection("registered", true);
    const trace = new TurnTraceBuffer({
      sender,
      sessionId: "session-1",
      turnId: "turn-1",
      placementGeneration: 1,
      maxBufferEvents: 3,
      maxBufferBytes: 1024,
      now: () => Date.parse("2026-08-18T00:00:00.000Z"),
    });
    trace.turnStarted();
    for (let index = 0; index < 5; index += 1) trace.itemCompleted("other", "completed");
    trace.turnCompleted("completed");
    const summary = await trace.finish();

    expect(summary.lastSequence).toBe(7);
    expect(summary.droppedEvents).toBe(7);
    expect(
      sender.sent.some((entry) =>
        (entry.frame as AgentTraceBatch).events.some((event) => event.kind === "turn_completed"),
      ),
    ).toBe(true);
  });
});

describe("TurnReportOwner", () => {
  it("D-17/D-19 resends one immutable Report after registration and reconciliation wake-up", async () => {
    const connection = new FakeConnection("stopped");
    const owner = new TurnReportOwner({ connection, id: () => REPORT_REQUEST_ID });
    const report = owner.create(reportInput());
    const confirm = vi.fn(async () => undefined);
    const recorded = owner.submit(report, confirm);
    expect(connection.sent).toHaveLength(0);

    connection.setState("registered");
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    connection.setState("stopped");
    connection.setState("registered");
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    expect(connection.sent[0]?.frame).toEqual(connection.sent[1]?.frame);
    expect(owner.submit(report, confirm)).toBe(recorded);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(3));
    expect(connection.sent[2]?.frame).toEqual(report);

    await owner.handleResult({
      type: "turn:report:result",
      requestId: report.requestId,
      turnId: report.turnId,
      status: "already_recorded",
      resultHash: report.resultHash,
    });
    await recorded;
    expect(confirm).toHaveBeenCalledOnce();
    expect(owner.pendingCount).toBe(0);
    owner.stop();
  });

  it("D-20 retains the Fence for a wrong hash, conflict, and stale generation", async () => {
    const connection = new FakeConnection("registered");
    const owner = new TurnReportOwner({ connection, id: () => REPORT_REQUEST_ID });
    const report = owner.create(reportInput());
    const confirm = vi.fn(async () => undefined);
    void owner.submit(report, confirm).catch(() => undefined);

    expect(
      await owner.handleResult({
        type: "turn:report:result",
        requestId: report.requestId,
        turnId: report.turnId,
        status: "recorded",
        resultHash: sha256("wrong"),
      }),
    ).toBe(false);
    expect(owner.pendingCount).toBe(1);
    expect(confirm).not.toHaveBeenCalled();

    await owner.handleResult({
      type: "turn:report:result",
      requestId: report.requestId,
      turnId: report.turnId,
      status: "conflict",
      resultHash: report.resultHash,
    });
    expect(owner.get(report.turnId)?.serverStatus).toBe("conflict");
    expect(owner.pendingCount).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    owner.stop();
  });

  it("D-20 releases only after durable confirmation succeeds", async () => {
    const connection = new FakeConnection("registered");
    const owner = new TurnReportOwner({ connection, id: () => REPORT_REQUEST_ID, retryDelayMs: 100 });
    const report = owner.create(reportInput());
    const confirm = vi.fn().mockRejectedValueOnce(new Error("fsync failed")).mockResolvedValueOnce(undefined);
    const recorded = owner.submit(report, confirm);
    const result = {
      type: "turn:report:result" as const,
      requestId: report.requestId,
      turnId: report.turnId,
      status: "recorded" as const,
      resultHash: report.resultHash,
    };
    await owner.handleResult(result);
    expect(owner.pendingCount).toBe(1);
    await vi.waitFor(() => expect(connection.sent.length).toBeGreaterThanOrEqual(2), { interval: 10 });
    await owner.handleResult(result);
    await recorded;
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(owner.pendingCount).toBe(0);
    owner.stop();
  });
});

class FakeConnection {
  readonly sent: Array<{ frame: unknown; options?: { priority?: string } }> = [];
  readonly #listeners = new Set<(state: RuntimeConnectionState) => void>();
  readonly #rejectSends: boolean;
  state: RuntimeConnectionState;

  constructor(state: RuntimeConnectionState, rejectSends = false) {
    this.state = state;
    this.#rejectSends = rejectSends;
  }

  subscribeState(listener: (state: RuntimeConnectionState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  async send(frame: unknown, options?: { priority?: string }): Promise<void> {
    this.sent.push({ frame, options });
    if (this.#rejectSends) throw new Error("socket unavailable");
  }

  setState(state: RuntimeConnectionState): void {
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

function reportInput(): TurnReportHashInput {
  return {
    deliveryId: "delivery-1",
    turnId: "turn-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    outcome: "completed",
    executionEffects: "completed",
    finalText: "done",
    usage: { inputTokens: 2, outputTokens: 1 },
    traceSummary: { lastSequence: 3, droppedEvents: 1 },
  };
}

function sha256(value: string): TurnReportRequest["resultHash"] {
  return createHash("sha256").update(value).digest("hex");
}
