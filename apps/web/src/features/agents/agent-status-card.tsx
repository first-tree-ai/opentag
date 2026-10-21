import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Icon, Popover } from "../../ui/design-system.js";
import type { AgentDetailView } from "./agent-model.js";
import {
  type AgentDependencyStatus,
  agentComputerStatus,
  agentMessagingStatus,
  agentRuntimeIssue,
  messagingChannelLabel,
  platformLabel,
  runtimeProviderName,
} from "./agent-presentation.js";

/** Two dependencies with two lines each, using the existing healthy layout's space in every state. */
export function AgentStatusCard({ agent }: { agent: AgentDetailView }) {
  const computer = agentRuntimeIssue(agent) ?? agentComputerStatus(agent);
  const binding = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  const provider = runtimeProviderName(agent.runtimeProvider);
  const computerIdentity = agent.computer
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
        <AgentStatusRow
          agent={agent}
          dependency="computer"
          fullIdentity={computerIdentity}
          identity={
            <>
              {agent.computer ? (
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
  const triggerClassName = "-my-px grid h-11 min-w-0 grid-rows-2 py-px text-left text-sm";
  const accessibleStatus = fullIdentity
    ? m.agents_status_identity_label({ status: status.label, identity: fullIdentity })
    : status.label;
  const content = (
    <>
      <span className="flex min-w-0 items-center justify-between gap-0 @min-[24rem]/agent-status:gap-4">
        <strong className="min-w-0 truncate font-semibold text-kumo-strong">{name}</strong>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 font-medium ${status.action ? "text-kumo-link" : "text-kumo-default"}`}
          data-state={status.tone}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full bg-current ${dependencyStatusClassName(status.tone)}`}
          />
          <span className="whitespace-nowrap" data-ui="agent-status-label">
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
          state={{ agent, returnAgentId: agent.id, returnLabel: agent.displayName }}
          {...status.action.link}
        >
          {content}
        </Link>
      ) : (
        <Popover>
          <Popover.Trigger
            render={
              <Button
                variant="inline"
                type="button"
                className={`${triggerClassName} h-11! w-full grid-cols-[minmax(0,1fr)] items-stretch justify-stretch gap-0 px-0! font-normal! hover:bg-transparent`}
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
