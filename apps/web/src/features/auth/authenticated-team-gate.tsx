import type { MeMembership } from "@opentag/shared/browser";
import { useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ApiError, browserApi } from "../../api.js";
import { useResource } from "../../lib/resource.js";
import { UnavailablePage } from "../../routes/fallback-pages.js";
import { TeamContext } from "../../session/team-session.js";
import { AsyncState } from "../../ui/async-state.js";

export function AuthenticatedTeamGate() {
  const location = useLocation();
  const navigate = useNavigate();
  const [meRevision, setMeRevision] = useState(0);
  const state = useResource(() => browserApi.auth.me(), `me:${meRevision}`);
  if (state.kind === "error" && state.error instanceof ApiError && state.error.status === 401) {
    const requested = location.pathname === "/" ? "/agents" : `${location.pathname}${location.search}`;
    return <Navigate replace to={`/login?next=${encodeURIComponent(requested)}`} />;
  }
  return (
    <AsyncState state={state}>
      {(me) => {
        const stored = readTeamPreference();
        const membership = me.memberships.find((item: MeMembership) => item.teamId === stored) ?? me.memberships[0];
        if (!membership) return <UnavailablePage title="No active Team" />;
        const selectTeam = (teamId: string) => {
          if (!me.memberships.some((item: MeMembership) => item.teamId === teamId)) return;
          window.localStorage.setItem("opentag.selectedTeamId", teamId);
          navigate(location.pathname, { replace: true });
          window.location.reload();
        };
        return (
          <TeamContext value={{ me, membership, refreshMe: () => setMeRevision((value) => value + 1), selectTeam }}>
            <Outlet />
          </TeamContext>
        );
      }}
    </AsyncState>
  );
}

function readTeamPreference(): string | undefined {
  const value = window.localStorage.getItem("opentag.selectedTeamId");
  return value && value.length <= 64 ? value : undefined;
}
