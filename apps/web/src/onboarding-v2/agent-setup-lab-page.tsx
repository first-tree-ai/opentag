import type { AgentRuntimeProvider, AgentSetupSnapshot, ImProvider } from "@opentag/shared/browser";
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
  type LabPreviewPage,
  type LabScenario,
  labPreviewPageFor,
  labScenarioDefaults,
  labScenarioStartsWithCreation,
  labSeed,
  pendingLabEvent,
  runPendingLabEvent,
} from "./agent-setup-lab-model.js";
import { AgentSetupSurface, type CreationPreviewView } from "./page.js";
import {
  isReadinessScenario,
  PREVIEW_RUNTIMES,
  type PreviewRuntime,
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
type LabCustomization = "computer" | "failure" | "inventory" | "messaging-provider" | "runtime";

interface LabConfiguration {
  readonly automation: LabAutomation;
  readonly failure: LabObservationFailure;
  readonly inventory: LabInventory;
  readonly journey: LabJourney;
  readonly messagingProvider: ImProvider;
  readonly revision: number;
  readonly runtime: AgentRuntimeProvider;
  readonly runtimeBaseline: AgentRuntimeProvider;
  readonly scenario: LabScenarioOption;
}

function initialConfiguration(): LabConfiguration {
  const scenario = "full-new-computer";
  const defaults = labScenarioDefaults(scenario);
  return {
    ...defaults,
    automation: "manual",
    failure: "none",
    journey: "first",
    revision: 0,
    runtimeBaseline: defaults.runtime,
    scenario,
  };
}

function initialPhase(scenario: LabScenarioOption): LabPhase {
  return !isReadinessScenario(scenario) && labScenarioStartsWithCreation(scenario) ? "creation" : "setup";
}

function initialCreationView(scenario: LabScenarioOption): CreationPreviewView {
  return !isReadinessScenario(scenario) && labPreviewPageFor(scenario) === "agent" ? "agent" : "destination";
}

function computerScenario(snapshot: AgentSetupSnapshot): LabScenario {
  if (snapshot.computer.kind === "requires-rebind") return "computer-rebind";
  if (snapshot.computer.kind === "bound" && snapshot.computer.connectionStatus === "offline") {
    return "computer-reconnect";
  }
  return "computer-connection";
}

function runtimeScenario(snapshot: AgentSetupSnapshot, configuredScenario: LabScenario): LabScenario {
  if (snapshot.runtime.kind === "waiting") return "runtime-waiting";
  if (snapshot.runtime.kind !== "observed") {
    return labPreviewPageFor(configuredScenario) === "checks" ? configuredScenario : "runtime-setup";
  }
  if (snapshot.runtime.status === "checking") return "runtime-checking";
  if (snapshot.runtime.status === "sign-in") return "runtime-sign-in";
  return "runtime-setup";
}

function messagingScenario(snapshot: AgentSetupSnapshot): LabScenario {
  if (snapshot.messaging.kind === "waiting-handoff") return "messaging-handoff";
  if (snapshot.messaging.kind === "blocked") return "messaging-recovery";
  return "messaging-setup";
}

function scenarioForSetupSnapshot(snapshot: AgentSetupSnapshot, configuredScenario: LabScenario): LabScenario {
  if (snapshot.stage === "needs-computer") return computerScenario(snapshot);
  if (snapshot.stage === "needs-runtime") return runtimeScenario(snapshot, configuredScenario);
  if (snapshot.stage === "needs-provider-clis") return "messaging-support-setup";
  if (snapshot.stage === "needs-messaging") return messagingScenario(snapshot);
  return "everything-ready";
}

interface ActiveLabSelection {
  readonly page: LabPreviewPage | undefined;
  readonly scenario: LabScenarioOption;
}

function activeLabSelection({
  creationView,
  phase,
  productionScenario,
  readinessScenario,
  snapshot,
}: {
  readonly creationView: CreationPreviewView;
  readonly phase: LabPhase;
  readonly productionScenario: LabScenario;
  readonly readinessScenario: ReadinessScenario | undefined;
  readonly snapshot: AgentSetupSnapshot;
}): ActiveLabSelection {
  if (readinessScenario) return { page: undefined, scenario: readinessScenario };
  if (phase === "admission") return { page: "agent", scenario: "agent-creation" };
  if (phase === "setup") {
    const scenario = scenarioForSetupSnapshot(snapshot, productionScenario);
    return { page: labPreviewPageFor(scenario), scenario };
  }
  if (creationView === "agent") return { page: "agent", scenario: "agent-creation" };
  const scenario = labPreviewPageFor(productionScenario) === "destination" ? productionScenario : "full-new-computer";
  return { page: "destination", scenario };
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
  const defaults = labScenarioDefaults(current.scenario);
  return {
    ...current,
    ...defaults,
    failure: "none",
    revision: current.revision + 1,
    runtimeBaseline: defaults.runtime,
  };
}

function configurationForScenario(current: LabConfiguration, scenario: LabScenarioOption): LabConfiguration {
  if (isReadinessScenario(scenario)) {
    return { ...current, failure: "none", revision: current.revision + 1, scenario };
  }
  const defaults = labScenarioDefaults(scenario);
  return {
    ...current,
    ...defaults,
    failure: "none",
    revision: current.revision + 1,
    runtimeBaseline: defaults.runtime,
    scenario,
  };
}

function updateCustomizations(
  current: readonly LabCustomization[],
  customization: LabCustomization,
  active: boolean,
): readonly LabCustomization[] {
  if (active) return current.includes(customization) ? current : [...current, customization];
  return current.filter((candidate) => candidate !== customization);
}

function updateAfterMemoryRebuild(
  current: readonly LabCustomization[],
  customization: LabCustomization,
  active: boolean,
): readonly LabCustomization[] {
  return updateCustomizations(updateCustomizations(current, "computer", false), customization, active);
}

/** The production New Agent surface and focused readiness fixtures over a controllable in-memory world. */
export function AgentSetupLabPage() {
  const [configuration, setConfiguration] = useState<LabConfiguration>(initialConfiguration);
  const [customizations, setCustomizations] = useState<readonly LabCustomization[]>([]);
  const [creationView, setCreationView] = useState<CreationPreviewView>("destination");
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
  const active = activeLabSelection({
    creationView,
    phase,
    productionScenario,
    readinessScenario,
    snapshot: memory.inspect().snapshot,
  });

  const reset = useCallback(() => {
    setConfiguration(resetConfiguration);
    setCustomizations([]);
    setPreviewRuntime("codex");
    setNavigationTarget(undefined);
    setPhase(initialPhase(configuration.scenario));
    setCreationView(initialCreationView(configuration.scenario));
  }, [configuration.scenario]);

  const changeScenario = useCallback((scenario: LabScenarioOption) => {
    setConfiguration((current) => configurationForScenario(current, scenario));
    setCustomizations([]);
    setNavigationTarget(undefined);
    setPhase(initialPhase(scenario));
    setCreationView(initialCreationView(scenario));
  }, []);

  const changeJourney = useCallback(
    (journey: LabJourney) => {
      setConfiguration((current) => ({ ...current, journey, revision: current.revision + 1 }));
      setCustomizations((current) => updateCustomizations(current, "computer", false));
      setNavigationTarget(undefined);
      setPhase(initialPhase(configuration.scenario));
      setCreationView(initialCreationView(configuration.scenario));
    },
    [configuration.scenario],
  );

  const createPreviewAgent = useCallback(
    async (request: CreationIntentRequest) => {
      setConfiguration((current) => ({
        ...current,
        runtime: request.runtimeProvider,
        runtimeBaseline: request.runtimeProvider,
      }));
      setCustomizations((current) => updateCustomizations(current, "runtime", false));
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
    if (pending === "reconnect-computer") {
      setCustomizations((current) => updateCustomizations(current, "computer", false));
    }
  }, [memory, pending, phase]);

  const changeRuntime = useCallback(
    (runtime: AgentRuntimeProvider) => {
      setConfiguration((current) => ({ ...current, runtime, revision: current.revision + 1 }));
      setCustomizations((current) =>
        updateAfterMemoryRebuild(current, "runtime", runtime !== configuration.runtimeBaseline),
      );
    },
    [configuration.runtimeBaseline],
  );

  const takeComputerOffline = useCallback(() => {
    memory.controls.setComputerOnline(false);
    setCustomizations((current) => updateCustomizations(current, "computer", true));
  }, [memory]);

  const changeInventory = useCallback(
    (inventory: LabInventory) => {
      setConfiguration((current) => ({ ...current, inventory, revision: current.revision + 1 }));
      setCustomizations((current) =>
        updateAfterMemoryRebuild(current, "inventory", inventory !== labScenarioDefaults(productionScenario).inventory),
      );
    },
    [productionScenario],
  );

  const changeMessagingProvider = useCallback(
    (messagingProvider: ImProvider) => {
      setConfiguration((current) => ({ ...current, messagingProvider, revision: current.revision + 1 }));
      setCustomizations((current) =>
        updateAfterMemoryRebuild(
          current,
          "messaging-provider",
          messagingProvider !== labScenarioDefaults(productionScenario).messagingProvider,
        ),
      );
    },
    [productionScenario],
  );

  const changeFailure = useCallback((failure: LabObservationFailure) => {
    setConfiguration((current) => ({ ...current, failure }));
    setCustomizations((current) => updateCustomizations(current, "failure", failure !== "none"));
  }, []);

  useEffect(() => {
    memory.controls.setObservationFailure(configuration.failure === "none" ? undefined : configuration.failure);
  }, [configuration.failure, memory]);

  useEffect(() => {
    if (configuration.automation === "manual" || !pending) return;
    const timer = window.setTimeout(runPending, automaticEventDelay(pending));
    return () => window.clearTimeout(timer);
  }, [configuration.automation, pending, runPending]);

  return (
    <div className="relative min-h-screen pb-28 sm:pb-20" data-ui="onboarding-v2-lab-page">
      <LabPreview
        configuration={configuration}
        createPreviewAgent={createPreviewAgent}
        memory={memory}
        navigationTarget={navigationTarget}
        onCreationViewChange={setCreationView}
        onNavigationTargetChange={setNavigationTarget}
        onPreviewRuntimeChange={setPreviewRuntime}
        phase={phase}
        previewRuntime={previewRuntime}
        productionScenario={productionScenario}
        readinessScenario={readinessScenario}
        version={version}
      />
      <AgentSetupLabControls
        activePage={active.page}
        activeScenario={active.scenario}
        automation={configuration.automation}
        customizationCount={customizations.length}
        failure={configuration.failure}
        inventory={configuration.inventory}
        journey={configuration.journey}
        memory={memory}
        messagingProvider={configuration.messagingProvider}
        onAutomationChange={(automation) => setConfiguration((current) => ({ ...current, automation }))}
        onFailPending={() => failPendingLabEvent(memory)}
        onFailureChange={changeFailure}
        onInventoryChange={changeInventory}
        onJourneyChange={changeJourney}
        onMessagingProviderChange={changeMessagingProvider}
        onReset={reset}
        onRunPending={runPending}
        onRuntimeChange={changeRuntime}
        onScenarioChange={changeScenario}
        onTakeComputerOffline={takeComputerOffline}
        pending={pending}
        runtime={configuration.runtime}
        scenario={configuration.scenario}
      />
    </div>
  );
}

function LabPreview({
  configuration,
  createPreviewAgent,
  memory,
  navigationTarget,
  onCreationViewChange,
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
  readonly onCreationViewChange: (view: CreationPreviewView) => void;
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
        creationPreviewInitialView={productionScenario === "agent-creation" ? "agent" : "destination"}
        key={`creation:${configuration.revision}:${configuration.journey}`}
        onAgentAvailable={() => undefined}
        onBackToAgents={configuration.journey === "additional" ? () => onNavigationTargetChange("agents") : undefined}
        onCreationPreviewViewChange={onCreationViewChange}
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
