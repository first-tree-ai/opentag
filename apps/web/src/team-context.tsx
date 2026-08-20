import type { MeMembership, MeResponse } from "@opentag/shared/browser";
import { createContext, useContext } from "react";

export interface TeamSession {
  me: MeResponse;
  /**
   * Undefined only while a signed-in user has no Team yet. Onboarding is the one
   * page that renders in that state; every Team-scoped page is behind a redirect.
   */
  membership: MeMembership | undefined;
  refreshMe: () => void;
  selectTeam: (teamId: string) => void;
}

export interface ActiveTeamSession extends TeamSession {
  membership: MeMembership;
}

const teamContext = createContext<TeamSession | undefined>(undefined);
export const TeamContext = teamContext.Provider;

/** For Team-scoped pages, which never render without an active membership. */
export function useTeam(): ActiveTeamSession {
  const session = useTeamSession();
  if (!session.membership) throw new Error("An active Team membership is required");
  return session as ActiveTeamSession;
}

/** For onboarding, which must also render for a user who has no Team yet. */
export function useTeamSession(): TeamSession {
  const value = useContext(teamContext);
  if (!value) throw new Error("Team context is missing");
  return value;
}

export const SELECTED_TEAM_STORAGE_KEY = "opentag.selectedTeamId";

export function readTeamPreference(): string | undefined {
  const value = window.localStorage.getItem(SELECTED_TEAM_STORAGE_KEY);
  return value && value.length <= 64 ? value : undefined;
}
