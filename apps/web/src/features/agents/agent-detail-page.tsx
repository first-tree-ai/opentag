import { Link } from "@tanstack/react-router";
import * as m from "../../paraglide/messages.js";
import { buttonClassName, Icon, StatusIndicator, Text } from "../../ui/design-system.js";
import { AgentUsageOverview } from "../agent-usage.js";
import { AsyncState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import { AgentTasksSection } from "../tasks-page.js";
import { AgentAvatar } from "./agent-avatar.js";
import type { AgentDetailView } from "./agent-model.js";
import { agentAvailabilityRecovery, agentRecoveryMessage, agentStatusPresentation } from "./agent-presentation.js";
import { useAgentDetailView } from "./agent-queries.js";
import { agentDetailLink, agentSettingsLink } from "./agent-routes.js";
import { AgentSchedulesSection } from "./agent-schedules-section.js";
import { AgentStatusCard } from "./agent-status-card.js";
import { CloudProgressNotice } from "./cloud/cloud-progress-notice.js";

export function AgentDetailPage({ agentId, scheduleId }: { agentId: string; scheduleId?: string }) {
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
            <div className="grid gap-6 min-[951px]:grid-cols-2">
              <AgentUsageOverview accountId={me.user.id} agentId={agent.id} />
              <AgentStatusCard agent={agent} />
            </div>
            {agent.computerKind === "cloud" ? <CloudProgressNotice agentId={agent.id} /> : null}
            <AgentSchedulesSection agentId={agent.id} scheduleId={scheduleId} />
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
   * The handle addresses the Agent in Feishu, where each Agent has its own bot. Slack uses the bound Bot identity,
   * which can differ from the Agent handle.
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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-4">
          <AgentAvatar displayName={agent.displayName} avatarPath={agent.avatarPath} className="size-11" />
          <div className="grid min-w-0 gap-1.5">
            <Text as="h1" DANGEROUS_className="wrap-anywhere" size="lg" variant="heading">
              {agent.displayName}
            </Text>
            <p className="flex flex-wrap items-center gap-3 text-sm text-kumo-subtle">
              {handle ? <span className="min-w-0 wrap-anywhere">@{handle}</span> : null}
              {showCreator ? <span>{m.agents_created_by({ name: agent.createdBy.displayName })}</span> : null}
            </p>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-3">
          {!backToSettings ? (
            <Link
              className={buttonClassName({ variant: "outline" })}
              state={{ agent }}
              {...agentSettingsLink(agent.id)}
            >
              {m.agents_settings()}
            </Link>
          ) : null}
        </div>
      </div>
    </header>
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
        <Link className={buttonClassName({ size: "compact", variant: "outline" })} state={{ agent }} {...recovery.link}>
          {recovery.label}
        </Link>
      ) : null}
    </section>
  );
}
