import { createFileRoute } from "@tanstack/react-router";
import { ContextTreePage } from "../../../../features/agents/context-tree-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/context-tree")({
  component: AgentContextTreeRoute,
});

/**
 * The route reads the Agent id and hands it to the page as a prop, so the page never reads the
 * router and can be mounted directly in a test.
 */
function AgentContextTreeRoute() {
  const { agentId } = Route.useParams();
  return <ContextTreePage agentId={agentId} />;
}
