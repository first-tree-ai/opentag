import type { AccountComputerSummary, AgentRuntimeProvider, AgentSummary, ImProvider } from "@opentag/shared/browser";
import type { MemorySetupAdapter, MemorySetupSeed } from "./setup-memory-adapter.js";

export const LAB_AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
export const LAB_ACCOUNT_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const LAB_COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const LAB_SPARE_COMPUTER_ID = "95fe9af3-d1c6-472b-b78c-8a7ccf512751";
const LAB_PREVIOUS_COMPUTER_ID = "a5fe9af3-d1c6-472b-b78c-8a7ccf512752";
const LAB_NOW = "2026-09-01T10:00:00.000Z";

export const LAB_JOURNEYS = ["first", "additional"] as const;
export type LabJourney = (typeof LAB_JOURNEYS)[number];

/** Reviewable product journeys and checkpoints. Fine-grained failures still live under Overrides. */
export const LAB_SCENARIOS = [
  "full-new-computer",
  "full-existing-computer",
  "agent-creation",
  "computer-connection",
  "computer-reconnect",
  "computer-rebind",
  "runtime-waiting",
  "runtime-checking",
  "runtime-setup",
  "runtime-sign-in",
  "messaging-support-setup",
  "messaging-setup",
  "messaging-handoff",
  "messaging-recovery",
  "everything-ready",
] as const;
export type LabScenario = (typeof LAB_SCENARIOS)[number];

export const LAB_PREVIEW_PAGES = ["destination", "agent", "computer", "checks", "messaging", "complete"] as const;
export type LabPreviewPage = (typeof LAB_PREVIEW_PAGES)[number];

const LAB_SCENARIO_PREVIEW_PAGE: Record<LabScenario, LabPreviewPage> = {
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

export function labPreviewPageFor(scenario: LabScenario): LabPreviewPage {
  return LAB_SCENARIO_PREVIEW_PAGE[scenario];
}

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

type LabComputerPreset = "unbound" | "bound" | "requires-rebind";
type LabMessagingPreset = "not-configured" | "waiting-handoff" | "blocked" | "ready";

interface LabScenarioPreset extends LabScenarioDefaults {
  readonly computer: LabComputerPreset;
  readonly imCliReadiness: NonNullable<MemorySetupSeed["imCliReadiness"]>;
  readonly messaging: LabMessagingPreset;
  readonly runtimeMissing?: boolean;
  readonly runtimeStatus: NonNullable<MemorySetupSeed["runtimeStatus"]>;
}

const READY_IM_CLIS = { feishu: "ready", slack: "ready" } as const;
const CHECKING_IM_CLIS = { feishu: "checking", slack: "checking" } as const;

const LAB_SCENARIO_PRESETS: Record<LabScenario, LabScenarioPreset> = {
  "full-new-computer": {
    computer: "unbound",
    imCliReadiness: CHECKING_IM_CLIS,
    inventory: "none",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "checking",
  },
  "full-existing-computer": {
    computer: "unbound",
    imCliReadiness: CHECKING_IM_CLIS,
    inventory: "one-online",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "checking",
  },
  "agent-creation": {
    computer: "unbound",
    imCliReadiness: CHECKING_IM_CLIS,
    inventory: "none",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "checking",
  },
  "computer-connection": {
    computer: "unbound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "none",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "ready",
  },
  "computer-reconnect": {
    computer: "bound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-offline",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "ready",
  },
  "computer-rebind": {
    computer: "requires-rebind",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-online",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "ready",
  },
  "runtime-waiting": {
    computer: "bound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-online",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeMissing: true,
    runtimeStatus: "ready",
  },
  "runtime-checking": {
    computer: "bound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-online",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "checking",
  },
  "runtime-setup": {
    computer: "bound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-online",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "install",
  },
  "runtime-sign-in": {
    computer: "bound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-online",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "sign-in",
  },
  "messaging-support-setup": {
    computer: "bound",
    imCliReadiness: { feishu: "unavailable", slack: "ready" },
    inventory: "one-online",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "ready",
  },
  "messaging-setup": {
    computer: "bound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-online",
    messaging: "not-configured",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "ready",
  },
  "messaging-handoff": {
    computer: "bound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-online",
    messaging: "waiting-handoff",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "ready",
  },
  "messaging-recovery": {
    computer: "bound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-online",
    messaging: "blocked",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "ready",
  },
  "everything-ready": {
    computer: "bound",
    imCliReadiness: READY_IM_CLIS,
    inventory: "one-online",
    messaging: "ready",
    messagingProvider: "feishu",
    runtime: "codex",
    runtimeStatus: "ready",
  },
};

export function labScenarioDefaults(scenario: LabScenario): LabScenarioDefaults {
  const { inventory, messagingProvider, runtime } = LAB_SCENARIO_PRESETS[scenario];
  return { inventory, messagingProvider, runtime };
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

export function labSeed(
  scenario: LabScenario,
  inventory: LabInventory,
  runtime: AgentRuntimeProvider,
  messagingProvider: ImProvider,
): MemorySetupSeed {
  const preset = LAB_SCENARIO_PRESETS[scenario];
  const computers = inventoryComputers(inventory);
  const boundComputer = preset.computer === "bound" ? computers[0] : undefined;
  const assignedComputer =
    preset.computer === "requires-rebind"
      ? { computerId: LAB_PREVIOUS_COMPUTER_ID, displayName: "Previous Mac", platform: "darwin" as const }
      : boundComputer;
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
    computer: assignedComputer
      ? {
          computerId: assignedComputer.computerId,
          displayName: assignedComputer.displayName,
          platform: assignedComputer.platform,
        }
      : null,
    requiresComputerRebind: preset.computer === "requires-rebind" ? true : undefined,
  };
  const messaging =
    preset.messaging === "ready"
      ? { kind: "bound" as const, provider: messagingProvider, reachable: true }
      : preset.messaging === "waiting-handoff"
        ? { kind: "bound" as const, provider: messagingProvider, reachable: false }
        : preset.messaging === "blocked"
          ? {
              kind: "bound" as const,
              provider: messagingProvider,
              reachable: true,
              attention: "reauthorization-required" as const,
            }
          : undefined;

  return {
    agent,
    computers,
    computerOnline: boundComputer?.connectionStatus !== "offline",
    runtimeStatus: preset.runtimeStatus,
    runtimeMissing: preset.runtimeMissing,
    imCliReadiness: preset.imCliReadiness,
    messaging,
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
  if (
    snapshot.runtime.kind === "waiting" ||
    (snapshot.runtime.kind === "observed" && snapshot.runtime.status !== "ready")
  ) {
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
