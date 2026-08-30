import type { UserProfile } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../api.js";
import { OnboardingView } from "../onboarding/view.js";
import { Button, Dialog, Text } from "../ui/design-system.js";
import { findOnboardingScenario, ONBOARDING_LAB_ACCOUNT_ID, ONBOARDING_SCENARIOS } from "./onboarding-lab-scenarios.js";

export interface OnboardingLabPageProps {
  readonly onScenarioChange: (scenarioId: string) => void;
  /** Runs after a verified reset: refresh authoritative `/me` state, then enter ordinary onboarding. */
  readonly onResetSucceeded: () => Promise<void> | void;
  readonly scenarioId: string | null;
  readonly user: UserProfile;
}

type ResetState = { readonly kind: "idle" | "pending" } | { readonly kind: "error"; readonly error: Error };

const noop = () => undefined;

/**
 * The staging-only Onboarding Lab. The page *is* the onboarding page: the same presentation, at the
 * same size, with no frame or chrome of its own, so what a reviewer judges is what production
 * renders. Everything the Lab adds — choosing a scenario and resetting the authenticated Account —
 * lives in one floating control that production never shows.
 *
 * Scenario Preview renders fixed states through the production onboarding presentation and writes
 * nothing, so it is shown to every signed-in Account; the reset action is the only Server mutation,
 * and it always targets the authenticated Account.
 */
export function OnboardingLabPage({ onResetSucceeded, onScenarioChange, scenarioId, user }: OnboardingLabPageProps) {
  const scenario = findOnboardingScenario(scenarioId);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [resetState, setResetState] = useState<ResetState>({ kind: "idle" });
  const switcherRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const resetInFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    // The confirmation Dialog renders outside the switcher and owns its own dismissal, so the
    // switcher stops listening while it is up rather than closing under it and destroying the
    // element the Dialog returns focus to.
    if (confirming) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!switcherRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [confirming, open]);

  async function reset() {
    if (resetInFlight.current) return;
    resetInFlight.current = true;
    setConfirming(false);
    setResetState({ kind: "pending" });
    try {
      await browserApi.resetAccount("reset-all");
      await onResetSucceeded();
    } catch (cause) {
      setResetState({
        kind: "error",
        error: cause instanceof Error ? cause : new Error("This Account could not be reset"),
      });
    } finally {
      resetInFlight.current = false;
    }
  }

  return (
    <>
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
        accountId={ONBOARDING_LAB_ACCOUNT_ID}
      />

      <div
        className="fixed bottom-4 right-4 z-30 w-[min(24rem,calc(100vw-2rem))]"
        data-ui="onboarding-lab-switcher"
        ref={switcherRef}
      >
        {/*
          The toggle precedes the panel it controls, so a forward Tab from it reaches the controls it
          just revealed instead of leaving the switcher and traversing the whole onboarding page. The
          panel still reads above the toggle: that is visual order, and the stylesheet owns it.
        */}
        <Button
          aria-controls="onboarding-lab-switcher-panel"
          aria-expanded={open}
          className="w-full justify-start"
          ref={toggleRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="grid text-left">
            <span className="text-xs text-kumo-subtle">Onboarding Lab</span>
            <span>{scenario.title}</span>
          </span>
        </Button>

        {open ? (
          <div
            className="mb-2 grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
            data-ui="onboarding-lab-switcher-panel"
            id="onboarding-lab-switcher-panel"
          >
            <div className="grid gap-1">
              <span className="text-xs font-medium uppercase text-kumo-subtle">Staging only</span>
              <Text as="h2" variant="heading">
                Onboarding Lab
              </Text>
              <p>
                Each scenario renders the page above from fixed facts. Preview makes no request and creates no durable
                state, so use it for screen hierarchy, copy and state communication — and the real reset for interaction
                testing.
              </p>
            </div>

            <nav aria-label="Onboarding scenarios" className="grid gap-2">
              {ONBOARDING_SCENARIOS.map((candidate) => (
                <Button
                  aria-current={candidate.id === scenario.id || undefined}
                  className="w-full justify-start"
                  key={candidate.id}
                  type="button"
                  onClick={() => onScenarioChange(candidate.id)}
                >
                  <strong>{candidate.title}</strong>
                  <span>{candidate.description}</span>
                </Button>
              ))}
            </nav>

            <div className="grid gap-2 border-t border-kumo-line pt-3">
              <Text as="h3" variant="heading">
                Real reset
              </Text>
              <p>
                Reset returns this Account to a first-run state and then enters the ordinary onboarding route. Your
                local OpenTag home and Computer identity are reused, so the next run only needs a fresh Computer connect
                command.
              </p>
              <p className="rounded-md bg-kumo-info-tint p-3 text-sm" role="status">
                <strong>This resets your own Account.</strong> It disables the Agents, Computer enrollments and
                messaging connections belonging to {user.email}, and reaches nothing of anyone else's. Another tester
                signed in as themselves is unaffected.
              </p>
              <Button
                loading={resetState.kind === "pending"}
                disabled={resetState.kind === "pending"}
                ref={resetTriggerRef}
                size="compact"
                variant="danger"
                onClick={() => setConfirming(true)}
              >
                {resetState.kind === "pending" ? "Resetting…" : "Reset my account and start onboarding"}
              </Button>
              {resetState.kind === "error" ? (
                <div className="rounded-md bg-kumo-danger-tint p-3 text-sm text-kumo-danger" role="alert">
                  <p>{resetState.error.message}</p>
                  <Button size="compact" variant="secondary" onClick={() => setConfirming(true)}>
                    Retry
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {confirming ? (
        <Dialog
          busy={resetState.kind === "pending"}
          description="This disables your current Agents, Computer enrollments and messaging connections on staging. Nobody else's Account is touched."
          eyebrow="Staging only"
          returnFocusRef={resetTriggerRef}
          title="Reset your staging Account?"
          onClose={() => setConfirming(false)}
        >
          <div className="flex flex-wrap gap-3">
            <Button loading={resetState.kind === "pending"} variant="danger" onClick={() => void reset()}>
              Reset and start onboarding
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
