import { NavLink, useParams } from "react-router-dom";
import { titleCase } from "../../lib/format.js";
import { NotFoundPage } from "../../routes/fallback-pages.js";
import { useTeam } from "../../session/team-session.js";
import { EmptyState } from "../../ui/empty-state.js";
import { Page } from "../../ui/page.js";
import { ComputersSettings } from "./computers-settings.js";
import { MembersSettings } from "./members-settings.js";
import { TeamSettings } from "./team-settings.js";

const settingsSections = ["team", "computers", "resources", "members", "security"] as const;

export function SettingsPage() {
  const { section = "team" } = useParams();
  const { membership, refreshMe } = useTeam();
  if (!settingsSections.includes(section as (typeof settingsSections)[number])) return <NotFoundPage />;
  return (
    <Page title="Settings">
      <nav className="tabs" aria-label="Team settings">
        {settingsSections.map((item) => (
          <NavLink to={`/settings/${item}`} key={item}>
            {titleCase(item)}
          </NavLink>
        ))}
      </nav>
      {section === "team" ? <TeamSettings membership={membership} refreshMe={refreshMe} /> : null}
      {section === "members" ? <MembersSettings teamId={membership.teamId} /> : null}
      {section === "computers" ? (
        <ComputersSettings canManage={membership.role === "admin"} teamId={membership.teamId} />
      ) : null}
      {section === "resources" ? (
        <EmptyState title="Team Resources not enabled">No Resource records are created by this page.</EmptyState>
      ) : null}
      {section === "security" ? (
        <EmptyState title="Security overview">Sensitive credentials are never returned to the browser.</EmptyState>
      ) : null}
    </Page>
  );
}
