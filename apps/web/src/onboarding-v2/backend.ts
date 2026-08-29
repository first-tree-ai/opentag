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

import type { AgentDraft, ConnectState, CreationState, MessagingState, ReadinessFacts } from "./flow.js";

export type PlanSignIn = "idle" | "pending" | "signed-in";

/** The Agent, once it exists. Messaging is set up against it, so it outlives the step that made it. */
export interface CreatedAgent {
  readonly id: string;
  readonly name: string;
}

export interface OnboardingBackend {
  readonly connect: ConnectState;
  readonly readiness: ReadinessFacts | undefined;
  readonly messaging: MessagingState;
  readonly planSignIn: PlanSignIn;
  /**
   * Creating the Agent belongs here rather than to the page: it is the one step that writes to the
   * Server, and a page that owned it would have to hold a timer in the mock and a request in the
   * real one — two shapes for one fact.
   */
  readonly creation: CreationState;
  readonly agent: CreatedAgent | undefined;
  /**
   * The last thing that failed, in words a person can act on. Held rather than thrown: none of
   * these failures ends the flow, and a step that has lost its Server is still a step the reader
   * is looking at.
   */
  readonly error: string | undefined;
  readonly startPlanSignIn: () => void;
  /** Issues the first connect code. Safe to call repeatedly; only an idle connection acts on it. */
  readonly issueConnectCode: () => void;
  /** Replaces an expired code with a fresh one, restarting the wait. */
  readonly refreshConnectCode: () => void;
  readonly createAgent: (draft: AgentDraft) => void;
  readonly startMessaging: (provider: "feishu" | "slack") => void;
  /** Slack's install is a link out; this is the user leaving for Slack. */
  readonly startSlackInstall: () => void;
  readonly reset: () => void;
}
