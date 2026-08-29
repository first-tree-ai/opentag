/**
 * Pure model for the redesigned onboarding flow. It holds no React state, performs no I/O and
 * knows nothing about the mock backend, so the whole flow can be reasoned about and tested as
 * data. The page derives what to render from `deriveFlowState`; it never keeps a step cursor.
 */

export const RUNTIMES = ["codex", "claude-code"] as const;
export type Runtime = (typeof RUNTIMES)[number];

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

export type MessagingState =
  | { readonly kind: "idle" }
  | { readonly kind: "issuing" }
  | { readonly kind: "waiting"; readonly qrValue: string }
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
  /**
   * Whether the arrival has been shown. The connect step advances on its own, but only after
   * "Your computer is connected." has been on screen long enough to read; without this the page
   * would jump the instant the Computer appears and the outcome would never be seen.
   */
  readonly connectAcknowledged: boolean;
  readonly readiness: ReadinessFacts | undefined;
  readonly creation: CreationState;
  readonly messaging: MessagingState;
}

/**
 * One page per step. Connecting the Computer and checking it were once one page, but they hold
 * entirely different content — a command to run versus a report on what came back — so they read
 * better as separate screens with an automatic advance between them.
 */
export type PageId = StepId;

export const STEP_IDS = ["destination", "agent", "connect", "check", "messaging"] as const;
export type StepId = (typeof STEP_IDS)[number];

export type StepStatus = "complete" | "current" | "upcoming";

export interface FlowState {
  readonly page: PageId;
  readonly steps: readonly { readonly id: StepId; readonly status: StepStatus }[];
  /** True once every prerequisite for creating the Agent has been satisfied. */
  readonly complete: boolean;
}

export function emptyDraft(): AgentDraft {
  return { destination: undefined, name: DEFAULT_AGENT_NAME, runtime: undefined };
}

export function initialFacts(): FlowFacts {
  return {
    draft: emptyDraft(),
    destinationConfirmed: false,
    draftConfirmed: false,
    connect: { kind: "idle" },
    connectAcknowledged: false,
    readiness: undefined,
    creation: "idle",
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

export function draftIsSubmittable(draft: AgentDraft): boolean {
  return draft.runtime !== undefined && validateAgentName(draft.name) === undefined;
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
  const { draft, destinationConfirmed, draftConfirmed, connect, connectAcknowledged, readiness, creation, messaging } =
    facts;
  const destinationDone = draft.destination !== undefined && destinationConfirmed;
  const agentDone = destinationDone && draftIsSubmittable(draft) && draftConfirmed;
  const connectDone = agentDone && computerIsConnected(connect) && connectAcknowledged;
  const checkDone = connectDone && readinessPassed(readiness) && creation === "created";
  const messagingDone = checkDone && messaging.kind === "connected";

  const page: PageId = !destinationDone
    ? "destination"
    : !agentDone
      ? "agent"
      : !connectDone
        ? "connect"
        : !checkDone
          ? "check"
          : "messaging";

  const done: Record<StepId, boolean> = {
    destination: destinationDone,
    agent: agentDone,
    connect: connectDone,
    check: checkDone,
    messaging: messagingDone,
  };
  const currentIndex = STEP_IDS.findIndex((id) => !done[id]);
  const steps = STEP_IDS.map((id, index) => ({
    id,
    status: stepStatus(done[id], index, currentIndex),
  }));

  return { page, steps, complete: messagingDone };
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
