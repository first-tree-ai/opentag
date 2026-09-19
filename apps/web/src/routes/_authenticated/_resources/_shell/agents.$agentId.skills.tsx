import { createFileRoute } from "@tanstack/react-router";
import { SkillsPage } from "../../../../features/skills/skills-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/skills")({
  component: AgentSkillsRoute,
});

/**
 * The route reads the Agent id and hands it to the page as a prop, so the page never reads the
 * router and can be mounted directly in a test.
 */
function AgentSkillsRoute() {
  const { agentId } = Route.useParams();
  return <SkillsPage agentId={agentId} />;
}
