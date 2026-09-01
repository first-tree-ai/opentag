/**
 * What a computer has to have before an Agent can run on it, as data.
 *
 * These are the checks themselves, not the flow that collects them: they take the two statuses the
 * Server reports and say what a reader should see. Onboarding gathers those statuses while walking
 * someone through setup; Agent settings reads them back off an Agent that already exists. Both feed
 * the same functions, so both describe a computer the same way.
 */

/** Mirrors the Server's provider readiness vocabulary so a mock stays swappable for the real API. */
export type RuntimeStatus = "checking" | "ready" | "install" | "sign-in" | "unavailable";
/** The messaging CLI has no sign-in of its own: it is installed or it is not. */
export type MessagingCliStatus = "checking" | "ready" | "install" | "unavailable";

/**
 * `install` and `sign-in` are mutually exclusive outcomes of one Server-side probe, so the two
 * runtime rows are derived from a single status rather than being two independent facts. A runtime
 * that is not installed leaves sign-in genuinely unknown, which the `blocked` state says out loud
 * instead of guessing.
 *
 * The messaging CLI is not a row: which binary is needed depends on a provider chosen later, and
 * both onboarding and Agent settings name a missing one with a sentence
 * (`SETUP_COPY.messaging.cliMissing`) rather than a third check line. `messagingCliCheck` returns
 * that sentence's `CheckState`.
 */
export type CheckState = "pending" | "passed" | "failed" | "blocked";

export interface CheckRow {
  readonly id: "runtime-cli" | "runtime-auth";
  readonly state: CheckState;
}

/**
 * The runtime rows, from the one status they are both derived from. An absent status is a probe
 * that has not answered yet, which reads the same as `checking`.
 *
 * The messaging CLI is deliberately not here: which one is even needed depends on a provider that
 * is chosen separately, so a missing `lark-cli` used to block someone who was going to pick Slack.
 * That check is asked for on its own, where the requirement becomes real.
 */
export function deriveChecks(runtime: RuntimeStatus | undefined): readonly CheckRow[] {
  const status = runtime ?? "checking";
  return [
    { id: "runtime-cli", state: runtimeCliState(status) },
    { id: "runtime-auth", state: runtimeAuthState(status) },
  ];
}

/** The chosen provider's CLI, as the `CheckState` behind the missing-CLI sentence. */
export function messagingCliCheck(status: MessagingCliStatus | undefined): CheckState {
  return messagingCliState(status ?? "checking");
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
  if (status === "checking" || status === "install") return "pending";
  if (status === "ready") return "passed";
  return "failed";
}

/** Formats a remaining duration as `m:ss`, never rounding a live second up. */
export function formatRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
