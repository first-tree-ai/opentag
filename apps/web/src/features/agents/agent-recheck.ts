import type { AgentDetailView } from "./agent-model.js";

/**
 * Entering an Agent's home or setup step while its Computer is online but its runtime or Provider CLIs
 * read not ready (or unknown) asks the Computer to check again, once. An admin who just fixed
 * something on the computer should see it recognised without having to find a button. The window keeps
 * page switches and remounts from asking a Computer to re-probe more than once a minute per Agent.
 */
export const AGENT_RECHECK_MIN_INTERVAL_MS = 60_000;

const STORAGE_PREFIX = "opentag.agent-recheck.";
const lastRecheckAt = new Map<string, number>();

/*
 * The window survives a reload through session storage, so reloading the page does not ask again;
 * storage that is unavailable (private mode, blocked site data) falls back to this page's memory.
 */
function readLast(agentId: string): number | undefined {
  try {
    const stored = Number(window.sessionStorage.getItem(STORAGE_PREFIX + agentId));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch {
    // Storage unavailable: the in-memory value below still applies.
  }
  return lastRecheckAt.get(agentId);
}

function writeLast(agentId: string, now: number): void {
  lastRecheckAt.set(agentId, now);
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + agentId, String(now));
  } catch {
    // Storage unavailable: the in-memory value keeps the window for this page.
  }
}

/** Claims the Agent's re-check for now; false while one asked within the window still stands. */
export function claimAgentRecheck(agentId: string, now: number): boolean {
  const last = readLast(agentId);
  if (last !== undefined && now - last < AGENT_RECHECK_MIN_INTERVAL_MS) return false;
  writeLast(agentId, now);
  return true;
}

export function resetAgentRechecks(): void {
  lastRecheckAt.clear();
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(STORAGE_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // Nothing stored to clear.
  }
}

/**
 * Only a Local Agent that is running and whose Computer is online can be re-checked: a Cloud
 * Computer has nothing to re-probe, an offline one cannot answer, and a paused Agent was stopped on
 * purpose. A runtime probe already running needs no second one.
 */
export function agentHomeNeedsRecheck(agent: AgentDetailView): boolean {
  if (agent.status === "suspended" || agent.availability.state === "suspended") return false;
  if (agent.computerKind !== "local" || agent.computerConnectionStatus !== "online") return false;
  const { availability } = agent;
  const runtime = availability.dependencies.runtime.status;
  if (runtime === "checking") return false;
  return (
    runtime !== "ready" ||
    availability.reason === "runtime_unconfirmed" ||
    availability.reason === "handoff_unavailable" ||
    availability.reason === "handoff_unconfirmed"
  );
}
