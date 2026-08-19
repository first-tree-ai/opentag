import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  DirectImMessageDeliveryRequest,
  EffectiveRuntimeSnapshot,
  SessionReconcileRequest,
} from "@opentag/shared";
import { computeTurnResultHash } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../runtime/admission-controller.js";
import { AgentWorkspaceManager } from "../runtime/agent-workspace.js";
import { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import { TurnCustodyOwner } from "../runtime/turn-custody-owner.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

describe("AdmissionController", () => {
  it("C-20/C-21 enforces one Session and ten concurrent Sessions per Agent without a queue", () => {
    const admission = new AdmissionController();
    const reservations = Array.from({ length: 10 }, (_, index) => admission.reserve(`session-${index}`, "agent-1"));
    expect(reservations.every((decision) => decision.accepted)).toBe(true);
    expect(admission.reserve("session-0", "agent-2")).toEqual({ accepted: false, reason: "session_busy" });
    expect(admission.reserve("session-10", "agent-1")).toEqual({ accepted: false, reason: "agent_busy" });
    expect(admission.snapshot().activeAgents.get("agent-1")).toBe(10);
    for (const decision of reservations) if (decision.accepted) decision.reservation.release();
    expect(admission.snapshot().client).toBe(0);
  });

  it("C-22/C-23 atomically caps the daemon at 99 across Agents", () => {
    const admission = new AdmissionController();
    const reservations = Array.from({ length: 99 }, (_, index) =>
      admission.reserve(`session-${index}`, `agent-${Math.floor(index / 9)}`),
    );
    expect(reservations.every((decision) => decision.accepted)).toBe(true);
    expect(admission.reserve("session-99", "agent-99")).toEqual({ accepted: false, reason: "client_busy" });
    expect(admission.snapshot().client).toBe(99);
  });
});

describe("TurnCustodyOwner", () => {
  it("C-25/C-28 commits durable custody before Accepted can start the Provider", async () => {
    const fixture = await custodyFixture();
    const start = vi.fn(async () => undefined);
    const owner = new TurnCustodyOwner({
      bindingStore: fixture.store,
      id: () => "turn-1",
      reconciler: fixture.reconciler,
      start,
    });
    const request = delivery(fixture.runtime, "delivery-1", randomUUID());
    const first = owner.accept(request);
    const duplicate = owner.accept(structuredClone(request));
    expect(duplicate).toBe(first);
    const decision = await first;
    expect(decision.result).toMatchObject({ status: "accepted", turnId: "turn-1" });
    expect(start).not.toHaveBeenCalled();
    expect(await fixture.store.read("agent-1", "session-1")).toMatchObject({
      unresolvedTurn: { phase: "accepted", deliveryId: "delivery-1", turnId: "turn-1" },
    });
    expect(owner.admission.snapshot().client).toBe(1);

    await decision.onAcceptedSent?.();
    expect(start).toHaveBeenCalledOnce();
    expect(owner.admission.get("session-1")?.phase).toBe("active");
    await decision.onAcceptedSent?.();
    expect(start).toHaveBeenCalledOnce();
  });

  it("C-24/C-31 retains capacity through reporting and releases only a matching result", async () => {
    const fixture = await custodyFixture();
    const owner = new TurnCustodyOwner({
      bindingStore: fixture.store,
      id: () => "turn-1",
      reconciler: fixture.reconciler,
    });
    const decision = await owner.accept(delivery(fixture.runtime, "delivery-1", randomUUID()));
    await decision.onAcceptedSent?.();
    const reportBody = {
      deliveryId: "delivery-1",
      turnId: "turn-1",
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
      outcome: "completed" as const,
      executionEffects: "completed" as const,
      finalText: "done",
      traceSummary: { lastSequence: 1, droppedEvents: 0 },
    };
    const resultHash = computeTurnResultHash(reportBody);
    await owner.markReporting("turn-1", {
      type: "turn:report",
      requestId: randomUUID(),
      ...reportBody,
      resultHash,
    });
    expect(owner.admission.get("session-1")?.phase).toBe("reporting");
    expect(owner.admission.reserve("session-1", "agent-1")).toEqual({ accepted: false, reason: "session_busy" });
    await expect(owner.recordResult("turn-1", sha256("wrong"))).rejects.toThrow(/does not match/);
    expect(owner.admission.snapshot().client).toBe(1);
    await owner.recordResult("turn-1", resultHash);
    expect(owner.admission.snapshot().client).toBe(0);
    expect((await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn).toBeUndefined();
  });

  it("C-26/C-27 rejects conflicting duplicates and rolls back failed preflight", async () => {
    const fixture = await custodyFixture();
    const owner = new TurnCustodyOwner({
      bindingStore: fixture.store,
      id: () => "turn-1",
      preflight: async () => "provider_unavailable",
      reconciler: fixture.reconciler,
    });
    const request = delivery(fixture.runtime, "delivery-1", randomUUID());
    await expect(owner.accept(request)).resolves.toMatchObject({
      result: { status: "rejected", reason: "provider_unavailable" },
    });
    expect(owner.admission.snapshot().client).toBe(0);
    expect((await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn).toBeUndefined();

    const readyOwner = new TurnCustodyOwner({
      bindingStore: fixture.store,
      id: () => "turn-2",
      reconciler: fixture.reconciler,
    });
    const accepted = readyOwner.accept(request);
    await expect(
      readyOwner.accept({ ...request, content: { kind: "text", text: "different" } }),
    ).resolves.toMatchObject({ result: { status: "rejected", reason: "input_conflict" } });
    await expect(accepted).resolves.toMatchObject({ result: { status: "accepted" } });
  });

  it("C-29 waits for a successful Accepted send and correlates explicit redelivery with a new request ID", async () => {
    const fixture = await custodyFixture();
    const start = vi.fn(async () => undefined);
    const owner = new TurnCustodyOwner({
      bindingStore: fixture.store,
      id: () => "turn-1",
      reconciler: fixture.reconciler,
      start,
    });
    const firstRequest = delivery(fixture.runtime, "delivery-1", randomUUID());
    const first = await owner.accept(firstRequest);
    expect(start).not.toHaveBeenCalled();
    const retryRequest = { ...firstRequest, requestId: randomUUID() };
    const retry = await owner.accept(retryRequest);
    expect(retry.result).toMatchObject({ requestId: retryRequest.requestId, turnId: "turn-1" });
    await retry.onAcceptedSent?.();
    expect(start).toHaveBeenCalledOnce();
    await first.onAcceptedSent?.();
    expect(start).toHaveBeenCalledOnce();
  });

  it("C-30 rejects an expired input before taking a slot", async () => {
    const fixture = await custodyFixture();
    const owner = new TurnCustodyOwner({
      bindingStore: fixture.store,
      now: () => Date.parse("2026-08-18T01:00:00.000Z"),
      reconciler: fixture.reconciler,
    });
    const request = {
      ...delivery(fixture.runtime, "delivery-1", randomUUID()),
      deadlineAt: "2026-08-18T00:59:59.000Z",
    };
    await expect(owner.accept(request)).resolves.toMatchObject({
      result: { status: "rejected", reason: "turn_expired" },
    });
    expect(owner.admission.snapshot().client).toBe(0);
  });

  it("serializes accepted custody with Agent configuration reconciliation", async () => {
    const fixture = await custodyFixture();
    let enterPreflight: (() => void) | undefined;
    let releasePreflight: (() => void) | undefined;
    const preflightEntered = new Promise<void>((resolve) => {
      enterPreflight = resolve;
    });
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const owner = new TurnCustodyOwner({
      bindingStore: fixture.store,
      id: () => "turn-1",
      preflight: async () => {
        enterPreflight?.();
        await preflightGate;
        return undefined;
      },
      reconciler: fixture.reconciler,
    });

    const accepted = owner.accept(delivery(fixture.runtime, "delivery-1", randomUUID()));
    await preflightEntered;
    const upgradedRuntime: EffectiveRuntimeSnapshot = {
      ...fixture.runtime,
      revision: {
        agent: { sequence: 2, id: "agent-revision-2" },
        session: fixture.runtime.revision.session,
      },
      instructions: { ...fixture.runtime.instructions, agent: "upgraded agent" },
    };
    const upgraded = fixture.reconciler.reconcile({
      ...fixture.reconcile,
      requestId: randomUUID(),
      runtime: upgradedRuntime,
    });
    releasePreflight?.();

    await expect(accepted).resolves.toMatchObject({ result: { status: "accepted", turnId: "turn-1" } });
    await expect(upgraded).resolves.toMatchObject({ status: "busy", reason: "agent_configuration_busy" });
    expect(fixture.reconciler.getAgent("agent-1")?.revisionSequence).toBe(1);
  });
});

async function custodyFixture() {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-custody-test-"));
  homes.push(home);
  const computerId = randomUUID();
  const store = new SessionBindingStore({ home, providerHomeIdentity: "a".repeat(64) });
  const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
  const reconciler = new SessionReconciler({ computerId, preparation: workspace });
  const runtime = snapshot();
  const reconcile: SessionReconcileRequest = {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime,
  };
  await reconciler.reconcile(reconcile);
  return { computerId, home, reconcile, reconciler, runtime, store, workspace };
}

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-1",
    provider: "codex",
    instructions: { platform: "platform", agent: "agent", session: "session" },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

function delivery(
  runtime: EffectiveRuntimeSnapshot,
  deliveryId: string,
  requestId: string,
): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId,
    deliveryId,
    imMessageId: `message-${deliveryId}`,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "hello" },
    runtime,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
