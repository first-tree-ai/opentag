import { useState } from "react";
import { formatDateTime, formatRelativeTime } from "../../../i18n/format.js";
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
    ? "Online"
    : blocked
      ? runtimeUnavailable
        ? "Not ready"
        : "Offline"
      : "Unable to confirm";
  const computerTone: StatusTone = ready ? "success" : blocked ? "warning" : "neutral";
  return (
    <div className="grid gap-6">
      <section
        aria-labelledby="agent-computer-heading"
        className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      >
        {/*
          The heading names the block, not the machine, because it sits among Name, Messaging, Model
          and Resources on one screen and has to be findable as "Computer". Which machine it is stays
          directly beneath, where it reads as this block's answer rather than as the page's subject.
        */}
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <Text as="h2" id="agent-computer-heading" variant="heading">
              Computer
            </Text>
            <p className="text-sm text-kumo-subtle">
              {agent.computer.displayName} · {platformLabel(agent.computer.platform)}
            </p>
          </div>
          <StatusIndicator label={computerStatus} tone={computerTone} />
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
                    size="compact"
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
