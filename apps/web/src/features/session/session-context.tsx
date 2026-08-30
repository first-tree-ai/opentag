import type { MeResponse, MeWorkspace } from "@opentag/shared/browser";
import { createContext, useContext } from "react";

/**
 * Authentication proves the Account identity and nothing more. The Server says the same: an Account
 * may hold no active resource grant and still be signed in, so a page that needs only the Account
 * reads this rather than the Workspace session below.
 */
export interface AccountSession {
  me: MeResponse;
  /** Re-reads `/me` from scratch, showing the loading state again; a failure surfaces as the load error. */
  reloadMe: () => void;
  /** Resolves only once the authoritative `/me` response has been installed as current state. */
  refreshMe: () => Promise<MeResponse>;
}

export interface WorkspaceSession extends AccountSession {
  membership: MeWorkspace;
}

export const accountContext = createContext<AccountSession | undefined>(undefined);

export const AccountContext = accountContext.Provider;

export const workspaceContext = createContext<WorkspaceSession | undefined>(undefined);

export const WorkspaceContext = workspaceContext.Provider;

export function useAccount(): AccountSession {
  const value = useContext(accountContext);
  if (!value) throw new Error("Account context is missing");
  return value;
}

export function useWorkspace(): WorkspaceSession {
  const value = useContext(workspaceContext);
  if (!value) throw new Error("Workspace context is missing");
  return value;
}
