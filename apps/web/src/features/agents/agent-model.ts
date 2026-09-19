import type {
  AccountComputerSummary,
  AgentDetail,
  AgentListItem as AgentListApiItem,
  AgentSummary,
  ImBindingHandoffStatus,
  ImBindingSummary,
  ProviderCliHandoffProgress,
  ProviderReadinessStatus,
} from "@opentag/shared/browser";

export type AgentAvailability = {
  state: "ready" | "action_required" | "setting_up" | "not_connected" | "suspended" | "unconfirmed";
  reason:
    | "agent_suspended"
    | "agent_unconfirmed"
    | "computer_not_bound"
    | "computer_offline"
    | "runtime_unavailable"
    | "runtime_unconfirmed"
    | "im_not_connected"
    | "im_provisioning"
    | "im_reauthorization_required"
    | "im_error"
    | "im_disabled"
    | "handoff_unavailable"
    | "handoff_checking"
    | "computer_unconfirmed"
    | "handoff_unconfirmed"
    | null;
  lastConfirmedAt: string | null;
  dependencies: {
    computer: { state: "ready" | "action_required" | "not_bound" | "unconfirmed"; lastConfirmedAt: string | null };
    /** Readiness of the Agent's Provider on its Computer. `runtime_unavailable` is diagnosed from this. */
    runtime: { provider: AgentSummary["runtimeProvider"]; status: ProviderReadinessStatus | null };
    handoff: {
      state: "ready" | "action_required" | "checking" | "setting_up" | "not_connected" | "unconfirmed";
      lastConfirmedAt: string | null;
      providerCli?: ProviderCliHandoffProgress;
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

/** List rows already carry identity, lifecycle and activity; usage is list-only and is dropped. */
export function agentDetailFromListItem(item: AgentListApiItem): AgentDetail {
  const { usage: _usage, ...detail } = item;
  return detail;
}

export type DetailEvidence<T> = { kind: "ready"; value: T | undefined } | { kind: "unconfirmed" };

export type AgentDetailView = AgentDetail & {
  availability: AgentAvailability;
  messaging: DetailEvidence<ImBindingSummary>;
  /** The bound Computer's exact kind when the Account read confirmed it; Cloud-only settings rely on it. */
  computerKind?: "local" | "cloud";
};

/**
 * A handoff the Server is re-verifying rather than one it found broken. The Server answers
 * `handoffReady: false` for both, and tells them apart only through the progress phase: the CLI
 * being prepared and the credentials being checked both settle on their own within seconds, while
 * `needs_attention` and an absent phase (the channel connection itself) do not.
 */
export function isHandoffChecking(handoff: ImBindingHandoffStatus | null | undefined): boolean {
  if (handoff?.bindingState !== "active" || handoff.handoffReady) return false;
  const phase = handoff.providerCli?.phase;
  return phase === "preparing_cli" || phase === "checking_credentials";
}

type HandoffDependencyState = AgentAvailability["dependencies"]["handoff"]["state"];

function handoffDependencyState(
  binding: ImBindingSummary | undefined,
  handoff: ImBindingHandoffStatus | undefined,
  bindingEvidenceConfirmed: boolean,
  handoffEvidenceConfirmed: boolean,
): HandoffDependencyState {
  if (!bindingEvidenceConfirmed || !handoffEvidenceConfirmed) return "unconfirmed";
  if (!binding) return "not_connected";
  if (binding.bindingState === "provisioning") return "setting_up";
  if (binding.bindingState !== "active") return "action_required";
  if (handoff?.handoffReady) return "ready";
  return isHandoffChecking(handoff) ? "checking" : "action_required";
}

function handoffDependency(
  state: HandoffDependencyState,
  binding: ImBindingSummary | undefined,
  handoff: ImBindingHandoffStatus | undefined,
): AgentAvailability["dependencies"]["handoff"] {
  const dependency: AgentAvailability["dependencies"]["handoff"] = {
    state,
    lastConfirmedAt: binding?.lastRuntimeObservationAt ?? binding?.lastValidatedAt ?? null,
  };
  if (handoff?.bindingState === "active" && !handoff.handoffReady && handoff.providerCli) {
    dependency.providerCli = handoff.providerCli;
  }
  return dependency;
}

export function projectAgentAvailability(
  agent: AgentSummary,
  computer: AccountComputerSummary | undefined,
  binding: ImBindingSummary | undefined,
  handoff: ImBindingHandoffStatus | undefined,
  bindingEvidenceConfirmed: boolean,
  handoffEvidenceConfirmed: boolean,
): AgentAvailability {
  const computerReady = computer?.connectionStatus === "online";
  const providerReadiness = computer?.providerReadiness?.find(
    (observation) => observation.provider === agent.runtimeProvider,
  );
  const handoffState = handoffDependencyState(binding, handoff, bindingEvidenceConfirmed, handoffEvidenceConfirmed);
  const dependencies: AgentAvailability["dependencies"] = {
    computer: {
      // Not bound is a fact the Server states, so it is never reported as evidence we could not read:
      // one is answered by binding a Computer and the other by waiting for a read to succeed.
      state:
        agent.computer === null
          ? "not_bound"
          : computer
            ? computerReady
              ? "ready"
              : "action_required"
            : "unconfirmed",
      lastConfirmedAt: computer?.lastSeenAt ?? null,
    },
    runtime: { provider: agent.runtimeProvider, status: providerReadiness?.status ?? null },
    handoff: handoffDependency(handoffState, binding, handoff),
    channel: {
      state: !bindingEvidenceConfirmed ? "unconfirmed" : binding ? "connected" : "not_connected",
      provider: binding?.provider ?? null,
      botDisplayName: binding?.bot.displayName ?? null,
    },
  };
  if (agent.status === "suspended") {
    return { state: "suspended", reason: "agent_suspended", lastConfirmedAt: agent.updatedAt, dependencies };
  }
  if (agent.computer === null) {
    return { state: "action_required", reason: "computer_not_bound", lastConfirmedAt: null, dependencies };
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
  return messagingAvailability(binding, handoff, dependencies);
}

/** The Agent-wide verdict once every dependency up to the messaging binding has confirmed. */
function messagingAvailability(
  binding: ImBindingSummary,
  handoff: ImBindingHandoffStatus | undefined,
  dependencies: AgentAvailability["dependencies"],
): AgentAvailability {
  const lastConfirmedAt = binding.lastRuntimeObservationAt ?? binding.lastValidatedAt;
  if (binding.bindingState === "provisioning") {
    return { state: "setting_up", reason: "im_provisioning", lastConfirmedAt, dependencies };
  }
  if (binding.bindingState === "reauthorization_required") {
    return { state: "action_required", reason: "im_reauthorization_required", lastConfirmedAt, dependencies };
  }
  if (binding.bindingState === "error" || binding.bindingState === "disabled") {
    return {
      state: "action_required",
      // A binding that was turned off has no connection failure to report, so it does not borrow one.
      reason: binding.bindingState === "disabled" ? "im_disabled" : "im_error",
      lastConfirmedAt,
      dependencies,
    };
  }
  if (isHandoffChecking(handoff)) {
    return { state: "setting_up", reason: "handoff_checking", lastConfirmedAt, dependencies };
  }
  if (!handoff?.handoffReady) {
    return { state: "action_required", reason: "handoff_unavailable", lastConfirmedAt, dependencies };
  }
  return { state: "ready", reason: null, lastConfirmedAt, dependencies };
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
