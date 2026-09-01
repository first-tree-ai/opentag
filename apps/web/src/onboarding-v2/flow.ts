/**
 * Pure model for the redesigned onboarding flow. It holds no React state, performs no I/O and
 * knows nothing about the mock backend, so the whole flow can be reasoned about and tested as
 * data. The page derives what to render from `deriveFlowState`; it never keeps a step cursor.
 */

import type { ProviderCliHandoffProgress } from "@opentag/shared/browser";
import type { MessagingCliStatus, RuntimeStatus } from "../setup/checks.js";

export const RUNTIMES = ["codex", "claude-code"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/**
 * A cloud agent can run OpenTag's own runtime or one of the same coding agents a local one uses.
 * OpenTag's is listed first because it is the reason to pick cloud at all: nothing to install and
 * nothing to sign into.
 */
export const CLOUD_RUNTIMES = ["opentag", "claude-code", "codex"] as const;
export type CloudRuntime = (typeof CLOUD_RUNTIMES)[number];

/**
 * Which tokens the agent spends. Only a third-party runtime can run on the user's own plan: the
 * OpenTag agent has no separate subscription to attach, so that option is shown but not offered.
 */
export const TOKEN_SOURCES = ["opentag", "own-plan"] as const;
export type TokenSource = (typeof TOKEN_SOURCES)[number];

export function tokenChoiceApplies(runtime: CloudRuntime | undefined): boolean {
  return runtime !== undefined && runtime !== "opentag";
}

export type Destination = "local" | "cloud";

/** Display order only. The Server's own order is unrelated and stays as it is. */
export const MESSAGING_PROVIDERS = ["slack", "feishu"] as const;
export type MessagingProvider = (typeof MESSAGING_PROVIDERS)[number];

export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const AGENT_NAME_MAX_LENGTH = 64;
export const DEFAULT_AGENT_NAME = "opentag";

export interface AgentDraft {
  readonly destination: Destination | undefined;
  readonly name: string;
  readonly runtime: Runtime | undefined;
  readonly cloudRuntime: CloudRuntime | undefined;
  readonly tokenSource: TokenSource | undefined;
}

export interface ReadinessFacts {
  readonly runtime: RuntimeStatus;
  /**
   * Which runtime the verdict above is about. A reader who goes back and changes their mind must
   * not be shown the previous runtime's result as though it were the new one's: the Agent's
   * provider is immutable once created, so a stale `ready` would commit them to a runtime that was
   * never checked. A verdict whose provider no longer matches the draft is not a verdict.
   */
  readonly runtimeProvider?: Runtime;
  /**
   * Per messaging provider, because the Server reports only the CLIs it has observed and in its own
   * canonical order. Reading position 0 would let one provider's result speak for another's.
   */
  readonly messagingCli: Partial<Record<MessagingProvider, MessagingCliStatus>>;
}

/**
 * Feishu and Slack connect differently. Feishu shows a code to scan on a phone; Slack sends the user
 * to Slack to install the App and bring them back, so its waiting state is about a page they are
 * not on rather than a code they are looking at.
 */
export type MessagingState =
  | { readonly kind: "idle" }
  | { readonly kind: "issuing" }
  | { readonly kind: "waiting"; readonly qrValue: string }
  | { readonly kind: "away" }
  /**
   * Installed, but not yet reachable. The Server observes the messaging identity for itself, and
   * setup cannot complete before it has — so this is the wait between "the app is connected" and
   * "the Agent can actually be reached through it".
   */
  | { readonly kind: "waiting-handoff"; readonly providerCli?: ProviderCliHandoffProgress }
  /**
   * A refused or expired attempt rests here rather than returning to `idle`. Idle is the state the
   * step starts an attempt from, so a failure that returned to it would be retried on sight, for
   * as long as the failure lasted, without the reader doing anything.
   */
  | { readonly kind: "failed" }
  | { readonly kind: "connected" };

/**
 * The Agent is created at the end of Step 4, not at Step 2. Two Server facts force this: an Agent
 * cannot be created without a `computerId`, and its runtime provider is immutable afterwards. So
 * Step 2 stays a local draft, and the commit happens once a runnable route has actually been
 * proven — which also means a failed check never strands a half-built Agent on an immutable
 * runtime the user cannot run.
 */
export type CreationState = "idle" | "creating" | "created";

export interface FlowFacts {
  readonly draft: AgentDraft;
  /**
   * Every step the user drives is left deliberately, by its own Continue button, rather than the
   * moment its fields happen to be valid. Otherwise a page would slide out from under someone
   * mid-edit, and Go back would have nothing to return to.
   */
  readonly destinationConfirmed: boolean;
  readonly draftConfirmed: boolean;
  /**
   * The Computer this run is preparing. A run that is connecting a new one has none until the
   * shared ComputerConnect lifecycle reports the exact arrival.
   */
  readonly selectedComputerId?: string | undefined;
  readonly readiness: ReadinessFacts | undefined;
  readonly cloudComputer: CloudComputerState;
  readonly creation: CreationState;
  /** Whether the user's own coding plan has been signed into, when they chose to use one. */
  readonly planSignedIn: boolean;
  readonly messaging: MessagingState;
}

/**
 * Choosing where the agent runs is not one of the steps: it decides how many there are, so it
 * settles the flow's shape before the flow starts. Numbering it would also mean the rail could
 * never be shown on the screen it belongs to, since at that point its own length is unknown.
 *
 * Only the local route has steps. Pagination earns its place when there is waiting to break up —
 * run a command, wait for a machine, wait for a check. A cloud agent has none of that: naming it
 * and pointing it at a messaging app is one short piece of work, so it is one page with no rail.
 */
/**
 * Connecting the Computer and checking it are one step. The check finishes within about a
 * hundred milliseconds of the Computer arriving, so there is no wait to break up — its result is
 * simply the rest of what connecting tells you.
 */
export const STEP_IDS = ["agent", "computer", "messaging"] as const;
/** A cloud agent has no Computer to connect, so its route is the two steps that remain. */
export const CLOUD_STEP_IDS = ["agent", "messaging"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type PageId = "destination" | "cloud" | StepId;

export type StepStatus = "complete" | "current" | "upcoming";

export interface FlowState {
  readonly page: PageId;
  readonly steps: readonly { readonly id: StepId; readonly status: StepStatus }[];
  /** True once every prerequisite for creating the Agent has been satisfied. */
  readonly complete: boolean;
}

export function emptyDraft(): AgentDraft {
  return {
    destination: undefined,
    name: DEFAULT_AGENT_NAME,
    runtime: undefined,
    cloudRuntime: undefined,
    tokenSource: undefined,
  };
}

export function initialFacts(): FlowFacts {
  return {
    draft: emptyDraft(),
    destinationConfirmed: false,
    draftConfirmed: false,
    readiness: undefined,
    cloudComputer: "idle",
    creation: "idle",
    planSignedIn: false,
    messaging: { kind: "idle" },
  };
}

export type AgentNameError = "empty" | "too-long" | "charset";

export function validateAgentName(value: string): AgentNameError | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.length > AGENT_NAME_MAX_LENGTH) return "too-long";
  if (!AGENT_NAME_PATTERN.test(trimmed)) return "charset";
  return undefined;
}

/** Whether an agent's own sign-in is still outstanding, which only a own-plan cloud agent has. */
export function needsPlanSignIn(draft: AgentDraft): boolean {
  return draft.destination === "cloud" && tokenChoiceApplies(draft.cloudRuntime) && draft.tokenSource === "own-plan";
}

export function draftIsSubmittable(draft: AgentDraft, planSignedIn = false): boolean {
  if (validateAgentName(draft.name) !== undefined) return false;
  if (draft.destination !== "cloud") return draft.runtime !== undefined;
  if (draft.cloudRuntime === undefined || draft.tokenSource === undefined) return false;
  return draft.tokenSource === "opentag" || planSignedIn;
}

/**
 * A cloud Agent runs on a Computer too — OpenTag allocates one instead of the user connecting
 * theirs. The Server requires a `computerId` either way, so the cloud route allocates before it
 * creates rather than modelling an Agent with no Computer at all.
 */
export type CloudComputerState = "idle" | "allocating" | "allocated";

/**
 * Creating an Agent waits on its runtime only. IM handoff readiness is provider-specific and is
 * settled at handoff, not before the Agent exists.
 */
/**
 * Whether the check the reader is looking at is a pass *for the runtime they have chosen*.
 *
 * The provider is checked here rather than trusted upstream because this is the gate: the Agent's
 * runtime cannot be changed once it is created, so letting a verdict from a different runtime open
 * this door commits someone to a runtime nothing ever checked. When no runtime is asked about, the
 * verdict answers for itself, which is what the derived flow state needs.
 */
export function readinessPassed(readiness: ReadinessFacts | undefined, runtime?: Runtime): boolean {
  if (readiness?.runtime !== "ready") return false;
  if (runtime === undefined || readiness.runtimeProvider === undefined) return true;
  return readiness.runtimeProvider === runtime;
}

export function readinessIsResolving(readiness: ReadinessFacts | undefined): boolean {
  return readiness === undefined || readiness.runtime === "checking";
}

export function deriveFlowState(facts: FlowFacts): FlowState {
  const { draft, destinationConfirmed, draftConfirmed, readiness, creation, planSignedIn, messaging } = facts;
  const { cloudComputer, selectedComputerId } = facts;
  const destination = draft.destination;
  if (!destination || !destinationConfirmed) {
    return { page: "destination", steps: [], complete: false };
  }

  if (destination === "cloud") {
    const agentDone =
      draftIsSubmittable(draft, planSignedIn) &&
      draftConfirmed &&
      cloudComputer === "allocated" &&
      creation === "created";
    const messagingDone = agentDone && messaging.kind === "connected";
    const ids = CLOUD_STEP_IDS;
    const currentIndex = agentDone && messagingDone ? -1 : ids.indexOf(agentDone ? "messaging" : "agent");
    return {
      page: currentIndex === -1 ? "messaging" : ids[currentIndex] === "agent" ? "cloud" : "messaging",
      steps: ids.map((id, index) => ({
        id,
        status: stepStatus(id === "agent" ? agentDone : messagingDone, index, currentIndex),
      })),
      complete: messagingDone,
    };
  }

  const done: Record<StepId, boolean> = { agent: false, computer: false, messaging: false };
  done.agent = draftIsSubmittable(draft) && draftConfirmed;
  done.computer =
    done.agent && selectedComputerId !== undefined && readinessPassed(readiness) && creation === "created";
  done.messaging = done.computer && messaging.kind === "connected";

  const currentIndex = STEP_IDS.findIndex((id) => !done[id]);
  const steps = STEP_IDS.map((id, index) => ({ id, status: stepStatus(done[id], index, currentIndex) }));

  return { page: STEP_IDS[currentIndex] ?? "messaging", steps, complete: done.messaging };
}

function stepStatus(isDone: boolean, index: number, currentIndex: number): StepStatus {
  if (isDone) return "complete";
  if (currentIndex === index) return "current";
  return "upcoming";
}
