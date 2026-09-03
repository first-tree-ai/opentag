import type { AccountComputerSummary, AgentRuntimeProvider, AgentSummary, ImProvider } from "@opentag/shared/browser";
import type { MemorySetupAdapter, MemorySetupSeed } from "./setup-memory-adapter.js";

export const LAB_AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
export const LAB_ACCOUNT_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const LAB_COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const LAB_SPARE_COMPUTER_ID = "95fe9af3-d1c6-472b-b78c-8a7ccf512751";
const LAB_NOW = "2026-09-01T10:00:00.000Z";

export const LAB_JOURNEYS = ["first", "additional"] as const;
export type LabJourney = (typeof LAB_JOURNEYS)[number];

/** A small set of design destinations. Fine-grained facts live under Overrides. */
export const LAB_SCENARIOS = [
  "full-new-computer",
  "full-existing-computer",
  "agent-creation",
  "computer-connection",
  "runtime-setup",
  "messaging-setup",
  "everything-ready",
] as const;
export type LabScenario = (typeof LAB_SCENARIOS)[number];

export const LAB_AUTOMATIONS = ["manual", "auto"] as const;
export type LabAutomation = (typeof LAB_AUTOMATIONS)[number];

export const LAB_INVENTORIES = ["none", "one-online", "one-offline", "several"] as const;
export type LabInventory = (typeof LAB_INVENTORIES)[number];

export const LAB_OBSERVATION_FAILURES = ["none", "computer", "runtime", "messaging"] as const;
export type LabObservationFailure = (typeof LAB_OBSERVATION_FAILURES)[number];

export interface LabScenarioDefaults {
  readonly inventory: LabInventory;
  readonly messagingProvider: ImProvider;
  readonly runtime: AgentRuntimeProvider;
}

export function labScenarioDefaults(scenario: LabScenario): LabScenarioDefaults {
  if (
    scenario === "full-existing-computer" ||
    scenario === "runtime-setup" ||
    scenario === "messaging-setup" ||
    scenario === "everything-ready"
  ) {
    return { inventory: "one-online", messagingProvider: "feishu", runtime: "codex" };
  }
  return { inventory: "none", messagingProvider: "feishu", runtime: "codex" };
}

export function labScenarioStartsWithCreation(scenario: LabScenario): boolean {
  return scenario === "full-new-computer" || scenario === "full-existing-computer" || scenario === "agent-creation";
}

function computer(
  computerId: string,
  displayName: string,
  connectionStatus: "online" | "offline",
): AccountComputerSummary {
  return {
    computerId,
    displayName,
    platform: "darwin",
    connectionStatus,
    connectedAt: connectionStatus === "online" ? LAB_NOW : null,
    lastSeenAt: connectionStatus === "offline" ? LAB_NOW : null,
    observedAt: LAB_NOW,
    createdAt: LAB_NOW,
    agentIds: [],
  };
}

function inventoryComputers(inventory: LabInventory): readonly AccountComputerSummary[] {
  if (inventory === "none") return [];
  const reviewMac = computer(LAB_COMPUTER_ID, "Review Mac", inventory === "one-offline" ? "offline" : "online");
  if (inventory !== "several") return [reviewMac];
  return [reviewMac, computer(LAB_SPARE_COMPUTER_ID, "Spare Mac", "offline")];
}

function scenarioPrebindsComputer(scenario: LabScenario): boolean {
  return scenario === "runtime-setup" || scenario === "messaging-setup" || scenario === "everything-ready";
}

export function labSeed(
  scenario: LabScenario,
  inventory: LabInventory,
  runtime: AgentRuntimeProvider,
  messagingProvider: ImProvider,
): MemorySetupSeed {
  const computers = inventoryComputers(inventory);
  const boundComputer = scenarioPrebindsComputer(scenario) ? computers[0] : undefined;
  const agent: AgentSummary = {
    id: LAB_AGENT_ID,
    name: "reviewer",
    displayName: "Reviewer",
    runtimeProvider: runtime,
    receiveMode: "mention_only",
    status: "active",
    createdAt: LAB_NOW,
    updatedAt: LAB_NOW,
    createdBy: { userId: LAB_ACCOUNT_ID, displayName: "Owner" },
    computer: boundComputer
      ? {
          computerId: boundComputer.computerId,
          displayName: boundComputer.displayName,
          platform: boundComputer.platform,
        }
      : null,
  };
  const runtimeStatus =
    scenario === "runtime-setup"
      ? "install"
      : scenario === "messaging-setup" || scenario === "everything-ready"
        ? "ready"
        : "checking";
  const messagingCliStatus =
    scenario === "messaging-setup" || scenario === "runtime-setup" || scenario === "everything-ready"
      ? "ready"
      : "checking";

  return {
    agent,
    computers,
    computerOnline: boundComputer?.connectionStatus !== "offline",
    runtimeStatus,
    imCliReadiness: { feishu: messagingCliStatus, slack: messagingCliStatus },
    messaging:
      scenario === "everything-ready" ? { kind: "bound", provider: messagingProvider, reachable: true } : undefined,
  };
}

export type LabPendingEvent =
  | "complete-admission"
  | "connect-computer"
  | "reconnect-computer"
  | "finish-readiness"
  | "scan-feishu"
  | "finish-slack"
  | "finish-handoff";

export function pendingLabEvent(memory: MemorySetupAdapter): LabPendingEvent | undefined {
  const { computerConnectState, snapshot } = memory.inspect();
  if (computerConnectState === "pending") return "connect-computer";
  if (snapshot.computer.kind === "bound" && snapshot.computer.connectionStatus === "offline") {
    return "reconnect-computer";
  }
  if (snapshot.runtime.kind === "observed" && snapshot.runtime.status !== "ready") {
    return "finish-readiness";
  }
  if (
    snapshot.computer.kind === "bound" &&
    snapshot.computer.imCliReadiness.some((readiness) => readiness.status !== "ready")
  ) {
    return "finish-readiness";
  }
  if (snapshot.messaging.kind === "authorizing") {
    return snapshot.messaging.provider === "feishu" ? "scan-feishu" : "finish-slack";
  }
  if (snapshot.messaging.kind === "waiting-handoff") return "finish-handoff";
  return undefined;
}

export function runPendingLabEvent(memory: MemorySetupAdapter): void {
  const event = pendingLabEvent(memory);
  if (!event) return;
  if (event === "connect-computer") memory.controls.completeComputerConnection();
  else if (event === "reconnect-computer") memory.controls.setComputerOnline(true);
  else if (event === "finish-readiness") memory.controls.runDoctor();
  else if (event === "scan-feishu") memory.controls.scanFeishuCode();
  else if (event === "finish-slack") memory.controls.completeSlackInstall();
  else if (event === "finish-handoff") memory.controls.completeHandoff();
}

export function failPendingLabEvent(memory: MemorySetupAdapter): boolean {
  const { computerConnectState, snapshot } = memory.inspect();
  if (computerConnectState === "pending") {
    memory.controls.expireComputerConnection();
    return true;
  }
  if (snapshot.messaging.kind !== "authorizing") return false;
  if (snapshot.messaging.provider === "feishu") memory.controls.failFeishuAttempt();
  else memory.controls.failSlackInstall();
  return true;
}

export function automaticEventDelay(event: LabPendingEvent): number {
  if (event === "finish-readiness" || event === "complete-admission") return 900;
  if (event === "scan-feishu" || event === "finish-slack") return 1_500;
  return 1_200;
}
