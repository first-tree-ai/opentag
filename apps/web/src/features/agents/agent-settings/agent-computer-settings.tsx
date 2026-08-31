import { useState } from "react";
import { formatDateTime, formatRelativeTime } from "../../../i18n/format.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Icon, StatusIndicator, type StatusTone, Text } from "../../../ui/design-system.js";
import type { AgentDetailView } from "../agent-model.js";
import { computerRecoveryMessage, platformLabel } from "../agent-presentation.js";
import { ComputerSetup } from "../computer-setup.js";

export function AgentComputerSettings({
  agent,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  onAgentChanged: () => void;
}) {
  const [reconnecting, setReconnecting] = useState(false);
  const computerState = agent.availability.dependencies.computer;
  const runtimeUnavailable = agent.availability.reason === "runtime_unavailable";
  // A reachable Computer that cannot run this Agent's Provider is not "Online" for this Agent.
  const ready = computerState.state === "ready" && !runtimeUnavailable;
  const blocked = computerState.state === "action_required" || runtimeUnavailable;
  const computerStatus = ready
    ? m.agent_settings_computer_online()
    : blocked
      ? runtimeUnavailable
        ? "Not ready"
        : m.agent_settings_computer_offline()
      : "Unable to confirm";
  const computerTone: StatusTone = ready ? "success" : blocked ? "warning" : "neutral";
  return (
    <div className="grid gap-6">
      <Text as="h1" id="computer-heading" size="lg" variant="heading">
        {m.agents_status_computer()}
      </Text>
      <section
        aria-labelledby="computer-device-heading"
        className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      >
        <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3" data-ui="computer-identity">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint">
            <Icon name="laptop" />
          </span>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <Text as="h2" id="computer-device-heading" variant="heading">
              {agent.computer.displayName}
            </Text>
            <span aria-hidden="true" className="text-sm text-kumo-subtle">
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
                  Last seen {formatRelativeTime(computerState.lastConfirmedAt)} ·{" "}
                  {formatDateTime(computerState.lastConfirmedAt)}
                </p>
              ) : null}
              <p>{computerRecoveryMessage(agent)}</p>
              {/* Re-enrolment only answers an unreachable Computer; a missing Provider needs the
                  Provider installed, so offering it there would send an operator down a dead path. */}
              {computerState.state === "action_required" ? (
                <>
                  <Button
                    aria-controls="agent-computer-reconnect"
                    aria-expanded={reconnecting}
                    variant={reconnecting ? "inline" : "secondary"}
                    onClick={() => setReconnecting((value) => !value)}
                  >
                    {reconnecting ? "Cancel Computer connection" : "Reconnect this Computer"}
                  </Button>
                  {reconnecting ? (
                    <div className="grid gap-3" id="agent-computer-reconnect">
                      <ComputerSetup
                        target={{
                          computerId: agent.computer.computerId,
                          displayName: agent.computer.displayName,
                        }}
                        onConnected={() => onAgentChanged()}
                      />
                      <p className="text-sm text-kumo-subtle">
                        Reconnecting restores this Computer for every Agent that runs on it.
                      </p>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
