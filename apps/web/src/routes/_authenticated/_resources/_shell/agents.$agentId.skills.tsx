import { createFileRoute } from "@tanstack/react-router";
import { AgentSkillsPage } from "../../../../features/agents/agent-detail-capabilities.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/skills")({
  component: AgentSkillsRoute,
});

function AgentSkillsRoute() {
  const { agentId } = Route.useParams();
  return <AgentSkillsPage agentId={agentId} />;
}
