import { useEffect } from "react";
import { analytics } from "./analytics.js";
import { ANALYTICS_EVENT, activationStep } from "./events.js";
import { takeSignInIntent } from "./sign-in-intent.js";

const REPORTED_KEY = "opentag:analytics:reported";
/**
 * How many milestone keys are kept. Each Account produces a handful — one per Agent for the first
 * conversation, one per Agent and stage for setup — and the oldest are dropped rather than letting
 * a long-lived browser grow an unbounded entry. A dropped key can only cause a milestone to be
 * reported a second time long after the first, which a funnel reads as one reader, not two.
 */
const REPORTED_LIMIT = 200;

/**
 * Keys already reported by this document, independent of storage.
 *
 * Storage answers "has this ever happened for this reader", which is the question a milestone
 * asks. It can also be unavailable — a private window, a browser configured to refuse it — and a
 * milestone that falls back to reporting every time would be worse than one that is missing. This
 * set is the floor: within one document a milestone is reported once whatever storage does.
 */
const reportedInDocument = new Set<string>();

/** Test seam: the in-document floor outlives a component, so a suite has to be able to clear it. */
export function resetReportedMilestones(): void {
  reportedInDocument.clear();
}

function reportedStorage(target: Window): Storage | undefined {
  try {
    return target.localStorage;
  } catch {
    return undefined;
  }
}

function readReported(storage: Storage): string[] {
  try {
    const raw = storage.getItem(REPORTED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Report a milestone the first time it is reached, and never again for this reader.
 *
 * A milestone is a step in a funnel rather than an action, so a second report of the same step is
 * not a second reader doing something — it is the same reader opening the page again, which would
 * inflate the step it lands on and understate the drop into the next one.
 */
export function reportMilestoneOnce(key: string, emit: () => void, target: Window = window): void {
  if (reportedInDocument.has(key)) return;
  reportedInDocument.add(key);
  const storage = reportedStorage(target);
  if (storage) {
    const reported = readReported(storage);
    if (reported.includes(key)) return;
    try {
      storage.setItem(REPORTED_KEY, JSON.stringify([...reported, key].slice(-REPORTED_LIMIT)));
    } catch {
      // Reported anyway: the in-document floor still holds for this visit.
    }
  }
  emit();
}

/**
 * A connected Computer.
 *
 * Only a first connection is an activation step. A repair reconnects a Computer the Account already
 * had, so counting it would report the same reader reaching step 3 a second time — inflating that
 * step and understating the drop out of it. The event is still worth having: a repair is somebody
 * recovering, which is its own thing to know.
 */
export function reportComputerConnected(mode: "create" | "repair"): void {
  analytics.track(ANALYTICS_EVENT.computerConnected, {
    mode,
    ...(mode === "create" ? activationStep("computer_connected") : {}),
  });
}

/**
 * Attach the Account, and report the sign-in that produced it.
 *
 * This runs wherever an authenticated surface first resolves the Account, which is every load of
 * every signed-in page — so the sign-in itself is told apart from a return visit by the intent the
 * sign-in path left behind. Without one, this is somebody arriving with a session they already had,
 * and only the identification is worth doing.
 */
export function useSignedInReport(userId: string | undefined): void {
  useEffect(() => {
    if (!userId) return;
    analytics.identify(userId);
    const intent = takeSignInIntent();
    if (!intent) return;
    analytics.track(intent.registering ? ANALYTICS_EVENT.signUp : ANALYTICS_EVENT.login, {
      method: intent.method,
      ...activationStep("signed_in"),
    });
  }, [userId]);
}

/**
 * Report that an Agent has held a conversation, the first time this application sees that it has.
 *
 * Conversations happen in the messaging app, not here, so this is an observation and is named as
 * one. Two biases are worth stating plainly, because both only ever lose events:
 *
 * - It can fire only while a reader has the Agent list open, so somebody who connects a Computer,
 *   talks to their Agent in Slack and never returns to this site is never counted.
 * - `usage.tasks` is a rolling thirty-day aggregate, not a lifetime count, so an Agent whose only
 *   conversations are older than that window reads here as one that has held none.
 *
 * The step is therefore a floor on the real conversion rather than an estimate of it, and must not
 * be read as "readers who have ever held a conversation".
 */
export function useFirstConversationReport(
  agents: readonly { readonly id: string; readonly usage: { readonly tasks: number } }[] | undefined,
): void {
  useEffect(() => {
    if (!agents) return;
    for (const agent of agents) {
      if (agent.usage.tasks < 1) continue;
      reportMilestoneOnce(`first-conversation:${agent.id}`, () => {
        analytics.track(ANALYTICS_EVENT.firstConversationObserved, activationStep("first_conversation"));
      });
    }
  }, [agents]);
}

/**
 * Report each setup stage an Agent reaches. The snapshot behind this is re-read every couple of
 * seconds while setup is open, so the stage — not the read — is what is reported, once per Agent.
 * These are the steps between connecting a Computer and being able to hold a conversation at all,
 * and they are where a reader who never reaches the last milestone actually stopped.
 */
export function useAgentSetupStageReport(agentId: string, stage: string | undefined): void {
  useEffect(() => {
    if (!stage) return;
    reportMilestoneOnce(`setup-stage:${agentId}:${stage}`, () => {
      analytics.track(ANALYTICS_EVENT.agentSetupStageReached, { stage });
      if (stage === "ready") analytics.track(ANALYTICS_EVENT.agentSetupCompleted, {});
    });
  }, [agentId, stage]);
}
