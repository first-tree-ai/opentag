import { useCallback, useEffect, useRef, useState } from "react";
import { COPY } from "./copy.js";
import {
  type AgentDraft,
  type CloudComputerState,
  type CreationState,
  type Destination,
  deriveFlowState,
  emptyDraft,
  type FlowFacts,
  type MessagingProvider,
} from "./flow.js";
import { LabControls } from "./lab-controls.js";
import { type MockScenario, type MockSpeed, SCENARIOS, useMockBackend } from "./mock-backend.js";
import "./onboarding-v2.css";
import { AgentStep, CloudStep, ComputerStep, DestinationStep, DoneStep, MessagingStep, StepRail } from "./steps.js";

const CREATE_AGENT_MS = 900;
/** Allocating the cloud Computer the Agent will be created on. */
const ALLOCATE_COMPUTER_MS = 700;

/**
 * The redesigned onboarding flow, running entirely against the in-page mock. It talks to no
 * Server and reuses none of the existing onboarding surface: this exists to develop the pages and
 * tune the interactions, so the only thing it needs to be faithful to is the flow itself.
 */
export function OnboardingV2Page() {
  const [scenario, setScenario] = useState<MockScenario>(SCENARIOS[0] as MockScenario);
  const [speed, setSpeed] = useState<MockSpeed>("manual");
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const [destinationConfirmed, setDestinationConfirmed] = useState(false);
  const [draftConfirmed, setDraftConfirmed] = useState(false);
  const [cloudComputer, setCloudComputer] = useState<CloudComputerState>("idle");
  const [creation, setCreation] = useState<CreationState>("idle");
  const [messagingProvider, setMessagingProvider] = useState<MessagingProvider>();
  /**
   * Cloud is not shipped: the Server cannot allocate a cloud Computer yet, so the route is
   * Coming soon in production. The mock panel can still offer it so its pages stay reviewable.
   */
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const backend = useMockBackend(scenario, speed);

  const facts: FlowFacts = {
    draft,
    destinationConfirmed,
    draftConfirmed,
    connect: backend.connect,
    readiness: backend.readiness,
    cloudComputer,
    creation,
    planSignedIn: backend.planSignIn === "signed-in",
    messaging: backend.messaging,
  };
  const flow = deriveFlowState(facts);

  // The connect code is issued when the page that shows it is first reached, not before: an
  // unseen code would spend its validity in the background. A Computer that is already connected
  // needs none, and `issueConnectCode` only acts on an idle connection.
  useEffect(() => {
    if (flow.page === "computer") backend.issueConnectCode();
  }, [backend.issueConnectCode, flow.page]);

  // Held so a restart or an unmount can cancel a creation that is still in flight; otherwise the
  // stale timer lands on the next run and skips its confirmation step.
  const creationTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(creationTimer.current), []);

  const createAgent = useCallback(() => {
    if (creation !== "idle") return;
    setCreation("creating");
    creationTimer.current = window.setTimeout(() => setCreation("created"), CREATE_AGENT_MS);
  }, [creation]);

  /**
   * Leaving the cloud page allocates a Computer and then creates the Agent on it. A cloud Agent
   * sits on the same Computer boundary a local one does — the Server requires a `computerId`
   * either way — so the difference is who provides the machine, not whether there is one.
   */
  const submitCloud = useCallback(() => {
    if (cloudComputer !== "idle") return;
    setDraftConfirmed(true);
    setCloudComputer("allocating");
    creationTimer.current = window.setTimeout(() => {
      setCloudComputer("allocated");
      setCreation("creating");
      creationTimer.current = window.setTimeout(() => setCreation("created"), CREATE_AGENT_MS);
    }, ALLOCATE_COMPUTER_MS);
  }, [cloudComputer]);

  /**
   * Going back undoes the decision that advanced you, rather than moving a separate cursor. That
   * keeps the page a pure function of the facts. Leaving the connect step is the one place this
   * takes care: a Computer's enrollment is durable and outlives this flow, so coming back forgets
   * only that the step was left, never the machine itself.
   */
  const backToDestination = useCallback(() => setDestinationConfirmed(false), []);
  const backToAgent = useCallback(() => setDraftConfirmed(false), []);

  const startOver = useCallback(() => {
    window.clearTimeout(creationTimer.current);
    setDraft(emptyDraft());
    setDestinationConfirmed(false);
    setDraftConfirmed(false);
    setCloudComputer("idle");
    setCreation("idle");
    setMessagingProvider(undefined);
    backend.reset();
  }, [backend]);

  return (
    <div className="otv2-shell">
      <header className="otv2-shell__header">
        <span className="otv2-brand">{COPY.brand}</span>
        <button className="otv2-restart" onClick={startOver} type="button">
          Start over
        </button>
      </header>

      <main className="otv2-shell__main">
        {/*
          A rail only where there are steps. The first screen cannot know how many follow, and the
          cloud route is one page, so neither shows one.
        */}
        {flow.steps.length > 0 ? <StepRail steps={flow.steps} /> : null}
        <div className="otv2-shell__content">
          {flow.complete ? (
            <DoneStep name={draft.name} />
          ) : flow.page === "destination" ? (
            <DestinationStep
              cloudAvailable={cloudAvailable}
              draft={draft}
              onChoose={(destination: Destination) => setDraft({ ...draft, destination })}
              onSubmit={() => setDestinationConfirmed(true)}
            />
          ) : flow.page === "cloud" ? (
            <CloudStep
              creation={creation}
              draft={draft}
              onBack={backToDestination}
              onChange={setDraft}
              cloudComputer={cloudComputer}
              onSignIn={backend.startPlanSignIn}
              onSubmit={submitCloud}
              signIn={backend.planSignIn}
            />
          ) : flow.page === "agent" ? (
            <AgentStep
              draft={draft}
              onBack={backToDestination}
              onChange={setDraft}
              onSubmit={() => setDraftConfirmed(true)}
            />
          ) : flow.page === "computer" ? (
            <ComputerStep
              connect={backend.connect}
              creation={creation}
              draft={draft}
              onBack={backToAgent}
              onCreate={createAgent}
              onRefreshCommand={backend.refreshConnectCode}
              readiness={backend.readiness}
            />
          ) : (
            <MessagingStep
              messaging={backend.messaging}
              onChoose={setMessagingProvider}
              onSlackInstall={backend.startSlackInstall}
              onStart={backend.startMessaging}
              provider={messagingProvider}
              readiness={backend.readiness}
            />
          )}
        </div>
      </main>

      <LabControls
        backend={backend}
        cloudAvailable={cloudAvailable}
        onCloudAvailableChange={setCloudAvailable}
        onScenarioChange={setScenario}
        onSpeedChange={setSpeed}
        scenario={scenario}
        speed={speed}
      />
    </div>
  );
}
