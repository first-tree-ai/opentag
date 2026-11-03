import { LIVE_REFETCH_INTERVAL_MS } from "../../query/live.js";
import type { AgentAvailability, AgentDetailView, AgentListItem } from "./agent-model.js";

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
 * The Agent home's status card follows the same rule through `observeAgentDetailStatus`, so the two
 * never disagree about one Agent.
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
 * quiet note, so one Agent's stuck reads never become a page-level notice. A row with nothing
 * settled already reads as unknown and needs no second note.
 */
export function observeAgentListStatus(
  memory: AgentListStatusMemory,
  agent: AgentListItem,
  now: number,
): { shown: AgentListItem; refreshing: boolean } {
  const entry = memory.get(agent.id) ?? {};
  if (!isTransientAgentAvailability(agent)) {
    memory.set(agent.id, { settled: agent });
    return { shown: agent, refreshing: false };
  }
  const transientSince = entry.transientSince ?? now;
  memory.set(agent.id, { ...entry, transientSince });
  return {
    shown: steadyAgentListItem(agent, entry.settled),
    refreshing: entry.settled !== undefined && now - transientSince >= AGENT_STATUS_REFRESHING_AFTER_MS,
  };
}

/** A detail read whose dependency states (Computer, runtime, delivery) are a moment of not knowing. */
function isTransientDetailAvailability(availability: AgentDetailView["availability"]): boolean {
  return (
    availability.state === "unconfirmed" ||
    availability.reason === "handoff_checking" ||
    (availability.reason === "runtime_unavailable" && availability.dependencies.runtime.status === "checking")
  );
}

/** The detail view's own transient evidence: the same moments of not knowing the list holds through. */
export function isTransientAgentDetail(agent: Pick<AgentDetailView, "availability" | "messaging">): boolean {
  return agent.messaging.kind === "unconfirmed" || isTransientDetailAvailability(agent.availability);
}

type SettledDependencies = Pick<AgentDetailView, "availability" | "computerConnectionStatus">;

/** What the Agent home remembers about its Agent between reads, per part of the status card. */
export type AgentDetailStatusMemory = {
  agentId?: string;
  dependencies?: SettledDependencies;
  messaging?: AgentDetailView["messaging"];
  transientSince?: number;
};

/**
 * Records one read of an Agent for its home status card and answers what the card shows, by the
 * list's rule: transient evidence keeps the last settled answer, a confirmed problem replaces it at
 * once, and a card held for a full refresh interval says it is refreshing. The dependency states and
 * the messaging read are held separately, so an unreadable messaging answer never hides a runtime or
 * Computer problem the same read confirmed. With nothing settled yet the card shows the current read.
 */
export function observeAgentDetailStatus(
  memory: AgentDetailStatusMemory,
  agent: AgentDetailView,
  now: number,
): { shown: AgentDetailView; refreshing: boolean } {
  if (memory.agentId !== agent.id) {
    memory.agentId = agent.id;
    memory.dependencies = undefined;
    memory.messaging = undefined;
    memory.transientSince = undefined;
  }
  const dependenciesTransient = isTransientDetailAvailability(agent.availability);
  const messagingTransient = agent.messaging.kind === "unconfirmed";
  if (!dependenciesTransient) {
    memory.dependencies = {
      availability: agent.availability,
      computerConnectionStatus: agent.computerConnectionStatus,
    };
  }
  if (!messagingTransient) memory.messaging = agent.messaging;
  const heldDependencies = dependenciesTransient ? memory.dependencies : undefined;
  const heldMessaging = messagingTransient ? memory.messaging : undefined;
  if (!heldDependencies && !heldMessaging) {
    memory.transientSince = dependenciesTransient || messagingTransient ? (memory.transientSince ?? now) : undefined;
    return { shown: agent, refreshing: false };
  }
  memory.transientSince ??= now;
  return {
    shown: { ...agent, ...heldDependencies, ...(heldMessaging ? { messaging: heldMessaging } : {}) },
    refreshing: now - memory.transientSince >= AGENT_STATUS_REFRESHING_AFTER_MS,
  };
}
