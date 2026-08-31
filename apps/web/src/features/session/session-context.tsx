import type { MeResponse } from "@opentag/shared/browser";
import { createContext, useContext } from "react";
import * as m from "../../paraglide/messages.js";

/**
 * Authentication proves the Account identity and nothing more. Resource pages use the same Account
 * session; they no longer depend on a management Workspace membership.
 */
export interface AccountSession {
  me: MeResponse;
  /** Re-reads `/me` from scratch, showing the loading state again; a failure surfaces as the load error. */
  reloadMe: () => void;
  /** Resolves only once the authoritative `/me` response has been installed as current state. */
  refreshMe: () => Promise<MeResponse>;
  /**
   * Ends this Account's session: drops everything read under it and retires any refresh still in
   * flight, so nothing answered for this Account can reach the next one. Call it once the Server has
   * confirmed the sign-out, before navigating.
   */
  endSession: () => void;
}

export const accountContext = createContext<AccountSession | undefined>(undefined);

export const AccountContext = accountContext.Provider;

export function useAccount(): AccountSession {
  const value = useContext(accountContext);
  if (!value) throw new Error(m.common_account_context_missing());
  return value;
}
