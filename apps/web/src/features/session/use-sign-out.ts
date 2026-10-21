import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { clearProfileNavigationDraft } from "../account/profile-navigation-draft.js";
import { useAccount } from "./session-context.js";

export interface SignOutState {
  signOut: () => Promise<void>;
  signingOut: boolean;
  error: string | undefined;
}

/**
 * The sign-out contract shared by every surface that can end a session: the Server confirms the
 * logout first, and only then does `afterSignOut` drop local state and leave. A failed logout leaves
 * the session untouched and reports the failure, so the Account never looks signed out while the
 * Server still holds the session.
 *
 * `afterSignOut` is the caller's because the contexts differ: the Account shell has the router and
 * the Account session, while the gate and the error pages may have neither.
 */
export function useSignOutFlow(afterSignOut: () => void | Promise<void>): SignOutState {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const after = useRef(afterSignOut);
  after.current = afterSignOut;

  const signOut = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSigningOut(true);
    setError(undefined);
    try {
      await browserApi.logout();
      clearProfileNavigationDraft();
      await after.current();
      // Stays "signing out" on success: the page is about to be replaced and must not offer a second attempt.
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : m.shell_unable_to_sign_out());
      setSigningOut(false);
      inFlight.current = false;
    }
  }, []);

  return { error, signOut, signingOut };
}

/** Sign-out for surfaces inside the Account session: end it before navigating to sign-in. */
export function useSignOut(): SignOutState {
  const { endSession } = useAccount();
  const navigate = useNavigate();
  return useSignOutFlow(() => {
    // End the Account-owned cache before login navigation so a later Account cannot see it.
    endSession();
    void navigate({ replace: true, to: "/login" });
  });
}

/**
 * Sign-out for surfaces that can render outside the Router, Query, and Account contexts, such as
 * the application error boundary. A full page load is the only way to discard state this hook
 * cannot reach, and it cannot throw while rendering.
 */
export function useContextFreeSignOut(): SignOutState {
  return useSignOutFlow(() => {
    window.location.assign("/login");
  });
}
