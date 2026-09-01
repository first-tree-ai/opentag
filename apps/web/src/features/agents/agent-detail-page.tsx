import { Link } from "@tanstack/react-router";
import { initials } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
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
          <AgentObjectHeader agent={agent} showBackLink={false} />
          <div className="grid gap-6">
            <AgentLifecycleNotice agent={agent} />
            {/*
             * Usage and status share a row: neither fills the width on its own, and a failed
             * dependency belongs beside the work it is stopping rather than in a banner above it.
             */}
            <div className="grid gap-6 @min-[48rem]/workspace:grid-cols-2">
              <AgentUsageOverview agentId={agent.id} />
              <AgentStatusCard agent={agent} />
            </div>
            <AgentTasksSection agentId={agent.id} />
          </div>
        </section>
      )}
    </AsyncState>
  );
}

export function AgentObjectHeader({
  agent,
  backToSettings,
  showBackLink = true,
}: {
  agent: AgentDetailView;
  backToSettings?: boolean;
  showBackLink?: boolean;
}) {
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
      {showBackLink ? (
        <Link
          className="inline-flex w-fit items-center gap-2 text-sm text-kumo-link"
          {...(backToSettings ? agentDetailLink(agent.id) : ({ to: "/agents" } as const))}
        >
          <Icon name="arrow-left" />
          {backToSettings ? agent.displayName : m.agents_title()}
        </Link>
      ) : null}
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
              {showCreator ? <span>{m.agents_created_by({ name: agent.createdBy.displayName })}</span> : null}
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
              <Icon name="settings" /> {m.agents_settings()}
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/**
 * The two user-facing conditions an Agent needs before it can do work. Runtime readiness stays
 * folded into Computer: it is part of the execution environment, and only needs to be named when
 * it changes that row's status or recovery action.
 */
export function AgentStatusCard({ agent }: { agent: AgentDetailView }) {
  const computer = agentComputerStatus(agent);
  const messaging = agentMessagingStatus(agent);
  const binding = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  const runtimeName = agent.runtimeProvider === "codex" ? "Codex" : "Claude Code";
  return (
    <section
      className="grid rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      aria-label={m.agents_status_region()}
      data-ui="agent-status-overview"
    >
      <ul className="grid h-full list-none grid-rows-2">
        <AgentStatusRow
          agent={agent}
          dependency="computer"
          // No Computer, no identity line -- the row already says so in its status, and naming
          // nothing would leave a bare separator where a machine should be. `identity` is
          // optional for exactly this: the messaging row below omits it the same way.
          identity={
            agent.computer
              ? m.agents_computer_identity({
                  name: agent.computer.displayName,
                  platform: platformLabel(agent.computer.platform),
                  runtime: runtimeName,
                })
              : undefined
          }
          name={m.agents_status_computer()}
          status={computer}
        />
        <AgentStatusRow
          agent={agent}
          dependency="messaging"
          identity={binding ? messagingChannelLabel(agent, binding) : undefined}
          name={m.agents_status_message_channel()}
          status={messaging}
        />
      </ul>
    </section>
  );
}

function AgentStatusRow({
  agent,
  dependency,
  identity,
  name,
  status,
}: {
  agent: AgentDetailView;
  dependency: "computer" | "messaging";
  identity?: string;
  name: string;
  status: AgentDependencyStatus;
}) {
  const isMessaging = dependency === "messaging";
  const rowClassName = isMessaging
    ? "grid content-center gap-2 border-t border-kumo-line pt-4"
    : "grid content-center gap-2 pb-4";
  const dataUi = isMessaging ? "agent-status-message-channel" : "agent-status-computer";
  return (
    <li className={rowClassName} data-ui={dataUi}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <strong className="text-sm font-semibold text-kumo-strong">{name}</strong>
        <span
          className="inline-flex items-center gap-1.5 text-sm font-medium text-kumo-default"
          data-state={status.tone}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full bg-current ${dependencyStatusClassName(status.tone)}`}
          />
          {status.label}
        </span>
      </div>
      {identity || status.action ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
          {identity ? <span className="min-w-0 flex-1 truncate text-sm text-kumo-subtle">{identity}</span> : null}
          {status.action ? (
            <Link
              className="ml-auto inline-flex w-fit shrink-0 items-center gap-1 text-sm text-kumo-link"
              state={{ agent, returnAgentId: agent.id, returnLabel: agent.displayName }}
              {...agentSettingsSectionLink(agent.id, status.action.section)}
            >
              {status.action.label}
              <Icon className="size-3.5" name="chevron-right" />
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function dependencyStatusClassName(tone: AgentDependencyStatus["tone"]): string {
  if (tone === "success") return "text-kumo-success";
  if (tone === "warning") return "text-kumo-warning";
  if (tone === "danger") return "text-kumo-danger";
  if (tone === "info") return "text-kumo-subtle";
  return "text-kumo-subtle";
}

export function AgentAvailabilityAction({ agent }: { agent: AgentDetailView }) {
  /*
   * Only while the Agent is healthy. A failed dependency is already named, with its own exit, by
   * the status card below, and saying it twice reads as two problems. A paused Agent is not a
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
 * own failures in the status card, but a paused Agent has nothing wrong with either -- it was
 * turned off -- so without this the home reports a healthy Computer and channel and never mentions
 * that the Agent is not running.
 */
export function AgentLifecycleNotice({ agent }: { agent: AgentDetailView }) {
  if (agent.availability.state !== "suspended") return null;
  const status = agentStatusPresentation(agent);
  const recovery = agentAvailabilityRecovery(agent);
  return (
    <section
      className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-kumo-recessed p-4 ring ring-kumo-line"
      aria-label={m.agents_lifecycle_aria({ status: status.label })}
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
