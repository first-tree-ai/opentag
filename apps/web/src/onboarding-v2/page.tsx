import { useCallback, useEffect, useRef, useState } from "react";
import * as m from "../paraglide/messages.js";
import { Button, Loader } from "../ui/design-system.js";
import type { OnboardingBackend } from "./backend.js";
import {
  type AgentDraft,
  type CloudComputerState,
  type Destination,
  deriveFlowState,
  emptyDraft,
  type FlowFacts,
  type MessagingProvider,
} from "./flow.js";
import { LabControls } from "./lab-controls.js";
import { type MockInventory, type MockScenario, type MockSpeed, SCENARIOS, useMockBackend } from "./mock-backend.js";
import "./onboarding-v2.css";
import { useServerBackend } from "./server-backend.js";
import { AgentStep, CloudStep, ComputerStep, DestinationStep, DoneStep, MessagingStep, StepRail } from "./steps.js";

/** How many times to ask before telling the reader the Server will not mark setup complete. */
const COMPLETE_ATTEMPTS = 3;

/** Allocating the cloud Computer the Agent will be created on. */
const ALLOCATE_COMPUTER_MS = 700;

function localDraft(): AgentDraft {
  return { ...emptyDraft(), destination: "local" };
}

/**
 * The redesigned onboarding flow, against the real Server.
 *
 * The draft is held here rather than inside the flow because the backend is built from it: a
 * readiness read has to ask about the Provider the reader actually chose, and a hook cannot be
 * given that after it runs.
 */
export function OnboardingV2Page({
  onComplete,
  reviewMode = false,
}: {
  onComplete?: (agentId: string) => Promise<void> | void;
  reviewMode?: boolean;
} = {}) {
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const backend = useServerBackend(draft);

  /*
   * An Agent read back from the Server fills the draft it would have been created from, so the
   * pages behind it read as this Account's rather than as a blank form: the name the Agent
   * actually has, on the runtime it actually runs.
   */
  const resumed = backend.agent;
  useEffect(() => {
    if (!resumed) return;
    setDraft((current) =>
      current.name === resumed.name && current.runtime === resumed.runtimeProvider
        ? current
        : { ...current, destination: "local", name: resumed.name, runtime: resumed.runtimeProvider },
    );
  }, [resumed]);

  /*
   * The read has to show something. This is the only route the setup gate allows, so a read that is
   * slow would flash an empty page and one that never lands would leave one, with nothing to look
   * at and nothing to press.
   */
  /*
   * A read that failed is not "you must be new". Starting over from here ends at a name collision,
   * so the reader is told and given the read back rather than a form they cannot submit.
   */
  if (backend.resumeError) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas"
        data-ui="onboarding-v2-resume-error"
      >
        <p className="text-sm text-kumo-danger m-0" role="alert">
          {backend.resumeError}
        </p>
        <Button onClick={backend.retryResume}>{m.onboarding_v2_nav_retry()}</Button>
      </div>
    );
  }

  if (backend.resuming) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas"
        data-ui="onboarding-v2-loading"
      >
        <Loader />
        <p className="text-sm text-kumo-subtle m-0" role="status">
          {m.onboarding_v2_loading()}
        </p>
      </div>
    );
  }

  return (
    <OnboardingV2Flow
      backend={backend}
      cloudAvailable={false}
      draft={draft}
      onComplete={onComplete}
      onDraftChange={setDraft}
      reviewMode={reviewMode}
    />
  );
}

/**
 * The same flow against the in-page mock, for developing and reviewing the pages without a Server.
 * It is a separate entry point rather than a mode of the one above, because a page that could
 * choose its backend at runtime would have to hold both, and the real one issues Server state.
 */
export function OnboardingV2MockPage() {
  const [scenario, setScenario] = useState<MockScenario>(SCENARIOS[0] as MockScenario);
  const [speed, setSpeed] = useState<MockSpeed>("manual");
  /** What the Account already owns. Orthogonal to the check outcome, so the lab picks it apart. */
  const [inventory, setInventory] = useState<MockInventory>("none");
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  /**
   * Cloud is not shipped: the Server cannot allocate a cloud Computer yet, so the route is
   * Coming soon in production. The panel can still offer it so its pages stay reviewable.
   */
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const backend = useMockBackend(scenario, speed, inventory);

  return (
    <OnboardingV2Flow
      backend={backend}
      cloudAvailable={cloudAvailable}
      draft={draft}
      lab={
        <LabControls
          backend={backend}
          cloudAvailable={cloudAvailable}
          inventory={inventory}
          onCloudAvailableChange={setCloudAvailable}
          onInventoryChange={setInventory}
          onScenarioChange={setScenario}
          onSpeedChange={setSpeed}
          scenario={scenario}
          speed={speed}
        />
      }
      onDraftChange={setDraft}
    />
  );
}

function OnboardingV2Flow({
  backend,
  cloudAvailable,
  draft,
  destinationPreselected = false,
  lab,
  onComplete,
  onDraftChange,
  reviewMode = false,
}: {
  backend: OnboardingBackend;
  cloudAvailable: boolean;
  draft: AgentDraft;
  /** Production currently supports only local Agents, so it begins at the Agent step. */
  destinationPreselected?: boolean;
  lab?: React.ReactNode;
  /** Told when the flow has actually finished, so setup can be marked complete. */
  onComplete?: (agentId: string) => Promise<void> | void;
  onDraftChange: (draft: AgentDraft) => void;
  /** A staging Re-board stays inspectable until the tester explicitly finishes the review. */
  reviewMode?: boolean;
}) {
  const [destinationConfirmed, setDestinationConfirmed] = useState(destinationPreselected);
  const [draftConfirmed, setDraftConfirmed] = useState(false);
  /*
   * The confirmations exist so a page is left deliberately rather than the moment its fields
   * happen to be valid. An Agent that already exists settles both of them: the decisions they
   * guard were made on a previous visit and cannot be taken back.
   */
  const resumed = backend.agent !== undefined;
  const [cloudComputer, setCloudComputer] = useState<CloudComputerState>("idle");
  const [messagingProvider, setMessagingProvider] = useState<MessagingProvider>();

  /*
   * The Computer this Account has, if it has one. An Account has a single machine, so this is a
   * fact about the Account rather than a choice the reader makes: the step names it, checks it, and
   * repairs it. The backend picks a reachable one first for Accounts that predate that rule and
   * still hold more than one.
   */
  const accountComputer = backend.knownComputers?.find((candidate) => candidate.id === backend.selectedComputerId);

  const facts: FlowFacts = {
    draft,
    destinationConfirmed: destinationConfirmed || destinationPreselected || resumed,
    draftConfirmed: draftConfirmed || resumed,
    selectedComputerId: backend.selectedComputerId,
    readiness: backend.readiness,
    cloudComputer,
    creation: backend.creation,
    planSignedIn: backend.planSignIn === "signed-in",
    messaging: backend.messaging,
  };
  const flow = deriveFlowState(facts);

  useEffect(() => {
    if (flow.page === "messaging" || flow.complete) backend.markPastComputerStep();
  }, [backend.markPastComputerStep, flow.complete, flow.page]);

  /*
   * Setup is completed from the finished flow. Reporting it from the render that first sees
   * `complete` — rather than from the button that connected the messaging app — keeps it true for
   * both routes and for a reader who arrives already finished. Only one attempt runs at a time;
   * failures get a small bounded retry budget before the reader is offered an explicit retry.
   */
  const reported = useRef<string | undefined>(undefined);
  const [completionAttempt, setCompletionAttempt] = useState(0);
  const [completionFailed, setCompletionFailed] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const retryCompletion = useCallback(() => {
    setCompletionAttempt(0);
    setCompletionFailed(false);
  }, []);
  useEffect(() => {
    const agentId = backend.agent?.id;
    if (
      !flow.complete ||
      !agentId ||
      reported.current === agentId ||
      completionFailed ||
      (reviewMode && !reviewConfirmed)
    )
      return;
    // Claimed before the call so a re-render cannot send it twice, and released if it fails.
    // Holding the claim through a refusal would leave the Account permanently un-onboarded: the
    // gate keeps sending them back here, and this is the only page that can let them out.
    reported.current = agentId;
    let live = true;
    void Promise.resolve(onComplete?.(agentId)).catch(() => {
      if (!live) return;
      reported.current = undefined;
      // Asking again immediately rather than on a timer: a timer scheduled from here is a
      // background retry nobody is watching, and this runs while the reader is looking at the
      // finished screen. Bounded, because a Server that refuses three times is not going to be
      // talked round, and at that point saying so beats retrying silently forever.
      if (completionAttempt + 1 < COMPLETE_ATTEMPTS) setCompletionAttempt(completionAttempt + 1);
      else setCompletionFailed(true);
    });
    return () => {
      live = false;
    };
  }, [backend.agent?.id, completionAttempt, completionFailed, flow.complete, onComplete, reviewConfirmed, reviewMode]);

  // Held so a restart or an unmount can cancel an allocation still in flight; otherwise the stale
  // timer lands on the next run and skips its confirmation step.
  const cloudTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(cloudTimer.current), []);

  /**
   * Leaving the cloud page allocates a Computer and then creates the Agent on it. A cloud Agent
   * sits on the same Computer boundary a local one does — the Server requires a `computerId`
   * either way — so the difference is who provides the machine, not whether there is one.
   */
  const submitCloud = useCallback(() => {
    if (cloudComputer !== "idle") return;
    setDraftConfirmed(true);
    setCloudComputer("allocating");
    cloudTimer.current = window.setTimeout(() => {
      setCloudComputer("allocated");
      backend.createAgent(draft);
    }, ALLOCATE_COMPUTER_MS);
  }, [backend, cloudComputer, draft]);

  /**
   * Going back undoes the decision that advanced you, rather than moving a separate cursor. That
   * keeps the page a pure function of the facts. Leaving the connect step is the one place this
   * takes care: a Computer's enrollment is durable and outlives this flow, so coming back forgets
   * only that the step was left, never the machine itself.
   */
  const backToDestination = useCallback(() => setDestinationConfirmed(false), []);
  const backToAgent = useCallback(() => setDraftConfirmed(false), []);

  const startOver = useCallback(() => {
    window.clearTimeout(cloudTimer.current);
    onDraftChange(destinationPreselected ? localDraft() : emptyDraft());
    setDestinationConfirmed(destinationPreselected);
    setDraftConfirmed(false);
    setCloudComputer("idle");
    setMessagingProvider(undefined);
    backend.reset();
  }, [backend, destinationPreselected, onDraftChange]);

  return (
    <div className={`otv2-shell flex min-h-screen flex-col bg-kumo-canvas ${lab ? "pb-20 sm:pb-0" : ""}`}>
      <header className="flex items-center justify-between p-6">
        <span className="text-lg font-semibold text-kumo-strong">{m.onboarding_v2_brand_name()}</span>
        {reviewMode ? null : (
          <Button onClick={startOver} variant="ghost">
            {m.onboarding_v2_start_over()}
          </Button>
        )}
      </header>

      <main className="otv2-frame flex flex-1 flex-col items-center gap-6 mx-auto p-6">
        {/*
          A rail only where there are steps. The first screen cannot know how many follow, and the
          cloud route is one page, so neither shows one.
        */}
        {flow.steps.length > 0 ? <StepRail steps={flow.steps} /> : null}
        <div className="w-full">
          {/*
            Whatever last failed against the Server, above the step rather than inside it: it is
            about the page's ability to make progress, not about the field being filled in.
          */}
          {backend.error || completionFailed ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-kumo-base p-4 ring ring-kumo-line"
              data-ui="onboarding-v2-error"
              role="alert"
            >
              <p className="text-sm text-kumo-danger m-0">{backend.error ?? m.onboarding_v2_error_complete_setup()}</p>
            </div>
          ) : null}
          {flow.complete ? (
            <DoneStep
              completion={
                completionFailed
                  ? { onFinish: retryCompletion, state: "failed" }
                  : reviewMode
                    ? { onFinish: () => setReviewConfirmed(true), state: reviewConfirmed ? "pending" : "ready" }
                    : undefined
              }
              name={backend.agent?.name ?? draft.name}
              provider={messagingProvider ?? backend.messagingProvider}
            />
          ) : flow.page === "destination" ? (
            <DestinationStep
              cloudAvailable={cloudAvailable}
              draft={draft}
              onChoose={(destination: Destination) => onDraftChange({ ...draft, destination })}
              onSubmit={() => setDestinationConfirmed(true)}
            />
          ) : flow.page === "cloud" ? (
            <CloudStep
              cloudComputer={cloudComputer}
              creation={backend.creation}
              draft={draft}
              onBack={resumed || destinationPreselected ? undefined : backToDestination}
              onChange={onDraftChange}
              onSignIn={backend.startPlanSignIn}
              onSubmit={submitCloud}
              signIn={backend.planSignIn}
            />
          ) : flow.page === "agent" ? (
            <AgentStep
              draft={draft}
              onBack={resumed ? undefined : backToDestination}
              onChange={onDraftChange}
              onSubmit={() => setDraftConfirmed(true)}
            />
          ) : flow.page === "computer" ? (
            <ComputerStep
              adapter={backend.computerConnectAdapter}
              computer={accountComputer}
              creation={backend.creation}
              draft={draft}
              onBack={resumed ? undefined : backToAgent}
              onComputerConnected={backend.computerConnected}
              onCreate={() => backend.createAgent(draft)}
              readiness={backend.readiness}
            />
          ) : (
            <MessagingStep
              computerOnline={backend.computerOnline}
              messaging={backend.messaging}
              onChoose={setMessagingProvider}
              onSlackInstall={backend.startSlackInstall}
              onStart={backend.startMessaging}
              provider={messagingProvider ?? backend.messagingProvider}
              readiness={backend.readiness}
            />
          )}
        </div>
      </main>

      {lab}
    </div>
  );
}
