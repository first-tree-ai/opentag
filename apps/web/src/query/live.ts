/**
 * Revalidation for ordinary live resources: Agent identity and activity, Computer inventory,
 * messaging evidence, Tasks, and usage.
 *
 * `staleTime` is the reuse window for a newly mounted consumer of the same key. Interval updates
 * keep an already-visible observer current. Focus and reconnect re-read immediately, even inside
 * that window — returning to the tab is a reason to ask again, not a reason to trust the last
 * successful paint.
 *
 * Short-lived workflows (setup snapshots, connection codes, Feishu attempts) keep their own cadence
 * and only reuse the transport. Configuration, `/me`, and internal previews stay on the client
 * defaults and do not opt in here.
 */
export const LIVE_STALE_TIME_MS = 30_000;
export const LIVE_REFETCH_INTERVAL_MS = 30_000;

export const liveResourceQueryOptions = {
  staleTime: LIVE_STALE_TIME_MS,
  refetchInterval: LIVE_REFETCH_INTERVAL_MS,
  refetchOnWindowFocus: "always" as const,
  refetchOnReconnect: "always" as const,
};
