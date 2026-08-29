/**
 * Pure model for the redesigned onboarding flow. It holds no React state, performs no I/O and
 * knows nothing about the mock backend, so the whole flow can be reasoned about and tested as
 * data. The page derives what to render from `deriveFlowState`; it never keeps a step cursor.
 */

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

export const MESSAGING_PROVIDERS = ["feishu", "slack"] as const;
export type MessagingProvider = (typeof MESSAGING_PROVIDERS)[number];

/** Mirrors the Server's provider readiness vocabulary so the mock stays swappable for the real API. */
export type RuntimeStatus = "checking" | "ready" | "install" | "sign-in" | "unavailable";
/** The messaging CLI has no sign-in of its own: it is installed or it is not. */
export type MessagingCliStatus = "checking" | "ready" | "install" | "unavailable";

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

export type ConnectState =
  | { readonly kind: "idle" }
  | { readonly kind: "issuing" }
  | { readonly kind: "issued"; readonly command: string; readonly expiresAt: number }
  | { readonly kind: "expired"; readonly command: string }
  | { readonly kind: "connected"; readonly command: string; readonly computerName: string };

export interface ReadinessFacts {
  readonly runtime: RuntimeStatus;
  readonly messagingCli: MessagingCliStatus;
}

/**
 * Lark and Slack connect differently. Lark shows a code to scan on a phone; Slack sends the user
 * to Slack to install the App and bring them back, so its waiting state is about a page they are
 * not on rather than a code they are looking at.
 */
export type MessagingState =
  | { readonly kind: "idle" }
  | { readonly kind: "issuing" }
  | { readonly kind: "waiting"; readonly qrValue: string }
  | { readonly kind: "away" }
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
  readonly connect: ConnectState;
  readonly readiness: ReadinessFacts | undefined;
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
    connect: { kind: "idle" },
    readiness: undefined,
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

export function computerIsConnected(connect: ConnectState): boolean {
  return connect.kind === "connected";
}

/**
 * The three rows Step 4 renders. `install` and `sign-in` are mutually exclusive outcomes of one
 * Server-side probe, so the two runtime rows are derived from a single status rather than being
 * two independent facts. A runtime that is not installed leaves sign-in genuinely unknown, which
 * the `blocked` state says out loud instead of guessing.
 */
export type CheckState = "pending" | "passed" | "failed" | "blocked";

export interface CheckRow {
  readonly id: "runtime-cli" | "runtime-auth" | "messaging-cli";
  readonly state: CheckState;
}

export function deriveChecks(readiness: ReadinessFacts | undefined): readonly CheckRow[] {
  if (!readiness) {
    return [
      { id: "runtime-cli", state: "pending" },
      { id: "runtime-auth", state: "pending" },
      { id: "messaging-cli", state: "pending" },
    ];
  }
  return [
    { id: "runtime-cli", state: runtimeCliState(readiness.runtime) },
    { id: "runtime-auth", state: runtimeAuthState(readiness.runtime) },
    { id: "messaging-cli", state: messagingCliState(readiness.messagingCli) },
  ];
}

function runtimeCliState(status: RuntimeStatus): CheckState {
  if (status === "checking") return "pending";
  // A runtime that reports `sign-in` proved its CLI runs; only the credential is missing.
  if (status === "ready" || status === "sign-in") return "passed";
  return "failed";
}

function runtimeAuthState(status: RuntimeStatus): CheckState {
  if (status === "checking") return "pending";
  if (status === "ready") return "passed";
  if (status === "sign-in") return "failed";
  // Without a working CLI there is no credential answer to report.
  return "blocked";
}

function messagingCliState(status: MessagingCliStatus): CheckState {
  if (status === "checking") return "pending";
  if (status === "ready") return "passed";
  return "failed";
}

export function readinessPassed(readiness: ReadinessFacts | undefined): boolean {
  return readiness?.runtime === "ready" && readiness.messagingCli === "ready";
}

export function readinessIsResolving(readiness: ReadinessFacts | undefined): boolean {
  return readiness === undefined || readiness.runtime === "checking" || readiness.messagingCli === "checking";
}

export function deriveFlowState(facts: FlowFacts): FlowState {
  const { draft, destinationConfirmed, draftConfirmed, connect, readiness, creation, planSignedIn, messaging } = facts;
  const destination = draft.destination;
  if (!destination || !destinationConfirmed) {
    return { page: "destination", steps: [], complete: false };
  }

  if (destination === "cloud") {
    const agentDone = draftIsSubmittable(draft, planSignedIn) && draftConfirmed && creation === "created";
    const messagingDone = agentDone && messaging.kind === "connected";
    const ids = CLOUD_STEP_IDS;
    const currentIndex = ids.findIndex((id) => !(id === "agent" ? agentDone : messagingDone));
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
  done.computer = done.agent && computerIsConnected(connect) && readinessPassed(readiness) && creation === "created";
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

/** Formats a remaining duration as `m:ss`, never rounding a live second up. */
export function formatRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
