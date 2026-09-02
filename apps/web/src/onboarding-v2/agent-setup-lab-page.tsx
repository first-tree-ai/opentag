import type { AgentSummary } from "@opentag/shared/browser";
import { useMemo, useState } from "react";
import * as m from "../paraglide/messages.js";
import { KumoSelectControl } from "../ui/design-system.js";
import { AgentSetupPage } from "./agent-setup-page.js";
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

function scenarioSeed(scenario: LabScenario): MemorySetupSeed {
  if (scenario === "needs-computer") return { agent: { ...LAB_AGENT, computer: null } };
  if (scenario === "needs-runtime") return { agent: LAB_AGENT, runtimeStatus: "install" };
  if (scenario === "ready") {
    return { agent: LAB_AGENT, messaging: { kind: "bound", provider: "feishu", reachable: true } };
  }
  return { agent: LAB_AGENT };
}

function scenarioLabel(scenario: LabScenario): string {
  if (scenario === "needs-computer") return m.onboarding_v2_lab_needs_computer();
  if (scenario === "needs-runtime") return m.onboarding_v2_lab_needs_runtime();
  if (scenario === "needs-messaging") return m.onboarding_v2_lab_needs_messaging();
  return m.onboarding_v2_lab_ready();
}

/** The production presentation against Issue 437's in-memory Adapter, with only the seed state selectable. */
export function AgentSetupLabPage() {
  const [scenario, setScenario] = useState<LabScenario>("needs-computer");
  const memory = useMemo(() => createMemorySetupAdapter(scenarioSeed(scenario)), [scenario]);
  return (
    <div className="relative min-h-screen">
      <AgentSetupPage adapter={memory.adapter} agentId={LAB_AGENT_ID} />
      <aside className="fixed inset-x-4 bottom-4 z-10 mx-auto flex max-w-md items-center gap-3 rounded-lg bg-kumo-base p-3 shadow-lg ring ring-kumo-line">
        <label className="text-sm font-medium text-kumo-strong" htmlFor="agent-setup-lab-scenario">
          {m.onboarding_v2_lab_scenario()}
        </label>
        <KumoSelectControl
          className="min-w-0 flex-1"
          id="agent-setup-lab-scenario"
          onChange={(event) => setScenario(event.target.value as LabScenario)}
          value={scenario}
        >
          {SCENARIOS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {scenarioLabel(candidate)}
            </option>
          ))}
        </KumoSelectControl>
      </aside>
    </div>
  );
}
