import { randomUUID } from "node:crypto";
import type { CloudLatencyRecord, RunnerClientFrame, RunnerServerFrame } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { RunnerCloudLatencyObserver } from "../runner/cloud-latency-observer.js";
import type { CloudTurnScope } from "../runner/cloud-turns.js";

function fixture(enabled = true) {
  let scope: CloudTurnScope | undefined = {
    sessionId: randomUUID(),
    sandboxId: randomUUID(),
    environmentGeneration: 1,
    resourceName: "fixture",
    resourceUid: "fixture",
  };
  const records: CloudLatencyRecord[] = [];
  const observer = new RunnerCloudLatencyObserver({
    env: enabled
      ? {
          OPENTAG_ENV: "staging",
          OPENTAG_CLOUD_LATENCY_DIAGNOSTICS: "true",
          OPENTAG_CLOUD_LATENCY_SESSION_IDS: scope.sessionId,
        }
      : {},
    scope: () => scope,
    write: (record) => records.push(record),
  });
  const turnId = randomUUID();
  const deliveryId = randomUUID();
  const sessionId = scope.sessionId;
  const diagnostic = { ...scope, turnId, deliveryId, phase: "worker_startup", event: "start" };
  const report: Extract<RunnerClientFrame, { type: "delivery:report" }> = {
    type: "delivery:report",
    requestId: randomUUID(),
    report: {
      type: "turn:report",
      requestId: randomUUID(),
      agentId: randomUUID(),
      sessionId,
      deliveryId,
      turnId,
      placementGeneration: 1,
      outcome: "completed",
      executionEffects: "completed",
      resultHash: "a".repeat(64),
      traceSummary: { droppedEvents: 0, lastSequence: 0 },
    },
  };
  const ack: Extract<RunnerServerFrame, { type: "delivery:report:ack" }> = {
    type: "delivery:report:ack",
    requestId: randomUUID(),
    turnId,
    resultHash: report.report.resultHash,
    status: "recorded",
  };
  return {
    observer,
    records,
    diagnostic,
    report,
    ack,
    changeScope: (value: CloudTurnScope | undefined) => {
      scope = value;
    },
  };
}

describe("Runner latency observation without lifecycle changes", () => {
  it("observes the parent worker envelope, checkpoint and exact report ack only once", async () => {
    const f = fixture();
    f.observer.diagnostic(f.diagnostic);
    f.observer.diagnostic({ ...f.diagnostic, event: "worker_end", seq: 3 });
    f.observer.diagnostic({ ...f.diagnostic, event: "worker_end", severity: "INFO" });
    expect(await f.observer.checkpoint(async () => 7)).toBe(7);
    f.observer.sent(f.report);
    f.observer.sent(f.report);
    f.observer.acknowledged({ ...f.ack, resultHash: "b".repeat(64) });
    expect(f.records.some((record) => record.event === "summary")).toBe(false);
    f.observer.acknowledged(f.ack);
    f.observer.acknowledged(f.ack);
    expect(f.records.map((record) => record.phase)).toEqual([
      "worker_execution",
      "worker_execution",
      "checkpoint",
      "checkpoint",
      "report_ack",
      "report_ack",
      undefined,
    ]);
    expect(f.records.at(-1)).toMatchObject({ event: "summary", outcome: "completed", diagnosticIncomplete: false });
  });

  it("defaults off and does not fabricate phases without an active allocation/worker", async () => {
    const f = fixture(false);
    f.observer.diagnostic(f.diagnostic);
    f.observer.sent(f.report);
    f.observer.acknowledged(f.ack);
    expect(await f.observer.workspace(async () => true)).toBe(true);
    expect(await f.observer.checkpoint(async () => 1)).toBe(1);
    expect(f.records).toEqual([]);
    f.changeScope(undefined);
    f.observer.sent(f.report);
    f.observer.diagnostic(f.diagnostic);
    expect(await f.observer.workspace(async () => true)).toBe(true);
  });

  it("preserves workspace success, declined preparation and original failures", async () => {
    for (const result of [true, false]) {
      const f = fixture();
      expect(await f.observer.workspace(async () => result)).toBe(result);
      expect(f.records.at(-1)?.outcome).toBe(result ? "completed" : "incomplete");
    }
    const f = fixture();
    const failure = new Error("private archive error");
    await expect(
      f.observer.workspace(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(f.records.at(-1)?.outcome).toBe("failed");
    expect(JSON.stringify(f.records)).not.toContain("private archive error");
  });

  it("fails closed for allocation changes, unsafe identities and conflicting acknowledgements", async () => {
    const f = fixture();
    f.observer.diagnostic({ ...f.diagnostic, turnId: "secret:invalid" });
    f.observer.diagnostic({ ...f.diagnostic, sessionId: randomUUID() });
    expect(f.records).toEqual([]);
    f.observer.diagnostic(f.diagnostic);
    f.observer.diagnostic({ ...f.diagnostic, event: "worker_end", diagnosticIncomplete: true, severity: "ERROR" });
    f.observer.sent(f.report);
    f.observer.acknowledged({ ...f.ack, status: "conflict" });
    expect(f.records.at(-1)).toMatchObject({ outcome: "incomplete", diagnosticIncomplete: true });
    const length = f.records.length;
    f.changeScope({ ...f.diagnostic, environmentGeneration: 2 });
    f.observer.diagnostic({ ...f.diagnostic, environmentGeneration: 2 });
    expect(await f.observer.checkpoint(async () => 1)).toBe(1);
    f.observer.acknowledged(f.ack);
    expect(f.records).toHaveLength(length);
  });

  it("matches scheduled Session settlements by message and Turn", () => {
    const f = fixture();
    const messageId = randomUUID();
    f.observer.sent({
      type: "session:message:settled",
      requestId: randomUUID(),
      messageId,
      turnId: f.ack.turnId,
      outcome: "completed",
    });
    const ack: Extract<RunnerServerFrame, { type: "session:message:settled:ack" }> = {
      type: "session:message:settled:ack",
      requestId: randomUUID(),
      messageId,
      turnId: f.ack.turnId,
      status: "already_recorded",
    };
    f.observer.acknowledged({ ...ack, messageId: randomUUID() });
    expect(f.records).toHaveLength(1);
    f.observer.acknowledged(ack);
    expect(f.records.at(-1)?.outcome).toBe("completed");
  });

  it("keeps failed, cancelled and unknown settlements distinct after acknowledgement", () => {
    for (const outcome of ["failed", "cancelled", "unknown"] as const) {
      const f = fixture();
      const messageId = randomUUID();
      f.observer.sent({
        type: "session:message:settled",
        requestId: randomUUID(),
        messageId,
        turnId: f.ack.turnId,
        outcome,
      });
      f.observer.acknowledged({
        type: "session:message:settled:ack",
        requestId: randomUUID(),
        messageId,
        turnId: f.ack.turnId,
        status: "recorded",
      });
      expect(f.records.at(-1)?.outcome).toBe(outcome);
    }
  });

  it("bounds retained observation identities without evicting previously observed Turns", () => {
    const f = fixture();
    for (let index = 0; index < 1025; index++)
      f.observer.sent({ ...f.report, report: { ...f.report.report, turnId: randomUUID() } });
    expect(f.records).toHaveLength(1024);
  });
});
