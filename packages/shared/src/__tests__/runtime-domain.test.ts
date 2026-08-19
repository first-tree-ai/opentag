import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentTraceBatchSchema,
  ClientRuntimeBusinessFrameSchema,
  computeDirectInputHash,
  computeRuntimeSnapshotHashes,
  computeTurnResultHash,
  DirectImMessageDeliveryRequestSchema,
  type EffectiveRuntimeSnapshot,
  EffectiveRuntimeSnapshotSchema,
  ImMessageDeliveryResultSchema,
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  ServerRuntimeBusinessFrameSchema,
  SessionReconcileRequestSchema,
  SessionReconcileResultSchema,
  type TurnReportRequest,
  TurnReportRequestSchema,
} from "../index.js";

describe("runtime domain contract", () => {
  it("B-01 validates every V0 domain request and result through the public schema surface", () => {
    const runtime = snapshot();
    const reconcile = {
      type: "session:reconcile",
      requestId: randomUUID(),
      computerId: randomUUID(),
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
      desired: "ready",
      runtime,
    } as const;
    expect(ServerRuntimeBusinessFrameSchema.parse(reconcile)).toEqual(reconcile);
    const report = turnReport();
    expect(
      ClientRuntimeBusinessFrameSchema.parse({
        type: "session:reconcile:result",
        requestId: reconcile.requestId,
        sessionId: reconcile.sessionId,
        placementGeneration: 1,
        status: "ready",
        retainedReports: [
          {
            deliveryId: report.deliveryId,
            turnId: report.turnId,
            placementGeneration: report.placementGeneration,
            resultHash: report.resultHash,
          },
        ],
      }),
    ).toMatchObject({ status: "ready", retainedReports: [{ turnId: report.turnId }] });

    const delivery = directDelivery(runtime);
    expect(ServerRuntimeBusinessFrameSchema.parse(delivery)).toEqual(delivery);
    expect(
      ClientRuntimeBusinessFrameSchema.parse({
        type: "im:deliver:result",
        requestId: delivery.requestId,
        deliveryId: delivery.deliveryId,
        sessionId: delivery.sessionId,
        placementGeneration: 1,
        status: "accepted",
        turnId: "turn-1",
      }),
    ).toMatchObject({ status: "accepted" });

    expect(
      AgentTraceBatchSchema.parse({
        type: "agent:trace",
        batchId: "batch-1",
        sessionId: "session-1",
        turnId: "turn-1",
        placementGeneration: 1,
        events: [{ kind: "turn_started", sequence: 1, at: "2026-08-18T00:00:00.000Z" }],
      }),
    ).toMatchObject({ type: "agent:trace" });

    expect(ClientRuntimeBusinessFrameSchema.parse(report)).toEqual(report);
    expect(
      ServerRuntimeBusinessFrameSchema.parse({
        type: "turn:report:result",
        requestId: report.requestId,
        turnId: report.turnId,
        status: "recorded",
        resultHash: report.resultHash,
      }),
    ).toMatchObject({ status: "recorded" });
  });

  it("B-02 rejects contradictory discriminated fields", () => {
    const runtime = snapshot();
    expect(() =>
      SessionReconcileRequestSchema.parse({
        type: "session:reconcile",
        requestId: randomUUID(),
        computerId: randomUUID(),
        sessionId: "session-1",
        agentId: "agent-1",
        placementGeneration: 1,
        desired: "ready",
      }),
    ).toThrow();
    expect(() =>
      SessionReconcileRequestSchema.parse({
        type: "session:reconcile",
        requestId: randomUUID(),
        computerId: randomUUID(),
        sessionId: "session-1",
        agentId: "agent-1",
        placementGeneration: 1,
        desired: "stopped",
        runtime,
      }),
    ).toThrow();
    expect(() =>
      ImMessageDeliveryResultSchema.parse({
        type: "im:deliver:result",
        requestId: randomUUID(),
        deliveryId: "delivery-1",
        sessionId: "session-1",
        placementGeneration: 1,
        status: "accepted",
      }),
    ).toThrow();
    expect(() =>
      SessionReconcileResultSchema.parse({
        type: "session:reconcile:result",
        requestId: randomUUID(),
        sessionId: "session-1",
        placementGeneration: 1,
        status: "running",
      }),
    ).toThrow();
    const report = turnReport();
    expect(() =>
      SessionReconcileResultSchema.parse({
        type: "session:reconcile:result",
        requestId: randomUUID(),
        sessionId: report.sessionId,
        placementGeneration: report.placementGeneration,
        status: "rejected",
        reason: "configuration_conflict",
        retainedReports: [
          {
            deliveryId: report.deliveryId,
            turnId: report.turnId,
            placementGeneration: report.placementGeneration,
            resultHash: report.resultHash,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      SessionReconcileResultSchema.parse({
        type: "session:reconcile:result",
        requestId: randomUUID(),
        sessionId: report.sessionId,
        placementGeneration: report.placementGeneration,
        status: "ready",
        retainedReports: [
          {
            deliveryId: report.deliveryId,
            turnId: report.turnId,
            placementGeneration: report.placementGeneration + 1,
            resultHash: report.resultHash,
          },
        ],
      }),
    ).toThrow();
    expect(() => TurnReportRequestSchema.parse({ ...report, outcome: "failed", errorReason: undefined })).toThrow();
  });

  it("B-03 enforces field byte budgets independently from JavaScript string length", () => {
    const valid = directDelivery(snapshot());
    expect(
      DirectImMessageDeliveryRequestSchema.parse({
        ...valid,
        content: { kind: "text", text: "你".repeat(Math.floor(RUNTIME_DIRECT_TEXT_MAX_BYTES / 3)) },
      }),
    ).toBeDefined();
    expect(() =>
      DirectImMessageDeliveryRequestSchema.parse({
        ...valid,
        content: { kind: "text", text: `${"你".repeat(Math.floor(RUNTIME_DIRECT_TEXT_MAX_BYTES / 3))}你` },
      }),
    ).toThrow();
    expect(() =>
      EffectiveRuntimeSnapshotSchema.parse({
        ...snapshot(),
        instructions: { platform: "p".repeat(12 * 1024), agent: "a".repeat(12 * 1024), session: "x" },
      }),
    ).toThrow();
  });

  it("B-04/B-05 produces stable golden hashes from fixed tuples", () => {
    const runtime = snapshot();
    const hashes = computeRuntimeSnapshotHashes(runtime);
    expect(hashes).toEqual({
      agentConfigHash: "9c345d5a6bbd8c2ddaf49112c5bb110c053ad7fb9619fd66f2036f2685c85838",
      sessionConfigHash: "932ed754f30eaf7c643c9550d2f092bb7f17e0df2f9e07451699bedcf693f850",
      effectiveSnapshotHash: "02018089a05da18452e77e14694f3c24f76a9b0dd7e0fddbc0da77fdcc43a149",
    });
    expect(computeRuntimeSnapshotHashes({ ...runtime, allowedTools: ["read", "write"] })).toEqual(hashes);
    expect(computeDirectInputHash(directDelivery(runtime))).toBe(
      "663213ee66a0e4d078f719e5fa9e0204c23efd87cffeb702d5b3ac1842e6eba0",
    );
    expect(turnReport().resultHash).toBe("1531ebd9cb35b71727fd8913be9afad9f44e24fb3299ced53716085642e460c9");
  });

  it("B-06 rejects unsafe IDs and sequence boundaries without coercion", () => {
    const valid = directDelivery(snapshot());
    for (const sessionId of ["", "../session", "a/b", "a\\b", "a".repeat(129)]) {
      expect(() => DirectImMessageDeliveryRequestSchema.parse({ ...valid, sessionId })).toThrow();
    }
    for (const placementGeneration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => DirectImMessageDeliveryRequestSchema.parse({ ...valid, placementGeneration })).toThrow();
    }
  });
});

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 3, id: "agent-revision-3" },
      session: { sequence: 7, id: "session-revision-7" },
    },
    agentId: "agent-1",
    provider: "codex",
    model: "gpt-5.6-codex",
    reasoningEffort: "high",
    instructions: { platform: "platform α", agent: "agent β", session: "session γ" },
    allowedTools: ["write", "read"],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    budget: { maxDurationMs: 60_000 },
  };
}

function directDelivery(runtime: EffectiveRuntimeSnapshot) {
  return {
    type: "im:deliver" as const,
    requestId: "11111111-1111-4111-8111-111111111111",
    deliveryId: "delivery-1",
    imMessageId: "message-1",
    imMessageRevision: 1,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct" as const,
    content: { kind: "text" as const, text: "你好 OpenTag" },
    runtime,
    deadlineAt: "2026-08-18T01:00:00.000Z",
  };
}

function turnReport(): TurnReportRequest {
  const body = {
    deliveryId: "delivery-1",
    turnId: "turn-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "done ✓",
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 },
    traceSummary: { lastSequence: 5, droppedEvents: 1 },
  };
  return {
    type: "turn:report",
    requestId: "22222222-2222-4222-8222-222222222222",
    ...body,
    resultHash: computeTurnResultHash(body),
  };
}
