import { useNavigate, useSearchParams } from "react-router-dom";
import { browserApi } from "../../api.js";
import { OnboardingLabPage } from "../../internal/onboarding-lab-page.js";
import { OnboardingPage } from "../../onboarding/page.js";
import { StandaloneNotFoundPage } from "../not-found.js";
import { AsyncState, useResource } from "../resource/use-resource.js";
import { useAccount, useWorkspace } from "../session/session-context.js";

export function OnboardingRoute() {
  const { me, refreshMe } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const targetAgentId = searchParams.get("agentId") ?? undefined;
  return (
    <OnboardingPage
      targetAgentId={targetAgentId}
      user={me.user}
      onSetupReady={async (agentId) => {
        await browserApi.completeSetup(agentId);
        await refreshMe();
      }}
      onTargetAgentChange={(agentId) => {
        const next = new URLSearchParams(searchParams);
        next.set("agentId", agentId);
        setSearchParams(next, { replace: true });
      }}
    />
  );
}

/**
 * The staging-only Onboarding Lab. A deployment outside staging is answered exactly like a page that
 * does not exist; on staging every signed-in Account may read the Scenario Preview and reset its own
 * onboarding, so reachability is the only question the Server answers here.
 */
export function OnboardingLabRoute() {
  const { me, refreshMe } = useAccount();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const offered = useResource(() => browserApi.onboardingLabOffered(), "onboarding-lab");
  return (
    <AsyncState state={offered}>
      {(value) =>
        value ? (
          <OnboardingLabPage
            scenarioId={searchParams.get("scenario")}
            user={me.user}
            onScenarioChange={(scenarioId) => {
              const next = new URLSearchParams(searchParams);
              next.set("scenario", scenarioId);
              setSearchParams(next, { replace: true });
            }}
            onResetSucceeded={async () => {
              // The Lab never infers success from client state: it enters onboarding only once the
              // refreshed Account actually reports incomplete setup.
              const account = await refreshMe();
              if (account.workspaces[0]?.setupCompletedAt) {
                throw new Error("The Account still reports completed setup; retry the reset.");
              }
              navigate("/onboarding", { replace: true });
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
