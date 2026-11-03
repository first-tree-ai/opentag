import { LIVE_REFETCH_INTERVAL_MS } from "../../query/live.js";
import type { AgentListItem } from "./agent-model.js";

/**
 * Whether an Agent's current evidence is a moment of not knowing rather than an answer.
 *
 * Every background read can briefly land here without anything being wrong: a refresh that failed
 * once, a read the browser paused offline, delivery credentials the Server is re-verifying after
 * their observation expired, or a Provider probe still running. Each resolves by itself, usually
 * within seconds, and none is something the reader can act on.
 */
export function isTransientAgentAvailability(agent: Pick<AgentListItem, "availability" | "evidenceConfirmed">) {
  const { availability } = agent;
  return (
    !agent.evidenceConfirmed ||
    availability.state === "unconfirmed" ||
    availability.reason === "handoff_checking" ||
    (availability.reason === "runtime_unavailable" && availability.dependencies.runtime.status === "checking")
  );
}

/**
 * The row the Agent list shows, holding the last settled answer through transient evidence.
 *
 * The list re-reads every dependency on a short cadence, so showing each transient answer as it
 * arrives made a healthy roster flicker through "checking" and "status unavailable" while nothing
 * was wrong. Instead the list keeps the Agent's last settled availability until the next settled
 * answer replaces it; activity and identity still come from the current read. With nothing settled
 * behind it there is nothing to hold, so the current read passes through: `observeAgentListStatus`
 * shows a check as a neutral "Checking" (never Ready, which a first check that then found a problem
 * would contradict seconds later), and unreadable evidence stays honestly unknown.
 *
 * Only the list does this. The Agent's own page keeps the exact current dependency states, where a
 * reader who is diagnosing an Agent needs them.
 */
export function steadyAgentListItem(agent: AgentListItem, lastSettled: AgentListItem | undefined): AgentListItem {
  if (!isTransientAgentAvailability(agent)) return agent;
  if (lastSettled) return { ...agent, availability: lastSettled.availability, evidenceConfirmed: true };
  return agent;
}

/** A readable check still running, as opposed to evidence the Server could not read at all. */
function isPendingCheck(agent: Pick<AgentListItem, "availability" | "evidenceConfirmed">): boolean {
  return agent.evidenceConfirmed && agent.availability.state !== "unconfirmed";
}

/**
 * How long a row may stay on held evidence before it says so. One live refresh interval means the
 * next read after the first transient one also failed to settle, so a single blip stays silent.
 */
export const AGENT_STATUS_REFRESHING_AFTER_MS = LIVE_REFETCH_INTERVAL_MS;

/** What the list remembers about one Agent between reads. */
export type AgentListStatusMemory = Map<string, { settled?: AgentListItem; transientSince?: number }>;

/**
 * Records one read of an Agent and answers what its row shows.
 *
 * `refreshing` is true only for a row that holds a settled status while its evidence has stayed
 * transient for at least `AGENT_STATUS_REFRESHING_AFTER_MS`: the row keeps that status and adds a
 * quiet note, so one Agent's stuck reads never become a page-level notice. `checking` is true for a
 * row with nothing settled whose check is still running; it reads "Checking" until the first answer.
 * A row with nothing settled already reads as checking or unknown and needs no second note.
 */
export function observeAgentListStatus(
  memory: AgentListStatusMemory,
  agent: AgentListItem,
  now: number,
): { shown: AgentListItem; refreshing: boolean; checking: boolean } {
  const entry = memory.get(agent.id) ?? {};
  if (!isTransientAgentAvailability(agent)) {
    memory.set(agent.id, { settled: agent });
    return { shown: agent, refreshing: false, checking: false };
  }
  const transientSince = entry.transientSince ?? now;
  memory.set(agent.id, { ...entry, transientSince });
  return {
    shown: steadyAgentListItem(agent, entry.settled),
    refreshing: entry.settled !== undefined && now - transientSince >= AGENT_STATUS_REFRESHING_AFTER_MS,
    checking: entry.settled === undefined && isPendingCheck(agent),
  };
}
