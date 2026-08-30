import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { orderAgentIds } from "../../features/agent-list-order.js";
import { Button, buttonClassName, Icon, StatusIndicator } from "../../ui/design-system.js";
import { EmptyState, Page } from "../layout/page.js";
import { AsyncState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import type { AgentListItem } from "./agent-model.js";
import {
  agentAvatarTone,
  agentCardStatus,
  formatElapsedCompact,
  formatUsageNumber,
  initials,
} from "./agent-presentation.js";
import { useAgentListView } from "./agent-queries.js";
import { agentDetailLink, agentSettingsSectionLink } from "./agent-routes.js";
import { NewAgentDialog } from "./new-agent-page.js";

export function AgentsPage() {
  const { me } = useAccount();
  const [createOpen, setCreateOpen] = useState(false);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const state = useAgentListView(me.user.id);
  return (
    <>
      <Page
        title="Agents"
        description="Monitor availability and 30-day usage across your AI teammates."
        action={
          <Button ref={createTriggerRef} size="compact" variant="outline" onClick={() => setCreateOpen(true)}>
            New Agent <Icon name="plus" />
          </Button>
        }
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
  return (
    <section className="grid gap-4" aria-label="Agents" data-ui="agent-list">
      <div className="grid gap-4 sm:grid-cols-2" data-ui="agent-card-grid">
        {order.map((id) => {
          const agent = byId.get(id);
          return agent ? <AgentCard agent={agent} key={agent.id} /> : null;
        })}
      </div>
    </section>
  );
}

export function AgentCard({ agent }: { agent: AgentListItem }) {
  const status = agentCardStatus(agent);
  const action = status.action;
  const statusDetail: ReactNode =
    agent.activity.state === "working" && status.label === "Working" ? (
      <>Started {formatElapsedCompact(agent.activity.startedAt)} ago</>
    ) : status.detail ? (
      action ? (
        <>
          <span className="text-kumo-subtle">{status.detail}</span>
          <span className="text-kumo-subtle" aria-hidden="true">
            {" · "}
          </span>
          <Link
            className={buttonClassName({ variant: "inline" })}
            {...agentSettingsSectionLink(agent.id, action.section)}
          >
            {action.label}
          </Link>
        </>
      ) : (
        status.detail
      )
    ) : undefined;
  return (
    <article
      className="relative grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      data-avatar-tone={agentAvatarTone(agent.id)}
      data-tone={status.tone}
      data-ui="agent-card"
    >
      <div className="flex items-center gap-3" data-ui="agent-card-identity">
        <span
          className="grid size-10 shrink-0 place-items-center rounded-full bg-kumo-tint text-sm font-semibold text-kumo-strong"
          aria-hidden="true"
        >
          {initials(agent.displayName)}
        </span>
        <div className="grid min-w-0 gap-1" data-ui="agent-card-identity-copy">
          <strong>
            <Link aria-label={`Open ${agent.displayName}`} {...agentDetailLink(agent.id)}>
              {agent.displayName}
            </Link>
          </strong>
          <small>@{agent.name}</small>
        </div>
      </div>
      <div data-ui="agent-card-state">
        <StatusIndicator detail={statusDetail} label={status.label} tone={status.tone} />
      </div>
      <dl className="grid grid-cols-2 gap-4 border-t border-kumo-line pt-3" data-ui="agent-card-usage">
        <div>
          <dt>Tasks</dt>
          <dd>{formatUsageNumber(agent.usage.tasks)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{formatUsageNumber(agent.usage.tokens)}</dd>
        </div>
      </dl>
      {/* The row itself is the link; the chevron only signals where it goes. */}
      <span aria-hidden="true" className="absolute right-4 top-4 text-kumo-subtle" data-ui="agent-card-action">
        <Icon name="chevron-right" />
      </span>
    </article>
  );
}
