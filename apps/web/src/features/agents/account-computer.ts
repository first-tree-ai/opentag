import type { ComputerConnectionStatus } from "@opentag/shared/browser";

/**
 * An Account has one Computer, so a surface resolves which machine it is talking about rather than
 * asking: the Computer a ready Runtime route already names, else one that is online, else the one
 * that is there.
 *
 * The order matters only for an Account still holding several enrollments from before the rule, and
 * it is what makes every surface name the same machine for it — a collection is never shown. A
 * surface with no route to offer passes no ready Computer: those enrollments accumulate from a
 * machine that was re-enrolled after it stopped answering, so the extra rows are the unreachable
 * ones and `online` already resolves them the same way a route would.
 */
export function resolveAccountComputer<T extends { readonly connectionStatus: ComputerConnectionStatus }>(
  computers: readonly T[],
  readyComputer?: T,
): T | undefined {
  return readyComputer ?? computers.find((computer) => computer.connectionStatus === "online") ?? computers[0];
}
