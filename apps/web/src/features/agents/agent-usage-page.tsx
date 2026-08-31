import { useRouterState } from "@tanstack/react-router";
import { AgentUsageTab } from "../../features/agent-usage.js";
import { AsyncState } from "../resource/resource-state.js";
import { AgentObjectHeader } from "./agent-detail-page.js";
import { useAgentDetailView } from "./agent-queries.js";

export function AgentUsagePage({ agentId }: { agentId: string }) {
  const routeState = useRouterState({ select: (state) => state.location.state });
  const initialAgent = routeState.agent?.id === agentId ? routeState.agent : undefined;
  const state = useAgentDetailView(agentId, { initialAgent });
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="grid gap-6">
          <AgentObjectHeader agent={agent} backToSettings />
          <AgentUsageTab agentId={agent.id} />
        </section>
      )}
    </AsyncState>
  );
}
