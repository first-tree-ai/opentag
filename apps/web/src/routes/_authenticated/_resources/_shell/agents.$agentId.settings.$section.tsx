import { createFileRoute } from "@tanstack/react-router";
import { AgentSettingsPage } from "../../../../features/agents/agent-settings/agent-settings-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/settings/$section")({
  component: AgentSettingsSectionRoute,
});

function AgentSettingsSectionRoute() {
  const { agentId, section } = Route.useParams();
  return <AgentSettingsPage agentId={agentId} section={section} />;
}
