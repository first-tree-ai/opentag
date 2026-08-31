import type { ComputerConnectionStatus } from "@opentag/shared/browser";
import { compareText } from "../../i18n/format.js";

/** What resolving the Account's Computer depends on, whichever surface is asking. */
export interface AccountComputerFacts {
  readonly connectionStatus: ComputerConnectionStatus;
  /** Whether a Runtime on this Computer is ready, so an Agent could actually run here. */
  readonly runtimeReady: boolean;
  /** How many Agents this enrollment carries — the Account's work, if any, is on this machine. */
  readonly agentCount: number;
  readonly displayName: string;
}

/**
 * How good an answer this Computer is to "which machine is the Account's". A machine that can run
 * an Agent comes before one that is merely reachable, and both come before an unreachable machine —
 * except that an unreachable machine carrying the Account's Agents beats an idle one, because when
 * nothing is reachable the question being asked is which machine to bring back.
 */
function accountComputerRank(facts: AccountComputerFacts): number {
  if (facts.connectionStatus === "online") return facts.runtimeReady ? 0 : 1;
  return facts.agentCount > 0 ? 2 : 3;
}

/**
 * An Account has one Computer, so a surface resolves which machine it is talking about rather than
 * asking. Every surface resolves it the same way, because they act on the answer as well as show
 * it: the Computer page repairs the machine it names, and New Agent creates on the machine it
 * names. Two surfaces disagreeing would mean managing one machine and running on another.
 *
 * The order only decides anything for an Account still holding several enrollments from before the
 * rule. Ties inside a rank are broken by display name so the answer is stable across reads.
 */
export function resolveAccountComputer<T>(
  computers: readonly T[],
  factsOf: (computer: T) => AccountComputerFacts,
): T | undefined {
  return [...computers].sort((left, right) => {
    const leftFacts = factsOf(left);
    const rightFacts = factsOf(right);
    const byRank = accountComputerRank(leftFacts) - accountComputerRank(rightFacts);
    return byRank !== 0 ? byRank : compareText(leftFacts.displayName, rightFacts.displayName);
  })[0];
}
