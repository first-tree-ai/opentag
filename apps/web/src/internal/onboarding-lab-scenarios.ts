import type { AgentSummary, WorkspaceComputerSummary } from "@opentag/shared/browser";
import type { OnboardingLoadState, OnboardingSnapshot } from "../onboarding/view.js";

/**
 * Fixed onboarding facts for staging review. Preview reuses the production state derivation and
 * presentation, so a scenario only supplies the facts a real Server would return; it never
 * simulates the Computer daemon, the Feishu protocol, or a general fake Server.
 */
export interface OnboardingScenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly load: OnboardingLoadState;
}

const COMPUTER_ID = "00000000-0000-4000-8000-00000000fc01";
const AGENT_ID = "00000000-0000-4000-8000-00000000fa01";
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000ac01";
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

export const ONBOARDING_LAB_ACCOUNT_ID = ACCOUNT_ID;

const computer: WorkspaceComputerSummary = {
  computerId: COMPUTER_ID,
  displayName: "Staging workstation",
  platform: "darwin",
  connectionStatus: "online",
  connectedAt: OBSERVED_AT,
  lastSeenAt: OBSERVED_AT,
  observedAt: OBSERVED_AT,
  enrolledAt: OBSERVED_AT,
  agentIds: [],
};

const agent: AgentSummary = {
  id: AGENT_ID,
  name: "opentag",
  displayName: "OpenTag",
  createdBy: { userId: ACCOUNT_ID, displayName: "Onboarding Test" },
  computer: { computerId: COMPUTER_ID, displayName: computer.displayName, platform: "darwin" },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: OBSERVED_AT,
  updatedAt: OBSERVED_AT,
};

function snapshot(overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    agents: [],
    computers: [],
    targetAgent: undefined,
    targetCandidates: [],
    handoff: undefined,
    runtime: { kind: "unavailable" },
    ...overrides,
  };
}

function ready(overrides: Partial<OnboardingSnapshot> = {}): OnboardingLoadState {
  return { kind: "ready", snapshot: snapshot(overrides) };
}

function withAgent(overrides: Partial<OnboardingSnapshot> = {}): OnboardingLoadState {
  return ready({ agents: [agent], targetAgent: agent, targetCandidates: [agent], ...overrides });
}

const readyRuntime = {
  kind: "available",
  providers: [{ computerId: COMPUTER_ID, provider: "codex", runtimeReady: true, status: "ready" }],
} as const;

export const ONBOARDING_SCENARIOS: readonly OnboardingScenario[] = [
  {
    id: "no-computer",
    title: "Brand new account",
    description: "No Computer has been connected yet.",
    load: ready(),
  },
  {
    id: "computer-offline",
    title: "Computer offline",
    description: "The only enrolled Computer is not connected.",
    load: ready({
      computers: [{ ...computer, connectionStatus: "offline", connectedAt: null, providerReadiness: [] }],
      runtime: { kind: "available", providers: [] },
    }),
  },
  {
    id: "provider-unavailable",
    title: "Provider unavailable",
    description: "The Computer is online but no Provider can run an Agent.",
    load: ready({
      computers: [
        { ...computer, providerReadiness: [{ provider: "codex", status: "install", observedAt: OBSERVED_AT }] },
      ],
      runtime: {
        kind: "available",
        providers: [{ computerId: COMPUTER_ID, provider: "codex", runtimeReady: false, status: "install" }],
      },
    }),
  },
  {
    id: "ready-to-create-agent",
    title: "Ready to create Agent",
    description: "A runnable Computer and Provider route is available.",
    load: ready({
      computers: [
        { ...computer, providerReadiness: [{ provider: "codex", status: "ready", observedAt: OBSERVED_AT }] },
      ],
      runtime: readyRuntime,
    }),
  },
  {
    id: "agent-runtime-unavailable",
    title: "Agent runtime unavailable",
    description: "The Agent exists but its bound runtime route is gone.",
    load: withAgent({
      computers: [{ ...computer, connectionStatus: "offline", connectedAt: null, providerReadiness: [] }],
      runtime: { kind: "available", providers: [] },
    }),
  },
  {
    id: "feishu-waiting",
    title: "Waiting for Feishu",
    description: "The Agent is prepared and has no messaging binding yet.",
    load: withAgent({
      computers: [
        {
          ...computer,
          agentIds: [AGENT_ID],
          providerReadiness: [{ provider: "codex", status: "ready", observedAt: OBSERVED_AT }],
        },
      ],
      runtime: readyRuntime,
    }),
  },
  {
    id: "feishu-authorizing",
    title: "Feishu authorization in progress",
    description: "A Feishu binding is provisioning and not usable yet.",
    load: withAgent({
      computers: [
        {
          ...computer,
          agentIds: [AGENT_ID],
          providerReadiness: [{ provider: "codex", status: "ready", observedAt: OBSERVED_AT }],
        },
      ],
      runtime: readyRuntime,
      handoff: { bindingState: "provisioning", handoffReady: false },
    }),
  },
  {
    id: "setup-complete",
    title: "Setup complete",
    description: "The Agent handoff is ready and setup can finish.",
    load: withAgent({
      computers: [
        {
          ...computer,
          agentIds: [AGENT_ID],
          providerReadiness: [{ provider: "codex", status: "ready", observedAt: OBSERVED_AT }],
        },
      ],
      runtime: readyRuntime,
      handoff: { bindingState: "active", handoffReady: true },
    }),
  },
  {
    id: "loading-failure",
    title: "Loading failure",
    description: "Authoritative onboarding facts could not be read.",
    load: { kind: "error", error: new Error("We couldn’t reach the Server to read your setup state.") },
  },
];

export const DEFAULT_ONBOARDING_SCENARIO = ONBOARDING_SCENARIOS[0] as OnboardingScenario;

export function findOnboardingScenario(id: string | null): OnboardingScenario {
  return ONBOARDING_SCENARIOS.find((scenario) => scenario.id === id) ?? DEFAULT_ONBOARDING_SCENARIO;
}
