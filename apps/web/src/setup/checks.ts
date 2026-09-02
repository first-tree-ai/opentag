/**
 * What a computer has to have before an Agent can run on it, as data.
 *
 * These are the checks themselves, not the flow that collects them: they take the two statuses the
 * Server reports and say what a reader should see. Onboarding gathers those statuses while walking
 * someone through setup; Agent settings reads them back off an Agent that already exists. Both feed
 * the same functions, so both describe a computer the same way.
 */

/** Mirrors the Server's provider readiness vocabulary so a mock stays swappable for the real API. */
export type MessagingCliStatus = "checking" | "ready" | "install" | "unavailable";

/**
 * `install` and `sign-in` are mutually exclusive outcomes of one Server-side probe, so the two
 * runtime rows are derived from a single status rather than being two independent facts. A runtime
 * that is not installed leaves sign-in genuinely unknown, which the `blocked` state says out loud
 * instead of guessing.
 *
 * The messaging CLI is not a row: which binary is needed depends on a provider chosen later, so it is
 * named in a sentence rather than a third check line. Onboarding is the only surface that uses this
 * chain: `messagingCliCheck` maps the reported status to the `CheckState` that decides whether
 * `messagingCliMissingCopy` is shown.
 */
export function formatRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
