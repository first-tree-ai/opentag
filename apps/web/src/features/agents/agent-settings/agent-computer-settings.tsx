import { useState } from "react";
import { browserApi } from "../../../api.js";
import { Banner, Button, StatusIndicator, type StatusTone, Text } from "../../../ui/design-system.js";
import type { AgentDetailView } from "../agent-model.js";
import { computerRecoveryMessage, formatDate, formatRelativeTime, platformLabel } from "../agent-presentation.js";
import { useComputersQuery } from "../agent-queries.js";
import { ComputerSetup } from "../computer-setup.js";

/**
 * The panel an Agent that has no Computer gets. It is a distinct screen rather than the reconnect
 * flow with a blank name: there is no machine to bring back, so the question is which Computer this
 * Agent should run on — one the Account already enrolled, or one it connects now.
 */
function AgentComputerBinding({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const computersQuery = useComputersQuery();
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string>();
  const enrolled = computersQuery.data?.computers ?? [];

  async function bind(computerId: string) {
    try {
      setBinding(true);
      setError(undefined);
      await browserApi.rebindAgentComputer(agent.id, computerId);
      onAgentChanged();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Unable to connect this Computer");
    } finally {
      setBinding(false);
    }
  }

  return (
    <div className="grid gap-6">
      <section
        aria-labelledby="computer-heading"
        className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <Text as="h1" id="computer-heading" size="lg" variant="heading">
            No Computer connected
          </Text>
          <StatusIndicator label="Not connected" tone="warning" />
        </header>
        <div className="grid gap-4 rounded-md bg-kumo-recessed p-4">
          <p>{computerRecoveryMessage(agent)}</p>
          {error ? <Banner variant="error" role="alert" description={error} /> : null}
          {enrolled.length > 0 ? (
            <div className="grid gap-2">
              <Text variant="heading">Use a Computer you already connected</Text>
              <ul className="grid gap-2">
                {enrolled.map((computer) => (
                  <li className="flex flex-wrap items-center justify-between gap-3" key={computer.computerId}>
                    <span>
                      {computer.displayName} · {platformLabel(computer.platform)} ·{" "}
                      {computer.connectionStatus === "online" ? "Online" : "Offline"}
                    </span>
                    <Button
                      disabled={binding}
                      size="compact"
                      variant="secondary"
                      onClick={() => void bind(computer.computerId)}
                    >
                      Use {computer.displayName}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Text variant="heading">Connect a new Computer</Text>
            <ComputerSetup onConnected={(computer) => void bind(computer.computerId)} />
          </div>
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
  const [reconnecting, setReconnecting] = useState(false);
  const computer = agent.computer;
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
  if (!computer) return <AgentComputerBinding agent={agent} onAgentChanged={onAgentChanged} />;
  return (
    <div className="grid gap-6">
      <section
        aria-labelledby="computer-heading"
        className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Text as="h1" id="computer-heading" size="lg" variant="heading">
              {computer.displayName} · {platformLabel(computer.platform)}
            </Text>
          </div>
          <StatusIndicator label={computerStatus} tone={computerTone} />
        </header>
        {ready ? null : (
          <div className="rounded-md bg-kumo-recessed p-4">
            <div className="grid gap-3">
              {computerState.lastConfirmedAt ? (
                <p>
                  Last seen {formatRelativeTime(computerState.lastConfirmedAt)} ·{" "}
                  {formatDate(computerState.lastConfirmedAt)}
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
                          computerId: computer.computerId,
                          displayName: computer.displayName,
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
