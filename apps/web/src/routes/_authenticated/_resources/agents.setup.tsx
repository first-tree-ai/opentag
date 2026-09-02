import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
  ): {
    action?: "create";
    agentId?: string;
    invalid?: true;
    slack_oauth?: "success";
    slack_oauth_error?: string;
  } => {
    const action = search.action === "create" ? "create" : undefined;
    const agentId = typeof search.agentId === "string" ? search.agentId : undefined;
    // TanStack can revalidate this normalized output; retain the marker after a non-string id is removed.
    const invalid =
      search.invalid === true ||
      (search.action !== undefined && action === undefined) ||
      (search.agentId !== undefined && agentId === undefined) ||
      (action !== undefined && agentId !== undefined)
        ? true
        : undefined;
    return {
      action,
      agentId,
      invalid,
      slack_oauth: search.slack_oauth === "success" ? "success" : undefined,
      slack_oauth_error: typeof search.slack_oauth_error === "string" ? search.slack_oauth_error : undefined,
    };
  },
});

/**
 * Agent Setup can run before the Account has entered the application, so it carries no AppShell: the
 * primary navigation would offer destinations this route sends straight back here, and a second
 * brand mark beside the one Agent Setup renders itself. The route stays thin — admission and the
 * exact-target decision live in the boundary.
 */
function AgentSetupRoute() {
  const { action, agentId, invalid, slack_oauth, slack_oauth_error } = Route.useSearch();
  const navigate = useNavigate();
  const [callbackError] = useState(slack_oauth_error);
  useEffect(() => {
    if (!slack_oauth && !slack_oauth_error) return;
    void navigate({ replace: true, search: { agentId }, to: "/agents/setup" });
  }, [agentId, navigate, slack_oauth, slack_oauth_error]);
  return (
    <AgentSetupBoundary action={action} agentId={agentId} invalidSearch={invalid} slackOAuthError={callbackError} />
  );
}
