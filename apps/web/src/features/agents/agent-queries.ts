import type { ImBindingHandoffStatus, ImBindingSummary } from "@opentag/shared/browser";
import { useQueries, useQuery } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { toResourceState } from "../resource/query-state.js";
import type { LoadState } from "../resource/use-resource.js";
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

  if (agentsQuery.isPending || computersQuery.isPending) return { kind: "loading" };
  if (!agentsQuery.data) return { kind: "error", error: agentsQuery.error ?? new Error("The request failed") };
  // Pending only counts while the evidence reads are actually running; a failed Computer read leaves
  // them disabled and permanently pending, which would otherwise hold the page in loading forever.
  if (evidenceOffered && [...bindings, ...handoffs].some((query) => query.isPending)) return { kind: "loading" };

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
  return toResourceState(
    { data: view, error: agentsQuery.error, isError: agentsQuery.isError },
    markAgentListUnconfirmed,
  );
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

  const settling = agentQuery.isPending || computersQuery.isPending || bindingQuery.isPending || handoffQuery.isPending;
  if (settling) return initialAgent ? { kind: "ready", value: initialAgent } : { kind: "loading" };
  if (!agentQuery.data) {
    return initialAgent
      ? { kind: "ready", value: markAgentDetailUnconfirmed(initialAgent) }
      : { kind: "error", error: agentQuery.error ?? new Error("The request failed") };
  }

  const agent = agentQuery.data;
  const binding = bindingQuery.isSuccess ? (bindingQuery.data ?? undefined) : undefined;
  const view: AgentDetailView = {
    ...agent,
    messaging: bindingQuery.isSuccess ? { kind: "ready", value: binding } : { kind: "unconfirmed" },
    availability: projectAgentAvailability(
      agent,
      computersQuery.data?.computers.find((computer) => computer.computerId === agent.computer.computerId),
      binding,
      handoffQuery.isSuccess ? (handoffQuery.data ?? undefined) : undefined,
      bindingQuery.isSuccess,
      handoffQuery.isSuccess,
    ),
  };
  return toResourceState(
    { data: view, error: agentQuery.error, isError: agentQuery.isError },
    markAgentDetailUnconfirmed,
  );
}
