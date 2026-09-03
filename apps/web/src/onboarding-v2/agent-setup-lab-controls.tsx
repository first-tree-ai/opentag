import type { AgentRuntimeProvider, ImProvider } from "@opentag/shared/browser";
import { useId, useRef, useState } from "react";
import { spaceScriptBoundary } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import { Button, Collapsible, Icon, KumoSelectControl } from "../ui/design-system.js";
import {
  LAB_AUTOMATIONS,
  LAB_INVENTORIES,
  LAB_JOURNEYS,
  LAB_OBSERVATION_FAILURES,
  LAB_SCENARIOS,
  type LabAutomation,
  type LabInventory,
  type LabJourney,
  type LabObservationFailure,
  type LabPendingEvent,
  type LabScenario,
} from "./agent-setup-lab-model.js";
import { RUNTIMES } from "./flow.js";
import {
  isReadinessScenario,
  READINESS_SCENARIO_LABELS,
  READINESS_SCENARIOS,
  type ReadinessScenario,
} from "./readiness-lab-fixtures.js";
import type { MemorySetupAdapter } from "./setup-memory-adapter.js";

type LabScenarioOption = LabScenario | ReadinessScenario;

function scenarioLabel(scenario: LabScenario): string {
  if (scenario === "full-new-computer") return m.onboarding_v2_lab_scenario_full_new_computer();
  if (scenario === "full-existing-computer") return m.onboarding_v2_lab_scenario_full_existing_computer();
  if (scenario === "agent-creation") return m.onboarding_v2_lab_scenario_agent_creation();
  if (scenario === "computer-connection") return m.onboarding_v2_lab_scenario_computer_connection();
  if (scenario === "runtime-setup") return m.onboarding_v2_lab_scenario_runtime_setup();
  if (scenario === "messaging-setup") return m.onboarding_v2_lab_scenario_messaging_setup();
  return m.onboarding_v2_lab_scenario_everything_ready();
}

function journeyLabel(journey: LabJourney): string {
  return journey === "first" ? m.onboarding_v2_lab_journey_first() : m.onboarding_v2_lab_journey_additional();
}

function inventoryLabel(inventory: LabInventory): string {
  if (inventory === "none") return m.onboarding_v2_lab_inventory_none();
  if (inventory === "one-online") return m.onboarding_v2_lab_inventory_one_online();
  if (inventory === "one-offline") return m.onboarding_v2_lab_inventory_one_offline();
  return m.onboarding_v2_lab_inventory_several();
}

function failureLabel(failure: LabObservationFailure): string {
  if (failure === "none") return m.onboarding_v2_lab_failure_none();
  if (failure === "computer") return m.onboarding_v2_lab_failure_computer();
  if (failure === "runtime") return m.onboarding_v2_lab_failure_runtime();
  return m.onboarding_v2_lab_failure_messaging();
}

function runtimeLabel(runtime: AgentRuntimeProvider): string {
  return runtime === "codex" ? m.onboarding_v2_runtime_codex_title() : m.onboarding_v2_runtime_claude_code_title();
}

function pendingLabel(event: LabPendingEvent | undefined): string {
  if (event === "complete-admission") return m.onboarding_v2_lab_event_complete_admission();
  if (event === "connect-computer") return m.onboarding_v2_lab_event_connect_computer();
  if (event === "reconnect-computer") return m.onboarding_v2_lab_event_reconnect_computer();
  if (event === "finish-readiness") return m.onboarding_v2_lab_event_finish_readiness();
  if (event === "scan-feishu") {
    return spaceScriptBoundary(m.onboarding_v2_lab_event_scan_provider({ provider: messagingProviderLabel("feishu") }));
  }
  if (event === "finish-slack") {
    return spaceScriptBoundary(
      m.onboarding_v2_lab_event_finish_provider({ provider: messagingProviderLabel("slack") }),
    );
  }
  if (event === "finish-handoff") return m.onboarding_v2_lab_event_finish_handoff();
  return m.onboarding_v2_lab_nothing_waiting();
}

function controlButtonLabel(scenario: LabScenarioOption, journey: LabJourney, status: string): string {
  return isReadinessScenario(scenario) ? status : `${journeyLabel(journey)} · ${status}`;
}

export function AgentSetupLabControls({
  automation,
  failure,
  inventory,
  journey,
  memory,
  messagingProvider,
  onAutomationChange,
  onFailPending,
  onFailureChange,
  onInventoryChange,
  onJourneyChange,
  onMessagingProviderChange,
  onReset,
  onRunPending,
  onRuntimeChange,
  onScenarioChange,
  pending,
  runtime,
  scenario,
  status,
}: {
  readonly automation: LabAutomation;
  readonly failure: LabObservationFailure;
  readonly inventory: LabInventory;
  readonly journey: LabJourney;
  readonly memory: MemorySetupAdapter;
  readonly messagingProvider: ImProvider;
  readonly onAutomationChange: (automation: LabAutomation) => void;
  readonly onFailPending: () => void;
  readonly onFailureChange: (failure: LabObservationFailure) => void;
  readonly onInventoryChange: (inventory: LabInventory) => void;
  readonly onJourneyChange: (journey: LabJourney) => void;
  readonly onMessagingProviderChange: (provider: ImProvider) => void;
  readonly onReset: () => void;
  readonly onRunPending: () => void;
  readonly onRuntimeChange: (runtime: AgentRuntimeProvider) => void;
  readonly onScenarioChange: (scenario: LabScenarioOption) => void;
  readonly pending: LabPendingEvent | undefined;
  readonly runtime: AgentRuntimeProvider;
  readonly scenario: LabScenarioOption;
  readonly status: string;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const scenarioId = useId();
  const inventoryId = useId();
  const failureId = useId();
  const runtimeId = useId();
  const messagingId = useId();
  const fixtureId = useId();
  const panelId = useId();
  const readinessFixture = isReadinessScenario(scenario);
  const { computerConnectState, snapshot } = memory.inspect();
  const canFailPending =
    computerConnectState === "pending" ||
    (snapshot.messaging.kind === "authorizing" && pending !== "complete-admission");
  const canTakeOffline = snapshot.computer.kind === "bound" && snapshot.computer.connectionStatus === "online";

  function togglePanel(): void {
    const next = !open;
    setOpen(next);
  }

  return (
    <aside
      className="fixed right-3 bottom-3 z-30 flex max-w-[calc(100vw-1.5rem)] items-end gap-2 sm:right-6 sm:bottom-6"
      data-open={open ? "true" : undefined}
      data-ui="onboarding-v2-lab"
    >
      {!open && pending ? <Button onClick={onRunPending}>{pendingLabel(pending)}</Button> : null}
      <div className="flex flex-col items-end gap-2">
        <Button
          aria-controls={panelId}
          aria-expanded={open}
          aria-label={m.onboarding_v2_lab_title()}
          onClick={togglePanel}
          variant="secondary"
        >
          {controlButtonLabel(scenario, journey, status)}
        </Button>
        <div
          className="flex max-h-[min(42rem,calc(100vh-7rem))] w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-4 overflow-y-auto rounded-xl bg-kumo-base p-4 shadow-lg ring ring-kumo-line"
          hidden={!open}
          id={panelId}
          ref={panelRef}
        >
          <header className="flex items-center justify-between gap-3">
            <div className="grid gap-0.5">
              <strong className="text-sm text-kumo-strong">{m.onboarding_v2_lab_title()}</strong>
              <span className="text-xs text-kumo-subtle">{status}</span>
            </div>
            <Button onClick={onReset} size="compact" variant="ghost">
              {m.onboarding_v2_lab_reset()}
            </Button>
          </header>

          <fieldset className="grid gap-2 border-0 p-0 m-0" hidden={readinessFixture}>
            <legend className="text-xs font-medium uppercase text-kumo-subtle">{m.onboarding_v2_lab_journey()}</legend>
            <div className="grid grid-cols-2 gap-1">
              {LAB_JOURNEYS.map((candidate) => (
                <Button
                  aria-pressed={journey === candidate}
                  key={candidate}
                  onClick={() => onJourneyChange(candidate)}
                  size="compact"
                  variant={journey === candidate ? "secondary" : "ghost"}
                >
                  {journeyLabel(candidate)}
                </Button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-1">
            <label className="text-xs font-medium uppercase text-kumo-subtle" htmlFor={scenarioId}>
              {m.onboarding_v2_lab_scenario()}
            </label>
            <KumoSelectControl
              container={panelRef}
              id={scenarioId}
              onChange={(event) => onScenarioChange(event.target.value as LabScenarioOption)}
              value={readinessFixture ? "" : scenario}
            >
              {readinessFixture ? (
                <option disabled value="">
                  {m.onboarding_v2_lab_scenario_core_placeholder()}
                </option>
              ) : null}
              {LAB_SCENARIOS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {scenarioLabel(candidate)}
                </option>
              ))}
            </KumoSelectControl>
          </div>

          <Collapsible.Root className="border-t border-kumo-line pt-3" defaultOpen={readinessFixture}>
            <Collapsible.Trigger
              render={<Button className="w-full justify-between" size="compact" type="button" variant="ghost" />}
            >
              {m.onboarding_v2_lab_component_fixtures()}
              <Icon className="size-3.5 transition-transform [[data-panel-open]_&]:rotate-180" name="chevron-down" />
            </Collapsible.Trigger>
            <Collapsible.Panel className="mt-3 grid gap-1">
              <label className="text-xs text-kumo-subtle" htmlFor={fixtureId}>
                {m.onboarding_v2_lab_component_fixtures()}
              </label>
              <KumoSelectControl
                container={panelRef}
                id={fixtureId}
                onChange={(event) => onScenarioChange(event.target.value as ReadinessScenario)}
                value={readinessFixture ? scenario : ""}
              >
                <option disabled value="">
                  {m.onboarding_v2_lab_component_fixture_none()}
                </option>
                {READINESS_SCENARIOS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {READINESS_SCENARIO_LABELS[candidate]}
                  </option>
                ))}
              </KumoSelectControl>
            </Collapsible.Panel>
          </Collapsible.Root>
          <fieldset className="grid gap-2 border-0 p-0 m-0" hidden={readinessFixture}>
            <legend className="text-xs font-medium uppercase text-kumo-subtle">
              {m.onboarding_v2_lab_automation()}
            </legend>
            <div className="grid grid-cols-2 gap-1">
              {LAB_AUTOMATIONS.map((candidate) => (
                <Button
                  aria-pressed={automation === candidate}
                  key={candidate}
                  onClick={() => onAutomationChange(candidate)}
                  size="compact"
                  variant={automation === candidate ? "secondary" : "ghost"}
                >
                  {candidate === "manual"
                    ? m.onboarding_v2_lab_automation_manual()
                    : m.onboarding_v2_lab_automation_auto()}
                </Button>
              ))}
            </div>
          </fieldset>

          <div hidden={readinessFixture}>
            <Collapsible.Root className="border-t border-kumo-line pt-3">
              <Collapsible.Trigger
                render={<Button className="w-full justify-between" size="compact" type="button" variant="ghost" />}
              >
                {m.onboarding_v2_lab_overrides()}
                <Icon className="size-3.5 transition-transform [[data-panel-open]_&]:rotate-180" name="chevron-down" />
              </Collapsible.Trigger>
              <Collapsible.Panel className="mt-3 grid gap-3">
                <div className="grid gap-1">
                  <label className="text-xs text-kumo-subtle" htmlFor={runtimeId}>
                    {m.onboarding_v2_agent_runtime_label()}
                  </label>
                  <KumoSelectControl
                    container={panelRef}
                    id={runtimeId}
                    onChange={(event) => onRuntimeChange(event.target.value as AgentRuntimeProvider)}
                    value={runtime}
                  >
                    {RUNTIMES.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {runtimeLabel(candidate)}
                      </option>
                    ))}
                  </KumoSelectControl>
                  <p className="text-xs text-kumo-subtle m-0">{m.onboarding_v2_lab_runtime_override_hint()}</p>
                </div>

                <div className="grid gap-1">
                  <label className="text-xs text-kumo-subtle" htmlFor={inventoryId}>
                    {m.onboarding_v2_lab_computers_on_account()}
                  </label>
                  <KumoSelectControl
                    container={panelRef}
                    id={inventoryId}
                    onChange={(event) => onInventoryChange(event.target.value as LabInventory)}
                    value={inventory}
                  >
                    {LAB_INVENTORIES.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {inventoryLabel(candidate)}
                      </option>
                    ))}
                  </KumoSelectControl>
                </div>

                {scenario === "everything-ready" ? (
                  <div className="grid gap-1">
                    <label className="text-xs text-kumo-subtle" htmlFor={messagingId}>
                      {m.onboarding_v2_lab_messaging_provider()}
                    </label>
                    <KumoSelectControl
                      container={panelRef}
                      id={messagingId}
                      onChange={(event) => onMessagingProviderChange(event.target.value as ImProvider)}
                      value={messagingProvider}
                    >
                      {(["feishu", "slack"] as const).map((candidate) => (
                        <option key={candidate} value={candidate}>
                          {messagingProviderLabel(candidate)}
                        </option>
                      ))}
                    </KumoSelectControl>
                  </div>
                ) : null}

                <div className="grid gap-1">
                  <label className="text-xs text-kumo-subtle" htmlFor={failureId}>
                    {m.onboarding_v2_lab_observation_failure()}
                  </label>
                  <KumoSelectControl
                    container={panelRef}
                    id={failureId}
                    onChange={(event) => onFailureChange(event.target.value as LabObservationFailure)}
                    value={failure}
                  >
                    {LAB_OBSERVATION_FAILURES.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {failureLabel(candidate)}
                      </option>
                    ))}
                  </KumoSelectControl>
                </div>
              </Collapsible.Panel>
            </Collapsible.Root>
          </div>

          <section
            className="grid gap-2 rounded-lg bg-kumo-recessed p-3"
            aria-label={m.onboarding_v2_lab_external_event()}
            hidden={readinessFixture}
          >
            <span className="text-xs font-medium uppercase text-kumo-subtle">
              {m.onboarding_v2_lab_external_event()}
            </span>
            <strong className="text-sm text-kumo-strong">{pendingLabel(pending)}</strong>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!pending} onClick={onRunPending} size="compact">
                {pendingLabel(pending)}
              </Button>
              {canFailPending ? (
                <Button onClick={onFailPending} size="compact" variant="outline">
                  {computerConnectState === "pending"
                    ? m.onboarding_v2_lab_expire_code()
                    : m.onboarding_v2_lab_fail_authorization()}
                </Button>
              ) : null}
              {!pending && canTakeOffline ? (
                <Button onClick={() => memory.controls.setComputerOnline(false)} size="compact" variant="outline">
                  {m.onboarding_v2_lab_take_computer_offline()}
                </Button>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </aside>
  );
}
