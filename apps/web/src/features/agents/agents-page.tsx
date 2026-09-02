import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { orderAgentIds } from "../../features/agent-list-order.js";
import { formatCompactNumber, initials } from "../../i18n/format.js";
import { messagingProviderLabel } from "../../im/provider-label.js";
import * as m from "../../paraglide/messages.js";
import { Button, Icon, StatusIndicator } from "../../ui/design-system.js";
import { ProviderIcon } from "../../ui/provider-icon.js";
import { EmptyState, Page } from "../layout/page.js";
import { AsyncState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import type { AgentListItem } from "./agent-model.js";
import { agentCardStatus } from "./agent-presentation.js";
import { useAgentListView } from "./agent-queries.js";
import { agentDetailLink } from "./agent-routes.js";
import { NewAgentDialog } from "./new-agent-page.js";

export function AgentsPage() {
  const { me } = useAccount();
  const [createOpen, setCreateOpen] = useState(false);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const state = useAgentListView(me.user.id);
  return (
    <>
      <Page
        action={
          <div data-ui="agents-page-action">
            <Button ref={createTriggerRef} variant="secondary" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" weight="bold" /> {m.agents_new_agent()}
            </Button>
          </div>
        }
        title={m.agents_title()}
      >
        <AsyncState state={state}>{(value) => <AgentsContent agents={value.agents} />}</AsyncState>
      </Page>
      <NewAgentDialog open={createOpen} returnFocusRef={createTriggerRef} onClose={() => setCreateOpen(false)} />
    </>
  );
}

export function AgentsContent({ agents }: { agents: AgentListItem[] }) {
  if (agents.length > 0) return <AgentList agents={agents} />;
  return <EmptyState title={m.agents_empty_title()}>{m.agents_empty_description()}</EmptyState>;
}

export function AgentList({ agents }: { agents: AgentListItem[] }) {
  const shownOrder = useRef<readonly string[]>([]);
  const byPriority = [...agents].sort(
    (left, right) => agentCardStatus(left).priority - agentCardStatus(right).priority,
  );
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  /*
   * Written during render on purpose. `orderAgentIds` is stable under reapplication, so a
   * repeated render of the same list produces the same order; deferring it to an effect would
   * show one frame of the resorted list before restoring the order the viewer is pointing at.
   */
  const order = orderAgentIds(
    byPriority.map((agent) => agent.id),
    shownOrder.current,
  );
  shownOrder.current = order;
  const workingCount = agents.filter((agent) => agent.activity.state === "working").length;
  return (
    <section className="grid gap-4" aria-label={m.agents_title()} data-ui="agent-list">
      <p className="text-sm text-kumo-subtle">{agentListSummary(agents.length, workingCount)}</p>
      <div className="@container/agent-roster grid gap-3" data-ui="agent-roster">
        {order.map((id) => {
          const agent = byId.get(id);
          return agent ? <AgentRow agent={agent} key={agent.id} /> : null;
        })}
      </div>
    </section>
  );
}

export function AgentRow({ agent }: { agent: AgentListItem }) {
  const status = agentCardStatus(agent);
  const channel = agent.availability.dependencies.channel.provider;
  return (
    <article
      className="relative grid gap-4 rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-line transition-colors hover:bg-kumo-tint focus-within:ring-2 focus-within:ring-kumo-focus @min-[42rem]/agent-roster:grid-cols-[minmax(0,1.2fr)_minmax(11rem,1fr)_auto_1rem] @min-[42rem]/agent-roster:items-center"
      data-tone={status.tone}
      data-ui="agent-row"
    >
      <div className="flex min-w-0 items-center gap-3 pr-6 @min-[42rem]/agent-roster:pr-0" data-ui="agent-row-identity">
        <span
          className="grid size-10 shrink-0 place-items-center rounded-full bg-kumo-tint text-sm font-semibold text-kumo-strong"
          data-ui="agent-row-avatar"
          aria-hidden="true"
        >
          {initials(agent.displayName.replaceAll("-", " "))}
        </span>
        <div className="grid min-w-0 gap-1">
          <strong className="truncate text-base">{agent.displayName}</strong>
          {channel ? (
            <span className="flex items-center gap-1.5 text-sm text-kumo-subtle">
              <ProviderIcon className="size-4" provider={channel} />
              {messagingProviderLabel(channel)}
            </span>
          ) : null}
        </div>
      </div>
      <div className="grid gap-1.5 pl-13 @min-[42rem]/agent-roster:pl-0" data-ui="agent-row-status">
        <StatusIndicator label={status.label} tone={status.tone} />
        {status.detail ? (
          <p className="text-sm text-kumo-subtle" data-ui="agent-row-state">
            {status.detail}
          </p>
        ) : null}
      </div>
      <AgentUsageSummary agent={agent} />
      <Icon
        className="absolute right-5 top-5 text-kumo-subtle @min-[42rem]/agent-roster:static @min-[42rem]/agent-roster:justify-self-end"
        name="chevron-right"
      />
      <Link
        aria-label={m.agents_open_agent({ name: agent.displayName })}
        className="absolute inset-0 rounded-lg focus:outline-none"
        data-ui="agent-row-open"
        {...agentDetailLink(agent.id)}
      />
    </article>
  );
}

function AgentUsageSummary({ agent }: { agent: AgentListItem }) {
  const tasks = formatCompactNumber(agent.usage.tasks);
  const tokens = formatCompactNumber(agent.usage.tokens);
  return (
    <dl
      className="grid gap-0.5 pl-13 @min-[42rem]/agent-roster:w-48 @min-[42rem]/agent-roster:justify-self-end @min-[42rem]/agent-roster:pl-0"
      data-ui="agent-row-usage"
    >
      <dt className="text-xs text-kumo-subtle">{m.agents_list_usage_window({ days: agent.usage.windowDays })}</dt>
      <dd className="flex items-baseline gap-1.5 whitespace-nowrap text-sm font-medium text-kumo-strong tabular-nums">
        <span>
          {agent.usage.tasks === 1
            ? m.agents_list_usage_task_single({ count: tasks })
            : m.agents_list_usage_task_plural({ count: tasks })}
        </span>
        <span aria-hidden="true" className="text-kumo-subtle">
          ·
        </span>
        <span>
          {agent.usage.tokens === 1
            ? m.agents_list_usage_token_single({ count: tokens })
            : m.agents_list_usage_token_plural({ count: tokens })}
        </span>
      </dd>
    </dl>
  );
}

function agentListSummary(count: number, workingCount: number): string {
  if (workingCount > 0) {
    return count === 1
      ? m.agents_list_summary_single({ count, workingCount })
      : m.agents_list_summary_plural({ count, workingCount });
  }
  return count === 1 ? m.agents_list_count_single({ count }) : m.agents_list_count_plural({ count });
}
