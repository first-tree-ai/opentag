import { createFileRoute } from "@tanstack/react-router";
import { AgentUsagePage } from "../../../../features/agents/agent-usage-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/agents/$agentId/usage")({
  component: AgentUsageRoute,
});

function AgentUsageRoute() {
  const { agentId } = Route.useParams();
  return <AgentUsagePage agentId={agentId} />;
}
