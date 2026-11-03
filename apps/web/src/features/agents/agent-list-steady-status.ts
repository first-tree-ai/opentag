import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AgentAvailability, AgentListItem } from "./agent-model.js";

/**
 * How long a row that was Ready keeps reading Ready while its evidence is only being re-read.
 *
 * The Server answers "checking" whenever delivery evidence expires or a Computer reconnects, and a
 * background read that fails marks the whole list unconfirmed. Each of those settles on its own
 * within seconds, yet shown as they arrive they make a healthy roster blink between Ready and a
 * label that reads like a fault. The window matches the handoff fast-poll window: a check the
 * Computer has not answered by then is no longer routine, and the row reports it as it is.
 */
export const STEADY_READY_HOLD_MS = 90_000;

type SteadyMemory = {
  /** The availability the row last showed as Ready, reused verbatim so every derived field agrees. */
  ready?: AgentAvailability;
  /** When the current run of self-resolving answers began. */
  transientSince?: number;
};

/*
 * Held per QueryClient, so the memory survives leaving and reopening the list within a session and
 * goes away with the cache when the session ends. Agent IDs are unique, so rows never share entries.
 */
const memories = new WeakMap<QueryClient, Map<string, SteadyMemory>>();

function memoryFor(queryClient: QueryClient): Map<string, SteadyMemory> {
  let memory = memories.get(queryClient);
  if (!memory) {
    memory = new Map();
    memories.set(queryClient, memory);
  }
  return memory;
}

/**
 * An answer that says the evidence is still being read rather than that something is wrong. Every
 * other non-ready state -- an offline Computer, a missing sign-in, a failed delivery, a paused
 * Agent -- is a verdict and is never held back.
 */
export function isSelfResolvingAvailability(agent: AgentListItem): boolean {
  const { availability } = agent;
  if (!agent.evidenceConfirmed || availability.state === "unconfirmed") return true;
  if (availability.reason === "handoff_checking") return true;
  return availability.reason === "runtime_unavailable" && availability.dependencies.runtime.status === "checking";
}

function isReady(agent: AgentListItem): boolean {
  return agent.evidenceConfirmed && agent.availability.state === "ready";
}

/**
 * The row to present for one Agent, and when its hold runs out. Identity, lifecycle and activity
 * always come from the current answer; only the availability verdict can be carried over.
 */
export function steadyAgentListItem(
  agent: AgentListItem,
  memory: Map<string, SteadyMemory>,
  now: number,
): { agent: AgentListItem; holdUntil?: number } {
  if (isReady(agent)) {
    memory.set(agent.id, { ready: agent.availability });
    return { agent };
  }
  const entry = memory.get(agent.id);
  if (!isSelfResolvingAvailability(agent) || !entry?.ready) {
    // A verdict replaces whatever was remembered: if the Agent recovers, it is Ready again on its
    // own answer, and a later check has nothing stale to fall back on.
    if (entry && !isSelfResolvingAvailability(agent)) memory.delete(agent.id);
    return { agent };
  }
  entry.transientSince ??= now;
  const holdUntil = entry.transientSince + STEADY_READY_HOLD_MS;
  if (now >= holdUntil) return { agent };
  return { agent: { ...agent, availability: entry.ready, evidenceConfirmed: true }, holdUntil };
}

/**
 * The Agent list as it should be presented: a row that was Ready stays Ready through routine
 * re-checks, and reports them only once they outlast `STEADY_READY_HOLD_MS`. A row first seen in
 * a self-resolving state has no Ready to keep and is shown as it is.
 */
export function useSteadyAgentList(agents: readonly AgentListItem[]): AgentListItem[] {
  const memory = memoryFor(useQueryClient());
  const [, setExpired] = useState(0);
  const now = Date.now();
  const steady = agents.map((agent) => steadyAgentListItem(agent, memory, now));
  const nextExpiry = Math.min(...steady.map((row) => row.holdUntil ?? Number.POSITIVE_INFINITY));

  // Nothing else re-renders the list when a hold runs out while the answers stay the same.
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setExpired((count) => count + 1), Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [nextExpiry]);

  return steady.map((row) => row.agent);
}
