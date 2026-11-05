import { Link } from "@tanstack/react-router";
import * as m from "../../paraglide/messages.js";
import { buttonClassName, Icon, StatusIndicator, Text } from "../../ui/design-system.js";
import { AgentUsageOverview } from "../agent-usage.js";
import { ImFeedbackList } from "../im-feedback-list.js";
import { AsyncState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import { AgentTasksSection } from "../tasks-page.js";
import { AgentAvatar } from "./agent-avatar.js";
import type { AgentDetailView } from "./agent-model.js";
import { agentCardStatus, agentMessagingStatus } from "./agent-presentation.js";
import { useAgentDetailView } from "./agent-queries.js";
import { agentDetailLink, agentSettingsLink } from "./agent-routes.js";
import { AgentSchedulesSection } from "./agent-schedules-section.js";
import { AgentStatusCard } from "./agent-status-card.js";
import { CloudWorkspaceRecovery } from "./cloud/cloud-workspace-recovery.js";
import { ResumeAgentButton } from "./resume-agent-button.js";

export function AgentDetailPage({
  agentId,
  scheduleId,
  workspaceRecovery,
}: {
  agentId: string;
  scheduleId?: string;
  workspaceRecovery?: boolean;
}) {
  const { me } = useAccount();
  const state = useAgentDetailView(agentId, { watched: true, accountId: me.user.id });
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="grid gap-6">
          <AgentObjectHeader agent={agent} showBackLink={false} showHandle={false} showOverviewStatus />
          <div className="grid gap-6">
            {/*
             * Usage and status share a row: neither fills the width on its own, and a failed
             * dependency belongs beside the work it is stopping rather than in a banner above it.
             */}
            <div className="grid gap-6 min-[951px]:grid-cols-2">
              <AgentUsageOverview accountId={me.user.id} agentId={agent.id} />
              <AgentStatusCard agent={agent} />
            </div>
            {agent.computerKind === "cloud" ? (
              <CloudWorkspaceRecovery key={agent.id} agentId={agent.id} initialOpen={workspaceRecovery} />
            ) : null}
            <AgentSchedulesSection agentId={agent.id} scheduleId={scheduleId} />
            <AgentTasksSection agentId={agent.id} connectChannel={connectChannelAction(agent)} />
            <ImFeedbackList agentId={agent.id} />
          </div>
        </section>
      )}
    </AsyncState>
  );
}

const HEADER_LAYOUT = {
  overview: {
    root: "@container/agent-header grid gap-4",
    content: "grid items-start gap-x-3 gap-y-1.5 @min-[24rem]/agent-header:grid-cols-[minmax(0,1fr)_auto]",
    identity: "flex min-w-0 items-start gap-3",
    actions:
      "flex flex-wrap items-center justify-self-end gap-3 @min-[24rem]/agent-header:col-start-2 @min-[24rem]/agent-header:row-start-1",
  },
  legacy: {
    root: "grid gap-4",
    content: "flex flex-wrap items-start justify-between gap-4",
    identity: "flex min-w-0 flex-1 basis-64 items-start gap-4",
    actions: "ml-auto flex shrink-0 flex-wrap items-center justify-end gap-3",
  },
} as const;

function agentHeaderHandle(agent: AgentDetailView, showHandle: boolean) {
  if (!showHandle || (agent.messaging.kind === "ready" && agent.messaging.value?.provider === "slack"))
    return undefined;
  return agent.name;
}

export function AgentObjectHeader({
  agent,
  backToSettings,
  showBackLink = true,
  showHandle = true,
  showOverviewStatus = false,
}: {
  agent: AgentDetailView;
  backToSettings?: boolean;
  showBackLink?: boolean;
  showHandle?: boolean;
  showOverviewStatus?: boolean;
}) {
  const { me } = useAccount();
  const showCreator = agent.createdBy.userId !== me.user.id;
  /*
   * Legacy capability pages retain their internal identity hint. The overview uses the
   * connected Bot's identity in its Messaging row instead of implying this handle is an IM address.
   */
  const handle = agentHeaderHandle(agent, showHandle);
  const layout = showOverviewStatus ? HEADER_LAYOUT.overview : HEADER_LAYOUT.legacy;
  return (
    <header className={layout.root}>
      {showBackLink ? (
        <Link
          className="inline-flex w-fit items-center gap-2 text-sm text-kumo-link"
          {...(backToSettings ? agentDetailLink(agent.id) : ({ to: "/agents" } as const))}
        >
          <Icon name="arrow-left" />
          {backToSettings ? agent.displayName : m.agents_title()}
        </Link>
      ) : null}
      <div className={layout.content}>
        <div className={layout.identity}>
          <AgentAvatar displayName={agent.displayName} avatarPath={agent.avatarPath} className="size-11" />
          <div className="grid min-w-0 gap-1.5">
            {/* A long name keeps the header to two lines; the full name stays in the heading's text
                and title, and in settings. */}
            <Text as="h1" DANGEROUS_className="wrap-anywhere line-clamp-2" size="lg" variant="heading">
              <span title={agent.displayName}>{agent.displayName}</span>
            </Text>
            {showHandle || showCreator ? (
              <p className="flex flex-wrap items-center gap-3 text-sm text-kumo-subtle">
                {handle ? <span className="min-w-0 wrap-anywhere">@{handle}</span> : null}
                {showCreator ? <span>{m.agents_created_by({ name: agent.createdBy.displayName })}</span> : null}
              </p>
            ) : null}
          </div>
        </div>
        {showOverviewStatus ? (
          <div className="min-w-0 pl-14 @min-[24rem]/agent-header:col-span-2">
            <AgentOverviewStatus agent={agent} />
          </div>
        ) : null}
        <div className={layout.actions}>
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

/** Reuse the roster's canonical verdict; activity supplements readiness only while actually working. */
function AgentOverviewStatus({ agent }: { agent: AgentDetailView }) {
  const status = agentCardStatus({ ...agent, evidenceConfirmed: agent.availability.state !== "unconfirmed" });
  const detail =
    agent.availability.state === "ready" && status.tone === "success" && agent.activity.state === "working"
      ? status.detail
      : undefined;
  const paused = agent.status === "suspended";
  return (
    <section
      className="grid min-w-0 gap-1.5 text-sm font-normal"
      aria-label={m.agents_lifecycle_aria({ status: status.label })}
      data-ui="agent-overview-status"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <StatusIndicator
          className="min-w-0 flex-wrap text-sm font-normal"
          label={<span className="whitespace-normal text-sm font-normal">{status.label}</span>}
          detail={detail ? <span data-ui="agent-overview-activity">{detail}</span> : undefined}
          tone={status.tone}
        />
        {paused ? <ResumeAgentButton agentId={agent.id} /> : null}
      </div>
      {paused ? <p className="text-kumo-subtle">{m.agent_settings_status_paused_description()}</p> : null}
    </section>
  );
}

/** The status card's own way to connect messaging, offered again where the empty Task list asks for work. */
function connectChannelAction(agent: AgentDetailView) {
  if (agent.messaging.kind !== "ready" || agent.messaging.value) return undefined;
  return agentMessagingStatus(agent).action;
}
