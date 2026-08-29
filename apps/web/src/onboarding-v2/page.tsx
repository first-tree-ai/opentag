import { useCallback, useEffect, useRef, useState } from "react";
import { COPY } from "./copy.js";
import {
  type AgentDraft,
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
import { AgentStep, CheckStep, ConnectStep, DestinationStep, DoneStep, MessagingStep, StepRail } from "./steps.js";

const CREATE_AGENT_MS = 900;
/** Long enough to read "Your computer is connected." before the flow moves on by itself. */
const CONNECTED_DWELL_MS = 1_400;

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
  const [connectAcknowledged, setConnectAcknowledged] = useState(false);
  const [creation, setCreation] = useState<CreationState>("idle");
  const [messagingProvider, setMessagingProvider] = useState<MessagingProvider>();
  const backend = useMockBackend(scenario, speed);

  const facts: FlowFacts = {
    draft,
    destinationConfirmed,
    draftConfirmed,
    connect: backend.connect,
    connectAcknowledged,
    readiness: backend.readiness,
    creation,
    messaging: backend.messaging,
  };
  const flow = deriveFlowState(facts);

  // The connect code is issued when the page that shows it is first reached, not before: an
  // unseen code would spend its validity in the background.
  useEffect(() => {
    if (flow.page === "connect") backend.issueConnectCode();
  }, [backend.issueConnectCode, flow.page]);

  // The arrival is shown before the flow advances, so the user sees the outcome of the command
  // they ran rather than a screen that changes underneath them.
  const connected = backend.connect.kind === "connected";
  useEffect(() => {
    if (!connected || connectAcknowledged) return;
    const id = window.setTimeout(() => setConnectAcknowledged(true), CONNECTED_DWELL_MS);
    return () => window.clearTimeout(id);
  }, [connectAcknowledged, connected]);

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
   * Going back undoes the decision that advanced you, rather than moving a separate cursor. That
   * keeps the page a pure function of the facts, and it means Go back does what it says: leaving
   * the check step really is asking to connect a Computer again, so the code is reissued.
   */
  const backToDestination = useCallback(() => setDestinationConfirmed(false), []);
  const backToAgent = useCallback(() => setDraftConfirmed(false), []);
  const backToConnect = useCallback(() => {
    setConnectAcknowledged(false);
    backend.reset();
  }, [backend]);

  const startOver = useCallback(() => {
    window.clearTimeout(creationTimer.current);
    setDraft(emptyDraft());
    setDestinationConfirmed(false);
    setDraftConfirmed(false);
    setConnectAcknowledged(false);
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
        <StepRail steps={flow.steps} />
        <div className="otv2-shell__content">
          {flow.complete ? (
            <DoneStep name={draft.name} />
          ) : flow.page === "destination" ? (
            <DestinationStep
              draft={draft}
              onChoose={(destination: Destination) => setDraft({ ...draft, destination })}
              onSubmit={() => setDestinationConfirmed(true)}
            />
          ) : flow.page === "agent" ? (
            <AgentStep
              draft={draft}
              onBack={backToDestination}
              onChange={setDraft}
              onSubmit={() => setDraftConfirmed(true)}
            />
          ) : flow.page === "connect" ? (
            <ConnectStep
              connect={backend.connect}
              onAdvance={() => setConnectAcknowledged(true)}
              onBack={backToAgent}
              onRefreshCommand={backend.refreshConnectCode}
            />
          ) : flow.page === "check" ? (
            <CheckStep
              creation={creation}
              draft={draft}
              onBack={backToConnect}
              onCreate={createAgent}
              readiness={backend.readiness}
            />
          ) : (
            <MessagingStep
              messaging={backend.messaging}
              onChoose={setMessagingProvider}
              onStart={backend.startMessaging}
              provider={messagingProvider}
            />
          )}
        </div>
      </main>

      <LabControls
        backend={backend}
        onScenarioChange={setScenario}
        onSpeedChange={setSpeed}
        scenario={scenario}
        speed={speed}
      />
    </div>
  );
}
