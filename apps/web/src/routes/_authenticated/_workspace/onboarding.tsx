import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { browserApi } from "../../../api.js";
import { Redirect } from "../../../features/navigation/redirect.js";
import { useWorkspace } from "../../../features/session/session-context.js";
import { OnboardingV2Page } from "../../../onboarding-v2/page.js";

export const Route = createFileRoute("/_authenticated/_workspace/onboarding")({
  component: OnboardingRoute,
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
  const { membership, refreshMe } = useWorkspace();
  // Held stable: the flow retries this a bounded number of times, and an identity that changed on
  // every render of this route would reopen that budget each time.
  const complete = useCallback(
    async (agentId: string) => {
      await browserApi.completeSetup(agentId);
      await refreshMe();
    },
    [refreshMe],
  );
  if (membership.setupCompletedAt) return <Redirect replace to="/agents" />;
  return <OnboardingV2Page onComplete={complete} />;
}
