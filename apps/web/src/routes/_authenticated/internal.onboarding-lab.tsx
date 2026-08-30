import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { browserApi } from "../../api.js";
import { StandaloneNotFoundPage } from "../../features/not-found.js";
import { AsyncState, toResourceState } from "../../features/resource/resource-state.js";
import { useAccount } from "../../features/session/session-context.js";
import { OnboardingLabPage } from "../../internal/onboarding-lab-page.js";
import { queryKeys } from "../../query/keys.js";

export const Route = createFileRoute("/_authenticated/internal/onboarding-lab")({
  component: OnboardingLabRoute,
  validateSearch: (search: Record<string, unknown>): { scenario?: string } => ({
    scenario: typeof search.scenario === "string" ? search.scenario : undefined,
  }),
});

/**
 * The staging-only Onboarding Lab. A deployment outside staging is answered exactly like a page that
 * does not exist; on staging every signed-in Account may read the Scenario Preview and reset its own
 * onboarding, so reachability is the only question the Server answers here.
 */
function OnboardingLabRoute() {
  const { me, refreshMe } = useAccount();
  const navigate = useNavigate();
  const { scenario } = Route.useSearch();
  const offered = toResourceState(
    useQuery({ queryKey: queryKeys.onboardingLabOffered(), queryFn: () => browserApi.onboardingLabOffered() }),
  );
  return (
    <AsyncState state={offered}>
      {(value) =>
        value ? (
          <OnboardingLabPage
            scenarioId={scenario ?? null}
            user={me.user}
            onScenarioChange={(scenarioId) => {
              void navigate({ replace: true, search: (previous) => ({ ...previous, scenario: scenarioId }), to: "." });
            }}
            onResetSucceeded={async () => {
              // The Lab never infers success from client state: it enters onboarding only once the
              // refreshed Account actually reports incomplete setup.
              const account = await refreshMe();
              if (account.workspaces[0]?.setupCompletedAt) {
                throw new Error("The Account still reports completed setup; retry the reset.");
              }
              await navigate({ replace: true, to: "/onboarding" });
            }}
          />
        ) : (
          // The Lab renders outside AppShell, so its not-found answer must carry its own page frame.
          <StandaloneNotFoundPage />
        )
      }
    </AsyncState>
  );
}
