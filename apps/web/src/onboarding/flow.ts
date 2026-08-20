import type {
  AgentSummary,
  ComputerConnectionStatus,
  ImBindingSummary,
  MeMembership,
  MembershipRole,
} from "@opentag/shared/browser";

/**
 * The fields the flow needs from a Computer. Both the owner-scoped `Computer` and
 * the Team-scoped `TeamComputerSummary` satisfy it, so the Admin and member views
 * can read the source each is actually allowed to see.
 */
export interface OnboardingComputer {
  readonly id: string;
  readonly displayName: string;
  readonly connectionStatus: ComputerConnectionStatus;
}

/**
 * OpenTag Home onboarding is a conditional flow, not a wizard with a stored cursor.
 * Every entry re-derives the current step from server facts, so a refresh, a lost
 * response, or a second tab all land on the same place without creating a second
 * Agent or a second IM binding.
 */
export const ONBOARDING_STEPS = ["team", "computer", "provider", "agent", "im", "ready"] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/**
 * Which Local Computer this flow should use. `single` is the case the product
 * cares about most: one eligible Computer is selected without asking.
 */
export type ComputerSelection =
  | { readonly kind: "none" }
  | { readonly kind: "offline"; readonly computers: readonly OnboardingComputer[] }
  | { readonly kind: "single"; readonly computer: OnboardingComputer }
  | { readonly kind: "choice"; readonly computers: readonly OnboardingComputer[] };

/**
 * IM progress is reported separately from Agent readiness. A failing or revoked
 * binding is surfaced, but it never retracts an Agent that is otherwise ready.
 */
export type ImProgress =
  | { readonly kind: "none" }
  | { readonly kind: "provisioning"; readonly binding: ImBindingSummary }
  | { readonly kind: "active"; readonly binding: ImBindingSummary }
  | {
      readonly kind: "attention";
      readonly binding: ImBindingSummary;
      readonly reason: "reauthorization_required" | "error" | "disabled";
    };

export interface OnboardingFacts {
  readonly role: MembershipRole;
  readonly membership: MeMembership | undefined;
  readonly computers: readonly OnboardingComputer[];
  readonly agents: readonly AgentSummary[];
  readonly binding: ImBindingSummary | undefined;
  /**
   * The provider CLI is self-attested. No server surface reports whether Codex is
   * installed and signed in on the Computer, so the admin confirms it once and the
   * flow never blocks Agent readiness on it.
   */
  readonly providerAcknowledged: boolean;
}

export interface OnboardingState {
  readonly step: OnboardingStepId;
  readonly completed: readonly OnboardingStepId[];
  readonly computer: ComputerSelection;
  readonly agent: AgentSummary | undefined;
  readonly im: ImProgress;
  /** The Agent can serve work. IM is reported separately and does not gate this. */
  readonly agentReady: boolean;
  /**
   * A user with no Team is not a member waiting on an Admin -- they are the person
   * who has to create the Team, so they always drive their own first step.
   */
  readonly canManage: boolean;
}

export function classifyOnboardingComputer(computers: readonly OnboardingComputer[]): ComputerSelection {
  if (computers.length === 0) return { kind: "none" };
  const online = computers.filter((computer) => computer.connectionStatus === "online");
  if (online.length === 0) return { kind: "offline", computers: [...computers] };
  const only = online[0];
  if (online.length === 1 && only) return { kind: "single", computer: only };
  return { kind: "choice", computers: online };
}

export function classifyOnboardingImBinding(binding: ImBindingSummary | undefined): ImProgress {
  if (!binding) return { kind: "none" };
  if (binding.bindingState === "active") return { kind: "active", binding };
  if (binding.bindingState === "provisioning") return { kind: "provisioning", binding };
  return { kind: "attention", binding, reason: binding.bindingState };
}

/**
 * Picks the Agent this flow is about. The flow creates at most one Agent, so an
 * existing Agent means step 4 already happened -- including when the create
 * response was lost and the Agent was recovered by name.
 */
export function selectOnboardingAgent(agents: readonly AgentSummary[]): AgentSummary | undefined {
  if (agents.length === 0) return undefined;
  return [...agents].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
}

export function deriveOnboardingState(facts: OnboardingFacts): OnboardingState {
  const computer = classifyOnboardingComputer(facts.computers);
  const agent = selectOnboardingAgent(facts.agents);
  const im = classifyOnboardingImBinding(facts.binding);
  const agentReady = agent !== undefined;
  const step = deriveStep(facts, computer, agent, im);
  const canManage = facts.membership === undefined || canManageOnboarding(facts.role);
  return { step, completed: stepsBefore(step), computer, agent, im, agentReady, canManage };
}

function deriveStep(
  facts: OnboardingFacts,
  computer: ComputerSelection,
  agent: AgentSummary | undefined,
  im: ImProgress,
): OnboardingStepId {
  if (!facts.membership) return "team";
  // An Agent that already exists proves the Computer and provider steps were done,
  // so a Computer that later goes offline must not push the flow backwards.
  if (!agent) {
    if (computer.kind === "none" || computer.kind === "offline") return "computer";
    // The provider confirmation lives in the Admin's browser, so a read-only viewer
    // can never observe it. Reporting only Server-observable progress to them beats
    // claiming the Admin is stuck on a step nobody else can see.
    if (!facts.providerAcknowledged && canManageOnboarding(facts.role)) return "provider";
    return "agent";
  }
  return im.kind === "active" ? "ready" : "im";
}

function stepsBefore(step: OnboardingStepId): OnboardingStepId[] {
  return ONBOARDING_STEPS.slice(0, ONBOARDING_STEPS.indexOf(step));
}

/** Members see the same progress, never the controls that change it. */
export function canManageOnboarding(role: MembershipRole): boolean {
  return role === "admin";
}

/**
 * Onboarding asks for one Agent name, not two. The canonical name is derived so
 * the admin never has to reason about the `[a-z0-9][a-z0-9-]*` shape themselves.
 */
export function deriveAgentName(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "agent";
}
