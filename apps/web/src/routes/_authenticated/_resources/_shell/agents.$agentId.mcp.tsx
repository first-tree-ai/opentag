import { createFileRoute } from "@tanstack/react-router";
import { McpPage } from "../../../../features/mcp/mcp-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/mcp")({
  component: AgentMcpRoute,
});

/**
 * The route reads the Agent id and hands it to the page as a prop, so the page never reads the
 * router and can be mounted directly in a test.
 */
function AgentMcpRoute() {
  const { agentId } = Route.useParams();
  return <McpPage agentId={agentId} />;
}
