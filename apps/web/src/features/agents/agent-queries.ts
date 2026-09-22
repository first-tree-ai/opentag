import type {
  AccountComputerSummary,
  AgentDetail,
  AgentListItem as AgentListApiItem,
  ImBindingHandoffStatus,
  ImBindingSummary,
} from "@opentag/shared/browser";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { LIVE_REFETCH_INTERVAL_MS, liveResourceQueryOptions } from "../../query/live.js";
import {
  observedAfter,
  type ResourceObservation,
  refusalOutranks,
  resourceSuccessObservation,
  type TerminalResourceObservation,
  terminalResourceObservation,
} from "../../query/session-cache.js";
import type { LoadState } from "../resource/resource-state.js";
import {
  isConfirmedQuerySuccess,
  isTerminalResourceError,
  toResourceState,
  usePersistedSettledError,
} from "../resource/resource-state.js";
import type { AgentCloudRuntimeEvidence, AgentDetailView, AgentListItem } from "./agent-model.js";
import {
  agentDetailFromListItem,
  isHandoffChecking,
  markAgentDetailUnconfirmed,
  markAgentListUnconfirmed,
  projectAgentAvailability,
} from "./agent-model.js";

export function readAgentList() {
  return browserApi.agents();
}

export function readAgent(agentId: string) {
  return browserApi.agent(agentId);
}

export function readComputers() {
  return browserApi.computers();
}

/** Logical online identity alone cannot establish Cloud execution readiness. */
function useCloudRuntimeEvidence(enabled: boolean, watched: boolean): AgentCloudRuntimeEvidence {
  const query = useQuery({
    queryKey: queryKeys.cloudAvailability(),
    queryFn: () => browserApi.cloudAvailability(),
    enabled,
    ...(watched ? liveResourceQueryOptions : { staleTime: liveResourceQueryOptions.staleTime }),
  });
  return enabled && isConfirmedQuerySuccess(query) && query.data
    ? { kind: "ready", value: query.data }
    : { kind: "unconfirmed" };
}

/*
 * These two endpoints answer 204 for an Agent that has none, which the API layer resolves as
 * `undefined`. A query may not resolve `undefined` — it is how the cache says "nothing read yet" —
 * so absence becomes `null` here, at the only place that has to know the difference.
 */
export const readImBinding = (agentId: string): Promise<ImBindingSummary | null> =>
  browserApi.imBinding(agentId).then((binding) => binding ?? null);

export const readImBindingHandoff = (agentId: string): Promise<ImBindingHandoffStatus | null> =>
  browserApi.imBindingHandoff(agentId).then((handoff) => handoff ?? null);

/**
 * How often a handoff still being verified is re-read, and for how long that cadence is kept.
 *
 * The Server re-verifies delivery on demand: the read that finds the evidence expired answers "not
 * ready, checking" and only then asks the Computer, which reports back within seconds. At the
 * shared 30-second cadence the page would keep saying "checking" long after that, so a check in
 * progress is re-read at the same beat Agent setup uses. The window bounds the cost of a Computer
 * that never answers: after it the query returns to the shared cadence, still saying "checking",
 * and leaves the verdict to the Server's own retry budget. Each read costs the Server one
 * requirements lookup per Agent (its refresh work is coalesced), so the window is the number to
 * revisit if the cadence or the Agent count ever grows.
 */
export const HANDOFF_CHECKING_REFETCH_INTERVAL_MS = 2_000;
export const HANDOFF_CHECKING_POLL_WINDOW_MS = 90_000;
const HANDOFF_CHECKING_POLL_BUDGET = HANDOFF_CHECKING_POLL_WINDOW_MS / HANDOFF_CHECKING_REFETCH_INTERVAL_MS;

/**
 * The window is spent in checking answers, not in wall-clock time. A hidden tab neither polls nor
 * spends it, so a viewer who comes back minutes later -- the very case the fast cadence exists for
 * -- still has whatever budget the check had left. Keyed by the query itself, so the budget belongs
 * to that cache entry and goes with it.
 */
const handoffCheckingAnswers = new WeakMap<object, { answers: number; dataUpdatedAt: number }>();

/** The refetch interval for one handoff query, chosen from its latest answer. */
export function handoffRefetchInterval(query: {
  state: { data: ImBindingHandoffStatus | null | undefined; dataUpdatedAt: number };
}): number {
  if (!isHandoffChecking(query.state.data)) {
    handoffCheckingAnswers.delete(query);
    return LIVE_REFETCH_INTERVAL_MS;
  }
  const budget = handoffCheckingAnswers.get(query) ?? { answers: 0, dataUpdatedAt: Number.NaN };
  // The interval is recomputed on every render and state change; only a new answer spends budget.
  if (query.state.dataUpdatedAt !== budget.dataUpdatedAt) {
    budget.answers += 1;
    budget.dataUpdatedAt = query.state.dataUpdatedAt;
  }
  handoffCheckingAnswers.set(query, budget);
  return budget.answers <= HANDOFF_CHECKING_POLL_BUDGET
    ? HANDOFF_CHECKING_REFETCH_INTERVAL_MS
    : LIVE_REFETCH_INTERVAL_MS;
}

const handoffQueryOptions = { ...liveResourceQueryOptions, refetchInterval: handoffRefetchInterval };

/** The Account's Computers. One cache entry, so every surface that needs them shares one read. */
export function useComputersQuery(
  watched = false,
  enabled = true,
  options: { refetchOnMount?: boolean | "always" } = {},
) {
  return useQuery({
    queryKey: queryKeys.computers(),
    queryFn: readComputers,
    enabled,
    ...(watched ? liveResourceQueryOptions : { staleTime: liveResourceQueryOptions.staleTime }),
    ...(options.refetchOnMount !== undefined ? { refetchOnMount: options.refetchOnMount } : {}),
  });
}

export function useAgentListQuery(accountId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.agents.list(accountId),
    queryFn: readAgentList,
    enabled: enabled && accountId.length > 0,
    ...liveResourceQueryOptions,
  });
}

/**
 * Cached identity and avatar only. The switcher must not subscribe to Computer, binding or handoff evidence for
 * every Agent — those reads belong to surfaces that actually display availability.
 */
export function useAgentIdentityList(
  accountId: string,
): LoadState<{ agents: readonly { id: string; displayName: string; avatarUrl?: string | null }[] }> {
  const agentsQuery = useAgentListQuery(accountId);
  const agentsError = usePersistedSettledError(queryKeys.agents.list(accountId), agentsQuery);
  if (agentsError && isTerminalResourceError(agentsError)) return { kind: "error", error: agentsError };
  if (!agentsQuery.isFetched) return { kind: "loading" };
  if (!agentsQuery.data) return { kind: "error", error: agentsError ?? new Error("The request failed") };
  return toResourceState(
    { data: { agents: agentsQuery.data.agents }, error: agentsError, isError: agentsError !== null },
    (value) => value,
  );
}

export function useImBindingQuery(agentId: string, watched = true) {
  return useQuery({
    queryKey: queryKeys.agents.imBinding(agentId),
    queryFn: () => readImBinding(agentId),
    ...(watched ? liveResourceQueryOptions : { staleTime: liveResourceQueryOptions.staleTime }),
  });
}

export function useImBindingHandoffQuery(agentId: string, watched = true) {
  return useQuery({
    queryKey: queryKeys.agents.imBindingHandoff(agentId),
    queryFn: () => readImBindingHandoff(agentId),
    ...(watched ? handoffQueryOptions : { staleTime: liveResourceQueryOptions.staleTime }),
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
  const agentsQuery = useAgentListQuery(accountId);
  const computersQuery = useComputersQuery(true);
  const agents = agentsQuery.data?.agents ?? [];
  const evidenceOffered = isConfirmedQuerySuccess(computersQuery);
  const cloudRuntime = useCloudRuntimeEvidence(
    evidenceOffered &&
      agents.some((agent) =>
        computersQuery.data?.computers.some(
          (computer) => computer.computerId === agent.computer?.computerId && computer.kind === "cloud",
        ),
      ),
    true,
  );
  const bindings = useQueries({
    queries: agents.map((agent) => ({
      queryKey: queryKeys.agents.imBinding(agent.id),
      queryFn: () => readImBinding(agent.id),
      enabled: evidenceOffered,
      ...liveResourceQueryOptions,
    })),
  });
  const handoffs = useQueries({
    queries: agents.map((agent) => ({
      queryKey: queryKeys.agents.imBindingHandoff(agent.id),
      queryFn: () => readImBindingHandoff(agent.id),
      enabled: evidenceOffered,
      ...handoffQueryOptions,
    })),
  });

  const agentsError = usePersistedSettledError(queryKeys.agents.list(accountId), agentsQuery);

  // A terminal response is an answer about the list itself, so it outranks the reads still settling
  // beside it as well as any rows the cache still holds.
  if (agentsError && isTerminalResourceError(agentsError)) return { kind: "error", error: agentsError };
  if (!agentsQuery.isFetched || !computersQuery.isFetched) return { kind: "loading" };
  if (!agentsQuery.data) return { kind: "error", error: agentsError ?? new Error("The request failed") };
  // Only the first read is waited on, and only while the evidence reads are actually offered: a
  // failed Computer read leaves them disabled and never fetched, which would hold the page forever.
  if (evidenceOffered && [...bindings, ...handoffs].some((query) => !query.isFetched)) return { kind: "loading" };

  const computers = evidenceOffered ? (computersQuery.data?.computers ?? []) : [];
  const view = {
    agents: agents.map((agent, index) => {
      const binding = bindings[index];
      const handoff = handoffs[index];
      const bindingConfirmed = Boolean(binding && isConfirmedQuerySuccess(binding));
      const handoffConfirmed = Boolean(handoff && isConfirmedQuerySuccess(handoff));
      return {
        ...agent,
        availability: projectAgentAvailability(
          agent,
          evidenceOffered
            ? computers.find((computer) => computer.computerId === agent.computer?.computerId)
            : undefined,
          bindingConfirmed ? (binding?.data ?? undefined) : undefined,
          handoffConfirmed ? (handoff?.data ?? undefined) : undefined,
          bindingConfirmed,
          handoffConfirmed,
          cloudRuntime,
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
 * When `accountId` is provided, a successful list row for this Agent is reused instead of repeating
 * GET /agents/:id. A list failure is not an answer about this Agent: per-ID confirmation stays
 * available, and a later list error cannot un-read a successful per-ID recovery.
 *
 * `initialAgent` is an Agent carried in history state by the link that opened this page, so a page
 * reached from one that already had it does not flash a loading state.
 */
export function useAgentDetailView(
  agentId: string,
  {
    watched = false,
    initialAgent,
    accountId,
  }: { watched?: boolean; initialAgent?: AgentDetailView; accountId?: string } = {},
): LoadState<AgentDetailView> {
  const queryClient = useQueryClient();
  const watch = watched ? liveResourceQueryOptions : { staleTime: liveResourceQueryOptions.staleTime };
  const listQuery = useAgentListQuery(accountId ?? "", Boolean(accountId));
  const listed = listQuery.data?.agents.find((agent) => agent.id === agentId);
  const detailKey = queryKeys.agents.detail(agentId);
  /*
   * Observation order — never the wall clock — arbitrates between the shared list row and the
   * per-Agent read: two answers that settle in the same millisecond, or under a clock that moved
   * backwards, still order by which the cache observed later.
   */
  const listSuccess = resourceSuccessObservation(queryClient, queryKeys.agents.list(accountId ?? ""));
  const detailSuccess = resourceSuccessObservation(queryClient, detailKey);
  const detailRefusal = terminalResourceObservation(queryClient, detailKey);
  const listedUsable = Boolean(
    listed &&
      isConfirmedQuerySuccess(listQuery) &&
      !refusalOutranks(detailRefusal, listSuccess) &&
      !observedAfter(detailSuccess, listSuccess),
  );
  const listSettled = !accountId || listQuery.isFetched;
  const agentQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => readAgent(agentId),
    enabled: listSettled && !listedUsable,
    ...watch,
  });
  const computersQuery = useComputersQuery(watched);
  const bindingQuery = useImBindingQuery(agentId, watched);
  const handoffQuery = useImBindingHandoffQuery(agentId, watched);
  const projectedAgent = listedUsable ? listed : agentQuery.data;
  const cloudRuntime = useCloudRuntimeEvidence(
    isConfirmedQuerySuccess(computersQuery) &&
      computersQuery.data?.computers.some(
        (computer) => computer.computerId === projectedAgent?.computer?.computerId && computer.kind === "cloud",
      ) === true,
    watched,
  );
  const listError = usePersistedSettledError(queryKeys.agents.list(accountId ?? ""), listQuery);
  const detailError = usePersistedSettledError(detailKey, agentQuery);

  /*
   * Waiting on the first read of each, not on whether one is in flight now. A re-read must not put
   * the page back into loading: doing so unmounts what the page is showing, and anything below that
   * reads the same evidence would be remounted into re-reading it, which never settles.
   */
  const evidenceSettling = !computersQuery.isFetched || !bindingQuery.isFetched || !handoffQuery.isFetched;
  const bindingConfirmed = isConfirmedQuerySuccess(bindingQuery);
  const handoffConfirmed = isConfirmedQuerySuccess(handoffQuery);
  const computersConfirmed = isConfirmedQuerySuccess(computersQuery);
  return presentAgentDetailView({
    agentData: agentQuery.data,
    agentFetched: agentQuery.isFetched,
    binding: bindingConfirmed ? (bindingQuery.data ?? undefined) : undefined,
    bindingConfirmed,
    computers: computersConfirmed ? computersQuery.data?.computers : undefined,
    computersConfirmed,
    cloudRuntime,
    detailError,
    detailRefusal,
    detailSuccess,
    evidenceSettling,
    handoff: handoffConfirmed ? (handoffQuery.data ?? undefined) : undefined,
    handoffConfirmed,
    initialAgent,
    listError,
    listSettled,
    listSuccess,
    listed,
    listedUsable,
  });
}

function detailDisplayError(
  listedUsable: boolean,
  listError: Error | null,
  detailError: Error | null,
  listed: AgentListApiItem | undefined,
): Error | null {
  if (listedUsable) return listError && !isTerminalResourceError(listError) ? listError : null;
  if (detailError) return detailError;
  return listed && listError && !isTerminalResourceError(listError) ? listError : null;
}

function isNewerDetailRefusal(
  detailError: Error | null,
  detailRefusal: TerminalResourceObservation | undefined,
  listSuccess: ResourceObservation | undefined,
  detailSuccess: ResourceObservation | undefined,
): detailError is Error {
  return Boolean(
    detailError &&
      isTerminalResourceError(detailError) &&
      refusalOutranks(detailRefusal, listSuccess) &&
      refusalOutranks(detailRefusal, detailSuccess),
  );
}

function resolveAgentProjection(
  listedUsable: boolean,
  listed: AgentListApiItem | undefined,
  agentData: AgentDetail | undefined,
): AgentDetail | undefined {
  if (listedUsable && listed) return agentDetailFromListItem(listed);
  return agentData ?? (listed ? agentDetailFromListItem(listed) : undefined);
}

function assembleAgentDetailView(
  agent: AgentDetail,
  computersConfirmed: boolean,
  computers: readonly AccountComputerSummary[] | undefined,
  bindingConfirmed: boolean,
  binding: ImBindingSummary | undefined,
  handoffConfirmed: boolean,
  handoff: ImBindingHandoffStatus | undefined,
  cloudRuntime: AgentCloudRuntimeEvidence,
): AgentDetailView {
  const computer = computersConfirmed
    ? computers?.find((entry) => entry.computerId === agent.computer?.computerId)
    : undefined;
  return {
    ...agent,
    ...(computer?.kind === undefined ? {} : { computerKind: computer.kind }),
    ...(computer ? { computerConnectionStatus: computer.connectionStatus } : {}),
    messaging: bindingConfirmed ? { kind: "ready", value: binding } : { kind: "unconfirmed" },
    availability: projectAgentAvailability(
      agent,
      computer,
      binding,
      handoff,
      bindingConfirmed,
      handoffConfirmed,
      cloudRuntime,
    ),
  };
}

function presentAgentDetailView({
  agentData,
  agentFetched,
  binding,
  bindingConfirmed,
  computers,
  computersConfirmed,
  cloudRuntime,
  detailError,
  detailRefusal,
  detailSuccess,
  evidenceSettling,
  handoff,
  handoffConfirmed,
  initialAgent,
  listError,
  listSettled,
  listSuccess,
  listed,
  listedUsable,
}: {
  agentData?: AgentDetail;
  agentFetched: boolean;
  binding?: ImBindingSummary;
  bindingConfirmed: boolean;
  computers?: readonly AccountComputerSummary[];
  computersConfirmed: boolean;
  cloudRuntime: AgentCloudRuntimeEvidence;
  detailError: Error | null;
  detailRefusal?: TerminalResourceObservation;
  detailSuccess?: ResourceObservation;
  evidenceSettling: boolean;
  handoff?: ImBindingHandoffStatus;
  handoffConfirmed: boolean;
  initialAgent?: AgentDetailView;
  listError: Error | null;
  listSettled: boolean;
  listSuccess?: ResourceObservation;
  listed?: AgentListApiItem;
  listedUsable: boolean;
}): LoadState<AgentDetailView> {
  if (isNewerDetailRefusal(detailError, detailRefusal, listSuccess, detailSuccess)) {
    return { kind: "error", error: detailError };
  }
  if (!listSettled || evidenceSettling || (!listedUsable && !agentFetched && !listed)) {
    return initialAgent ? { kind: "ready", value: initialAgent } : { kind: "loading" };
  }
  const agent = resolveAgentProjection(listedUsable, listed, agentData);
  if (!agent) {
    if (initialAgent) return { kind: "ready", value: markAgentDetailUnconfirmed(initialAgent) };
    return { kind: "error", error: detailError ?? new Error("The request failed") };
  }
  const displayError = detailDisplayError(listedUsable, listError, detailError, listed);
  return toResourceState(
    {
      data: assembleAgentDetailView(
        agent,
        computersConfirmed,
        computers,
        bindingConfirmed,
        binding,
        handoffConfirmed,
        handoff,
        cloudRuntime,
      ),
      error: displayError,
      isError: displayError !== null,
    },
    markAgentDetailUnconfirmed,
  );
}
