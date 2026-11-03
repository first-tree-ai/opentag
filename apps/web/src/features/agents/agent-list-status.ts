import type { AgentAvailability, AgentListItem } from "./agent-model.js";

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
 * answer replaces it; activity and identity still come from the current read. A check with no
 * settled answer behind it is presented as ready, because it resolves to an answer the list then
 * shows; unreadable evidence with nothing settled behind it stays honestly unknown.
 *
 * Only the list does this. The Agent's own page keeps the exact current dependency states, where a
 * reader who is diagnosing an Agent needs them.
 */
export function steadyAgentListItem(agent: AgentListItem, lastSettled: AgentListItem | undefined): AgentListItem {
  if (!isTransientAgentAvailability(agent)) return agent;
  if (lastSettled) return { ...agent, availability: lastSettled.availability, evidenceConfirmed: true };
  if (agent.evidenceConfirmed && agent.availability.state !== "unconfirmed") {
    return { ...agent, availability: readyAvailability(agent.availability) };
  }
  return agent;
}

function readyAvailability(availability: AgentAvailability): AgentAvailability {
  return { ...availability, state: "ready", reason: null };
}
