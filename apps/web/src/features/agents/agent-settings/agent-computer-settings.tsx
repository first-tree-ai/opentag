import { useState } from "react";
import { formatDateTime, formatRelativeTime } from "../../../i18n/format.js";
import * as m from "../../../paraglide/messages.js";
import { Button, StatusIndicator, type StatusTone, Text } from "../../../ui/design-system.js";
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
    ? m.agent_settings_online_status()
    : blocked
      ? runtimeUnavailable
        ? m.agent_settings_not_ready_status()
        : m.agent_settings_offline_status()
      : m.agent_settings_unable_to_confirm_status();
  const computerTone: StatusTone = ready ? "success" : blocked ? "warning" : "neutral";
  return (
    <div className="grid gap-6">
      <section
        aria-labelledby="computer-heading"
        className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Text as="h1" id="computer-heading" size="lg" variant="heading">
              {agent.computer.displayName} · {platformLabel(agent.computer.platform)}
            </Text>
          </div>
          <StatusIndicator label={computerStatus} tone={computerTone} />
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
                <>
                  <Button
                    aria-controls="agent-computer-reconnect"
                    aria-expanded={reconnecting}
                    size="compact"
                    variant={reconnecting ? "inline" : "secondary"}
                    onClick={() => setReconnecting((value) => !value)}
                  >
                    {reconnecting
                      ? m.agent_settings_cancel_computer_connection()
                      : m.agent_settings_reconnect_computer()}
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
                      <p className="text-sm text-kumo-subtle">{m.agent_settings_reconnecting_description()}</p>
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
