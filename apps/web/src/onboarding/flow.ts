import type {
  AgentRuntimeProvider,
  ComputerConnectionStatus,
  ImBindingState,
  MembershipRole,
} from "@opentag/shared/browser";

export interface OnboardingTeam {
  readonly role: MembershipRole;
}

export interface OnboardingComputer {
  readonly id: string;
  readonly displayName: string;
  readonly connectionStatus: ComputerConnectionStatus;
}

export interface OnboardingProvider {
  readonly computerId: string;
  readonly provider: AgentRuntimeProvider;
  /** Whether this provider can run an Agent on this Computer now. */
  readonly runtimeReady: boolean;
}

export interface OnboardingAgent {
  readonly id: string;
  readonly computerId: string;
  readonly runtimeProvider: AgentRuntimeProvider;
}

type UnusableImBindingState = Exclude<ImBindingState, "active">;

/**
 * `handoffReady` is the authoritative combined IM readiness fact. In
 * particular, an active binding is not necessarily a usable handoff.
 */
export type OnboardingHandoff =
  | { readonly bindingState: "active"; readonly handoffReady: true }
  | { readonly bindingState: "active"; readonly handoffReady: false }
  | { readonly bindingState: UnusableImBindingState; readonly handoffReady: false };

export interface OnboardingFacts {
  readonly team: OnboardingTeam | undefined;
  readonly computers: readonly OnboardingComputer[];
  readonly providers: readonly OnboardingProvider[];
  /** An explicit current choice; ignored unless it still names a runnable route. */
  readonly providerSelection?: Pick<OnboardingProvider, "computerId" | "provider">;
  /** The Agent belonging to this onboarding intent, if it already exists. */
  readonly agent: OnboardingAgent | undefined;
  readonly handoff: OnboardingHandoff | undefined;
}

export type HandoffProgress =
  | { readonly kind: "none" }
  | { readonly kind: "provisioning" }
  | { readonly kind: "active-not-ready" }
  | {
      readonly kind: "attention";
      readonly bindingState: Exclude<UnusableImBindingState, "provisioning">;
    };

export type OnboardingCurrentState =
  | { readonly kind: "team" }
  | { readonly kind: "computer"; readonly availability: "none" }
  | {
      readonly kind: "computer";
      readonly availability: "offline";
      readonly computers: readonly OnboardingComputer[];
    }
  | {
      readonly kind: "computer";
      readonly availability: "choice";
      readonly computers: readonly OnboardingComputer[];
    }
  | {
      readonly kind: "provider";
      readonly availability: "none";
      readonly computer: OnboardingComputer;
    }
  | {
      readonly kind: "agent";
      readonly computer: OnboardingComputer;
      readonly provider: OnboardingProvider;
      /** Remaining runnable Providers for a non-blocking Change control. */
      readonly alternatives: readonly OnboardingProvider[];
    }
  | { readonly kind: "agent-runtime"; readonly agent: OnboardingAgent }
  | {
      readonly kind: "handoff";
      readonly agent: OnboardingAgent;
      readonly progress: HandoffProgress;
    }
  | {
      readonly kind: "ready";
      readonly agent: OnboardingAgent;
      readonly handoff: OnboardingHandoff & { readonly bindingState: "active"; readonly handoffReady: true };
    };

export interface OnboardingState {
  readonly currentState: OnboardingCurrentState;
  /** Whether the selected or Agent-bound runtime path is currently runnable. */
  readonly runtimeReady: boolean;
  /** Whether the Server says the Agent's IM handoff is currently usable. */
  readonly handoffReady: boolean;
  /** Members observe the same state without receiving mutation controls. */
  readonly canManage: boolean;
}

/**
 * Derives the current page state from facts; no step cursor or browser state is
 * retained. Once an Agent exists, earlier prerequisites never pull the flow back.
 */
export function deriveOnboardingState(facts: OnboardingFacts): OnboardingState {
  const canManage = facts.team === undefined || facts.team.role === "admin";
  const handoffReady = facts.handoff?.handoffReady === true;

  if (!facts.team) {
    return { currentState: { kind: "team" }, runtimeReady: false, handoffReady, canManage };
  }

  if (facts.agent) {
    const runtimeReady = agentRuntimeIsReady(facts.agent, facts.providers);
    if (!runtimeReady) {
      return {
        currentState: { kind: "agent-runtime", agent: facts.agent },
        runtimeReady,
        handoffReady,
        canManage,
      };
    }
    if (facts.handoff?.bindingState === "active" && facts.handoff.handoffReady) {
      return {
        currentState: { kind: "ready", agent: facts.agent, handoff: facts.handoff },
        runtimeReady,
        handoffReady,
        canManage,
      };
    }
    return {
      currentState: { kind: "handoff", agent: facts.agent, progress: handoffProgress(facts.handoff) },
      runtimeReady,
      handoffReady,
      canManage,
    };
  }

  const onlineComputers = facts.computers.filter((computer) => computer.connectionStatus === "online");
  const [onlineComputer, ...otherOnlineComputers] = onlineComputers;
  if (facts.computers.length === 0) {
    return { currentState: { kind: "computer", availability: "none" }, runtimeReady: false, handoffReady, canManage };
  }
  if (!onlineComputer) {
    return {
      currentState: { kind: "computer", availability: "offline", computers: facts.computers },
      runtimeReady: false,
      handoffReady,
      canManage,
    };
  }

  const runnableComputerIds = new Set(
    facts.providers.filter((provider) => provider.runtimeReady).map((provider) => provider.computerId),
  );
  const eligibleComputers = onlineComputers.filter((computer) => runnableComputerIds.has(computer.id));
  const [eligibleComputer, ...otherEligibleComputers] = eligibleComputers;
  if (otherEligibleComputers.length > 0) {
    return {
      currentState: { kind: "computer", availability: "choice", computers: eligibleComputers },
      runtimeReady: false,
      handoffReady,
      canManage,
    };
  }

  let computer = eligibleComputer;
  if (!computer) {
    if (otherOnlineComputers.length > 0) {
      return {
        currentState: { kind: "computer", availability: "choice", computers: onlineComputers },
        runtimeReady: false,
        handoffReady,
        canManage,
      };
    }
    computer = onlineComputer;
  }

  const runnableProviders = facts.providers.filter(
    (provider) => provider.computerId === computer.id && provider.runtimeReady,
  );
  const orderedProviders = [...runnableProviders].sort(compareProviders);
  const [defaultProvider] = orderedProviders;
  if (!defaultProvider) {
    return {
      currentState: { kind: "provider", availability: "none", computer },
      runtimeReady: false,
      handoffReady,
      canManage,
    };
  }

  const selection = facts.providerSelection;
  const provider =
    orderedProviders.find(
      (candidate) =>
        selection !== undefined &&
        candidate.computerId === selection.computerId &&
        candidate.provider === selection.provider,
    ) ?? defaultProvider;
  const alternatives = orderedProviders.filter(
    (candidate) => candidate.computerId !== provider.computerId || candidate.provider !== provider.provider,
  );

  return {
    currentState: { kind: "agent", computer, provider, alternatives },
    runtimeReady: true,
    handoffReady,
    canManage,
  };
}

function compareProviders(left: OnboardingProvider, right: OnboardingProvider): number {
  return providerRank(left.provider) - providerRank(right.provider);
}

function providerRank(provider: AgentRuntimeProvider): number {
  return provider === "codex" ? 0 : 1;
}

function agentRuntimeIsReady(agent: OnboardingAgent, providers: readonly OnboardingProvider[]): boolean {
  return providers.some(
    (provider) =>
      provider.computerId === agent.computerId && provider.provider === agent.runtimeProvider && provider.runtimeReady,
  );
}

function handoffProgress(handoff: OnboardingHandoff | undefined): HandoffProgress {
  if (!handoff) return { kind: "none" };
  if (handoff.bindingState === "provisioning") return { kind: "provisioning" };
  if (handoff.bindingState === "active") return { kind: "active-not-ready" };
  return { kind: "attention", bindingState: handoff.bindingState };
}
