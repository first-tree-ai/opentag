import { createFileRoute } from "@tanstack/react-router";
import { AgentSetupBoundary } from "../../../features/agent-setup/agent-setup-boundary.js";

export const Route = createFileRoute("/_authenticated/_resources/agents/setup")({
  component: AgentSetupRoute,
  /**
   * The Agent this run is finishing, when something already knows it. A Slack install leaves and
   * returns through this route, so a target that arrives in the URL has to survive the trip rather
   * than being dropped on the way in; the boundary decides what the target may resolve to.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { action?: "create"; agentId?: string; invalid?: true; review?: "reboard" } => {
    const action = search.action === "create" ? "create" : undefined;
    const agentId = typeof search.agentId === "string" ? search.agentId : undefined;
    const invalid =
      (search.action !== undefined && action === undefined) || (action !== undefined && agentId !== undefined)
        ? true
        : undefined;
    return { action, agentId, invalid, review: search.review === "reboard" ? "reboard" : undefined };
  },
});

/**
 * Agent Setup can run before the Account has entered the application, so it carries no AppShell: the
 * primary navigation would offer destinations this route sends straight back here, and a second
 * brand mark beside the one Agent Setup renders itself. The route stays thin — admission and the
 * exact-target decision live in the boundary.
 */
function AgentSetupRoute() {
  const { action, agentId, invalid, review } = Route.useSearch();
  return <AgentSetupBoundary action={action} agentId={agentId} invalidSearch={invalid} review={review} />;
}
