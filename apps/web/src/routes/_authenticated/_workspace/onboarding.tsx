import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { browserApi } from "../../../api.js";
import { Redirect } from "../../../features/navigation/redirect.js";
import { useAccount } from "../../../features/session/session-context.js";
import { forgetReboardReview, isReboardReviewFor } from "../../../internal/reboard-review.js";
import { OnboardingV2Page } from "../../../onboarding-v2/page.js";

export const Route = createFileRoute("/_authenticated/_workspace/onboarding")({
  component: OnboardingRoute,
  /**
   * The Agent this run is finishing, when something already knows it. The flow does not read it
   * yet, but a Slack install leaves and returns through this route, so a target that arrives in
   * the URL has to survive the trip rather than being dropped on the way in.
   */
  validateSearch: (search: Record<string, unknown>): { agentId?: string; review?: "reboard" } => ({
    agentId: typeof search.agentId === "string" ? search.agentId : undefined,
    review: search.review === "reboard" ? "reboard" : undefined,
  }),
});

/**
 * Onboarding runs before the Account has entered the application, so it carries no AppShell: the
 * primary navigation would offer destinations this route sends straight back here, and a second
 * brand mark beside the one onboarding renders itself.
 *
 * The flow carries its own draft and its own Server access, so the route's only remaining job is
 * to mark setup complete once the flow reports it finished.
 */
function OnboardingRoute() {
  const { me, refreshMe } = useAccount();
  const { review } = Route.useSearch();
  // Held stable: the flow retries this a bounded number of times, and an identity that changed on
  // every render of this route would reopen that budget each time.
  const complete = useCallback(
    async (agentId: string) => {
      await browserApi.completeSetup(agentId);
      await refreshMe();
      forgetReboardReview();
    },
    [refreshMe],
  );
  if (me.setupCompletedAt) return <Redirect replace to="/agents" />;
  return <OnboardingV2Page onComplete={complete} reviewMode={review === "reboard" || isReboardReviewFor(me.user.id)} />;
}
