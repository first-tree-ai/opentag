import type { UserProfile } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import { browserApi } from "../api.js";
import { OnboardingView } from "../onboarding/view.js";
import { Button, Dialog } from "../ui/design-system.js";
import {
  findOnboardingScenario,
  ONBOARDING_LAB_WORKSPACE_ID,
  ONBOARDING_SCENARIOS,
} from "./onboarding-lab-scenarios.js";

export interface OnboardingLabPageProps {
  readonly onScenarioChange: (scenarioId: string) => void;
  /** Whether this Account owns the Lab's destructive half; Preview is open to every signed-in Account. */
  readonly resetAvailable: boolean;
  /** Runs after a verified reset: refresh authoritative `/me` state, then enter ordinary onboarding. */
  readonly onResetSucceeded: () => Promise<void> | void;
  readonly scenarioId: string | null;
  readonly user: UserProfile;
}

type ResetState = { readonly kind: "idle" | "pending" } | { readonly kind: "error"; readonly error: Error };

const noop = () => undefined;

/**
 * The staging-only Onboarding Lab. Scenario Preview renders fixed states through the production
 * onboarding presentation and writes nothing, so it is shown to every signed-in Account; the reset
 * action is the only Server mutation, and it always targets the authenticated Account.
 */
export function OnboardingLabPage({
  onResetSucceeded,
  onScenarioChange,
  resetAvailable,
  scenarioId,
  user,
}: OnboardingLabPageProps) {
  const scenario = findOnboardingScenario(scenarioId);
  const [confirming, setConfirming] = useState(false);
  const [resetState, setResetState] = useState<ResetState>({ kind: "idle" });
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const resetInFlight = useRef(false);

  async function reset() {
    if (resetInFlight.current) return;
    resetInFlight.current = true;
    setConfirming(false);
    setResetState({ kind: "pending" });
    try {
      await browserApi.resetOnboardingLab();
      await onResetSucceeded();
    } catch (cause) {
      setResetState({
        kind: "error",
        error: cause instanceof Error ? cause : new Error("The shared staging Account could not be reset"),
      });
    } finally {
      resetInFlight.current = false;
    }
  }

  return (
    <div className="object-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Staging only</span>
          <h1>Onboarding Lab</h1>
          <p>
            {resetAvailable
              ? "Review fixed onboarding states without touching the Server, or reset the shared staging Account and run the real first-run flow end to end."
              : "Review fixed onboarding states without touching the Server. Running the real first-run flow needs the Account this deployment configures for the Lab."}
          </p>
        </div>
      </header>

      <section aria-labelledby="onboarding-lab-preview-title" className="onboarding-lab-section">
        <h2 id="onboarding-lab-preview-title">Scenario Preview</h2>
        <p>
          Each scenario renders the production onboarding page from fixed facts. Preview makes no request and creates no
          durable state, so use it for screen hierarchy, copy and state communication — and the real reset below for
          interaction testing.
        </p>
        <nav aria-label="Onboarding scenarios" className="onboarding-lab-scenarios">
          {ONBOARDING_SCENARIOS.map((candidate) => (
            <button
              aria-current={candidate.id === scenario.id || undefined}
              className="onboarding-lab-scenario"
              key={candidate.id}
              type="button"
              onClick={() => onScenarioChange(candidate.id)}
            >
              <strong>{candidate.title}</strong>
              <span>{candidate.description}</span>
            </button>
          ))}
        </nav>
        <figure aria-label={`Onboarding preview: ${scenario.title}`} className="onboarding-lab-preview">
          <OnboardingView
            completionState={{ kind: "idle" }}
            key={scenario.id}
            load={scenario.load}
            mode="preview"
            onAgentCreated={noop}
            onChooseAgent={noop}
            onCompleteSetup={noop}
            onReload={noop}
            onRetryLoad={noop}
            refreshPending={false}
            user={user}
            workspaceId={ONBOARDING_LAB_WORKSPACE_ID}
          />
        </figure>
      </section>

      {resetAvailable ? (
        <section aria-labelledby="onboarding-lab-reset-title" className="onboarding-lab-section">
          <h2 id="onboarding-lab-reset-title">Real reset</h2>
          <p>
            Reset returns this Account to a first-run state and then enters the ordinary onboarding route. Your local
            OpenTag home and Computer identity are reused, so the next run only needs a fresh Computer connect command.
          </p>
          <p className="notice" role="status">
            <strong>Shared staging test account.</strong> Every tester signs in as the same Account. Resetting it
            disables the current Agents, Computer enrollments and messaging connections, and can interrupt another
            tester who is already running onboarding.
          </p>
          <div className="actions">
            <Button
              disabled={resetState.kind === "pending"}
              ref={resetTriggerRef}
              variant="danger"
              onClick={() => setConfirming(true)}
            >
              {resetState.kind === "pending" ? "Resetting…" : "Reset shared account and start onboarding"}
            </Button>
          </div>
          {resetState.kind === "error" ? (
            <div className="notice error" role="alert">
              <p>{resetState.error.message}</p>
              <Button size="compact" variant="secondary" onClick={() => setConfirming(true)}>
                Retry
              </Button>
            </div>
          ) : null}
        </section>
      ) : (
        <section aria-labelledby="onboarding-lab-reset-title" className="onboarding-lab-section">
          <h2 id="onboarding-lab-reset-title">Real reset</h2>
          <p>
            Resetting the shared staging Account to a first-run state is limited to the one Account this deployment
            configures for the Lab. Sign in as that Account to run it; Scenario Preview above needs no such access.
          </p>
        </section>
      )}

      {resetAvailable && confirming ? (
        <Dialog
          busy={resetState.kind === "pending"}
          description="This disables the current Agents, Computer enrollments and messaging connections for the shared staging Account. Another tester using it right now will be interrupted."
          eyebrow="Staging only"
          returnFocusRef={resetTriggerRef}
          title="Reset the shared staging Account?"
          onClose={() => setConfirming(false)}
        >
          <div className="actions">
            <Button variant="danger" onClick={() => void reset()}>
              Reset and start onboarding
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
