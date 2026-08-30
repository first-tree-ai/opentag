import { Link } from "@tanstack/react-router";
import { buttonClassName, Icon, StatusIndicator, Text } from "../../ui/design-system.js";
import { AsyncState, useResource } from "../resource/use-resource.js";
import { useAccount } from "../session/session-context.js";
import type { AgentDetailView } from "./agent-model.js";
import { loadAgentDetail, markAgentDetailUnconfirmed } from "./agent-model.js";
import {
  agentAvailabilityRecovery,
  agentRecoveryMessage,
  agentStatusPresentation,
  agentUseInstruction,
  formatRelativeTime,
  initials,
  titleCase,
} from "./agent-presentation.js";
import { agentDetailLink, agentSettingsLink, agentSettingsSectionLink, agentUsageLink } from "./agent-routes.js";

export function AgentDetailPage({ agentId }: { agentId: string }) {
  const state = useResource(() => loadAgentDetail(agentId), agentId, {
    onBackgroundError: markAgentDetailUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="grid gap-6">
          <AgentObjectHeader agent={agent} />
          <div className="grid gap-6">
            {agent.availability.state !== "ready" ? <AgentRecoveryBanner agent={agent} /> : null}
            <AgentCurrentActivity agent={agent} />
            <AgentContact agent={agent} />
          </div>
        </section>
      )}
    </AsyncState>
  );
}

export function AgentObjectHeader({ agent, backToSettings }: { agent: AgentDetailView; backToSettings?: boolean }) {
  const { me } = useAccount();
  const showCreator = agent.createdBy.userId !== me.user.id;
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
            <p>
              <span>@{agent.name}</span>
              {showCreator ? <span>Created by {agent.createdBy.displayName}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!backToSettings ? (
            <Link className="text-sm text-kumo-link" state={{ agent }} {...agentUsageLink(agent.id)}>
              Usage
            </Link>
          ) : null}
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

export function AgentRecoveryBanner({ agent }: { agent: AgentDetailView }) {
  const recovery = agentAvailabilityRecovery(agent);
  const status = agentStatusPresentation(agent);
  return (
    <section
      className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-kumo-danger-tint p-4"
      aria-label={`Agent status: ${status.label}`}
    >
      <div>
        <strong>{status.label}</strong>
        <p>{agentRecoveryMessage(agent)}</p>
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

export function AgentCurrentActivity({ agent }: { agent: AgentDetailView }) {
  return (
    <section
      className="grid gap-3 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      aria-labelledby="current-activity-heading"
    >
      <header className="flex items-center justify-between gap-3">
        <Text as="h2" id="current-activity-heading" variant="heading">
          Current work
        </Text>
      </header>
      {agent.activity.state === "working" ? (
        <div className="flex items-center gap-3">
          <span className="size-3 rounded-full bg-kumo-brand" aria-hidden="true" />
          <div>
            <strong>Handling a request</strong>
            <p>Started {formatRelativeTime(agent.activity.startedAt)}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-kumo-subtle">
          <strong>No active work</strong>
        </p>
      )}
    </section>
  );
}

export function AgentContact({ agent }: { agent: AgentDetailView }) {
  const binding = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  return (
    <section
      className="grid gap-3 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      aria-labelledby="agent-contact-heading"
    >
      <header className="flex items-center justify-between gap-3">
        <Text as="h2" id="agent-contact-heading" variant="heading">
          Messaging
        </Text>
      </header>
      {agent.messaging.kind === "unconfirmed" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-kumo-recessed p-3">
          <span className="grid size-8 place-items-center rounded-full bg-kumo-tint" aria-hidden="true">
            ?
          </span>
          <span className="grid min-w-0 flex-1 gap-1">
            <strong>Unable to confirm messaging</strong>
            <small>Try again shortly</small>
          </span>
        </div>
      ) : binding ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-kumo-recessed p-3">
          <span className="grid size-8 place-items-center rounded-full bg-kumo-tint" aria-hidden="true">
            {titleCase(binding.provider).charAt(0)}
          </span>
          <span className="grid min-w-0 flex-1 gap-1">
            <strong>
              {titleCase(binding.provider)} · @{agent.name}
            </strong>
            <small>{agentUseInstruction(agent, binding.provider)}</small>
          </span>
          <Link
            className={buttonClassName({ size: "compact", variant: "outline" })}
            state={{ agent, returnAgentId: agent.id, returnLabel: agent.displayName }}
            {...agentSettingsSectionLink(agent.id, "messaging")}
          >
            Manage
          </Link>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-kumo-recessed p-3">
          <span className="grid size-8 place-items-center rounded-full bg-kumo-tint" aria-hidden="true">
            +
          </span>
          <span className="grid min-w-0 flex-1 gap-1">
            <strong>No messaging connected</strong>
            <small>Connect Feishu or Slack to start sending work</small>
          </span>
          <Link
            className={buttonClassName({ size: "compact", variant: "outline" })}
            state={{ returnAgentId: agent.id, returnLabel: agent.displayName }}
            {...agentSettingsSectionLink(agent.id, "messaging")}
          >
            Connect
          </Link>
        </div>
      )}
    </section>
  );
}

export function AgentAvailabilityAction({ agent }: { agent: AgentDetailView }) {
  const status = agentStatusPresentation(agent);
  return (
    <div className="inline-flex">
      <StatusIndicator label={status.label} tone={status.tone} />
    </div>
  );
}
