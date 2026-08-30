import { createFileRoute } from "@tanstack/react-router";
import { LegacyAgentSectionRedirect } from "../../../../features/agents/legacy-redirects.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/agents/$agentId/$legacySection")({
  component: LegacyAgentSectionRoute,
});

function LegacyAgentSectionRoute() {
  const { agentId, legacySection } = Route.useParams();
  return <LegacyAgentSectionRedirect agentId={agentId} legacySection={legacySection} />;
}
