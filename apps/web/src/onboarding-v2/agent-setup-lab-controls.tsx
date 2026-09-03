import type { AgentRuntimeProvider, AgentSetupSnapshot, ImProvider } from "@opentag/shared/browser";
import { type RefObject, useId, useRef, useState } from "react";
import { spaceScriptBoundary } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import { Button, Collapsible, Icon, KumoSelectControl, StatusIndicator, type StatusTone } from "../ui/design-system.js";
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
  labScenarioStartsWithCreation,
} from "./agent-setup-lab-model.js";
import { RUNTIMES } from "./flow.js";
import { preparationReadinessRows, preparationSummaryRows } from "./preparation-readiness.js";
import {
  isReadinessScenario,
  READINESS_SCENARIOS,
  type ReadinessScenario,
  readinessScenarioLabel,
} from "./readiness-lab-fixtures.js";
import type { CheckRow } from "./readiness-list.js";
import type { MemorySetupAdapter } from "./setup-memory-adapter.js";

type LabScenarioOption = LabScenario | ReadinessScenario;

type LabScenarioCopy = Readonly<{ label: () => string; description: () => string }>;

const LAB_SCENARIO_COPY: Record<LabScenario, LabScenarioCopy> = {
  "full-new-computer": {
    label: m.onboarding_v2_lab_scenario_full_new_computer,
    description: m.onboarding_v2_lab_scenario_full_new_computer_description,
  },
  "full-existing-computer": {
    label: m.onboarding_v2_lab_scenario_full_existing_computer,
    description: m.onboarding_v2_lab_scenario_full_existing_computer_description,
  },
  "agent-creation": {
    label: m.onboarding_v2_lab_scenario_agent_creation,
    description: m.onboarding_v2_lab_scenario_agent_creation_description,
  },
  "computer-connection": {
    label: m.onboarding_v2_lab_scenario_computer_connection,
    description: m.onboarding_v2_lab_scenario_computer_connection_description,
  },
  "computer-reconnect": {
    label: m.onboarding_v2_lab_scenario_computer_reconnect,
    description: m.onboarding_v2_lab_scenario_computer_reconnect_description,
  },
  "computer-rebind": {
    label: m.onboarding_v2_lab_scenario_computer_rebind,
    description: m.onboarding_v2_lab_scenario_computer_rebind_description,
  },
  "runtime-waiting": {
    label: m.onboarding_v2_lab_scenario_runtime_waiting,
    description: m.onboarding_v2_lab_scenario_runtime_waiting_description,
  },
  "runtime-checking": {
    label: m.onboarding_v2_lab_scenario_runtime_checking,
    description: m.onboarding_v2_lab_scenario_runtime_checking_description,
  },
  "runtime-setup": {
    label: m.onboarding_v2_lab_scenario_runtime_setup,
    description: m.onboarding_v2_lab_scenario_runtime_setup_description,
  },
  "runtime-sign-in": {
    label: m.onboarding_v2_lab_scenario_runtime_sign_in,
    description: m.onboarding_v2_lab_scenario_runtime_sign_in_description,
  },
  "messaging-support-setup": {
    label: m.onboarding_v2_lab_scenario_messaging_support_setup,
    description: m.onboarding_v2_lab_scenario_messaging_support_setup_description,
  },
  "messaging-setup": {
    label: m.onboarding_v2_lab_scenario_messaging_setup,
    description: m.onboarding_v2_lab_scenario_messaging_setup_description,
  },
  "messaging-handoff": {
    label: m.onboarding_v2_lab_scenario_messaging_handoff,
    description: m.onboarding_v2_lab_scenario_messaging_handoff_description,
  },
  "messaging-recovery": {
    label: m.onboarding_v2_lab_scenario_messaging_recovery,
    description: m.onboarding_v2_lab_scenario_messaging_recovery_description,
  },
  "everything-ready": {
    label: m.onboarding_v2_lab_scenario_everything_ready,
    description: m.onboarding_v2_lab_scenario_everything_ready_description,
  },
};

function scenarioLabel(scenario: LabScenario): string {
  return LAB_SCENARIO_COPY[scenario].label();
}

function scenarioDescription(scenario: LabScenario): string {
  return LAB_SCENARIO_COPY[scenario].description();
}

function scenarioAllowsRuntimeOverride(scenario: LabScenarioOption): boolean {
  return !isReadinessScenario(scenario) && !labScenarioStartsWithCreation(scenario);
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

function controlButtonLabel(scenario: LabScenarioOption, status: string, customizationCount: number): string {
  if (isReadinessScenario(scenario)) return status;
  if (customizationCount > 0) return `${m.onboarding_v2_lab_custom_state()} · ${status}`;
  return `${scenarioLabel(scenario)} · ${status}`;
}

function controlSubtitle(scenario: LabScenarioOption, status: string, customizationCount: number): string {
  if (isReadinessScenario(scenario)) return status;
  if (customizationCount > 0) {
    return `${scenarioLabel(scenario)} · ${m.onboarding_v2_lab_overrides_changed({ count: customizationCount })}`;
  }
  return scenarioLabel(scenario);
}

function ControlTriggerContent({
  customizationCount,
  open,
  scenario,
  status,
}: {
  readonly customizationCount: number;
  readonly open: boolean;
  readonly scenario: LabScenarioOption;
  readonly status: string;
}) {
  if (!open) return controlButtonLabel(scenario, status, customizationCount);
  return (
    <>
      <Icon name="close" />
      {m.common_close()}
    </>
  );
}

function readinessTone(row: CheckRow): StatusTone {
  if (row.state === "passed") return "success";
  if (row.state === "failed") return "danger";
  if (row.state === "blocked") return "warning";
  return "neutral";
}

function readinessStatus(row: CheckRow): string {
  return row.status === "ready" ? m.onboarding_v2_prep_status_ready() : row.statusLabel;
}

interface LabStateItem {
  readonly key: string;
  readonly label: string;
  readonly status: string;
  readonly tone: StatusTone;
}

function readinessStateItem(key: string, label: string, row: CheckRow): LabStateItem {
  return { key, label, status: readinessStatus(row), tone: readinessTone(row) };
}

function messagingConnectionState(snapshot: AgentSetupSnapshot): LabStateItem {
  const { messaging } = snapshot;
  const label =
    "provider" in messaging
      ? spaceScriptBoundary(
          m.onboarding_v2_lab_messaging_connection_provider({ provider: messagingProviderLabel(messaging.provider) }),
        )
      : m.onboarding_v2_lab_messaging_connection();
  if (messaging.kind === "ready") {
    return { key: "messaging-connection", label, status: m.onboarding_v2_prep_status_ready(), tone: "success" };
  }
  if (messaging.kind === "blocked") {
    return { key: "messaging-connection", label, status: m.onboarding_v2_prep_needs_attention(), tone: "danger" };
  }
  if (messaging.kind === "waiting-handoff") {
    return {
      key: "messaging-connection",
      label,
      status: m.onboarding_v2_lab_messaging_connection_waiting_handoff(),
      tone: "warning",
    };
  }
  if (messaging.kind === "authorizing") {
    return {
      key: "messaging-connection",
      label,
      status: m.onboarding_v2_lab_messaging_connection_authorizing(),
      tone: "neutral",
    };
  }
  if (messaging.kind === "observation-failed") {
    return {
      key: "messaging-connection",
      label,
      status: m.onboarding_v2_lab_messaging_connection_observation_failed(),
      tone: "danger",
    };
  }
  return {
    key: "messaging-connection",
    label,
    status: m.onboarding_v2_lab_messaging_connection_not_started(),
    tone: "neutral",
  };
}

function LabStateSummary({ snapshot }: { readonly snapshot: AgentSetupSnapshot }) {
  const full = preparationReadinessRows(snapshot);
  const summary = preparationSummaryRows(snapshot);
  const rows: readonly LabStateItem[] = [
    readinessStateItem("computer", m.onboarding_v2_prep_computer_label(), full.computer),
    readinessStateItem(
      "runtime",
      m.onboarding_v2_lab_state_runtime({ runtime: summary.runtime.label }),
      summary.runtime,
    ),
    readinessStateItem("messaging-support", summary.messaging.label, summary.messaging),
    messagingConnectionState(snapshot),
  ] as const;
  return (
    <section
      aria-label={m.onboarding_v2_lab_current_state()}
      className="grid gap-2 rounded-lg bg-kumo-recessed p-3"
      data-ui="lab-state-summary"
    >
      <span className="text-xs font-medium uppercase text-kumo-subtle">{m.onboarding_v2_lab_current_state()}</span>
      <dl className="grid gap-2 m-0">
        {rows.map(({ key, label, status, tone }) => (
          <div className="flex min-w-0 items-center justify-between gap-3" key={key}>
            <dt className="truncate text-sm text-kumo-strong">{label}</dt>
            <dd className="shrink-0 m-0">
              <StatusIndicator label={status} tone={tone} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function LabScenarioDescription({ scenario }: { readonly scenario: LabScenarioOption }) {
  if (isReadinessScenario(scenario)) return null;
  return <p className="text-xs text-kumo-subtle m-0">{scenarioDescription(scenario)}</p>;
}

function ComponentFixtureControl({
  container,
  onScenarioChange,
  scenario,
}: {
  readonly container: RefObject<HTMLDivElement | null>;
  readonly onScenarioChange: (scenario: LabScenarioOption) => void;
  readonly scenario: LabScenarioOption;
}) {
  const fixtureId = useId();
  const readinessFixture = isReadinessScenario(scenario);

  return (
    <Collapsible.Root
      className="border-t border-kumo-line pt-3"
      defaultOpen={readinessFixture}
      key={readinessFixture ? "fixture" : "scenario"}
    >
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
          container={container}
          id={fixtureId}
          onChange={(event) => onScenarioChange(event.target.value as ReadinessScenario)}
          value={readinessFixture ? scenario : ""}
        >
          <option disabled value="">
            {m.onboarding_v2_lab_component_fixture_none()}
          </option>
          {READINESS_SCENARIOS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {readinessScenarioLabel(candidate)}
            </option>
          ))}
        </KumoSelectControl>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function FlowProgressControl({
  automation,
  canFailPending,
  computerConnectPending,
  onAutomationChange,
  onFailPending,
  onRunPending,
  pending,
}: {
  readonly automation: LabAutomation;
  readonly canFailPending: boolean;
  readonly computerConnectPending: boolean;
  readonly onAutomationChange: (automation: LabAutomation) => void;
  readonly onFailPending: () => void;
  readonly onRunPending: () => void;
  readonly pending: LabPendingEvent | undefined;
}) {
  return (
    <section aria-label={m.onboarding_v2_lab_flow_progress()} className="grid gap-3 rounded-lg bg-kumo-recessed p-3">
      <fieldset className="grid gap-2 border-0 p-0 m-0">
        <legend className="text-xs font-medium uppercase text-kumo-subtle">
          {m.onboarding_v2_lab_flow_progress()}
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
              {candidate === "manual" ? m.onboarding_v2_lab_automation_manual() : m.onboarding_v2_lab_automation_auto()}
            </Button>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-2 border-t border-kumo-line pt-3">
        <span className="text-xs font-medium uppercase text-kumo-subtle">{m.onboarding_v2_lab_next_step()}</span>
        {pending ? (
          <>
            <strong className="text-sm text-kumo-strong">{pendingLabel(pending)}</strong>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onRunPending} size="compact">
                {pendingLabel(pending)}
              </Button>
              {canFailPending ? (
                <Button onClick={onFailPending} size="compact" variant="outline">
                  {computerConnectPending
                    ? m.onboarding_v2_lab_expire_code()
                    : m.onboarding_v2_lab_fail_authorization()}
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-sm text-kumo-subtle m-0">{m.onboarding_v2_lab_nothing_waiting()}</p>
        )}
      </div>
    </section>
  );
}

function RuntimeOverrideControl({
  container,
  id,
  onChange,
  runtime,
  visible,
}: {
  readonly container: RefObject<HTMLDivElement | null>;
  readonly id: string;
  readonly onChange: (runtime: AgentRuntimeProvider) => void;
  readonly runtime: AgentRuntimeProvider;
  readonly visible: boolean;
}) {
  if (!visible) return null;
  return (
    <div className="grid gap-1">
      <label className="text-xs text-kumo-subtle" htmlFor={id}>
        {m.onboarding_v2_agent_runtime_label()}
      </label>
      <KumoSelectControl
        container={container}
        id={id}
        onChange={(event) => onChange(event.target.value as AgentRuntimeProvider)}
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
  );
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
  onTakeComputerOffline,
  pending,
  runtime,
  scenario,
  status,
  customizationCount,
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
  readonly onTakeComputerOffline: () => void;
  readonly pending: LabPendingEvent | undefined;
  readonly runtime: AgentRuntimeProvider;
  readonly scenario: LabScenarioOption;
  readonly status: string;
  readonly customizationCount: number;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const scenarioId = useId();
  const inventoryId = useId();
  const failureId = useId();
  const runtimeId = useId();
  const messagingId = useId();
  const panelId = useId();
  const readinessFixture = isReadinessScenario(scenario);
  const showJourney = !isReadinessScenario(scenario) && labScenarioStartsWithCreation(scenario);
  const showRuntimeOverride = scenarioAllowsRuntimeOverride(scenario);
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
        <Button aria-controls={panelId} aria-expanded={open} onClick={togglePanel} variant="secondary">
          <ControlTriggerContent
            customizationCount={customizationCount}
            open={open}
            scenario={scenario}
            status={status}
          />
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
              <span className="text-xs text-kumo-subtle">{controlSubtitle(scenario, status, customizationCount)}</span>
            </div>
            <Button onClick={onReset} size="compact" variant="ghost">
              {m.onboarding_v2_lab_reset()}
            </Button>
          </header>

          {showJourney ? (
            <fieldset className="grid gap-2 border-0 p-0 m-0">
              <legend className="text-xs font-medium uppercase text-kumo-subtle">
                {m.onboarding_v2_lab_journey()}
              </legend>
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
          ) : null}

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
            <LabScenarioDescription scenario={scenario} />
          </div>

          {!readinessFixture ? <LabStateSummary snapshot={snapshot} /> : null}

          {!readinessFixture ? (
            <FlowProgressControl
              automation={automation}
              canFailPending={canFailPending}
              computerConnectPending={computerConnectState === "pending"}
              onAutomationChange={onAutomationChange}
              onFailPending={onFailPending}
              onRunPending={onRunPending}
              pending={pending}
            />
          ) : null}

          <div hidden={readinessFixture}>
            <Collapsible.Root className="border-t border-kumo-line pt-3">
              <Collapsible.Trigger
                render={<Button className="w-full justify-between" size="compact" type="button" variant="ghost" />}
              >
                <span>{m.onboarding_v2_lab_overrides()}</span>
                <span className="flex items-center gap-2">
                  {customizationCount > 0 ? (
                    <span className="text-xs text-kumo-subtle">
                      {m.onboarding_v2_lab_overrides_changed({ count: customizationCount })}
                    </span>
                  ) : null}
                  <Icon
                    className="size-3.5 transition-transform [[data-panel-open]_&]:rotate-180"
                    name="chevron-down"
                  />
                </span>
              </Collapsible.Trigger>
              <Collapsible.Panel className="mt-3 grid gap-3">
                <RuntimeOverrideControl
                  container={panelRef}
                  id={runtimeId}
                  onChange={onRuntimeChange}
                  runtime={runtime}
                  visible={showRuntimeOverride}
                />

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

                {canTakeOffline ? (
                  <Button onClick={onTakeComputerOffline} size="compact" variant="outline">
                    {m.onboarding_v2_lab_take_computer_offline()}
                  </Button>
                ) : null}
              </Collapsible.Panel>
            </Collapsible.Root>
          </div>

          <ComponentFixtureControl container={panelRef} onScenarioChange={onScenarioChange} scenario={scenario} />
        </div>
      </div>
    </aside>
  );
}
