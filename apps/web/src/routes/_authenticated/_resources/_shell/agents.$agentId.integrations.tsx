import { createFileRoute } from "@tanstack/react-router";
import { AgentGitHubRepositories } from "../../../../features/integrations/agent-github-repositories.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/integrations")({
  component: AgentIntegrationsRoute,
});

function AgentIntegrationsRoute() {
  const { agentId } = Route.useParams();
  return <AgentGitHubRepositories agentId={agentId} />;
}
