import type { MeMembership, MeResponse } from "@opentag/shared/browser";
import { createContext, useContext } from "react";

export interface TeamSession {
  me: MeResponse;
  membership: MeMembership;
  refreshMe: () => void;
  selectTeam: (teamId: string) => void;
}

const teamContext = createContext<TeamSession | undefined>(undefined);

export const TeamContext = teamContext.Provider;

export function useTeam(): TeamSession {
  const value = useContext(teamContext);
  if (!value) throw new Error("Team context is missing");
  return value;
}
