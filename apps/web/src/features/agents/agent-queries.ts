import type { ImBindingHandoffStatus, ImBindingSummary } from "@opentag/shared/browser";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import type { LoadState } from "../resource/resource-state.js";
import { isTerminalResourceError, toResourceState } from "../resource/resource-state.js";
import type { AgentDetailView, AgentListItem } from "./agent-model.js";
import { markAgentDetailUnconfirmed, markAgentListUnconfirmed, projectAgentAvailability } from "./agent-model.js";

/**
 * What a page that waits for an Agent to recover asks for: re-read on an interval, and again when
 * the Account comes back to the tab. The query client leaves both off by default, because most
 * reads here answer a question the Account asked once.
 */
const WATCHED = { refetchInterval: 30_000, refetchOnWindowFocus: true } as const;

/*
 * These two endpoints answer 204 for an Agent that has none, which the API layer resolves as
 * `undefined`. A query may not resolve `undefined` — it is how the cache says "nothing read yet" —
 * so absence becomes `null` here, at the only place that has to know the difference.
 */
const readImBinding = (agentId: string): Promise<ImBindingSummary | null> =>
  browserApi.imBinding(agentId).then((binding) => binding ?? null);

const readImBindingHandoff = (agentId: string): Promise<ImBindingHandoffStatus | null> =>
  browserApi.imBindingHandoff(agentId).then((handoff) => handoff ?? null);

/** The part of a query this remembers. Taking a plain object keeps the reads it accepts explicit. */
interface SettlingQuery {
  error: Error | null;
  isError: boolean;
  isSuccess: boolean;
}

/**
 * The last answer the Server actually gave, held across the re-read that follows it.
 *
 * The cache clears `error` the moment a fetch starts on a query that has never held data, so
 * `isError` describes only the attempt in flight. A terminal response is not an attempt that failed
 * but an answer — the Agent is gone or forbidden — and forgetting it on every interval and every
 * focus is what let route state put a deleted Agent back on screen between re-reads. Only a success
 * retires it, and the resource it was recorded for keys it so a different Agent never inherits it.
 */
function useSettledError(key: string, query: SettlingQuery): Error | null {
  const settled = useRef<{ key: string; error: Error | null }>({ key, error: null });
  if (settled.current.key !== key) settled.current = { key, error: null };
  if (query.isSuccess) settled.current.error = null;
  else if (query.isError) settled.current.error = query.error ?? new Error("The request failed");
  return settled.current.error;
}

/** The Account's Computers. One cache entry, so every surface that needs them shares one read. */
export function useComputersQuery(watched = false) {
  return useQuery({
    queryKey: queryKeys.computers(),
    queryFn: () => browserApi.computers(),
    ...(watched ? WATCHED : {}),
  });
}

/**
 * The Agent list, assembled from the reads it needs rather than one opaque loader, so that opening
 * an Agent, or the New Agent dialog, reuses what the list already holds instead of asking again.
 *
 * The Computer read gates the per-Agent evidence: when it fails there is nothing to judge an Agent
 * against, so the original refused to ask, and asking anyway would add N requests during exactly the
 * kind of partial outage that makes this expensive.
 */
export function useAgentListView(accountId: string): LoadState<{ agents: AgentListItem[] }> {
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(accountId),
    queryFn: () => browserApi.agents(),
    ...WATCHED,
  });
  const computersQuery = useComputersQuery(true);
  const agents = agentsQuery.data?.agents ?? [];
  const evidenceOffered = computersQuery.isSuccess;
  const bindings = useQueries({
    queries: agents.map((agent) => ({
      queryKey: queryKeys.agents.imBinding(agent.id),
      queryFn: () => readImBinding(agent.id),
      enabled: evidenceOffered,
      ...WATCHED,
    })),
  });
  const handoffs = useQueries({
    queries: agents.map((agent) => ({
      queryKey: queryKeys.agents.imBindingHandoff(agent.id),
      queryFn: () => readImBindingHandoff(agent.id),
      enabled: evidenceOffered,
      ...WATCHED,
    })),
  });

  const agentsError = useSettledError(accountId, agentsQuery);

  // A terminal response is an answer about the list itself, so it outranks the reads still settling
  // beside it as well as any rows the cache still holds.
  if (agentsError && isTerminalResourceError(agentsError)) return { kind: "error", error: agentsError };
  if (!agentsQuery.isFetched || !computersQuery.isFetched) return { kind: "loading" };
  if (!agentsQuery.data) return { kind: "error", error: agentsError ?? new Error("The request failed") };
  // Only the first read is waited on, and only while the evidence reads are actually offered: a
  // failed Computer read leaves them disabled and never fetched, which would hold the page forever.
  if (evidenceOffered && [...bindings, ...handoffs].some((query) => !query.isFetched)) return { kind: "loading" };

  const computers = computersQuery.data?.computers ?? [];
  const view = {
    agents: agents.map((agent, index) => {
      const binding = bindings[index];
      const handoff = handoffs[index];
      return {
        ...agent,
        availability: projectAgentAvailability(
          agent,
          evidenceOffered ? computers.find((computer) => computer.computerId === agent.computer.computerId) : undefined,
          binding?.isSuccess ? (binding.data ?? undefined) : undefined,
          handoff?.isSuccess ? (handoff.data ?? undefined) : undefined,
          binding?.isSuccess ?? false,
          handoff?.isSuccess ?? false,
        ),
        evidenceConfirmed: true,
      };
    }),
  };
  return toResourceState({ data: view, error: agentsError, isError: agentsError !== null }, markAgentListUnconfirmed);
}

/**
 * One Agent, assembled the same way. The Agent's own read is the one that decides whether the page
 * has anything to show; the Computer, binding and handoff reads each contribute evidence and are
 * independent of one another, as they were when this was three settled promises.
 *
 * `initialAgent` is an Agent carried in history state by the link that opened this page, so a page
 * reached from one that already had it does not flash a loading state.
 */
export function useAgentDetailView(
  agentId: string,
  { watched = false, initialAgent }: { watched?: boolean; initialAgent?: AgentDetailView } = {},
): LoadState<AgentDetailView> {
  const watch = watched ? WATCHED : {};
  const agentQuery = useQuery({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => browserApi.agent(agentId),
    ...watch,
  });
  const computersQuery = useComputersQuery(watched);
  const bindingQuery = useQuery({
    queryKey: queryKeys.agents.imBinding(agentId),
    queryFn: () => readImBinding(agentId),
    ...watch,
  });
  const handoffQuery = useQuery({
    queryKey: queryKeys.agents.imBindingHandoff(agentId),
    queryFn: () => readImBindingHandoff(agentId),
    ...watch,
  });

  /*
   * Waiting on the first read of each, not on whether one is in flight now. A re-read must not put
   * the page back into loading: doing so unmounts what the page is showing, and anything below that
   * reads the same evidence would be remounted into re-reading it, which never settles.
   */
  const settling =
    !agentQuery.isFetched || !computersQuery.isFetched || !bindingQuery.isFetched || !handoffQuery.isFetched;
  const agentError = useSettledError(agentId, agentQuery);
  if (agentError && isTerminalResourceError(agentError)) {
    // A terminal primary response wins even while the evidence reads are still settling, and it
    // keeps winning while the next re-read is in flight. Route state must not keep a deleted or
    // forbidden Agent visible during either window.
    return { kind: "error", error: agentError };
  }
  if (settling) return initialAgent ? { kind: "ready", value: initialAgent } : { kind: "loading" };
  if (!agentQuery.data) {
    // Route state is only a non-terminal fallback. A deleted or forbidden Agent must never remain
    // visible just because navigation carried the last object that was rendered.
    if (initialAgent) {
      return { kind: "ready", value: markAgentDetailUnconfirmed(initialAgent) };
    }
    return { kind: "error", error: agentError ?? new Error("The request failed") };
  }

  const agent = agentQuery.data;
  const binding = bindingQuery.isSuccess ? (bindingQuery.data ?? undefined) : undefined;
  const view: AgentDetailView = {
    ...agent,
    messaging: bindingQuery.isSuccess ? { kind: "ready", value: binding } : { kind: "unconfirmed" },
    availability: projectAgentAvailability(
      agent,
      // Evidence counts only while the read that carries it is confirmed, as it does on the list. A
      // Computer the cache still holds after a failed re-read is not evidence of anything.
      computersQuery.isSuccess
        ? computersQuery.data.computers.find((computer) => computer.computerId === agent.computer.computerId)
        : undefined,
      binding,
      handoffQuery.isSuccess ? (handoffQuery.data ?? undefined) : undefined,
      bindingQuery.isSuccess,
      handoffQuery.isSuccess,
    ),
  };
  return toResourceState({ data: view, error: agentError, isError: agentError !== null }, markAgentDetailUnconfirmed);
}
