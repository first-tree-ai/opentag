import { useCallback, useEffect, useState } from "react";
import { COPY } from "./copy.js";
import {
  type AgentDraft,
  type CreationState,
  type Destination,
  deriveFlowState,
  emptyDraft,
  type FlowFacts,
} from "./flow.js";
import { LabControls } from "./lab-controls.js";
import { type MockScenario, type MockSpeed, SCENARIOS, useMockBackend } from "./mock-backend.js";
import "./onboarding-v2.css";
import { AgentStep, DestinationStep, DoneStep, MessagingStep, SetupStep, StepRail } from "./steps.js";

const CREATE_AGENT_MS = 900;

/**
 * The redesigned onboarding flow, running entirely against the in-page mock. It talks to no
 * Server and reuses none of the existing onboarding surface: this exists to develop the pages and
 * tune the interactions, so the only thing it needs to be faithful to is the flow itself.
 */
export function OnboardingV2Page() {
  const [scenario, setScenario] = useState<MockScenario>(SCENARIOS[0] as MockScenario);
  const [speed, setSpeed] = useState<MockSpeed>("realistic");
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const [draftConfirmed, setDraftConfirmed] = useState(false);
  const [creation, setCreation] = useState<CreationState>("idle");
  const backend = useMockBackend(scenario, speed);

  const facts: FlowFacts = {
    draft,
    draftConfirmed,
    connect: backend.connect,
    readiness: backend.readiness,
    creation,
    messaging: backend.messaging,
  };
  const flow = deriveFlowState(facts);

  // The connect code is issued when the page that shows it is first reached, not before: an
  // unseen code would spend its validity in the background.
  useEffect(() => {
    if (flow.page === "setup") backend.issueConnectCode();
  }, [backend.issueConnectCode, flow.page]);

  const createAgent = useCallback(() => {
    setCreation((current) => {
      if (current !== "idle") return current;
      window.setTimeout(() => setCreation("created"), CREATE_AGENT_MS);
      return "creating";
    });
  }, []);

  const startOver = useCallback(() => {
    setDraft(emptyDraft());
    setDraftConfirmed(false);
    setCreation("idle");
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
            <DestinationStep onChoose={(destination: Destination) => setDraft({ ...draft, destination })} />
          ) : flow.page === "agent" ? (
            <AgentStep draft={draft} onChange={setDraft} onSubmit={() => setDraftConfirmed(true)} />
          ) : flow.page === "setup" ? (
            <SetupStep
              connect={backend.connect}
              creation={creation}
              draft={draft}
              onCreate={createAgent}
              onRefreshCommand={backend.refreshConnectCode}
              readiness={backend.readiness}
            />
          ) : (
            <MessagingStep messaging={backend.messaging} onStart={backend.startMessaging} />
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
