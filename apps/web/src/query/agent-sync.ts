import type { ListAgentsResponse } from "@opentag/shared/browser";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./keys.js";

/**
 * One completion path after an Agent write. Child surfaces must not also invalidate a nested key
 * they already covered: overlapping invalidations cancel the in-flight read they just started.
 */
export async function syncAgentQueries(
  queryClient: QueryClient,
  agentId: string,
  options: { readonly computers?: boolean } = {},
): Promise<void> {
  const jobs = [
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.listRoot() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.all(agentId) }),
  ];
  if (options.computers) {
    jobs.push(queryClient.invalidateQueries({ queryKey: queryKeys.computers() }));
  }
  await Promise.all(jobs);
}

/**
 * Drops a deleted Agent from cached lists without treating the remaining rows as a fresh Server
 * read. `setQueriesData` would bump `dataUpdatedAt` and let an unchanged peer overrule a newer
 * per-ID result.
 */
export function evictAgentFromLists(queryClient: QueryClient, agentId: string): void {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.agents.listRoot() })) {
    const current = query.state.data as ListAgentsResponse | undefined;
    if (!current) continue;
    queryClient.setQueryData(
      query.queryKey,
      { ...current, agents: current.agents.filter((item) => item.id !== agentId) },
      { updatedAt: query.state.dataUpdatedAt },
    );
  }
}
