import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type SessionReconcileRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkspaceManager } from "../runtime/agent-workspace.js";
import { sessionBindingPath } from "../runtime/runtime-paths.js";
import { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

describe("SessionBindingStore", () => {
  it("C-16/C-17 persists immutable identities without storing a Home path or credential", async () => {
    const fixture = await bindingFixture();
    const binding = await fixture.store.read("agent-1", "session-1");
    expect(binding).toMatchObject({
      schemaVersion: 1,
      agentId: "agent-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      provider: "codex",
      providerHomeIdentity: fixture.homeIdentity,
    });
    const raw = await readFile(sessionBindingPath(fixture.home, "agent-1", "session-1"), "utf8");
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain("credential-canary");

    const mismatchedStore = new SessionBindingStore({ home: fixture.home, providerHomeIdentity: "b".repeat(64) });
    const mismatchedWorkspace = new AgentWorkspaceManager({ home: fixture.home, bindingStore: mismatchedStore });
    const mismatched = new SessionReconciler({ computerId: fixture.computerId, preparation: mismatchedWorkspace });
    await expect(mismatched.reconcile({ ...fixture.reconcile, requestId: randomUUID() })).rejects.toThrow(
      /identity|binding/i,
    );
  });

  it("C-18 retains only the most recent 64 recorded input tombstones", async () => {
    const fixture = await bindingFixture();
    for (let index = 0; index < 65; index += 1) {
      const request = delivery(fixture.runtime, index);
      const inputHash = computeDirectInputHash(request);
      const turnId = `turn-${index}`;
      const resultHash = sha256(`result-${index}`);
      await fixture.store.recordAccepted(request, inputHash, turnId);
      await fixture.store.updateUnresolved("agent-1", "session-1", turnId, "reporting", { resultHash });
      await fixture.store.recordResult("agent-1", "session-1", turnId, resultHash);
    }
    const binding = await fixture.store.read("agent-1", "session-1");
    expect(binding?.recentRecordedInputs).toHaveLength(64);
    expect(binding?.recentRecordedInputs[0]?.deliveryId).toBe("delivery-1");
    expect(binding?.recentRecordedInputs.at(-1)?.deliveryId).toBe("delivery-64");
    const raw = await readFile(sessionBindingPath(fixture.home, "agent-1", "session-1"), "utf8");
    expect(raw).not.toContain("direct text 64");
  });

  it("C-19 enforces monotonic unresolved phases and reopens disk-only custody as recovery", async () => {
    const fixture = await bindingFixture();
    const request = delivery(fixture.runtime, 1);
    const inputHash = computeDirectInputHash(request);
    await fixture.store.recordAccepted(request, inputHash, "turn-1");
    await fixture.store.updateUnresolved("agent-1", "session-1", "turn-1", "starting", {
      providerThreadId: "thread-1",
    });
    await fixture.store.updateUnresolved("agent-1", "session-1", "turn-1", "running", {
      providerTurnId: "provider-turn-1",
    });
    await expect(fixture.store.updateUnresolved("agent-1", "session-1", "turn-1", "starting")).rejects.toThrow(
      /backwards/,
    );

    const reopenedStore = new SessionBindingStore({
      home: fixture.home,
      providerHomeIdentity: fixture.homeIdentity,
    });
    const reopenedWorkspace = new AgentWorkspaceManager({ home: fixture.home, bindingStore: reopenedStore });
    const reopened = new SessionReconciler({ computerId: fixture.computerId, preparation: reopenedWorkspace });
    await expect(reopened.reconcile({ ...fixture.reconcile, requestId: randomUUID() })).resolves.toMatchObject({
      status: "recovery_required",
      turn: { deliveryId: "delivery-1", turnId: "turn-1" },
    });
  });

  it("keeps the immutable full Turn Report durable before and after acknowledgement", async () => {
    const fixture = await bindingFixture();
    const request = delivery(fixture.runtime, 1);
    const report = turnReport(request, "turn-1");
    await fixture.store.recordAccepted(request, computeDirectInputHash(request), report.turnId);
    await fixture.store.updateUnresolved("agent-1", "session-1", report.turnId, "reporting", {
      report,
      resultHash: report.resultHash,
    });

    const reopened = new SessionBindingStore({ home: fixture.home, providerHomeIdentity: fixture.homeIdentity });
    expect((await reopened.read("agent-1", "session-1"))?.unresolvedTurn?.report).toEqual(report);
    await reopened.recordResult("agent-1", "session-1", report.turnId, report.resultHash);

    const recorded = await reopened.read("agent-1", "session-1");
    expect(recorded?.unresolvedTurn).toBeUndefined();
    expect(recorded?.recentRecordedInputs.at(-1)?.report).toEqual(report);
    await expect(reopened.recordResult("agent-1", "session-1", report.turnId, report.resultHash)).resolves.toEqual(
      recorded,
    );

    const active = delivery(fixture.runtime, 2);
    await reopened.recordAccepted(active, computeDirectInputHash(active), "turn-2");
    await expect(
      reopened.recordResult("agent-1", "session-1", report.turnId, report.resultHash),
    ).resolves.toMatchObject({ unresolvedTurn: { turnId: "turn-2" } });
  });

  it("C-16 fails closed when a binding JSON file is corrupted", async () => {
    const fixture = await bindingFixture();
    await writeFile(sessionBindingPath(fixture.home, "agent-1", "session-1"), "{not-json", "utf8");
    await expect(fixture.store.read("agent-1", "session-1")).rejects.toThrow(/invalid JSON/);
  });
});

async function bindingFixture() {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-binding-test-"));
  homes.push(home);
  const computerId = randomUUID();
  const homeIdentity = "a".repeat(64);
  const store = new SessionBindingStore({ home, providerHomeIdentity: homeIdentity });
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
  return { computerId, home, homeIdentity, reconcile, reconciler, runtime, store, workspace };
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

function delivery(runtime: EffectiveRuntimeSnapshot, index: number): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: `delivery-${index}`,
    imMessageId: `message-${index}`,
    imMessageRevision: 1,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: `direct text ${index}` },
    runtime,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function turnReport(request: DirectImMessageDeliveryRequest, turnId: string): TurnReportRequest {
  const body = {
    deliveryId: request.deliveryId,
    turnId,
    sessionId: request.sessionId,
    agentId: request.agentId,
    placementGeneration: request.placementGeneration,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "durable result",
    traceSummary: { lastSequence: 2, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
