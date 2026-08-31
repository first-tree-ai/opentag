/**
 * The one seam the flow's pages sit on. Both the in-page mock and the Server-backed implementation
 * satisfy it, so the pages never learn which one they are running against and no page holds a
 * branch for "real" versus "review".
 *
 * It is written in the vocabulary of what a page observes — a command that can expire, a Computer
 * that shows up, a readiness result, a messaging app that connects — and deliberately not in the
 * vocabulary of the transport underneath. That is what lets the mock stay a model of the flow
 * rather than a fake of the API.
 */

import type { WorkspaceComputerSummary } from "@opentag/shared/browser";
import type { ComputerConnectAdapter } from "../features/computer-connect/computer-connect.js";
import type { AgentDraft, CreationState, MessagingProvider, MessagingState, ReadinessFacts, Runtime } from "./flow.js";

export type PlanSignIn = "idle" | "pending" | "signed-in";

/** The Agent, once it exists. Messaging is set up against it, so it outlives the step that made it. */
export interface CreatedAgent {
  readonly id: string;
  readonly name: string;
  readonly runtimeProvider: Runtime;
}

export interface KnownComputer {
  readonly id: string;
  readonly displayName: string;
  readonly availability: "online" | "offline" | "unknown";
  /** Human phrasing for how long ago it was seen, shown only when it is offline. */
  readonly lastSeen?: string;
}

export interface OnboardingBackend {
  /** Review Lab's deterministic transport; production uses ComputerConnect's browser adapter. */
  readonly computerConnectAdapter?: ComputerConnectAdapter;
  readonly readiness: ReadinessFacts | undefined;
  readonly messaging: MessagingState;
  /**
   * Which messaging app a resumed run is already bound to.
   *
   * The choice a reader made lives on the page, which a Slack callback destroys: the browser leaves
   * for Slack's pages and comes back to a fresh mount. `messaging` alone cannot rebuild it, because
   * "waiting to be observed" says nothing about which app is waiting — so the step would render
   * neither branch and show an empty page until readiness happened to flip. A resumed run reports
   * the provider its binding already names; a first run has none and reports nothing.
   */
  readonly messagingProvider: MessagingProvider | undefined;
  /**
   * The Computers this Account already has, so the step can prepare one instead of asking for a
   * command. An Account is meant to have exactly one; the shape stays a list because Accounts that
   * predate that rule can still hold more, and the step has to pick without asking the reader.
   *
   * Optional so small test backends can omit inventory. Production and Review Lab both provide the
   * selected Computer when one already exists.
   */
  readonly knownComputers?: readonly KnownComputer[];
  /** The one this run is preparing, or `undefined` when there is none and one must be connected. */
  readonly selectedComputerId?: string | undefined;
  /** Adopts only the exact Computer the shared connection lifecycle has verified online. */
  readonly computerConnected: (computer: WorkspaceComputerSummary) => void;
  /**
   * Records that readiness has already carried this run beyond the Computer page. Availability
   * can change later without rewinding messaging setup.
   */
  readonly markPastComputerStep: () => void;
  readonly planSignIn: PlanSignIn;
  /**
   * Creating the Agent belongs here rather than to the page: it is the one step that writes to the
   * Server, and a page that owned it would have to hold a timer in the mock and a request in the
   * real one — two shapes for one fact.
   */
  readonly creation: CreationState;
  /**
   * Whether the Computer the Agent runs on is reachable right now, once one is known. Being
   * reachable is one of the things setup completion waits on, and the wait cannot name what it is
   * waiting for without it.
   */
  readonly computerOnline: boolean | undefined;
  readonly agent: CreatedAgent | undefined;
  /**
   * The last thing that failed, in words a person can act on. Held rather than thrown: none of
   * these failures ends the flow, and a step that has lost its Server is still a step the reader
   * is looking at.
   */
  readonly error: string | undefined;
  /**
   * True until the Account's existing Agents and Computers have been read.
   *
   * This flow sits behind the setup gate, which means it is re-entered rather than visited once: a
   * Slack install leaves for Slack and comes back, a tab is refreshed, a laptop wakes up. Starting
   * from an empty draft each time would ask an Account that already has an Agent to make one
   * again — and the second attempt collides with the first on name uniqueness.
   */
  readonly resuming: boolean;
  /** Why the Account could not be read, if it could not. */
  readonly resumeError: string | undefined;
  /**
   * The Agent this flow found but cannot finish, when every Agent the Account has is one with no
   * Computer. This flow's connect step proves nothing about which machine answered its code, so it
   * cannot give that Agent one; carrying on would report a connection and then stop at messaging,
   * which refuses an Agent that has nowhere to run. The reader is sent to where the choice is
   * explicit instead.
   */
  readonly resumeBlocked: { readonly agentId: string; readonly agentName: string } | undefined;
  /** Reads it again. A failed read has to be recoverable: this route is the gate's only exit. */
  readonly retryResume: () => void;
  readonly startPlanSignIn: () => void;
  readonly createAgent: (draft: AgentDraft) => void;
  readonly startMessaging: (provider: "feishu" | "slack") => void;
  /** Slack's install is a link out; this is the user leaving for Slack. */
  readonly startSlackInstall: () => void;
  readonly reset: () => void;
}
