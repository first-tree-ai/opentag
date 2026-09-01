import { describe, expect, it } from "vitest";
import { AdmissionController } from "../runtime/admission-controller.js";
import { ComposedClientRuntime } from "../runtime/client-runtime-composition.js";
import { RuntimeDurabilityMetrics } from "../runtime/runtime-durability.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";

function composedRuntime(components: {
  custodyTurns: number;
  activeTurns: number;
  pendingReports: number;
  queuedSessionMessages: number;
  reconciler: SessionReconciler;
}): ComposedClientRuntime {
  const admission = new AdmissionController();
  return new ComposedClientRuntime({} as never, {
    admission,
    bindingStore: {} as never,
    custody: { liveTurnCount: components.custodyTurns } as never,
    credentialEnvironment: {} as never,
    durabilityMetrics: new RuntimeDurabilityMetrics(),
    reconciler: components.reconciler,
    sessionMessageInbox: { pendingCount: components.queuedSessionMessages } as never,
    reportOwner: { pendingCount: components.pendingReports } as never,
    runner: { activeCount: components.activeTurns } as never,
    runtimeManager: {} as never,
    workspace: {} as never,
    refreshCapability: async () => undefined,
    capabilityRefreshIntervalMs: 10,
    capabilityAbort: new AbortController(),
  });
}

describe("protected work snapshot", () => {
  it("is zero only when every authoritative owner is idle", () => {
    const reconciler = new SessionReconciler({ computerId: crypto.randomUUID() });
    const idle = composedRuntime({
      custodyTurns: 0,
      activeTurns: 0,
      pendingReports: 0,
      queuedSessionMessages: 0,
      reconciler,
    });
    expect(idle.protectedWork()).toEqual({
      sessionActivities: 0,
      pendingRecoveries: 0,
      custodyTurns: 0,
      activeTurns: 0,
      pendingReports: 0,
      queuedSessionMessages: 0,
      total: 0,
    });

    const busy = composedRuntime({
      custodyTurns: 1,
      activeTurns: 1,
      pendingReports: 2,
      queuedSessionMessages: 3,
      reconciler,
    });
    reconciler.setActivity("session-1", { phase: "running", deliveryId: "delivery-1", turnId: "turn-1" });
    reconciler.setRecovery("session-2", { deliveryId: "delivery-2", turnId: "turn-2" });
    const snapshot = busy.protectedWork();
    expect(snapshot).toMatchObject({
      sessionActivities: 1,
      pendingRecoveries: 1,
      custodyTurns: 1,
      activeTurns: 1,
      pendingReports: 2,
      queuedSessionMessages: 3,
    });
    expect(snapshot.total).toBe(9);

    // Clearing the authoritative records returns the gate to idle.
    expect(reconciler.clearActivity("session-1", "turn-1")).toBe(true);
    expect(reconciler.clearRecovery("session-2", "turn-2")).toBe(true);
    expect(busy.protectedWork().total).toBe(7);
  });

  it("exposes the reconciler's authoritative activity and recovery records", () => {
    const reconciler = new SessionReconciler({ computerId: crypto.randomUUID() });
    reconciler.setActivity("session-1", { phase: "reporting", deliveryId: "delivery-1", turnId: "turn-1" });
    reconciler.setRecovery("session-2", { deliveryId: "delivery-2", turnId: "turn-2" });
    expect(reconciler.protectedWorkSnapshot()).toEqual({
      activities: [{ sessionId: "session-1", phase: "reporting", deliveryId: "delivery-1", turnId: "turn-1" }],
      recoveries: [{ sessionId: "session-2", deliveryId: "delivery-2", turnId: "turn-2" }],
    });
  });

  it("closes admission before a zero-work snapshot and can reopen it after an abandoned attempt", () => {
    const admission = new AdmissionController();
    const runtime = new ComposedClientRuntime({} as never, {
      admission,
      bindingStore: {} as never,
      custody: { liveTurnCount: 0 } as never,
      credentialEnvironment: {} as never,
      durabilityMetrics: new RuntimeDurabilityMetrics(),
      reconciler: new SessionReconciler({ computerId: crypto.randomUUID() }),
      sessionMessageInbox: { pendingCount: 0 } as never,
      reportOwner: { pendingCount: 0 } as never,
      runner: { activeCount: 0 } as never,
      runtimeManager: {} as never,
      workspace: {} as never,
      refreshCapability: async () => undefined,
      capabilityRefreshIntervalMs: 10,
      capabilityAbort: new AbortController(),
    });

    const resume = runtime.quiesceForUpdate();
    expect(admission.paused).toBe(true);
    expect(runtime.protectedWork().total).toBe(0);
    resume();
    resume();
    expect(admission.paused).toBe(false);
  });
});
