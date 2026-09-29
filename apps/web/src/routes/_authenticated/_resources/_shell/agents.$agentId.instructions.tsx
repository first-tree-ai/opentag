import { createFileRoute } from "@tanstack/react-router";
import { AgentInstructionsPage } from "../../../../features/agents/agent-instructions-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/instructions")({
  component: AgentInstructionsRoute,
});

function AgentInstructionsRoute() {
  const { agentId } = Route.useParams();
  return <AgentInstructionsPage agentId={agentId} />;
}
