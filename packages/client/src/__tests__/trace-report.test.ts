import { createHash } from "node:crypto";
import type { AgentTraceBatch, TurnReportHashInput, TurnReportRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConnectionState } from "../runtime/runtime-connection.js";
import {
  type DurableFailure,
  type DurableWorkRecord,
  MemoryRuntimeDurabilityStore,
  RuntimeDurabilityMetrics,
  type RuntimeRetryScheduler,
} from "../runtime/runtime-durability.js";
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
    expect(serialized).toContain("Provider reported a runtime warning");
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
  it("rejects a duplicate Turn Report with a different immutable identity", async () => {
    const owner = new TurnReportOwner({ connection: new FakeConnection("stopped") });
    const report = owner.create(reportInput());
    const other = { ...report, requestId: "00000000-0000-4000-8000-000000000002" };
    const pending = owner.submit(report, vi.fn());

    await expect(owner.submit(other, vi.fn())).rejects.toThrow("already owns this Turn");
    owner.stop();
    await expect(pending).rejects.toThrow("stopped");
  });

  it("hydrates terminal fences, expired records, and interrupted sends", async () => {
    const store = new MemoryRuntimeDurabilityStore();
    const seed = new TurnReportOwner({ connection: new FakeConnection("stopped") });
    const conflictReport = seed.create(reportInput({ turnId: "turn-conflict" }));
    const expiredReport = seed.create(reportInput({ turnId: "turn-expired" }));
    const runningReport = seed.create(reportInput({ turnId: "turn-running" }));
    seed.stop();
    const terminalFailure: DurableFailure = {
      category: "conflict",
      code: "conflict",
      message: "conflict",
      phase: "request",
      requestId: conflictReport.requestId,
      retryability: "never",
    };
    await store.write(reportRecord(conflictReport, "failed", { lastError: terminalFailure }));
    await store.write(reportRecord(expiredReport, "accepted", { acceptedAt: 1 }));
    await store.write(reportRecord(runningReport, "running"));

    const owner = new TurnReportOwner({
      connection: new FakeConnection("stopped"),
      now: () => 10_000,
      persistence: store,
      retryPolicy: { maxAgeMs: 100, maxAttempts: 5 },
    });
    await owner.ready();

    expect(owner.get(conflictReport.turnId)?.serverStatus).toBe("conflict");
    expect(owner.getState(expiredReport.turnId)?.status).toBe("dead-letter");
    expect(owner.getState(runningReport.turnId)?.status).toBe("retryable");
    expect(owner.pendingCount).toBe(2);
    const pending = [owner.submit(conflictReport, vi.fn()), owner.submit(runningReport, vi.fn())];
    owner.stop();
    await Promise.allSettled(pending);
  });

  it("dead-letters structured transport failures without leaking unbounded messages", async () => {
    const report = new TurnReportOwner({ connection: new FakeConnection("registered") }).create(reportInput());
    const error = {
      category: "unavailable",
      code: "transport_blocked",
      phase: "transport",
      requestId: report.requestId,
      retryability: "never",
      message: 42,
    };
    const connection = new FakeConnection("registered", error);
    const owner = new TurnReportOwner({ connection, retryPolicy: { maxAttempts: 5, maxAgeMs: 10_000 } });
    const submitted = owner.submit(report, vi.fn());

    await expect(submitted).rejects.toMatchObject({ name: "RuntimeDurabilityFailure", code: "transport_blocked" });
    expect(owner.getState(report.turnId)).toMatchObject({
      status: "dead-letter",
      lastError: { code: "transport_blocked", message: "Runtime operation failed" },
    });
    owner.stop();
  });

  it("classifies persistence failures with the fallback durable error code", async () => {
    const report = new TurnReportOwner({ connection: new FakeConnection("stopped") }).create(reportInput());
    const failures: DurableFailure[] = [];
    const persistence = {
      list: vi.fn(async () => []),
      write: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const owner = new TurnReportOwner({
      connection: new FakeConnection("stopped"),
      onFailure: (failure) => failures.push(failure),
      persistence,
      retryPolicy: { maxAttempts: 1, maxAgeMs: 10_000 },
    });
    const submitted = owner.submit(report, vi.fn());

    await expect(submitted).rejects.toMatchObject({ code: "runtime_failed", retryability: "backoff" });
    expect(failures).toEqual([expect.objectContaining({ code: "runtime_failed", phase: "persistence" })]);
    owner.stop();
  });

  it("bounds confirmation retries and records a dead-letter state with injected time", async () => {
    const scheduled: Array<() => void> = [];
    const scheduler: RuntimeRetryScheduler = {
      schedule(_delay, task) {
        scheduled.push(task);
        return { cancel: () => undefined };
      },
    };
    const store = new MemoryRuntimeDurabilityStore();
    const metrics = new RuntimeDurabilityMetrics();
    const connection = new FakeConnection("registered");
    const owner = new TurnReportOwner({
      connection,
      metrics,
      persistence: store,
      retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2, maxAgeMs: 100 },
      scheduler,
    });
    const report = owner.create(reportInput());
    const submitted = owner.submit(report, vi.fn().mockRejectedValue(new Error("fsync failed")));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    const result = {
      type: "turn:report:result" as const,
      requestId: report.requestId,
      turnId: report.turnId,
      status: "recorded" as const,
      resultHash: report.resultHash,
    };
    await owner.handleResult(result);
    scheduled.shift()?.();
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    await owner.handleResult(result);
    await expect(submitted).rejects.toMatchObject({ name: "RuntimeDurabilityFailure" });
    expect(owner.getState(report.turnId)?.status).toBe("dead-letter");
    expect(owner.metricsSnapshot()).toMatchObject({ retries: 1, deadLetters: 1 });
    owner.stop();
  });

  it("resumes persisted Reports after restart and confirms exactly once", async () => {
    const store = new MemoryRuntimeDurabilityStore();
    const firstConnection = new FakeConnection("registered");
    const first = new TurnReportOwner({ connection: firstConnection, persistence: store });
    const report = first.create(reportInput());
    const pending = first.submit(
      report,
      vi.fn(async () => undefined),
    );
    await vi.waitFor(() => expect(firstConnection.sent).toHaveLength(1));
    first.stop();
    await expect(pending).rejects.toThrow("stopped");

    const resumedConnection = new FakeConnection("registered");
    const resumed = new TurnReportOwner({ connection: resumedConnection, persistence: store });
    await resumed.ready();
    const confirm = vi.fn(async () => undefined);
    const recovered = resumed.submit(report, confirm);
    await vi.waitFor(() => expect(resumedConnection.sent.length).toBeGreaterThanOrEqual(1));
    await resumed.handleResult({
      type: "turn:report:result",
      requestId: report.requestId,
      turnId: report.turnId,
      status: "already_recorded",
      resultHash: report.resultHash,
    });
    await recovered;
    expect(confirm).toHaveBeenCalledOnce();
    expect(resumed.getState(report.turnId)?.status).toBe("succeeded");
    resumed.stop();
  });

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
    const onTerminal = vi.fn();
    let settled = false;
    const submitted = owner.submit(report, confirm, { onTerminal });
    void submitted.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

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
    expect(onTerminal).toHaveBeenCalledWith("conflict");
    expect(settled).toBe(false);
    const lateTerminalObserver = vi.fn();
    expect(owner.submit(report, confirm, { onTerminal: lateTerminalObserver })).toBe(submitted);
    expect(lateTerminalObserver).toHaveBeenCalledWith("conflict");
    expect(owner.rearmTerminal({ ...report, resultHash: sha256("different claim") })).toBe(false);
    expect(owner.get(report.turnId)?.serverStatus).toBe("conflict");

    expect(owner.rearmTerminal(report)).toBe(true);
    expect(owner.get(report.turnId)?.serverStatus).toBeUndefined();
    const rearmedTerminalObserver = vi.fn();
    expect(owner.submit(report, confirm, { onTerminal: rearmedTerminalObserver })).toBe(submitted);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    await owner.handleResult({
      type: "turn:report:result",
      requestId: report.requestId,
      turnId: report.turnId,
      status: "stale_generation",
      resultHash: report.resultHash,
    });
    expect(rearmedTerminalObserver).toHaveBeenCalledWith("stale_generation");
    expect(owner.get(report.turnId)?.serverStatus).toBe("stale_generation");
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
  readonly #rejectSends: boolean | Error | unknown;
  state: RuntimeConnectionState;

  constructor(state: RuntimeConnectionState, rejectSends: boolean | Error | unknown = false) {
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
    if (this.#rejectSends) throw this.#rejectSends instanceof Error ? this.#rejectSends : this.#rejectSends;
  }

  setState(state: RuntimeConnectionState): void {
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

function reportInput(overrides: Partial<TurnReportHashInput> = {}): TurnReportHashInput {
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
    ...overrides,
  };
}

function reportRecord(
  report: TurnReportRequest,
  status: DurableWorkRecord["status"],
  overrides: Partial<DurableWorkRecord<TurnReportRequest>> = {},
): DurableWorkRecord<TurnReportRequest> {
  return {
    acceptedAt: 10_000,
    attempts: 0,
    key: report.turnId,
    kind: "turn-report",
    payload: report,
    status,
    updatedAt: 10_000,
    ...overrides,
  };
}

function sha256(value: string): TurnReportRequest["resultHash"] {
  return createHash("sha256").update(value).digest("hex");
}
