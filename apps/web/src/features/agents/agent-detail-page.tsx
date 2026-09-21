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
  agentRuntimeIssue,
  agentStatusPresentation,
  messagingChannelLabel,
  platformLabel,
} from "./agent-presentation.js";
import { useAgentDetailView } from "./agent-queries.js";
import { agentDetailLink, agentSettingsLink } from "./agent-routes.js";
import { AgentCloudOverviewPanel } from "./cloud/cloud-environment.js";

export function AgentDetailPage({ agentId }: { agentId: string }) {
  const { me } = useAccount();
  const state = useAgentDetailView(agentId, { watched: true, accountId: me.user.id });
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
            <div className="grid gap-6 @min-[48rem]/content:grid-cols-2">
              <AgentUsageOverview accountId={me.user.id} agentId={agent.id} />
              <AgentStatusCard agent={agent} />
            </div>
            {/* The Cloud board is the Agent page's environment truth; a Local Agent never renders it. */}
            {agent.computerKind === "cloud" ? <AgentCloudOverviewPanel agentId={agent.id} /> : null}
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
 * Connection and messaging stay visible; runtime only appears when it needs attention.
 */
export function AgentStatusCard({ agent }: { agent: AgentDetailView }) {
  const computer = agentComputerStatus(agent);
  const messaging = agentMessagingStatus(agent);
  const runtime = agentRuntimeIssue(agent);
  const binding = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  return (
    <section
      className="grid rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      aria-label={m.agents_status_region()}
      data-ui="agent-status-overview"
    >
      <ul className="grid h-full list-none divide-y divide-kumo-line">
        <AgentStatusRow
          agent={agent}
          dependency="computer"
          // No Computer, no identity line -- the row already says so in its status, and naming
          // nothing would leave a bare separator where a machine should be. `identity` is
          // optional for exactly this: the messaging row below omits it the same way.
          identity={
            agent.computer ? `${agent.computer.displayName} · ${platformLabel(agent.computer.platform)}` : undefined
          }
          name={m.agents_status_computer()}
          status={computer}
        />
        {runtime ? (
          <li className="grid gap-2 py-4 wrap-anywhere" data-ui="agent-status-runtime">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium" data-state={runtime.tone}>
                <span
                  aria-hidden="true"
                  className={`size-1.5 shrink-0 rounded-full bg-current ${dependencyStatusClassName(runtime.tone)}`}
                />
                {runtime.label}
              </span>
              {runtime.action ? (
                <Link className="inline-flex items-center gap-1 text-sm text-kumo-link" {...runtime.action.link}>
                  {runtime.action.label}
                  <Icon className="size-3.5" name="chevron-right" />
                </Link>
              ) : null}
            </div>
            {runtime.guidance ? <p className="text-sm text-kumo-subtle">{runtime.guidance}</p> : null}
          </li>
        ) : null}
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
  const rowClassName = "grid content-center gap-2 py-4 first:pt-0 last:pb-0";
  const dataUi = dependency === "messaging" ? "agent-status-message-channel" : "agent-status-computer";
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
              {...status.action.link}
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
        <p className="text-sm text-kumo-subtle">{agentRecoveryMessage()}</p>
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
