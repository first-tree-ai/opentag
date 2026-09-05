import { formatDateTime, formatRelativeTime } from "../../../i18n/format.js";
import * as m from "../../../paraglide/messages.js";
import { Icon, StatusIndicator, type StatusTone, Text } from "../../../ui/design-system.js";
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
      <AgentSettingsPageHeader
        description={m.agent_settings_computer_description()}
        id="computer-heading"
        title={m.agents_status_computer()}
      />
      <section aria-labelledby="computer-heading" className="grid gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <Text as="h2" variant="heading">
            {m.agent_settings_computer_none_heading()}
          </Text>
          <StatusIndicator label={m.agent_settings_computer_none_status()} tone="warning" />
        </header>
        <div className="grid gap-4">
          <p>{computerRecoveryMessage(agent)}</p>
          <AgentComputerChoice agentId={agent.id} onBound={onAgentChanged} />
        </div>
      </section>
    </div>
  );
}

/** The whole status line under the Computer's name: what state it is in, and how stale that is. */
function computerStatusLine(agent: AgentDetailView): {
  readonly lastSeen: string | undefined;
  readonly label: string;
  readonly ready: boolean;
  readonly tone: StatusTone;
} {
  const computerState = agent.availability.dependencies.computer;
  const runtimeUnavailable = agent.availability.reason === "runtime_unavailable";
  // A reachable Computer that cannot run this Agent's Provider is not "Online" for this Agent.
  const ready = computerState.state === "ready" && !runtimeUnavailable;
  const blocked = computerState.state === "action_required" || runtimeUnavailable;
  const label = ready
    ? m.agent_settings_computer_online()
    : blocked
      ? runtimeUnavailable
        ? m.agent_settings_computer_not_ready()
        : m.agent_settings_computer_offline()
      : m.agent_settings_computer_unconfirmed();
  // Last seen answers "how stale is Offline", so a Computer that is online now has nothing to add.
  const staleFor = ready ? null : computerState.lastConfirmedAt;
  return {
    lastSeen: staleFor
      ? m.agent_settings_last_seen({ date: formatDateTime(staleFor), relative: formatRelativeTime(staleFor) })
      : undefined,
    label,
    ready,
    tone: ready ? "success" : blocked ? "warning" : "neutral",
  };
}

export function AgentComputerSettings({
  agent,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  onAgentChanged: () => void;
}) {
  const computerState = agent.availability.dependencies.computer;
  const { lastSeen, label, ready, tone } = computerStatusLine(agent);
  const recovery = computerRecoveryMessage(agent);
  if (!agent.computer) return <AgentComputerBinding agent={agent} onAgentChanged={onAgentChanged} />;
  return (
    <div className="grid gap-6">
      <AgentSettingsPageHeader
        description={m.agent_settings_computer_description()}
        id="computer-heading"
        title={m.agents_status_computer()}
      />
      {/*
       * Two groups, and the gaps are what say so: what this machine is and why it cannot work sit
       * together at 12px, and the step that fixes it stands apart at 24px. Spacing them alike made
       * the panel one undifferentiated column of sentences.
       */}
      <section aria-labelledby="computer-device-heading" className="grid gap-6">
        <div className="grid gap-3">
          <header className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3" data-ui="computer-identity">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint">
              <Icon name="laptop" />
            </span>
            {/* Status sits under the name it describes, carrying last seen as its own detail: the
                two are one fact about this machine, and split across the row they read as two. */}
            <div className="grid min-w-0 gap-1">
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
              <StatusIndicator
                detail={lastSeen ? <span className="text-xs opacity-80">{lastSeen}</span> : undefined}
                label={label}
                tone={tone}
              />
            </div>
          </header>
          {/* The sentence explains the badge directly above it, so it belongs to that group. */}
          {ready ? null : <p>{recovery}</p>}
        </div>
        {/* Re-enrolment only answers an unreachable Computer; a missing Provider needs the Provider
            installed, so offering it there would send an operator down a dead path. */}
        {!ready && computerState.state === "action_required" ? (
          <AgentComputerRepair
            computer={agent.computer}
            key={agent.computer.computerId}
            onAgentChanged={onAgentChanged}
          />
        ) : null}
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
  return (
    // One group at the connect step's own 12px rhythm: the heading, the command, and its status.
    <section aria-labelledby="computer-repair-heading" className="grid gap-3">
      {/* The heading names the step and nothing else: the machine is two rows above, and what the
          command does is the command block's own comment. */}
      <Text as="h3" id="computer-repair-heading" variant="heading">
        {m.computer_connect_repair_title()}
      </Text>
      <ComputerConnect
        intent={{
          mode: "repair",
          target: { computerId: computer.computerId, displayName: computer.displayName },
        }}
        onConnected={onAgentChanged}
      />
    </section>
  );
}
