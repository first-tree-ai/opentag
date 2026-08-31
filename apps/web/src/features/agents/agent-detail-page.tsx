import { Link } from "@tanstack/react-router";
import { initials } from "../../i18n/format.js";
import { buttonClassName, Icon, StatusIndicator, Text } from "../../ui/design-system.js";
import { AgentUsageOverview } from "../agent-usage.js";
import { AsyncState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import { AgentTasksSection } from "../tasks-page.js";
import type { AgentDetailView } from "./agent-model.js";
import {
  type AgentDependencyStatus,
  agentAvailabilityRecovery,
  agentComputerStatus,
  agentMessagingStatus,
  agentRecoveryMessage,
  agentStatusPresentation,
  messagingChannelLabel,
  platformLabel,
} from "./agent-presentation.js";
import { useAgentDetailView } from "./agent-queries.js";
import { agentDetailLink, agentSettingsLink, agentSettingsSectionLink } from "./agent-routes.js";

export function AgentDetailPage({ agentId }: { agentId: string }) {
  const state = useAgentDetailView(agentId, { watched: true });
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="grid gap-6">
          <AgentObjectHeader agent={agent} />
          <div className="grid gap-6">
            <AgentLifecycleNotice agent={agent} />
            {/*
             * Usage and Connection share a row: neither fills the width on its own, and a failed
             * dependency belongs beside the work it is stopping rather than in a banner above it.
             */}
            <div className="grid gap-6 @min-[48rem]/workspace:grid-cols-2">
              <AgentUsageOverview agent={agent} agentId={agent.id} />
              <AgentConnectionCard agent={agent} />
            </div>
            <AgentTasksSection agentId={agent.id} />
          </div>
        </section>
      )}
    </AsyncState>
  );
}

export function AgentObjectHeader({ agent, backToSettings }: { agent: AgentDetailView; backToSettings?: boolean }) {
  const { me } = useAccount();
  const showCreator = agent.createdBy.userId !== me.user.id;
  /*
   * The handle addresses the Agent in Feishu, where each Agent has its own bot. Slack routes one
   * workspace Bot, so showing a per-Agent handle there names something nobody can address.
   */
  const handle =
    agent.messaging.kind === "ready" && agent.messaging.value?.provider === "slack" ? undefined : agent.name;
  return (
    <header className="grid gap-4">
      <Link
        className="inline-flex w-fit items-center gap-2 text-sm text-kumo-link"
        {...(backToSettings ? agentDetailLink(agent.id) : ({ to: "/agents" } as const))}
      >
        <Icon name="arrow-left" />
        {backToSettings ? agent.displayName : "Agents"}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="grid size-10 shrink-0 place-items-center rounded-full bg-kumo-tint font-semibold"
            aria-hidden="true"
          >
            {initials(agent.displayName)}
          </span>
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <Text as="h1" size="lg" variant="heading">
                {agent.displayName}
              </Text>
              <AgentAvailabilityAction agent={agent} />
            </div>
            <p className="flex flex-wrap items-center gap-3 text-sm text-kumo-subtle">
              {handle ? <span>@{handle}</span> : null}
              {showCreator ? <span>Created by {agent.createdBy.displayName}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!backToSettings ? (
            <Link
              className={buttonClassName({ variant: "secondary" })}
              state={{ agent }}
              {...agentSettingsLink(agent.id)}
            >
              <Icon name="settings" /> Settings
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/**
 * Computer and Messaging, side by side, each carrying its own status and its own repair exit. One
 * card rather than two: they are the pair an Agent needs before it can do anything, and reading
 * them together is how a viewer answers "can this Agent work" without holding two cards in mind.
 */
export function AgentConnectionCard({ agent }: { agent: AgentDetailView }) {
  const computer = agentComputerStatus(agent);
  const messaging = agentMessagingStatus(agent);
  const binding = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  return (
    <section
      className="grid content-start gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      aria-labelledby="agent-connection-heading"
      data-ui="connection-overview"
    >
      <Text as="h2" id="agent-connection-heading" variant="heading">
        Connection
      </Text>
      <ConnectionRow
        agent={agent}
        identity={`${agent.computer.displayName} · ${platformLabel(agent.computer.platform)}`}
        name="Computer"
        status={computer}
      />
      <ConnectionRow
        agent={agent}
        identity={binding ? messagingChannelLabel(agent, binding) : undefined}
        name="Messaging"
        status={messaging}
      />
    </section>
  );
}

function ConnectionRow({
  agent,
  identity,
  name,
  status,
}: {
  agent: AgentDetailView;
  identity?: string;
  name: string;
  status: AgentDependencyStatus;
}) {
  return (
    <div className="grid gap-1 border-t border-kumo-line pt-3" data-ui={`connection-${name.toLowerCase()}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">{name}</strong>
        <StatusIndicator label={status.label} tone={status.tone} />
      </div>
      {identity ? <p className="truncate text-sm text-kumo-subtle">{identity}</p> : null}
      {status.detail ? <p className="text-sm text-kumo-subtle">{status.detail}</p> : null}
      {status.action ? (
        <Link
          className="w-fit text-sm text-kumo-link"
          state={{ agent }}
          {...agentSettingsSectionLink(agent.id, status.action.section)}
        >
          {status.action.label}
        </Link>
      ) : null}
    </div>
  );
}

export function AgentAvailabilityAction({ agent }: { agent: AgentDetailView }) {
  /*
   * Only while the Agent is healthy. A failed dependency is already named, with its own exit, by
   * the Connection card below, and saying it twice reads as two problems. A paused Agent is not a
   * dependency failure and no card speaks for it, so it gets the notice beneath this header.
   */
  if (agent.availability.state !== "ready") return null;
  const status = agentStatusPresentation(agent);
  return (
    <div className="inline-flex">
      <StatusIndicator label={status.label} tone={status.tone} />
    </div>
  );
}

/**
 * The Agent's own lifecycle, which no dependency row can carry. Computer and Messaging state their
 * own failures in the Connection card, but a paused Agent has nothing wrong with either -- it was
 * turned off -- so without this the home reports a healthy Computer and channel and never mentions
 * that the Agent is not running.
 */
export function AgentLifecycleNotice({ agent }: { agent: AgentDetailView }) {
  if (agent.availability.state !== "suspended") return null;
  const status = agentStatusPresentation(agent);
  const recovery = agentAvailabilityRecovery(agent);
  return (
    <section
      className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-kumo-tint p-4"
      aria-label={`Agent status: ${status.label}`}
      data-ui="agent-lifecycle-notice"
    >
      <div className="grid gap-1">
        <StatusIndicator label={status.label} tone={status.tone} />
        <p className="text-sm text-kumo-subtle">{agentRecoveryMessage(agent)}</p>
      </div>
      {recovery ? (
        <Link
          className={buttonClassName({ size: "compact", variant: "secondary" })}
          state={{ agent }}
          {...recovery.link}
        >
          {recovery.label}
        </Link>
      ) : null}
    </section>
  );
}
