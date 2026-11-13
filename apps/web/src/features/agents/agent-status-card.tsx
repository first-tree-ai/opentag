import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Icon, Popover } from "../../ui/design-system.js";
import type { AgentDetailView } from "./agent-model.js";
import {
  type AgentDependencyStatus,
  agentActivityDetail,
  agentComputerStatus,
  agentMessagingStatus,
  agentRuntimeIssue,
  messagingChannelLabel,
  platformLabel,
  runtimeProviderName,
} from "./agent-presentation.js";

/**
 * What the Agent is doing, when there is something to say, then its two dependencies with two lines
 * each, using the existing healthy layout's space in every state.
 */
export function AgentStatusCard({ agent }: { agent: AgentDetailView }) {
  // The same running-Task line the Agent list row shows, from the same activity data.
  const activity = agentActivityDetail(agent);
  const computer = agentRuntimeIssue(agent) ?? agentComputerStatus(agent);
  const binding = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  const provider = runtimeProviderName(agent.runtimeProvider);
  // The Cloud is named as such: its machine name and platform are openTag's, not the reader's.
  const cloud = agent.computerKind === "cloud";
  const computerIdentity = cloud
    ? `${m.agents_computer_cloud()} · ${provider}`
    : agent.computer
      ? `${agent.computer.displayName} · ${platformLabel(agent.computer.platform)} · ${provider}`
      : provider;
  const messagingIdentity = binding ? messagingChannelLabel(agent, binding) : "";
  return (
    <section
      className="@container/agent-status grid ui-surface bg-kumo-base p-6 max-[640px]:p-5 ring ring-kumo-line"
      aria-label={m.agents_status_region()}
      data-ui="agent-status-overview"
    >
      <ul className="grid h-full list-none divide-y divide-kumo-line">
        {activity ? (
          // What the Agent is doing comes first, as its own row, so it never reads as a fact about
          // the Computer or the channel below it.
          <li
            className="flex min-w-0 items-center justify-between gap-4 py-5 text-sm first:pt-0 last:pb-0"
            data-ui="agent-status-work"
          >
            <strong className="min-w-0 truncate font-semibold text-kumo-strong">{m.agents_status_work()}</strong>
            <span className="whitespace-nowrap font-medium text-kumo-default" data-ui="agent-status-activity">
              {activity}
            </span>
          </li>
        ) : null}
        <AgentStatusRow
          agent={agent}
          dependency="computer"
          fullIdentity={computerIdentity}
          identity={
            <>
              {cloud ? (
                <>
                  <span className="truncate">{m.agents_computer_cloud()}</span>
                  <span aria-hidden="true">·</span>
                </>
              ) : agent.computer ? (
                <>
                  <span className="truncate">{agent.computer.displayName}</span>
                  <span className="hidden shrink-0 @min-[24rem]/agent-status:inline">
                    · {platformLabel(agent.computer.platform)}
                  </span>
                  <span aria-hidden="true">·</span>
                </>
              ) : null}
              <span className="shrink-0" data-ui="agent-status-provider">
                {provider}
              </span>
            </>
          }
          name={m.agents_status_computer()}
          status={computer}
        />
        <AgentStatusRow
          agent={agent}
          dependency="message-channel"
          fullIdentity={messagingIdentity}
          identity={<span className="truncate">{messagingIdentity}</span>}
          name={m.agents_status_message_channel()}
          status={agentMessagingStatus(agent)}
        />
      </ul>
    </section>
  );
}

function AgentStatusRow({
  agent,
  dependency,
  fullIdentity,
  identity,
  name,
  status,
}: {
  agent: AgentDetailView;
  dependency: "computer" | "message-channel";
  fullIdentity: string;
  identity: ReactNode;
  name: string;
  status: AgentDependencyStatus & { guidance?: string };
}) {
  // The 44px target uses 1px of existing space on either side of the original 42px two-line block.
  // In a narrow card the status wraps under the row name instead of squeezing it, so the block grows.
  const triggerClassName = "-my-px grid min-h-11 min-w-0 auto-rows-min py-px text-left text-sm";
  const accessibleStatus = fullIdentity
    ? m.agents_status_identity_label({ status: status.label, identity: fullIdentity })
    : status.label;
  const content = (
    <>
      <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 @min-[24rem]/agent-status:flex-nowrap">
        <strong className="shrink-0 font-semibold text-kumo-strong">{name}</strong>
        <span
          className={`inline-flex min-w-0 max-w-full items-center gap-1.5 font-medium ${status.action ? "text-kumo-link" : "text-kumo-default"}`}
          data-state={status.tone}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full bg-current ${dependencyStatusClassName(status.tone)}`}
          />
          {/* A longer Server verdict wraps inside the card instead of running past its edge at 320px. */}
          <span className="min-w-0 [overflow-wrap:anywhere]" data-ui="agent-status-label">
            {status.label}
          </span>
          {status.action ? (
            <Icon className="hidden size-3.5 shrink-0 @min-[24rem]/agent-status:block" name="arrow-right" />
          ) : null}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-kumo-subtle" aria-hidden="true">
        {identity}
      </span>
    </>
  );
  return (
    <li className="grid min-w-0 content-start py-5 first:pt-0 last:pb-0" data-ui={`agent-status-${dependency}`}>
      {status.action ? (
        <Link
          className={triggerClassName}
          aria-label={m.agents_status_action_label({ name, status: accessibleStatus, action: status.action.label })}
          title={fullIdentity ? `${fullIdentity} · ${status.label}` : undefined}
          state={{ agent, returnAgentId: agent.id }}
          {...status.action.link}
        >
          {content}
        </Link>
      ) : !status.guidance ? (
        // Nothing to act on and nothing more to say: the row is plain text, not a control that opens
        // a popover repeating it. The title keeps a truncated identity readable on hover.
        <div className={triggerClassName} title={fullIdentity || undefined}>
          <span className="sr-only">{`${name}: ${accessibleStatus}`}</span>
          <span aria-hidden="true" className="contents">
            {content}
          </span>
        </div>
      ) : (
        <Popover>
          <Popover.Trigger
            render={
              <Button
                variant="inline"
                type="button"
                className={`${triggerClassName} w-full grid-cols-[minmax(0,1fr)] items-stretch justify-stretch gap-0 px-0! font-normal! hover:bg-transparent`}
                aria-label={m.agents_status_details_label({ name, status: accessibleStatus })}
              />
            }
          >
            {content}
          </Popover.Trigger>
          <Popover.Content align="start" className="max-w-[calc(100vw-2rem)]">
            <Popover.Title className="text-sm font-semibold">{name}</Popover.Title>
            <Popover.Description render={<div className="grid gap-1 text-sm wrap-anywhere" />}>
              {fullIdentity ? <p>{fullIdentity}</p> : null}
              <p>{status.label}</p>
              {status.guidance ? <p>{status.guidance}</p> : null}
            </Popover.Description>
          </Popover.Content>
        </Popover>
      )}
    </li>
  );
}

function dependencyStatusClassName(tone: AgentDependencyStatus["tone"]): string {
  if (tone === "success") return "text-kumo-success";
  if (tone === "warning") return "text-(--status-warning)";
  if (tone === "danger") return "text-kumo-danger";
  return "text-kumo-subtle";
}
