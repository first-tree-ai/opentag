import { Link } from "@tanstack/react-router";
import { initials } from "../../i18n/format.js";
import { buttonClassName, Icon, StatusIndicator, Text } from "../../ui/design-system.js";
import { ProviderIcon } from "../../ui/provider-icon.js";
import { AgentUsageOverview } from "../agent-usage.js";
import { AsyncState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import { AgentTasksSection } from "../tasks-page.js";
import type { AgentDetailView } from "./agent-model.js";
import {
  agentAvailabilityRecovery,
  agentRecoveryMessage,
  agentStatusPresentation,
  messagingChannelLabel,
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
            {agent.availability.state !== "ready" ? <AgentRecoveryBanner agent={agent} /> : null}
            <AgentUsageOverview agent={agent} agentId={agent.id} />
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
          {!backToSettings ? <AgentMessagingLink agent={agent} /> : null}
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

export function AgentAvailabilityAction({ agent }: { agent: AgentDetailView }) {
  /*
   * Only while the Agent is healthy. Every other state is already named, with its recovery exit, by
   * the banner directly beneath this header, and saying it twice reads as two problems.
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
 * One affordance for messaging, beside Settings. It always opens messaging settings, so a missing
 * binding and unreadable evidence keep their entry point rather than disappearing.
 */
function AgentMessagingLink({ agent }: { agent: AgentDetailView }) {
  const binding = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  const label = binding
    ? messagingChannelLabel(agent, binding)
    : agent.messaging.kind === "unconfirmed"
      ? "Messaging status unavailable"
      : "Connect messaging";
  return (
    <Link
      aria-label={label}
      className="grid size-9 place-items-center rounded-md text-kumo-subtle ring ring-kumo-line"
      state={{ agent, returnAgentId: agent.id, returnLabel: agent.displayName }}
      title={label}
      {...agentSettingsSectionLink(agent.id, "messaging")}
    >
      {binding ? <ProviderIcon className="size-5" provider={binding.provider} /> : <Icon name="message" />}
    </Link>
  );
}
