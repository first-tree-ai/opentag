import { createFileRoute } from "@tanstack/react-router";
import { AgentDetailPage } from "../../../../features/agents/agent-detail-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/agents/$agentId/")({
  component: AgentDetailRoute,
});

function AgentDetailRoute() {
  const { agentId } = Route.useParams();
  return <AgentDetailPage agentId={agentId} />;
}
