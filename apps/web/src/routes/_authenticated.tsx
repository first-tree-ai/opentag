import type { MeResponse } from "@opentag/shared/browser";
import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { Redirect } from "../features/navigation/redirect.js";
import { AsyncState, useResource } from "../features/resource/use-resource.js";
import { AccountContext } from "../features/session/session-context.js";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedAccountGate,
});

/**
 * Resolves the authenticated Account and publishes it. Workspace authority is a separate question,
 * asked below only by the routes that act on stored resources.
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
  const [meRevision, setMeRevision] = useState(0);
  const [refreshed, setRefreshed] = useState<{ revision: number; me: MeResponse }>();
  const state = useResource(() => browserApi.me(), `me:${meRevision}`);
  /**
   * Installs the authoritative response before resolving, so a caller that navigates on the result
   * cannot have a gate re-evaluate the state this refresh was meant to replace.
   */
  const refreshMe = useCallback(async () => {
    const next = await browserApi.me();
    setRefreshed({ revision: meRevision, me: next });
    return next;
  }, [meRevision]);
  if (state.kind === "error" && state.error instanceof ApiError && state.error.status === 401) {
    return <Redirect replace search={{ next: requested }} to="/login" />;
  }
  return (
    <AsyncState state={state}>
      {(loaded) => (
        <AccountContext
          value={{
            me: refreshed?.revision === meRevision ? refreshed.me : loaded,
            refreshMe,
            reloadMe: () => setMeRevision((value) => value + 1),
          }}
        >
          <Outlet />
        </AccountContext>
      )}
    </AsyncState>
  );
}
