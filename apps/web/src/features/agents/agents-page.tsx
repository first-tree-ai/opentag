import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { orderAgentIds } from "../../features/agent-list-order.js";
import { formatCompactNumber, formatElapsedCompact, initials } from "../../i18n/format.js";
import { Button, Icon, StatusIndicator } from "../../ui/design-system.js";
import { ProviderIcon } from "../../ui/provider-icon.js";
import { EmptyState, Page } from "../layout/page.js";
import { AsyncState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import type { AgentListItem } from "./agent-model.js";
import { agentCardStatus, titleCase } from "./agent-presentation.js";
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
              <Icon name="plus" weight="bold" /> New Agent
            </Button>
          </div>
        }
        description="Choose an Agent to continue, or create a new one."
        title="Agents"
      >
        <AsyncState state={state}>{(value) => <AgentsContent agents={value.agents} />}</AsyncState>
      </Page>
      <NewAgentDialog open={createOpen} returnFocusRef={createTriggerRef} onClose={() => setCreateOpen(false)} />
    </>
  );
}

export function AgentsContent({ agents }: { agents: AgentListItem[] }) {
  if (agents.length > 0) return <AgentList agents={agents} />;
  return <EmptyState title="No Agents yet">Create your first shared AI teammate with New Agent.</EmptyState>;
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
    <section className="grid gap-4" aria-label="Agents" data-ui="agent-list">
      <p className="text-sm text-kumo-subtle">
        {agents.length} {agents.length === 1 ? "Agent" : "Agents"} · {workingCount} currently working
      </p>
      <div className="grid gap-3" data-ui="agent-roster">
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
  const statusDetail =
    agent.activity.state === "working" && status.label === "Working"
      ? `Working now · started ${formatElapsedCompact(agent.activity.startedAt)} ago`
      : (status.detail ?? (status.label === "Ready" ? "Ready for new work" : "Open to view status details"));
  return (
    <article
      className="relative grid gap-4 rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-line transition-colors hover:bg-kumo-tint focus-within:ring-2 focus-within:ring-kumo-focus @min-[48rem]/workspace:grid-cols-[minmax(0,1.25fr)_minmax(12rem,1fr)_5rem_7rem_1rem] @min-[48rem]/workspace:items-center"
      data-tone={status.tone}
      data-ui="agent-row"
    >
      <div className="flex min-w-0 items-center gap-3 pr-6 @min-[48rem]/workspace:pr-0" data-ui="agent-row-identity">
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
            {channel ? titleCase(channel) : "Messaging not connected"}
          </span>
        </div>
      </div>
      <div className="grid gap-1.5" data-ui="agent-row-status">
        <StatusIndicator label={status.label} tone={status.tone} />
        <p className="text-sm text-kumo-subtle" data-ui="agent-row-state">
          {statusDetail}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-4 @min-[48rem]/workspace:contents" data-ui="agent-row-facts">
        <AgentFact label={`Tasks (${agent.usage.windowDays}d)`} value={formatCompactNumber(agent.usage.tasks)} />
        <AgentFact label={`Tokens (${agent.usage.windowDays}d)`} value={formatCompactNumber(agent.usage.tokens)} />
      </dl>
      <Icon
        className="absolute right-5 top-5 text-kumo-subtle @min-[48rem]/workspace:static @min-[48rem]/workspace:justify-self-end"
        name="chevron-right"
      />
      <Link
        aria-label={`Open ${agent.displayName}`}
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
