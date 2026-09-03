import { createFileRoute } from "@tanstack/react-router";
import { AgentSettingsPage } from "../../../../features/agents/agent-settings/agent-settings-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/settings/")({
  component: AgentSettingsRoute,
});

function AgentSettingsRoute() {
  const { agentId } = Route.useParams();
  return <AgentSettingsPage agentId={agentId} />;
}
