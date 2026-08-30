import type { MeResponse } from "@opentag/shared/browser";
import { createContext, useContext } from "react";

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
}

export const accountContext = createContext<AccountSession | undefined>(undefined);

export const AccountContext = accountContext.Provider;

export function useAccount(): AccountSession {
  const value = useContext(accountContext);
  if (!value) throw new Error("Account context is missing");
  return value;
}
