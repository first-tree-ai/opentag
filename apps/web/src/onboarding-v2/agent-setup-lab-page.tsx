import type { AgentRuntimeProvider, ImProvider } from "@opentag/shared/browser";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CreationIntentRequest } from "../agent-creation/creation-intent-store.js";
import * as m from "../paraglide/messages.js";
import { Button, KumoSelectControl, Loader, Text } from "../ui/design-system.js";
import { AgentSetupLabControls } from "./agent-setup-lab-controls.js";
import {
  automaticEventDelay,
  failPendingLabEvent,
  LAB_ACCOUNT_ID,
  LAB_AGENT_ID,
  type LabAutomation,
  type LabInventory,
  type LabJourney,
  type LabObservationFailure,
  type LabPendingEvent,
  type LabScenario,
  labScenarioDefaults,
  labScenarioStartsWithCreation,
  labSeed,
  pendingLabEvent,
  runPendingLabEvent,
} from "./agent-setup-lab-model.js";
import { AgentSetupSurface } from "./page.js";
import {
  isReadinessScenario,
  PREVIEW_RUNTIMES,
  type PreviewRuntime,
  READINESS_SCENARIO_LABELS,
  type ReadinessScenario,
  readinessRowsForScenario,
  runtimeLabelFor,
} from "./readiness-lab-fixtures.js";
import { ReadinessList } from "./readiness-list.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

type LabPhase = "creation" | "admission" | "setup";
type LabNavigationTarget = "agent" | "agents";
type LabScenarioOption = LabScenario | ReadinessScenario;
type LabMemory = ReturnType<typeof createMemorySetupAdapter>;

interface LabConfiguration {
  readonly automation: LabAutomation;
  readonly failure: LabObservationFailure;
  readonly inventory: LabInventory;
  readonly journey: LabJourney;
  readonly messagingProvider: ImProvider;
  readonly revision: number;
  readonly runtime: AgentRuntimeProvider;
  readonly scenario: LabScenarioOption;
}

function initialConfiguration(): LabConfiguration {
  const scenario = "full-new-computer";
  return {
    ...labScenarioDefaults(scenario),
    automation: "manual",
    failure: "none",
    journey: "first",
    revision: 0,
    scenario,
  };
}

function initialPhase(scenario: LabScenarioOption): LabPhase {
  return !isReadinessScenario(scenario) && labScenarioStartsWithCreation(scenario) ? "creation" : "setup";
}

function phaseLabel(phase: LabPhase, memory: LabMemory): string {
  if (phase === "creation") return m.onboarding_v2_lab_status_agent_creation();
  if (phase === "admission") return m.onboarding_v2_lab_status_account_admission();
  const { stage } = memory.inspect().snapshot;
  if (stage === "needs-computer") return m.onboarding_v2_lab_status_computer();
  if (stage === "needs-runtime") return m.onboarding_v2_lab_status_runtime();
  if (stage === "needs-messaging") return m.onboarding_v2_lab_status_messaging();
  return m.onboarding_v2_lab_status_ready();
}

function productionScenarioFor(scenario: LabScenarioOption): LabScenario {
  return isReadinessScenario(scenario) ? "full-new-computer" : scenario;
}

function pendingEventFor(
  readinessScenario: ReadinessScenario | undefined,
  phase: LabPhase,
  memory: LabMemory,
): LabPendingEvent | undefined {
  if (readinessScenario) return undefined;
  if (phase === "admission") return "complete-admission";
  return phase === "setup" ? pendingLabEvent(memory) : undefined;
}

function resetConfiguration(current: LabConfiguration): LabConfiguration {
  if (isReadinessScenario(current.scenario)) {
    return { ...current, failure: "none", revision: current.revision + 1 };
  }
  return {
    ...current,
    ...labScenarioDefaults(current.scenario),
    failure: "none",
    revision: current.revision + 1,
  };
}

function configurationForScenario(current: LabConfiguration, scenario: LabScenarioOption): LabConfiguration {
  if (isReadinessScenario(scenario)) {
    return { ...current, failure: "none", revision: current.revision + 1, scenario };
  }
  return {
    ...current,
    ...labScenarioDefaults(scenario),
    failure: "none",
    revision: current.revision + 1,
    scenario,
  };
}

/** The production New Agent surface and focused readiness fixtures over a controllable in-memory world. */
export function AgentSetupLabPage() {
  const [configuration, setConfiguration] = useState<LabConfiguration>(initialConfiguration);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [navigationTarget, setNavigationTarget] = useState<LabNavigationTarget>();
  const [phase, setPhase] = useState<LabPhase>(() => initialPhase(configuration.scenario));
  const [previewRuntime, setPreviewRuntime] = useState<PreviewRuntime>("codex");
  const productionScenario = productionScenarioFor(configuration.scenario);
  const memory = useMemo(() => {
    // Reset increments the revision precisely to discard the current in-memory world.
    void configuration.revision;
    return createMemorySetupAdapter(
      labSeed(productionScenario, configuration.inventory, configuration.runtime, configuration.messagingProvider),
    );
  }, [
    configuration.inventory,
    configuration.messagingProvider,
    configuration.revision,
    configuration.runtime,
    productionScenario,
  ]);
  const version = useSyncExternalStore(memory.subscribe, memory.getVersion, memory.getVersion);
  const readinessScenario = isReadinessScenario(configuration.scenario) ? configuration.scenario : undefined;
  const pending = pendingEventFor(readinessScenario, phase, memory);
  const status = readinessScenario ? READINESS_SCENARIO_LABELS[readinessScenario] : phaseLabel(phase, memory);

  const reset = useCallback(() => {
    setConfiguration(resetConfiguration);
    setPreviewRuntime("codex");
    setNavigationTarget(undefined);
    setPhase(initialPhase(configuration.scenario));
  }, [configuration.scenario]);

  const changeScenario = useCallback((scenario: LabScenarioOption) => {
    setConfiguration((current) => configurationForScenario(current, scenario));
    setNavigationTarget(undefined);
    setPhase(initialPhase(scenario));
  }, []);

  const changeJourney = useCallback(
    (journey: LabJourney) => {
      setConfiguration((current) => ({ ...current, journey, revision: current.revision + 1 }));
      setNavigationTarget(undefined);
      setPhase(initialPhase(configuration.scenario));
    },
    [configuration.scenario],
  );

  const createPreviewAgent = useCallback(
    async (request: CreationIntentRequest) => {
      setConfiguration((current) => ({ ...current, runtime: request.runtimeProvider }));
      setPhase(configuration.journey === "first" ? "admission" : "setup");
      return { id: LAB_AGENT_ID };
    },
    [configuration.journey],
  );

  const runPending = useCallback(() => {
    if (phase === "admission") {
      setPhase("setup");
      return;
    }
    runPendingLabEvent(memory);
  }, [memory, phase]);

  useEffect(() => {
    memory.controls.setObservationFailure(configuration.failure === "none" ? undefined : configuration.failure);
  }, [configuration.failure, memory]);

  useEffect(() => {
    if (configuration.automation === "manual" || !pending) return;
    const timer = window.setTimeout(runPending, automaticEventDelay(pending));
    return () => window.clearTimeout(timer);
  }, [configuration.automation, pending, runPending]);

  return (
    <div
      className={`relative min-h-screen pb-20 sm:pb-0 ${controlsOpen ? "lg:pr-[27rem]" : ""}`}
      data-ui="onboarding-v2-lab-page"
    >
      <LabPreview
        configuration={configuration}
        createPreviewAgent={createPreviewAgent}
        memory={memory}
        navigationTarget={navigationTarget}
        onNavigationTargetChange={setNavigationTarget}
        onPreviewRuntimeChange={setPreviewRuntime}
        phase={phase}
        previewRuntime={previewRuntime}
        productionScenario={productionScenario}
        readinessScenario={readinessScenario}
        version={version}
      />
      <AgentSetupLabControls
        automation={configuration.automation}
        failure={configuration.failure}
        inventory={configuration.inventory}
        journey={configuration.journey}
        memory={memory}
        messagingProvider={configuration.messagingProvider}
        onAutomationChange={(automation) => setConfiguration((current) => ({ ...current, automation }))}
        onFailPending={() => failPendingLabEvent(memory)}
        onFailureChange={(failure) => setConfiguration((current) => ({ ...current, failure }))}
        onInventoryChange={(inventory) =>
          setConfiguration((current) => ({ ...current, inventory, revision: current.revision + 1 }))
        }
        onJourneyChange={changeJourney}
        onMessagingProviderChange={(messagingProvider) =>
          setConfiguration((current) => ({ ...current, messagingProvider, revision: current.revision + 1 }))
        }
        onOpenChange={setControlsOpen}
        onReset={reset}
        onRunPending={runPending}
        onRuntimeChange={(runtime) =>
          setConfiguration((current) => ({ ...current, runtime, revision: current.revision + 1 }))
        }
        onScenarioChange={changeScenario}
        pending={pending}
        runtime={configuration.runtime}
        scenario={configuration.scenario}
        status={status}
      />
    </div>
  );
}

function LabPreview({
  configuration,
  createPreviewAgent,
  memory,
  navigationTarget,
  onNavigationTargetChange,
  onPreviewRuntimeChange,
  phase,
  previewRuntime,
  productionScenario,
  readinessScenario,
  version,
}: {
  readonly configuration: LabConfiguration;
  readonly createPreviewAgent: (request: CreationIntentRequest) => Promise<{ id: string }>;
  readonly memory: LabMemory;
  readonly navigationTarget: LabNavigationTarget | undefined;
  readonly onNavigationTargetChange: (target: LabNavigationTarget | undefined) => void;
  readonly onPreviewRuntimeChange: (runtime: PreviewRuntime) => void;
  readonly phase: LabPhase;
  readonly previewRuntime: PreviewRuntime;
  readonly productionScenario: LabScenario;
  readonly readinessScenario: ReadinessScenario | undefined;
  readonly version: number;
}) {
  if (readinessScenario) {
    return (
      <ReadinessLabView
        onRuntimeChange={onPreviewRuntimeChange}
        runtime={previewRuntime}
        scenario={readinessScenario}
      />
    );
  }
  if (navigationTarget) {
    return <LabNavigationPreview target={navigationTarget} onReturn={() => onNavigationTargetChange(undefined)} />;
  }
  if (phase === "creation") {
    return (
      <AgentSetupSurface
        accountId={LAB_ACCOUNT_ID}
        creationPreview={createPreviewAgent}
        key={`creation:${configuration.revision}:${configuration.journey}`}
        onAgentAvailable={() => undefined}
        onBackToAgents={configuration.journey === "additional" ? () => onNavigationTargetChange("agents") : undefined}
      />
    );
  }
  if (phase === "admission") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas"
        data-ui="agent-setup-target-adopting"
      >
        <Loader />
        <p className="text-sm text-kumo-subtle m-0" role="status">
          {m.agent_setup_target_adopting()}
        </p>
      </div>
    );
  }
  return (
    <AgentSetupSurface
      agentId={LAB_AGENT_ID}
      computerAdapter={memory.computerAdapter}
      key={`setup:${configuration.revision}:${productionScenario}:${configuration.inventory}:${configuration.runtime}:${configuration.messagingProvider}`}
      onExternalNavigation={() => undefined}
      onOpenAgent={() => onNavigationTargetChange("agent")}
      refreshSignal={version}
      setupAdapter={memory.adapter}
    />
  );
}

function ReadinessLabView({
  onRuntimeChange,
  runtime,
  scenario,
}: {
  readonly onRuntimeChange: (runtime: PreviewRuntime) => void;
  readonly runtime: PreviewRuntime;
  readonly scenario: ReadinessScenario;
}) {
  const rows = readinessRowsForScenario(scenario, runtime);
  return (
    <div className="otv2-readiness-lab min-h-screen bg-kumo-canvas" data-ui="readiness-lab">
      <div className="otv2-readiness-lab__inner">
        <Text as="h1" size="lg" variant="heading">
          Readiness checklist
        </Text>
        <p className="m-0 text-sm text-kumo-subtle">Static review fixtures only — no live checks.</p>
        <div className="otv2-readiness-lab__controls">
          <label className="otv2-readiness-lab__label" htmlFor="readiness-lab-runtime">
            Preview Runtime
          </label>
          <KumoSelectControl
            className="otv2-readiness-lab__select"
            id="readiness-lab-runtime"
            onChange={(event) => onRuntimeChange(event.target.value as PreviewRuntime)}
            value={runtime}
          >
            {PREVIEW_RUNTIMES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {runtimeLabelFor(candidate, scenario)}
              </option>
            ))}
          </KumoSelectControl>
        </div>
        <ReadinessList label="Readiness results" rows={rows} />
      </div>
    </div>
  );
}

function LabNavigationPreview({
  onReturn,
  target,
}: {
  readonly onReturn: () => void;
  readonly target: LabNavigationTarget;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-kumo-canvas p-6" data-ui="lab-navigation-preview">
      <div className="grid max-w-lg justify-items-start gap-3 rounded-xl bg-kumo-base p-6 ring ring-kumo-line">
        <Text as="p" size="sm" variant="secondary">
          {m.onboarding_v2_lab_navigation_checkpoint()}
        </Text>
        <Text as="h1" size="lg" variant="heading">
          {target === "agents" ? m.onboarding_v2_back_to_agents() : m.onboarding_v2_open_agent()}
        </Text>
        <Text as="p" variant="secondary">
          {target === "agents"
            ? m.onboarding_v2_lab_navigation_agents_description()
            : m.onboarding_v2_lab_navigation_agent_description()}
        </Text>
        <Button onClick={onReturn} variant="secondary">
          {m.onboarding_v2_lab_navigation_return()}
        </Button>
      </div>
    </div>
  );
}
