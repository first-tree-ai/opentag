import { randomUUID } from "node:crypto";
import {
  computeTurnResultHash,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  type TurnReportRequest,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { MvpTurnReportRecovery, type MvpTurnReportRecoveryOptions } from "../runtime/mvp-turn-report-recovery.js";

describe("MvpTurnReportRecovery", () => {
  it("bounds active replay work and lazily reloads full reports from durable bindings", async () => {
    const first = turnReport("agent-1", "session-1", "first");
    const second = turnReport("agent-2", "session-2", "second");
    const bindings = new Map([
      [bindingKey(first.agentId, first.sessionId), reportingBinding(first)],
      [bindingKey(second.agentId, second.sessionId), reportingBinding(second)],
    ]);
    const read = vi.fn(async (agentId: string, sessionId: string) => bindings.get(bindingKey(agentId, sessionId)));
    const recordResult = vi.fn(async () => undefined);
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const submit = vi.fn((report: TurnReportRequest) =>
      report.sessionId === first.sessionId ? firstPending : Promise.resolve(),
    );
    const recovery = new MvpTurnReportRecovery({
      bindingStore: { read, recordResult } as unknown as MvpTurnReportRecoveryOptions["bindingStore"],
      maxActiveReplays: 1,
      reconciler: {
        clearRecovery: vi.fn(),
        withAgentLock: vi.fn(async (_agentId: string, action: () => unknown) => action()),
      } as unknown as MvpTurnReportRecoveryOptions["reconciler"],
      reportOwner: { submit } as unknown as MvpTurnReportRecoveryOptions["reportOwner"],
    });
    const firstRequest = reconcileRequest(first.agentId, first.sessionId);
    const secondRequest = reconcileRequest(second.agentId, second.sessionId);

    const firstResult = await recovery.prepare(firstRequest, recoveryRequired(firstRequest, first));
    const secondResult = await recovery.prepare(secondRequest, recoveryRequired(secondRequest, second));
    expect(firstResult.retainedReports).toEqual([reportReference(first)]);
    expect(secondResult.retainedReports).toEqual([reportReference(second)]);

    recovery.afterReconciled(firstRequest);
    recovery.afterReconciled(secondRequest);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenLastCalledWith(first, expect.any(Function));

    const reloadedSecond = { ...second, requestId: randomUUID() };
    bindings.set(bindingKey(second.agentId, second.sessionId), reportingBinding(reloadedSecond));
    releaseFirst?.();

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit).toHaveBeenLastCalledWith(reloadedSecond, expect.any(Function));
  });
});

function reconcileRequest(agentId: string, sessionId: string): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId: "computer-1",
    sessionId,
    agentId,
    placementGeneration: 1,
    desired: "ready",
    runtime: {
      revision: {
        agent: { sequence: 1, id: `${agentId}-revision` },
        session: { sequence: 1, id: `${sessionId}-revision` },
      },
      agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent", session: "session" },
      allowedTools: [],
      execution: { approvalPolicy: "never", networkAccess: false },
      workspace: { workspaceId: `${agentId}-workspace`, mode: "empty_on_create", sharing: "agent" },
    },
  };
}

function recoveryRequired(request: SessionReconcileRequest, report: TurnReportRequest): SessionReconcileResult {
  return {
    type: "session:reconcile:result",
    requestId: request.requestId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    status: "recovery_required",
    reason: "unresolved_turn",
    turn: { deliveryId: report.deliveryId, turnId: report.turnId },
  };
}

function turnReport(agentId: string, sessionId: string, suffix: string): TurnReportRequest {
  const body = {
    deliveryId: `delivery-${suffix}`,
    turnId: `turn-${suffix}`,
    sessionId,
    agentId,
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: `${suffix} result`,
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
  };
  return {
    type: "turn:report",
    requestId: randomUUID(),
    ...body,
    resultHash: computeTurnResultHash(body),
  };
}

function reportingBinding(report: TurnReportRequest) {
  return {
    unresolvedTurn: {
      requestId: randomUUID(),
      deliveryId: report.deliveryId,
      inputHash: "a".repeat(64),
      turnId: report.turnId,
      phase: "reporting" as const,
      report,
      resultHash: report.resultHash,
    },
    recentRecordedInputs: [],
  };
}

function reportReference(report: TurnReportRequest) {
  return {
    deliveryId: report.deliveryId,
    turnId: report.turnId,
    placementGeneration: report.placementGeneration,
    resultHash: report.resultHash,
  };
}

function bindingKey(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`;
}
