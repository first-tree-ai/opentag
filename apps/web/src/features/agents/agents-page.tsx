import { Link } from "@tanstack/react-router";
import { useRef } from "react";
import { orderAgentIds } from "../../features/agent-list-order.js";
import { formatCompactNumber, formatElapsedCompact, initials } from "../../i18n/format.js";
import { messagingProviderLabel } from "../../im/provider-label.js";
import * as m from "../../paraglide/messages.js";
import { buttonClassName, Icon, StatusIndicator } from "../../ui/design-system.js";
import { ProviderIcon } from "../../ui/provider-icon.js";
import { EmptyState, Page } from "../layout/page.js";
import { AsyncState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import type { AgentListItem } from "./agent-model.js";
import { agentCardStatus } from "./agent-presentation.js";
import { useAgentListView } from "./agent-queries.js";
import { agentDetailLink } from "./agent-routes.js";

export function AgentsPage() {
  const { me } = useAccount();
  const state = useAgentListView(me.user.id);
  return (
    <Page
      action={
        <div data-ui="agents-page-action">
          <Link className={buttonClassName({ variant: "secondary" })} search={{ action: "create" }} to="/agents/setup">
            <Icon name="plus" weight="bold" /> {m.agents_new_agent()}
          </Link>
        </div>
      }
      description={m.agents_page_description()}
      title={m.agents_title()}
    >
      <AsyncState state={state}>{(value) => <AgentsContent agents={value.agents} />}</AsyncState>
    </Page>
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
      <p className="text-sm text-kumo-subtle">
        {agents.length === 1
          ? m.agents_list_summary_single({ count: agents.length, workingCount })
          : m.agents_list_summary_plural({ count: agents.length, workingCount })}
      </p>
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
  const statusDetail = agentStatusDetail(agent);
  return (
    <article
      className="relative grid gap-4 rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-line transition-colors hover:bg-kumo-tint focus-within:ring-2 focus-within:ring-kumo-focus @min-[42rem]/agent-roster:grid-cols-[minmax(0,1.25fr)_minmax(12rem,1fr)_5rem_7rem_1rem] @min-[42rem]/agent-roster:items-center"
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
          <span className="flex items-center gap-1.5 text-sm text-kumo-subtle">
            {channel ? <ProviderIcon className="size-4" provider={channel} /> : null}
            {channel ? messagingProviderLabel(channel) : m.agents_messaging_not_connected()}
          </span>
        </div>
      </div>
      <div className="grid gap-1.5" data-ui="agent-row-status">
        <StatusIndicator label={status.label} tone={status.tone} />
        <p className="text-sm text-kumo-subtle" data-ui="agent-row-state">
          {statusDetail}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-4 @min-[42rem]/agent-roster:contents" data-ui="agent-row-facts">
        <AgentFact
          label={m.agents_fact_tasks_window({ days: agent.usage.windowDays })}
          value={formatCompactNumber(agent.usage.tasks)}
        />
        <AgentFact
          label={m.agents_fact_tokens_window({ days: agent.usage.windowDays })}
          value={formatCompactNumber(agent.usage.tokens)}
        />
      </dl>
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

function AgentFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-kumo-subtle">{label}</dt>
      <dd className="truncate text-sm font-medium text-kumo-strong">{value}</dd>
    </div>
  );
}

function agentStatusDetail(agent: AgentListItem): string {
  if (!agent.evidenceConfirmed) return m.agents_status_detail_unable_to_refresh();
  if (agent.availability.state === "unconfirmed") return m.agents_status_detail_unable_to_confirm_readiness();
  if (agent.availability.state === "action_required" || agent.availability.state === "not_connected") {
    return m.agents_status_detail_cannot_receive_work();
  }
  if (agent.availability.state === "setting_up") return m.agents_status_detail_messaging_setup();
  if (agent.activity.state === "working" && agent.availability.state === "ready") {
    return m.agents_status_detail_working({ elapsed: formatElapsedCompact(agent.activity.startedAt) });
  }
  if (agent.availability.state === "ready") return m.agents_status_detail_ready();
  return m.agents_status_detail_open_status();
}
