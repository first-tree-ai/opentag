import { createFileRoute, redirect } from "@tanstack/react-router";
import { agentInstructionsLink } from "../../../../features/agents/agent-routes.js";
import { AgentSettingsPage } from "../../../../features/agents/agent-settings/agent-settings-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/settings/$section")({
  beforeLoad: ({ params }) => {
    if (params.section === "instructions") throw redirect({ ...agentInstructionsLink(params.agentId), replace: true });
  },
  component: AgentSettingsSectionRoute,
});

function AgentSettingsSectionRoute() {
  const { agentId, section } = Route.useParams();
  return <AgentSettingsPage agentId={agentId} section={section} />;
}
