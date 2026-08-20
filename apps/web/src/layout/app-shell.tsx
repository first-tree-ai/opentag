import type { MeMembership } from "@opentag/shared/browser";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useTeam } from "../features/auth/team-session.js";

export function AppShell() {
  const { me, membership, selectTeam } = useTeam();
  return (
    <div className="shell">
      <aside aria-label="Primary navigation">
        <Link className="brand" to="/agents">
          OpenTag
        </Link>
        <label className="team-picker">
          <span>Team</span>
          <select value={membership.teamId} onChange={(event) => selectTeam(event.currentTarget.value)}>
            {me.memberships.map((item: MeMembership) => (
              <option value={item.teamId} key={item.teamId}>
                {item.teamDisplayName}
              </option>
            ))}
          </select>
        </label>
        <nav>
          <NavLink to="/agents">Agents</NavLink>
          <NavLink to="/settings/team">Settings</NavLink>
        </nav>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <span>{membership.role === "admin" ? "Team Admin" : "Member · read only"}</span>
          <span>{me.user.displayName}</span>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
