import { describe, expect, it } from "vitest";
import {
  LAB_AGENT_ID,
  LAB_SCENARIOS,
  type LabPreviewPage,
  type LabScenario,
  labPreviewPageFor,
  labScenarioDefaults,
  labSeed,
  pendingLabEvent,
  runPendingLabEvent,
} from "./agent-setup-lab-model.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

const EXPECTED_STAGES: Record<LabScenario, string> = {
  "full-new-computer": "needs-computer",
  "full-existing-computer": "needs-computer",
  "agent-creation": "needs-computer",
  "computer-connection": "needs-computer",
  "computer-reconnect": "needs-computer",
  "computer-rebind": "needs-computer",
  "runtime-waiting": "needs-runtime",
  "runtime-checking": "needs-runtime",
  "runtime-setup": "needs-runtime",
  "runtime-sign-in": "needs-runtime",
  "messaging-support-setup": "needs-provider-clis",
  "messaging-setup": "needs-messaging",
  "messaging-handoff": "needs-messaging",
  "messaging-recovery": "needs-messaging",
  "everything-ready": "ready",
};

const EXPECTED_PAGES: Record<LabScenario, LabPreviewPage> = {
  "full-new-computer": "destination",
  "full-existing-computer": "destination",
  "agent-creation": "agent",
  "computer-connection": "computer",
  "computer-reconnect": "computer",
  "computer-rebind": "computer",
  "runtime-waiting": "checks",
  "runtime-checking": "checks",
  "runtime-setup": "checks",
  "runtime-sign-in": "checks",
  "messaging-support-setup": "checks",
  "messaging-setup": "messaging",
  "messaging-handoff": "messaging",
  "messaging-recovery": "messaging",
  "everything-ready": "complete",
};

function snapshotFor(scenario: LabScenario) {
  return memoryFor(scenario).inspect().snapshot;
}

function memoryFor(scenario: LabScenario) {
  const defaults = labScenarioDefaults(scenario);
  return createMemorySetupAdapter(labSeed(scenario, defaults.inventory, defaults.runtime, defaults.messagingProvider));
}

describe("agent setup lab model", () => {
  it("keeps every published product scenario valid and at its named checkpoint", () => {
    expect(Object.keys(EXPECTED_STAGES)).toEqual([...LAB_SCENARIOS]);
    for (const scenario of LAB_SCENARIOS) {
      expect(snapshotFor(scenario).stage, scenario).toBe(EXPECTED_STAGES[scenario]);
    }
  });

  it("maps every product scenario to an explicit preview page", () => {
    expect(Object.keys(EXPECTED_PAGES)).toEqual([...LAB_SCENARIOS]);
    for (const scenario of LAB_SCENARIOS) {
      expect(labPreviewPageFor(scenario), scenario).toBe(EXPECTED_PAGES[scenario]);
    }
  });

  it("covers each Computer recovery shape directly", async () => {
    expect(snapshotFor("computer-connection").computer.kind).toBe("not-bound");
    expect(snapshotFor("computer-reconnect").computer).toMatchObject({ kind: "bound", connectionStatus: "offline" });
    const rebind = memoryFor("computer-rebind");
    const initial = rebind.inspect().snapshot.computer;
    expect(initial.kind).toBe("requires-rebind");
    if (initial.kind !== "requires-rebind") throw new Error("The rebind scenario needs a stale Computer binding");
    const target = (await rebind.computerAdapter.inventory.computers()).computers[0];
    if (!target) throw new Error("The rebind scenario needs an owned Computer target");
    expect(initial.computerId).not.toBe(target.computerId);

    await rebind.computerAdapter.inventory.bindComputer(LAB_AGENT_ID, target.computerId);

    expect(rebind.inspect().snapshot.computer).toMatchObject({
      kind: "bound",
      computerId: target.computerId,
      displayName: "Review Mac",
    });
  });

  it("covers waiting, checking, install, and sign-in Runtime states directly", () => {
    expect(snapshotFor("runtime-waiting").runtime.kind).toBe("waiting");
    expect(snapshotFor("runtime-checking").runtime).toMatchObject({ kind: "observed", status: "checking" });
    expect(snapshotFor("runtime-setup").runtime).toMatchObject({ kind: "observed", status: "install" });
    expect(snapshotFor("runtime-sign-in").runtime).toMatchObject({ kind: "observed", status: "sign-in" });
  });

  it("lets a missing Runtime report advance through the same doctor event as other Runtime failures", () => {
    const memory = memoryFor("runtime-waiting");
    expect(pendingLabEvent(memory)).toBe("finish-readiness");

    runPendingLabEvent(memory);

    expect(memory.inspect().snapshot.runtime).toMatchObject({ kind: "observed", status: "ready" });
    expect(memory.inspect().snapshot.stage).toBe("needs-messaging");
  });

  it("separates messaging-support failure, ready-to-connect, handoff, recovery, and completion", () => {
    const support = snapshotFor("messaging-support-setup");
    expect(support.runtime).toMatchObject({ kind: "observed", status: "ready" });
    expect(support.components.filter((component) => component.kind === "im-cli")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "feishu", status: "unavailable", blocking: true }),
        expect.objectContaining({ provider: "slack", status: "ready", blocking: false }),
      ]),
    );
    expect(snapshotFor("messaging-setup").messaging.kind).toBe("not-configured");
    expect(snapshotFor("messaging-handoff").messaging.kind).toBe("waiting-handoff");
    expect(snapshotFor("messaging-recovery").messaging).toMatchObject({
      kind: "blocked",
      code: "reauthorization-required",
    });
    expect(snapshotFor("everything-ready").messaging.kind).toBe("ready");
  });
});
