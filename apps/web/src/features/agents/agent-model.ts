import type {
  AgentDetail,
  AgentListItem as AgentListApiItem,
  AgentSummary,
  ImBindingHandoffStatus,
  ImBindingSummary,
  ProviderReadinessStatus,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { browserApi } from "../../api.js";

export type AgentAvailability = {
  state: "ready" | "action_required" | "setting_up" | "not_connected" | "suspended" | "unconfirmed";
  reason:
    | "agent_suspended"
    | "agent_unconfirmed"
    | "computer_offline"
    | "runtime_unavailable"
    | "runtime_unconfirmed"
    | "im_not_connected"
    | "im_provisioning"
    | "im_reauthorization_required"
    | "im_error"
    | "handoff_unavailable"
    | "computer_unconfirmed"
    | "handoff_unconfirmed"
    | null;
  lastConfirmedAt: string | null;
  dependencies: {
    computer: { state: "ready" | "action_required" | "unconfirmed"; lastConfirmedAt: string | null };
    /** Readiness of the Agent's Provider on its Computer. `runtime_unavailable` is diagnosed from this. */
    runtime: { provider: AgentSummary["runtimeProvider"]; status: ProviderReadinessStatus | null };
    handoff: {
      state: "ready" | "action_required" | "setting_up" | "not_connected" | "unconfirmed";
      lastConfirmedAt: string | null;
    };
    channel: {
      state: "connected" | "not_connected" | "unconfirmed";
      provider: "feishu" | "slack" | null;
      botDisplayName: string | null;
    };
  };
};

export type AgentListItem = AgentListApiItem & {
  availability: AgentAvailability;
  evidenceConfirmed: boolean;
};

export type DetailEvidence<T> = { kind: "ready"; value: T | undefined } | { kind: "unconfirmed" };

export type AgentDetailView = AgentDetail & {
  availability: AgentAvailability;
  messaging: DetailEvidence<ImBindingSummary>;
};

export function projectAgentAvailability(
  agent: AgentSummary,
  computer: WorkspaceComputerSummary | undefined,
  binding: ImBindingSummary | undefined,
  handoff: ImBindingHandoffStatus | undefined,
  bindingEvidenceConfirmed: boolean,
  handoffEvidenceConfirmed: boolean,
): AgentAvailability {
  const computerReady = computer?.connectionStatus === "online";
  const providerReadiness = computer?.providerReadiness?.find(
    (observation) => observation.provider === agent.runtimeProvider,
  );
  const handoffState =
    !bindingEvidenceConfirmed || !handoffEvidenceConfirmed
      ? ("unconfirmed" as const)
      : !binding
        ? ("not_connected" as const)
        : binding.bindingState === "provisioning"
          ? ("setting_up" as const)
          : binding.bindingState === "active" && handoff?.handoffReady
            ? ("ready" as const)
            : ("action_required" as const);
  const dependencies: AgentAvailability["dependencies"] = {
    computer: {
      state: computer ? (computerReady ? "ready" : "action_required") : "unconfirmed",
      lastConfirmedAt: computer?.lastSeenAt ?? null,
    },
    runtime: { provider: agent.runtimeProvider, status: providerReadiness?.status ?? null },
    handoff: {
      state: handoffState,
      lastConfirmedAt: binding?.lastRuntimeObservationAt ?? binding?.lastValidatedAt ?? null,
    },
    channel: {
      state: !bindingEvidenceConfirmed ? "unconfirmed" : binding ? "connected" : "not_connected",
      provider: binding?.provider ?? null,
      botDisplayName: binding?.bot.displayName ?? null,
    },
  };
  if (agent.status === "suspended") {
    return { state: "suspended", reason: "agent_suspended", lastConfirmedAt: agent.updatedAt, dependencies };
  }
  if (!computer) {
    return { state: "unconfirmed", reason: "computer_unconfirmed", lastConfirmedAt: null, dependencies };
  }
  if (!computerReady) {
    return {
      state: "action_required",
      reason: "computer_offline",
      lastConfirmedAt: computer?.lastSeenAt ?? null,
      dependencies,
    };
  }
  const runtimeReadiness = providerReadiness;
  if (!runtimeReadiness) {
    return { state: "unconfirmed", reason: "runtime_unconfirmed", lastConfirmedAt: null, dependencies };
  }
  if (runtimeReadiness.status !== "ready") {
    return { state: "action_required", reason: "runtime_unavailable", lastConfirmedAt: null, dependencies };
  }
  if (!bindingEvidenceConfirmed || !handoffEvidenceConfirmed) {
    return { state: "unconfirmed", reason: "handoff_unconfirmed", lastConfirmedAt: null, dependencies };
  }
  if (!binding) return { state: "not_connected", reason: "im_not_connected", lastConfirmedAt: null, dependencies };
  if (binding.bindingState === "provisioning") {
    return {
      state: "setting_up",
      reason: "im_provisioning",
      lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
      dependencies,
    };
  }
  if (binding.bindingState === "reauthorization_required") {
    return {
      state: "action_required",
      reason: "im_reauthorization_required",
      lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
      dependencies,
    };
  }
  if (binding.bindingState === "error" || binding.bindingState === "disabled") {
    return {
      state: "action_required",
      reason: "im_error",
      lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
      dependencies,
    };
  }
  if (!handoff?.handoffReady) {
    return {
      state: "action_required",
      reason: "handoff_unavailable",
      lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
      dependencies,
    };
  }
  return {
    state: "ready",
    reason: null,
    lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
    dependencies,
  };
}

export async function loadAgentList(): Promise<{ agents: AgentListItem[] }> {
  const [{ agents }, computersResult] = await Promise.all([
    browserApi.agents(),
    browserApi.computers().then(
      (value) => ({ kind: "ready" as const, value }),
      () => ({ kind: "unconfirmed" as const }),
    ),
  ]);
  const computers = computersResult.kind === "ready" ? computersResult.value.computers : [];
  if (computersResult.kind === "unconfirmed") {
    return {
      agents: agents.map((agent) => ({
        ...agent,
        availability: projectAgentAvailability(agent, undefined, undefined, undefined, false, false),
        evidenceConfirmed: true,
      })),
    };
  }
  const availability = await Promise.all(
    agents.map(async (agent) => {
      const [bindingResult, handoffResult] = await Promise.allSettled([
        browserApi.imBinding(agent.id),
        browserApi.imBindingHandoff(agent.id),
      ]);
      return projectAgentAvailability(
        agent,
        computers.find((computer) => computer.computerId === agent.computer.computerId),
        bindingResult.status === "fulfilled" ? bindingResult.value : undefined,
        handoffResult.status === "fulfilled" ? handoffResult.value : undefined,
        bindingResult.status === "fulfilled",
        handoffResult.status === "fulfilled",
      );
    }),
  );
  return {
    agents: agents.map((agent, index) => ({
      ...agent,
      availability:
        availability[index] ?? projectAgentAvailability(agent, undefined, undefined, undefined, false, false),
      evidenceConfirmed: true,
    })),
  };
}

export async function loadAgentDetail(agentId: string): Promise<AgentDetailView> {
  const agent = await browserApi.agent(agentId);
  const [computersResult, bindingResult, handoffResult] = await Promise.allSettled([
    browserApi.computers(),
    browserApi.imBinding(agent.id),
    browserApi.imBindingHandoff(agent.id),
  ]);
  const computers = computersResult.status === "fulfilled" ? computersResult.value.computers : [];
  const binding = bindingResult.status === "fulfilled" ? bindingResult.value : undefined;
  const handoff = handoffResult.status === "fulfilled" ? handoffResult.value : undefined;
  return {
    ...agent,
    messaging:
      bindingResult.status === "fulfilled" ? { kind: "ready", value: bindingResult.value } : { kind: "unconfirmed" },
    availability: projectAgentAvailability(
      agent,
      computers.find((computer) => computer.computerId === agent.computer.computerId),
      binding,
      handoff,
      bindingResult.status === "fulfilled",
      handoffResult.status === "fulfilled",
    ),
  };
}

export function markAgentListUnconfirmed(value: { agents: AgentListItem[] }): { agents: AgentListItem[] } {
  return {
    agents: value.agents.map((agent) => ({
      ...agent,
      availability: {
        ...agent.availability,
        state: "unconfirmed",
        reason: "agent_unconfirmed",
        lastConfirmedAt: null,
      },
      evidenceConfirmed: false,
    })),
  };
}

export function markAgentDetailUnconfirmed(agent: AgentDetailView): AgentDetailView {
  return {
    ...agent,
    messaging: { kind: "unconfirmed" },
    availability: {
      ...agent.availability,
      state: "unconfirmed",
      reason: "agent_unconfirmed",
      lastConfirmedAt: null,
      dependencies: {
        ...agent.availability.dependencies,
        computer: { state: "unconfirmed", lastConfirmedAt: null },
        handoff: { state: "unconfirmed", lastConfirmedAt: null },
        channel: { ...agent.availability.dependencies.channel, state: "unconfirmed" },
      },
    },
  };
}

export type AgentStatusSource = Pick<AgentListItem, "activity" | "availability">;
