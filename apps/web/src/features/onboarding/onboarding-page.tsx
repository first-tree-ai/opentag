import { Link } from "react-router-dom";
import { useTeam } from "../../session/team-session.js";
import { EmptyState } from "../../ui/empty-state.js";
import { Page } from "../../ui/page.js";

export function OnboardingPage() {
  const { membership } = useTeam();
  return (
    <Page title="Set up OpenTag">
      {membership.role === "admin" ? (
        <>
          <ol className="steps">
            <li>Team: {membership.teamDisplayName}</li>
            <li>Connect a Local Computer</li>
            <li>Confirm the provider CLI</li>
            <li>Create an Agent</li>
            <li>Connect IM</li>
          </ol>
          <Link className="button" to="/settings/computers">
            Start with a Computer
          </Link>
        </>
      ) : (
        <EmptyState title="Team Admin setup required">
          You can browse the Team after an Admin completes setup.
        </EmptyState>
      )}
    </Page>
  );
}
