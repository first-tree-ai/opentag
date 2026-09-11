import type { ListSkillsResponse, SkillSummary } from "@opentag/shared/browser";
import { type InfiniteData, type QueryClient, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { liveResourceQueryOptions } from "../../query/live.js";

/**
 * The Account's skill library, one page at a time. Pages accumulate in the cache, so a failed
 * append leaves the rows already on screen alone and stays retryable.
 */
export function useSkillListQuery() {
  return useInfiniteQuery({
    queryKey: queryKeys.skills.list(),
    queryFn: ({ pageParam }) => browserApi.skills({ cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    // The API reports the end of the list as null; the cache reads undefined as "no page after this".
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    ...liveResourceQueryOptions,
  });
}

export function flattenSkillPages(data: InfiniteData<ListSkillsResponse> | undefined): SkillSummary[] {
  return data?.pages.flatMap((page) => page.skills) ?? [];
}

/** The stored `SKILL.md` text. Read on demand — a dialog opens it — and kept while the library is fresh. */
export function useSkillMarkdownQuery(name: string) {
  return useQuery({
    queryKey: queryKeys.skills.markdown(name),
    queryFn: () => browserApi.skillMarkdown(name),
    staleTime: liveResourceQueryOptions.staleTime,
  });
}

export function useSkillAgentsQuery(name: string) {
  return useQuery({
    queryKey: queryKeys.skills.agents(name),
    queryFn: () => browserApi.skillAgents(name),
    staleTime: liveResourceQueryOptions.staleTime,
  });
}

/** One Agent's assignment set, watched like the other live Agent resources. */
export function useAgentSkillsQuery(agentId: string) {
  return useQuery({
    queryKey: queryKeys.skills.byAgent(agentId),
    queryFn: () => browserApi.agentSkills(agentId),
    ...liveResourceQueryOptions,
  });
}

/** Every skill read — the library, its `SKILL.md` texts and the per-Agent assignments — is re-read. */
export function invalidateSkills(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.skills.all() });
}

/** Drops a deleted skill from the cached library pages before the revalidation confirms it. */
export function removeSkillFromCache(queryClient: QueryClient, name: string): void {
  queryClient.setQueryData<InfiniteData<ListSkillsResponse>>(queryKeys.skills.list(), (data) =>
    data
      ? { ...data, pages: data.pages.map((page) => ({ ...page, skills: page.skills.filter((s) => s.name !== name) })) }
      : data,
  );
}
