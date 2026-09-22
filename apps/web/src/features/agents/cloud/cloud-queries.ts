import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { browserApi } from "../../../api.js";
import { queryKeys } from "../../../query/keys.js";
import { liveResourceQueryOptions } from "../../../query/live.js";
import { useComputersQuery } from "../agent-queries.js";

export const CLOUD_OVERVIEW_PAGE_LIMIT = 20;

/** Visible polling also discovers work arriving from IM after the last environment went idle. */
export function useAgentCloudOverview(agentId: string, options: { sessionId?: string; enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: options.sessionId
      ? queryKeys.agents.cloudOverviewSession(agentId, options.sessionId)
      : queryKeys.agents.cloudOverview(agentId),
    queryFn: ({ pageParam }) =>
      browserApi.agentCloudOverview(agentId, {
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: CLOUD_OVERVIEW_PAGE_LIMIT,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
    ...liveResourceQueryOptions,
  });
}

/** Preserve a previously read bound identity during refresh failure; a missing row is unknown. */
export function useAgentComputerKind(agentId: string): "cloud" | "local" | undefined {
  const agentQuery = useQuery({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => browserApi.agent(agentId),
    staleTime: liveResourceQueryOptions.staleTime,
  });
  const computersQuery = useComputersQuery();
  if (!agentQuery.data || !computersQuery.data) return undefined;
  const computerId = agentQuery.data?.computer?.computerId;
  if (!computerId) return undefined;
  const computer = computersQuery.data.computers.find((entry) => entry.computerId === computerId);
  return computer ? (computer.kind ?? "local") : undefined;
}
