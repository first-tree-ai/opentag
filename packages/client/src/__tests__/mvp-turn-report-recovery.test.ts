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

    recovery.afterReconciled(firstRequest, firstResult);
    recovery.afterReconciled(secondRequest, secondResult);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenLastCalledWith(first, expect.any(Function), { onTerminal: expect.any(Function) });

    const reloadedSecond = { ...second, requestId: randomUUID() };
    bindings.set(bindingKey(second.agentId, second.sessionId), reportingBinding(reloadedSecond));
    releaseFirst?.();

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit).toHaveBeenLastCalledWith(reloadedSecond, expect.any(Function), {
      onTerminal: expect.any(Function),
    });
  });

  it("releases an active replay slot when the Server returns a terminal Report status", async () => {
    const first = turnReport("agent-1", "session-1", "terminal");
    const second = turnReport("agent-2", "session-2", "recorded");
    const bindings = new Map([
      [bindingKey(first.agentId, first.sessionId), reportingBinding(first)],
      [bindingKey(second.agentId, second.sessionId), reportingBinding(second)],
    ]);
    const submit = vi.fn(
      (
        report: TurnReportRequest,
        _confirm: () => Promise<void> | void,
        options?: { onTerminal?(status: "conflict" | "stale_generation"): void },
      ) => {
        if (report.sessionId !== first.sessionId) return Promise.resolve();
        options?.onTerminal?.("conflict");
        return new Promise<void>(() => undefined);
      },
    );
    const recovery = recoveryFor(bindings, submit, { maxActiveReplays: 1 });
    const firstRequest = reconcileRequest(first.agentId, first.sessionId);
    const secondRequest = reconcileRequest(second.agentId, second.sessionId);

    const firstResult = await recovery.prepare(firstRequest, recoveryRequired(firstRequest, first));
    const secondResult = await recovery.prepare(secondRequest, recoveryRequired(secondRequest, second));
    recovery.afterReconciled(firstRequest, firstResult);
    recovery.afterReconciled(secondRequest, secondResult);

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1]?.[0]).toEqual(second);
  });

  it("cancels a prepared batch when its reconcile result was not sent", async () => {
    const first = turnReport("agent-1", "session-1", "first-prepared");
    const second = turnReport("agent-2", "session-2", "second-prepared");
    const bindings = new Map([
      [bindingKey(first.agentId, first.sessionId), reportingBinding(first)],
      [bindingKey(second.agentId, second.sessionId), reportingBinding(second)],
    ]);
    const recovery = recoveryFor(
      bindings,
      vi.fn(async () => undefined),
      { maxPreparedBatches: 1 },
    );
    const firstRequest = reconcileRequest(first.agentId, first.sessionId);
    const secondRequest = reconcileRequest(second.agentId, second.sessionId);

    const firstResult = await recovery.prepare(firstRequest, recoveryRequired(firstRequest, first));
    await recovery.prepare(firstRequest, recoveryRequired(firstRequest, first));
    await expect(recovery.prepare(secondRequest, recoveryRequired(secondRequest, second))).rejects.toThrow(
      "prepared batch limit",
    );

    const resultWithoutManifest = recoveryRequired(firstRequest, first);
    recovery.afterReconciled(firstRequest, resultWithoutManifest);
    recovery.cancel(firstRequest, resultWithoutManifest);
    await expect(recovery.prepare(secondRequest, recoveryRequired(secondRequest, second))).rejects.toThrow(
      "prepared batch limit",
    );

    recovery.cancel(firstRequest, firstResult);
    await expect(recovery.prepare(secondRequest, recoveryRequired(secondRequest, second))).rejects.toThrow(
      "prepared batch limit",
    );

    recovery.cancel(firstRequest, firstResult);
    await expect(recovery.prepare(secondRequest, recoveryRequired(secondRequest, second))).resolves.toMatchObject({
      retainedReports: [reportReference(second)],
    });
  });
});

function recoveryFor(
  bindings: Map<string, ReturnType<typeof reportingBinding>>,
  submit: MvpTurnReportRecoveryOptions["reportOwner"]["submit"],
  limits: Pick<MvpTurnReportRecoveryOptions, "maxActiveReplays" | "maxPreparedBatches">,
): MvpTurnReportRecovery {
  return new MvpTurnReportRecovery({
    bindingStore: {
      read: vi.fn(async (agentId: string, sessionId: string) => bindings.get(bindingKey(agentId, sessionId))),
      recordResult: vi.fn(async () => undefined),
    } as unknown as MvpTurnReportRecoveryOptions["bindingStore"],
    ...limits,
    reconciler: {
      clearRecovery: vi.fn(),
      withAgentLock: vi.fn(async (_agentId: string, action: () => unknown) => action()),
    } as unknown as MvpTurnReportRecoveryOptions["reconciler"],
    reportOwner: { submit },
  });
}

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
