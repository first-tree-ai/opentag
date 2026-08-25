import { randomUUID } from "node:crypto";
import type {
  DirectImMessageDeliveryRequest,
  EffectiveRuntimeSnapshot,
  InputRejectReason,
  SessionMessageDeliveryRequest,
  SessionReconcileRequest,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { type RuntimePreparation, SessionReconciler } from "../runtime/session-reconciler.js";

describe("SessionReconciler", () => {
  it("B-07 makes readiness per session and fences delivery by placement and runtime revision", async () => {
    const computerId = randomUUID();
    const reconciler = new SessionReconciler({ computerId });
    const request = reconcileRequest(computerId, "session-1", snapshot("agent-1", "workspace-1"));
    const delivery = directDelivery(request);

    expect(reconciler.checkDelivery(delivery)).toBe("session_not_ready");
    await expect(reconciler.reconcile(request)).resolves.toMatchObject({ status: "ready" });
    expect(reconciler.checkDelivery(delivery)).toBeUndefined();
    expect(reconciler.checkDelivery({ ...delivery, sessionId: "session-2" })).toBe("session_not_ready");
    expect(reconciler.checkDelivery({ ...delivery, placementGeneration: 0 })).toBe("stale_generation");
    expect(
      reconciler.checkDelivery({
        ...delivery,
        runtime: withSessionRevision(delivery.runtime, 2, "session-revision-2"),
      }),
    ).toBe("session_not_ready");
  });

  it("keeps internal Session admission separate from Direct IM delivery", async () => {
    const computerId = randomUUID();
    const sessionId = randomUUID();
    const agentId = randomUUID();
    const reconciler = new SessionReconciler({ computerId });
    const request = {
      ...reconcileRequest(computerId, sessionId, snapshot(agentId, agentId)),
      sessionKind: "internal" as const,
    };
    await expect(reconciler.reconcile(request)).resolves.toMatchObject({ status: "ready" });
    expect(reconciler.checkDelivery(directDelivery(request))).toBe("target_mismatch");
    const runtime = request.runtime;
    if (!runtime) throw new Error("Expected a ready Runtime snapshot");
    const collaboration: SessionMessageDeliveryRequest = {
      type: "session:message:deliver",
      requestId: randomUUID(),
      messageId: randomUUID(),
      sourceSessionId: randomUUID(),
      targetSessionId: sessionId,
      agentId,
      placementGeneration: 1,
      content: { kind: "text", text: "work" },
      runtime,
    };
    expect(reconciler.checkSessionMessageDelivery(collaboration)).toBeUndefined();
    expect(reconciler.getSession(sessionId)?.sessionKind).toBe("internal");
  });

  it("keeps Session kind immutable across legacy and collaboration reconcile requests", async () => {
    const computerId = randomUUID();
    const internalId = randomUUID();
    const agentId = randomUUID();
    const reconciler = new SessionReconciler({ computerId });
    const internal = {
      ...reconcileRequest(computerId, internalId, snapshot(agentId, agentId)),
      sessionKind: "internal" as const,
    };
    await expect(reconciler.reconcile(internal)).resolves.toMatchObject({ status: "ready" });

    await expect(
      reconciler.reconcile({ ...internal, requestId: randomUUID(), sessionKind: undefined }),
    ).resolves.toMatchObject({ status: "rejected", reason: "session_binding_conflict" });
    expect(reconciler.getSession(internalId)?.sessionKind).toBe("internal");
    expect(reconciler.checkDelivery(directDelivery(internal))).toBe("target_mismatch");

    const visibleId = randomUUID();
    const visible = reconcileRequest(computerId, visibleId, snapshot(agentId, agentId));
    await expect(reconciler.reconcile(visible)).resolves.toMatchObject({ status: "ready" });
    await expect(
      reconciler.reconcile({ ...visible, requestId: randomUUID(), sessionKind: "internal" }),
    ).resolves.toMatchObject({ status: "rejected", reason: "session_binding_conflict" });
    expect(reconciler.getSession(visibleId)?.sessionKind).toBe("visible");
  });

  it("accepts an idle internal Session configuration update when its sequence advances", async () => {
    const computerId = randomUUID();
    const sessionId = randomUUID();
    const agentId = randomUUID();
    const reconciler = new SessionReconciler({ computerId });
    const initialRuntime = snapshot(agentId, agentId);
    const initial = {
      ...reconcileRequest(computerId, sessionId, initialRuntime),
      sessionKind: "internal" as const,
    };
    await expect(reconciler.reconcile(initial)).resolves.toMatchObject({ status: "ready" });

    const updatedRuntime: EffectiveRuntimeSnapshot = {
      ...initialRuntime,
      model: "gpt-5.1",
      reasoningEffort: "medium",
      budget: { maxDurationMs: 45_000 },
      revision: {
        agent: { sequence: 2, id: initialRuntime.revision.agent.id },
        session: { sequence: 2, id: "session-revision-2" },
      },
    };
    await expect(
      reconciler.reconcile({ ...initial, requestId: randomUUID(), runtime: updatedRuntime }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(reconciler.getSession(sessionId)).toMatchObject({ revisionSequence: 2, sessionKind: "internal" });
  });

  it("B-08/B-13 coalesces identical requests and same-agent bootstrap", async () => {
    const computerId = randomUUID();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparation = preparationFixture();
    preparation.prepareAgent.mockImplementation(() => gate);
    const reconciler = new SessionReconciler({ computerId, preparation });
    const first = reconcileRequest(computerId, "session-1", snapshot("agent-1", "workspace-1"));
    const duplicate = reconciler.reconcile(first);
    const sameRequest = reconciler.reconcile(structuredClone(first));
    const sibling = reconciler.reconcile({ ...first, requestId: randomUUID(), sessionId: "session-2" });

    await vi.waitFor(() => expect(preparation.prepareAgent).toHaveBeenCalledOnce());
    release?.();
    const [firstResult, duplicateResult, siblingResult] = await Promise.all([duplicate, sameRequest, sibling]);
    expect(firstResult).toEqual(duplicateResult);
    expect(siblingResult.status).toBe("ready");
    expect(preparation.prepareAgent).toHaveBeenCalledOnce();
    expect(preparation.prepareSession).toHaveBeenCalledTimes(2);
    expect(reconciler.getSession("session-1")?.workspaceId).toBe("workspace-1");
    expect(reconciler.getSession("session-2")?.workspaceId).toBe("workspace-1");
  });

  it("B-09/B-10 rejects same-sequence conflicts and late revisions without state rollback", async () => {
    const computerId = randomUUID();
    const reconciler = new SessionReconciler({ computerId });
    const initialRuntime = snapshot("agent-1", "workspace-1");
    const initial = reconcileRequest(computerId, "session-1", initialRuntime);
    await reconciler.reconcile(initial);

    const conflict = reconcileRequest(
      computerId,
      "session-1",
      { ...initialRuntime, instructions: { ...initialRuntime.instructions, agent: "conflicting agent" } },
      1,
    );
    await expect(reconciler.reconcile(conflict)).resolves.toMatchObject({
      status: "rejected",
      reason: "configuration_conflict",
    });

    const upgraded = reconcileRequest(
      computerId,
      "session-1",
      withAgentRevision(initialRuntime, 2, "agent-revision-2"),
      1,
    );
    await expect(reconciler.reconcile(upgraded)).resolves.toMatchObject({ status: "ready" });
    await expect(reconciler.reconcile({ ...initial, requestId: randomUUID() })).resolves.toMatchObject({
      status: "rejected",
      reason: "stale_configuration",
    });
    expect(reconciler.getAgent("agent-1")?.revisionSequence).toBe(2);
  });

  it("B-11/B-12 blocks session migration and agent revision changes while a turn owns the binding", async () => {
    const computerId = randomUUID();
    const reconciler = new SessionReconciler({ computerId });
    const firstRuntime = snapshot("agent-1", "workspace-1");
    const siblingRuntime = snapshot("agent-1", "workspace-1");
    const first = reconcileRequest(computerId, "session-1", firstRuntime);
    const sibling = reconcileRequest(computerId, "session-2", siblingRuntime);
    await reconciler.reconcile(first);
    await reconciler.reconcile(sibling);
    reconciler.setActivity("session-1", { phase: "running", deliveryId: "delivery-1", turnId: "turn-1" });

    await expect(
      reconciler.reconcile({ ...first, requestId: randomUUID(), placementGeneration: 2 }),
    ).resolves.toMatchObject({ status: "busy", reason: "active_turn" });
    await expect(
      reconciler.reconcile({
        ...first,
        requestId: randomUUID(),
        runtime: withSessionRevision(firstRuntime, 2, "session-revision-2"),
      }),
    ).resolves.toMatchObject({ status: "busy", reason: "active_turn" });
    await expect(
      reconciler.reconcile({
        ...sibling,
        requestId: randomUUID(),
        runtime: withAgentRevision(siblingRuntime, 2, "agent-revision-2"),
      }),
    ).resolves.toMatchObject({ status: "busy", reason: "agent_configuration_busy" });
    expect(reconciler.getAgent("agent-1")?.revisionSequence).toBe(1);
  });

  it("B-14/B-16 keeps one agent workspace invariant and stops only the target binding", async () => {
    const computerId = randomUUID();
    const preparation = preparationFixture();
    const reconciler = new SessionReconciler({ computerId, preparation });
    const firstRuntime = snapshot("agent-1", "workspace-1");
    const siblingRuntime = snapshot("agent-1", "workspace-1");
    const first = reconcileRequest(computerId, "session-1", firstRuntime);
    const sibling = reconcileRequest(computerId, "session-2", siblingRuntime);
    await reconciler.reconcile(first);
    await reconciler.reconcile(sibling);

    await expect(
      reconciler.reconcile({
        ...sibling,
        requestId: randomUUID(),
        runtime: { ...siblingRuntime, workspace: { ...siblingRuntime.workspace, workspaceId: "workspace-2" } },
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "session_binding_conflict" });
    await expect(
      reconciler.reconcile({
        type: "session:reconcile",
        requestId: randomUUID(),
        computerId,
        sessionId: "session-1",
        agentId: "agent-1",
        placementGeneration: 1,
        desired: "stopped",
      }),
    ).resolves.toMatchObject({ status: "stopped" });
    expect(reconciler.getSession("session-1")?.status).toBe("stopped");
    expect(reconciler.getSession("session-2")?.status).toBe("ready");
    expect(reconciler.getAgent("agent-1")?.workspaceId).toBe("workspace-1");
    expect(preparation.stopSession).toHaveBeenCalledWith("session-1", 1);
  });

  it("B-17 distinguishes a live owner from disk-only recovery", async () => {
    const computerId = randomUUID();
    const reconciler = new SessionReconciler({ computerId });
    const request = reconcileRequest(computerId, "session-1", snapshot("agent-1", "workspace-1"));
    await reconciler.reconcile(request);
    reconciler.setActivity("session-1", { phase: "reporting", deliveryId: "delivery-1", turnId: "turn-1" });
    expect(reconciler.claimRecovery("session-1", { deliveryId: "delivery-1", turnId: "turn-1" })).toBe(false);
    await expect(reconciler.reconcile({ ...request, requestId: randomUUID() })).resolves.toMatchObject({
      status: "reporting",
      turn: { turnId: "turn-1" },
    });
    reconciler.clearActivity("session-1", "turn-1");
    expect(reconciler.claimRecovery("session-1", { deliveryId: "delivery-1", turnId: "turn-1" })).toBe(true);
    expect(reconciler.claimRecovery("session-1", { deliveryId: "delivery-1", turnId: "turn-1" })).toBe(true);
    expect(reconciler.claimRecovery("session-1", { deliveryId: "delivery-2", turnId: "turn-2" })).toBe(false);
    await expect(reconciler.reconcile({ ...request, requestId: randomUUID() })).resolves.toMatchObject({
      status: "recovery_required",
      turn: { turnId: "turn-1" },
    });
    expect(reconciler.checkDelivery(directDelivery(request))).toBe("session_recovery_required");
  });

  it("B-18 rejects snapshots the local policy cannot fully enforce", async () => {
    const computerId = randomUUID();
    const preparation = preparationFixture();
    const reconciler = new SessionReconciler({
      computerId,
      preparation,
      localPolicy: {
        validate: (runtime) => (runtime.execution.networkAccess ? "configuration_unsupported" : undefined),
      },
    });
    const request = reconcileRequest(computerId, "session-1", {
      ...snapshot("agent-1", "workspace-1"),
      execution: { approvalPolicy: "never", networkAccess: true },
    });

    await expect(reconciler.reconcile(request)).resolves.toMatchObject({
      status: "rejected",
      reason: "configuration_unsupported",
    });
    expect(preparation.prepareAgent).not.toHaveBeenCalled();
    expect(preparation.prepareSession).not.toHaveBeenCalled();
  });

  it("separates stable delivery policy from transient readiness validation", async () => {
    const computerId = randomUUID();
    const validate = vi.fn(
      (_snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined => "provider_unavailable",
    );
    const validateDelivery = vi.fn(() => undefined);
    const reconciler = new SessionReconciler({ computerId, localPolicy: { validate, validateDelivery } });
    const request = reconcileRequest(computerId, "session-1", snapshot("agent-1", "workspace-1"));

    validate.mockReturnValueOnce(undefined);
    await expect(reconciler.reconcile(request)).resolves.toMatchObject({ status: "ready" });
    expect(reconciler.checkDelivery(directDelivery(request))).toBeUndefined();
    expect(validateDelivery).toHaveBeenCalledWith(request.runtime);
  });
});

function snapshot(agentId: string, workspaceId: string): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId,
    provider: "codex",
    instructions: { platform: "platform", agent: "agent", session: "session" },
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId, mode: "empty_on_create", sharing: "agent" },
  };
}

function reconcileRequest(
  computerId: string,
  sessionId: string,
  runtime: EffectiveRuntimeSnapshot,
  placementGeneration = 1,
): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId,
    agentId: runtime.agentId,
    placementGeneration,
    desired: "ready",
    runtime,
  };
}

function directDelivery(request: SessionReconcileRequest): DirectImMessageDeliveryRequest {
  if (!request.runtime) throw new Error("Delivery fixture requires a runtime");
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: "delivery-1",
    imMessageId: "message-1",
    sessionId: request.sessionId,
    agentId: request.agentId,
    placementGeneration: request.placementGeneration,
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
    runtime: request.runtime,
  };
}

function withAgentRevision(runtime: EffectiveRuntimeSnapshot, sequence: number, id: string): EffectiveRuntimeSnapshot {
  return { ...runtime, revision: { ...runtime.revision, agent: { sequence, id } } };
}

function withSessionRevision(
  runtime: EffectiveRuntimeSnapshot,
  sequence: number,
  id: string,
): EffectiveRuntimeSnapshot {
  return { ...runtime, revision: { ...runtime.revision, session: { sequence, id } } };
}

function preparationFixture(): RuntimePreparation & {
  prepareAgent: ReturnType<typeof vi.fn>;
  prepareSession: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
} {
  return {
    prepareAgent: vi.fn(async () => undefined),
    prepareSession: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
  };
}
