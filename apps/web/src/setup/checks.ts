/**
 * The vocabulary a setup surface reads a Computer's readiness in, and the countdown a connect code
 * is shown with.
 */

/** Mirrors the Server's provider readiness vocabulary so a mock stays swappable for the real API. */
export type MessagingCliStatus = "checking" | "ready" | "install" | "unavailable";

/** Whole seconds while a connect code is still worth showing, so an expired one never reads as live. */
export function formatRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
