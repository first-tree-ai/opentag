import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { Redirect } from "../features/navigation/redirect.js";
import { AsyncState, toResourceState } from "../features/resource/resource-state.js";
import { AccountContext } from "../features/session/session-context.js";
import { queryKeys } from "../query/keys.js";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedAccountGate,
});

/**
 * Resolves the authenticated Account and publishes it. Resource pages use this Account session; they
 * no longer depend on a management Workspace membership.
 *
 * The Account is read while rendering rather than in `beforeLoad` because the application has no
 * request cache: a loader would re-request /me on every navigation.
 */
function AuthenticatedAccountGate() {
  const router = useRouter();
  /**
   * The page the visitor originally asked for, captured once. The router keeps this gate mounted
   * while the redirect to sign-in is in flight, so re-reading the live location would fold the
   * sign-in URL into its own `next` parameter on every render.
   */
  const [requested] = useState(() => {
    const { pathname, searchStr } = router.state.location;
    return pathname === "/" ? "/agents" : `${pathname}${searchStr}`;
  });
  const queryClient = useQueryClient();
  const state = toResourceState(useQuery({ queryKey: queryKeys.me(), queryFn: () => browserApi.me() }));
  /**
   * Installs the authoritative response before resolving, so a caller that navigates on the result
   * cannot have a gate re-evaluate the state this refresh was meant to replace.
   *
   * The read is made directly and only its success is written, rather than going through the cache's
   * own fetch. A failure here belongs to the caller that asked for the refresh — it is reported to
   * them and handled where they stand. Letting the cache record it would instead surface it on this
   * gate, replacing the whole signed-in surface with an error over a refresh the Account never saw.
   */
  const refreshMe = useCallback(async () => {
    const next = await browserApi.me();
    queryClient.setQueryData(queryKeys.me(), next);
    return next;
  }, [queryClient]);
  if (state.kind === "error" && state.error instanceof ApiError && state.error.status === 401) {
    return <Redirect replace search={{ next: requested }} to="/login" />;
  }
  return (
    <AsyncState state={state}>
      {(loaded) => (
        <AccountContext
          value={{
            me: loaded,
            refreshMe,
            // Resetting rather than invalidating, because this one is documented to show the loading
            // state again: invalidating would keep the Account on screen while it re-reads.
            reloadMe: () => void queryClient.resetQueries({ queryKey: queryKeys.me() }),
          }}
        >
          <Outlet />
        </AccountContext>
      )}
    </AsyncState>
  );
}
