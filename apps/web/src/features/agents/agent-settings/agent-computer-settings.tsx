import { useState } from "react";
import { formatDateTime, formatRelativeTime } from "../../../i18n/format.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Icon, StatusIndicator, type StatusTone, Text } from "../../../ui/design-system.js";
import { ComputerConnect } from "../../computer-connect/computer-connect.js";
import { AgentComputerChoice } from "../agent-computer-choice.js";
import type { AgentDetailView } from "../agent-model.js";
import { computerRecoveryMessage, platformLabel } from "../agent-presentation.js";
import { AgentSettingsPageHeader } from "./settings-layout.js";

/**
 * The panel an Agent that has no Computer gets. It is a distinct screen rather than the repair flow
 * with a blank name: there is no machine to bring back, so what has to happen is that the Agent is
 * given the Computer this Account has. That step is shared with the onboarding recovery, so a reader
 * who arrives from either direction gets the same result.
 */
function AgentComputerBinding({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  return (
    <div className="grid gap-6">
      <AgentSettingsPageHeader id="computer-heading" title={m.agents_status_computer()} />
      <section
        aria-labelledby="computer-heading"
        className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <Text as="h2" variant="heading">
            {m.agent_settings_computer_none_heading()}
          </Text>
          <StatusIndicator label={m.agent_settings_computer_none_status()} tone="warning" />
        </header>
        <div className="grid gap-4 rounded-md bg-kumo-recessed p-4">
          <p>{computerRecoveryMessage(agent)}</p>
          <AgentComputerChoice agentId={agent.id} onBound={onAgentChanged} />
        </div>
      </section>
    </div>
  );
}

export function AgentComputerSettings({
  agent,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  onAgentChanged: () => void;
}) {
  const computerState = agent.availability.dependencies.computer;
  const runtimeUnavailable = agent.availability.reason === "runtime_unavailable";
  // A reachable Computer that cannot run this Agent's Provider is not "Online" for this Agent.
  const ready = computerState.state === "ready" && !runtimeUnavailable;
  const blocked = computerState.state === "action_required" || runtimeUnavailable;
  const computerStatus = ready
    ? m.agent_settings_computer_online()
    : blocked
      ? runtimeUnavailable
        ? m.agent_settings_computer_not_ready()
        : m.agent_settings_computer_offline()
      : m.agent_settings_computer_unconfirmed();
  const computerTone: StatusTone = ready ? "success" : blocked ? "warning" : "neutral";
  if (!agent.computer) return <AgentComputerBinding agent={agent} onAgentChanged={onAgentChanged} />;
  return (
    <div className="grid gap-6">
      <AgentSettingsPageHeader id="computer-heading" title={m.agents_status_computer()} />
      <section
        aria-labelledby="computer-device-heading"
        className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      >
        <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3" data-ui="computer-identity">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint">
            <Icon name="laptop" />
          </span>
          <div className="grid min-w-0 gap-0.5 @min-[32rem]/content:flex @min-[32rem]/content:items-baseline @min-[32rem]/content:gap-x-1.5">
            <div className="min-w-0 break-words @min-[32rem]/content:truncate">
              <Text as="h2" id="computer-device-heading" variant="heading">
                {agent.computer.displayName}
              </Text>
            </div>
            <span aria-hidden="true" className="hidden text-sm text-kumo-subtle @min-[32rem]/content:inline">
              ·
            </span>
            <span className="text-sm text-kumo-subtle">{platformLabel(agent.computer.platform)}</span>
          </div>
          <StatusIndicator className="justify-self-end" label={computerStatus} tone={computerTone} />
        </header>
        {ready ? null : (
          <div className="rounded-md bg-kumo-recessed p-4">
            <div className="grid gap-3">
              {computerState.lastConfirmedAt ? (
                <p>
                  {m.agent_settings_last_seen({
                    relative: formatRelativeTime(computerState.lastConfirmedAt),
                    date: formatDateTime(computerState.lastConfirmedAt),
                  })}
                </p>
              ) : null}
              <p>{computerRecoveryMessage(agent)}</p>
              {/* Re-enrolment only answers an unreachable Computer; a missing Provider needs the
                  Provider installed, so offering it there would send an operator down a dead path. */}
              {computerState.state === "action_required" ? (
                <AgentComputerRepair
                  computer={agent.computer}
                  key={agent.computer.computerId}
                  onAgentChanged={onAgentChanged}
                />
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function AgentComputerRepair({
  computer,
  onAgentChanged,
}: {
  computer: NonNullable<AgentDetailView["computer"]>;
  onAgentChanged: () => void;
}) {
  const [reconnecting, setReconnecting] = useState(false);
  return (
    <>
      <Button
        aria-controls="agent-computer-reconnect"
        aria-expanded={reconnecting}
        size="compact"
        variant="inline"
        onClick={() => setReconnecting((value) => !value)}
      >
        {reconnecting ? m.agent_settings_computer_repair_hide() : m.agent_settings_computer_repair_show()}
      </Button>
      {reconnecting ? (
        <div className="grid gap-3" id="agent-computer-reconnect">
          <Text as="h2" variant="heading">
            {m.computer_connect_repair_title({ computerName: computer.displayName })}
          </Text>
          <ComputerConnect
            intent={{
              mode: "repair",
              target: { computerId: computer.computerId, displayName: computer.displayName },
            }}
            onConnected={onAgentChanged}
          />
          <p className="text-sm text-kumo-subtle">{m.agent_settings_reconnecting_description()}</p>
        </div>
      ) : null}
    </>
  );
}
