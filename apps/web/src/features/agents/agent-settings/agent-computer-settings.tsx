import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as m from "../../../paraglide/messages.js";
import { queryKeys } from "../../../query/keys.js";
import { Button, buttonClassName, StatusIndicator, Text } from "../../../ui/design-system.js";
import { AgentComputerChoice } from "../agent-computer-choice.js";
import type { AgentDetailView } from "../agent-model.js";
import { accountComputerLink } from "../agent-routes.js";
import { type ComputerConnection, ComputerIdentity } from "../computer-status.js";
import { AgentSettingsPageHeader } from "./settings-layout.js";

/**
 * A Cloud Computer is managed by the platform: nothing is installed, connected, or repaired here,
 * so the panel states that one fact under the normal heading and nothing more.
 */
function CloudComputerSettings() {
  return (
    <div className="grid gap-6">
      <AgentSettingsPageHeader
        description={m.cloud_computer_managed()}
        id="computer-heading"
        title={m.agents_status_computer()}
      />
    </div>
  );
}

/** The Agent's placement. Machine maintenance belongs to the Account. */
export function AgentComputerSettings({
  agent,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  onAgentChanged: () => void;
}) {
  const machine = agent.availability.dependencies.computer;
  if (agent.computer) {
    if (agent.computerKind === "cloud") return <CloudComputerSettings />;
    if (agent.computerKind === undefined && machine.state === "unconfirmed") {
      return <UnconfirmedComputerSettings computer={agent.computer} onAgentChanged={onAgentChanged} />;
    }
  }
  const connection = computerConnection(agent);
  const actionLabel = computerActionLabel(connection);
  return (
    <div className="grid w-full min-w-0 max-w-3xl gap-8 wrap-anywhere">
      <AgentSettingsPageHeader
        description={m.agent_settings_computer_description()}
        id="computer-heading"
        title={m.agents_status_computer()}
      />
      {agent.computer ? (
        <section aria-label={m.computer_agent_location()} className="grid gap-4">
          <ComputerIdentity
            computer={{ ...agent.computer, kind: agent.computerKind }}
            connection={connection}
            lastSeenAt={machine.lastConfirmedAt}
          />
          {connection === "offline" ? (
            <p className="max-w-prose text-sm text-kumo-subtle">{m.computer_agent_offline()}</p>
          ) : null}
          <Link
            {...accountComputerLink(agent.computer.computerId, agent.id)}
            className={buttonClassName({ variant: "secondary", size: "compact", className: "w-fit" })}
          >
            {actionLabel}
          </Link>
        </section>
      ) : (
        <section aria-labelledby="computer-choice-heading" className="grid gap-4">
          <Text as="h2" id="computer-choice-heading" variant="heading">
            {m.agent_settings_computer_none_heading()}
          </Text>
          <p className="max-w-prose text-sm text-kumo-subtle">{m.computer_agent_unbound()}</p>
          <AgentComputerChoice agentId={agent.id} autoBindSole={false} onBound={onAgentChanged} />
        </section>
      )}
    </div>
  );
}

/**
 * The bound Computer's kind could not be confirmed. "Unconfirmed" is the Account's Computers read
 * having failed, so retrying re-reads that inventory as well as the Agent — syncing the Agent
 * alone never touches the read that failed.
 */
function UnconfirmedComputerSettings({
  computer,
  onAgentChanged,
}: {
  computer: NonNullable<AgentDetailView["computer"]>;
  onAgentChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const retry = () => {
    onAgentChanged();
    void queryClient.invalidateQueries({ queryKey: queryKeys.computers() });
  };
  return (
    <div className="grid gap-4">
      <Text as="h2" variant="heading">
        {computer.displayName}
      </Text>
      <StatusIndicator label={m.computer_status_unavailable()} tone="neutral" />
      <div>
        <Button type="button" variant="secondary" onClick={retry}>
          {m.common_try_again()}
        </Button>
      </div>
    </div>
  );
}

function computerConnection(agent: AgentDetailView): ComputerConnection {
  const state = agent.availability.dependencies.computer.state;
  if (state === "unconfirmed") return "unconfirmed";
  if (agent.computerConnectionStatus === "disconnected") return "disconnected";
  if (state === "ready") return "online";
  return state === "action_required" ? "offline" : "unconfirmed";
}

function computerActionLabel(connection: ComputerConnection): string {
  if (connection === "disconnected") return m.computer_reconnect();
  if (connection === "offline") return m.computer_recovery_heading();
  return m.computer_manage();
}
