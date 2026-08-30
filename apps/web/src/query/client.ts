import { QueryClient } from "@tanstack/react-query";

/**
 * The cache the application reads every Server resource through.
 *
 * `retry` stays off in every environment. Nothing here has ever retried inside a single fetch:
 * recovery is explicit, driven by a revalidation interval, a focus, or a button the Account presses.
 * A silent retry would also hide the first failure of a refresh the caller is waiting on, which is
 * the failure a page has to report.
 *
 * `refetchOnWindowFocus` is off by default and opted into per call site. Only the pages that watch a
 * resource recover — the Agent list, an Agent's detail and settings, and the Computer list behind
 * Agent creation — want a focus to re-read; the rest would be asking the Server for something the
 * Account did not ask to see again.
 */
export function createQueryClient(): QueryClient {
  const isTest = import.meta.env.MODE === "test";
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Matches the hook this replaced: a resource is stale as soon as it is read, so mounting a
        // page always re-reads it, while an already-mounted observer keeps serving what it holds.
        staleTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
        // A test never simulates coming back online, so subscribing to it only invites a fetch no
        // test asked for.
        refetchOnReconnect: !isTest,
      },
    },
  });
}
