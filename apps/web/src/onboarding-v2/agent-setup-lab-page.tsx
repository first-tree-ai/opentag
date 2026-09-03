import type { AgentSummary } from "@opentag/shared/browser";
import { useMemo, useState } from "react";
import * as m from "../paraglide/messages.js";
import { KumoSelectControl, Text } from "../ui/design-system.js";
import { AgentSetupPage } from "./agent-setup-page.js";
import {
  PREVIEW_RUNTIMES,
  type PreviewRuntime,
  READINESS_SCENARIO_LABELS,
  READINESS_SCENARIOS,
  type ReadinessScenario,
  readinessRowsForScenario,
  runtimeLabelFor,
} from "./readiness-lab-fixtures.js";
import { ReadinessList } from "./readiness-list.js";
import { createMemorySetupAdapter, type MemorySetupSeed } from "./setup-memory-adapter.js";

const LAB_AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const LAB_COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const LAB_USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const LAB_NOW = "2026-09-01T10:00:00.000Z";

const LAB_AGENT: AgentSummary = {
  id: LAB_AGENT_ID,
  name: "reviewer",
  displayName: "Reviewer",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: LAB_NOW,
  updatedAt: LAB_NOW,
  createdBy: { userId: LAB_USER_ID, displayName: "Owner" },
  computer: { computerId: LAB_COMPUTER_ID, displayName: "Review Mac", platform: "darwin" },
};

const SCENARIOS = ["needs-computer", "needs-runtime", "needs-messaging", "ready"] as const;
type LabScenario = (typeof SCENARIOS)[number];

/** Every selectable lab scenario: the production stage seeds first, then the readiness fixtures. */
const ALL_SCENARIOS = [...SCENARIOS, ...READINESS_SCENARIOS] as const;
type LabScenarioOption = (typeof ALL_SCENARIOS)[number];

function isReadinessScenario(scenario: LabScenarioOption): scenario is ReadinessScenario {
  return (READINESS_SCENARIOS as readonly string[]).includes(scenario);
}

function scenarioSeed(scenario: LabScenario): MemorySetupSeed {
  if (scenario === "needs-computer") return { agent: { ...LAB_AGENT, computer: null } };
  if (scenario === "needs-runtime") return { agent: LAB_AGENT, runtimeStatus: "install" };
  if (scenario === "ready") {
    return { agent: LAB_AGENT, messaging: { kind: "bound", provider: "feishu", reachable: true } };
  }
  return { agent: LAB_AGENT };
}

function scenarioLabel(scenario: LabScenarioOption): string {
  if (isReadinessScenario(scenario)) return READINESS_SCENARIO_LABELS[scenario];
  if (scenario === "needs-computer") return m.onboarding_v2_lab_needs_computer();
  if (scenario === "needs-runtime") return m.onboarding_v2_lab_needs_runtime();
  if (scenario === "needs-messaging") return m.onboarding_v2_lab_needs_messaging();
  return m.onboarding_v2_lab_ready();
}

/** The four production scenarios drive the real Agent Setup surface over the in-memory Adapter. */
function ProductionSetupView({ scenario }: { scenario: LabScenario }) {
  const memory = useMemo(() => createMemorySetupAdapter(scenarioSeed(scenario)), [scenario]);
  return <AgentSetupPage adapter={memory.adapter} agentId={LAB_AGENT_ID} />;
}

/**
 * A purely presentational preview of the readiness list: one persistent list under a fixed
 * heading, and the Preview Runtime selector whose label the fixtures treat as caller copy. No
 * setup state, adapter, timers, or stage calculations live here.
 */
function ReadinessLabView({
  onRuntimeChange,
  runtime,
  scenario,
}: {
  onRuntimeChange: (runtime: PreviewRuntime) => void;
  runtime: PreviewRuntime;
  scenario: ReadinessScenario;
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

/**
 * The lab against Issue 437's in-memory Adapter: the production stage seeds stay selectable, and
 * the readiness scenarios render the same presentational list with explicit fixture copy.
 */
export function AgentSetupLabPage() {
  const [scenario, setScenario] = useState<LabScenarioOption>("needs-computer");
  const [runtime, setRuntime] = useState<PreviewRuntime>("codex");
  return (
    <div className="relative min-h-screen">
      <aside
        className={`${isReadinessScenario(scenario) ? "otv2-readiness-lab__scenario" : "fixed inset-x-4 bottom-4"} z-10 mx-auto flex max-w-md items-center gap-3 rounded-lg bg-kumo-base p-3 shadow-lg ring ring-kumo-line`}
      >
        <label className="text-sm font-medium text-kumo-strong" htmlFor="agent-setup-lab-scenario">
          {m.onboarding_v2_lab_scenario()}
        </label>
        <KumoSelectControl
          className="min-w-0 flex-1"
          id="agent-setup-lab-scenario"
          onChange={(event) => setScenario(event.target.value as LabScenarioOption)}
          value={scenario}
        >
          {ALL_SCENARIOS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {scenarioLabel(candidate)}
            </option>
          ))}
        </KumoSelectControl>
      </aside>
      {isReadinessScenario(scenario) ? (
        <ReadinessLabView onRuntimeChange={setRuntime} runtime={runtime} scenario={scenario} />
      ) : (
        <ProductionSetupView scenario={scenario} />
      )}
    </div>
  );
}
