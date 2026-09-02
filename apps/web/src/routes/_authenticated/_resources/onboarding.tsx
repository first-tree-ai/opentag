import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { OnboardingBoundary } from "../../../features/onboarding/onboarding-boundary.js";

export const Route = createFileRoute("/_authenticated/_resources/onboarding")({
  component: OnboardingRoute,
  /**
   * The Agent this run is finishing, when something already knows it. A Slack install leaves and
   * returns through this route, so a target that arrives in the URL has to survive the trip rather
   * than being dropped on the way in; the boundary decides what the target may resolve to.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { agentId?: string; review?: "reboard"; slack_oauth?: "success"; slack_oauth_error?: string } => ({
    agentId: typeof search.agentId === "string" ? search.agentId : undefined,
    review: search.review === "reboard" ? "reboard" : undefined,
    slack_oauth: search.slack_oauth === "success" ? "success" : undefined,
    slack_oauth_error: typeof search.slack_oauth_error === "string" ? search.slack_oauth_error : undefined,
  }),
});

/**
 * Onboarding runs before the Account has entered the application, so it carries no AppShell: the
 * primary navigation would offer destinations this route sends straight back here, and a second
 * brand mark beside the one onboarding renders itself. The route stays thin — admission and the
 * exact-target decision live in the boundary.
 */
function OnboardingRoute() {
  const { agentId, review, slack_oauth, slack_oauth_error } = Route.useSearch();
  const navigate = useNavigate();
  const [callbackError] = useState(slack_oauth_error);
  useEffect(() => {
    if (!slack_oauth && !slack_oauth_error) return;
    void navigate({ replace: true, search: { agentId, review }, to: "/onboarding" });
  }, [agentId, navigate, review, slack_oauth, slack_oauth_error]);
  return <OnboardingBoundary agentId={agentId} review={review} slackOAuthError={callbackError} />;
}
