import { focusManager, QueryClient } from "@tanstack/react-query";

/*
 * The cache watches only `visibilitychange` on its own, which fires when a tab is switched but not
 * when the window itself regains focus — an Account that clicked away to a terminal and back would
 * see the state it left. The hook this replaced listened to both, so both are restored here.
 */
focusManager.setEventListener((handleFocus) => {
  // Called with no argument on purpose: a focus event says the Account is looking at this now, so
  // re-read. Passing `true` would instead assert a state, and the cache only reacts when that state
  // changes — so every focus after the first would be ignored.
  const onFocus = () => handleFocus();
  const onVisibilityChange = () => handleFocus(document.visibilityState === "visible");
  window.addEventListener("focus", onFocus, false);
  document.addEventListener("visibilitychange", onVisibilityChange, false);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
});

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
