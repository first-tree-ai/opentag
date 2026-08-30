import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { browserApi } from "../../../api.js";
import { Redirect } from "../../../features/navigation/redirect.js";
import { useAccount } from "../../../features/session/session-context.js";
import { OnboardingPage } from "../../../onboarding/page.js";

export const Route = createFileRoute("/_authenticated/_workspace/onboarding")({
  component: OnboardingRoute,
  validateSearch: (search: Record<string, unknown>): { agentId?: string } => ({
    agentId: typeof search.agentId === "string" ? search.agentId : undefined,
  }),
});

/**
 * Onboarding runs before the Account has entered the application, so it carries no AppShell: the
 * primary navigation would offer destinations this route sends straight back here, and a second
 * brand mark beside the one onboarding renders itself.
 */
function OnboardingRoute() {
  const { me, refreshMe } = useAccount();
  const navigate = useNavigate();
  const { agentId: targetAgentId } = Route.useSearch();
  if (me.setupCompletedAt) return <Redirect replace to="/agents" />;
  return (
    <OnboardingPage
      targetAgentId={targetAgentId}
      user={me.user}
      onSetupReady={async (agentId) => {
        await browserApi.completeSetup(agentId);
        await refreshMe();
      }}
      onTargetAgentChange={(agentId) => {
        void navigate({ replace: true, search: (previous) => ({ ...previous, agentId }), to: "." });
      }}
    />
  );
}
