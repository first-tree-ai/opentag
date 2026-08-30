import { useRouterState } from "@tanstack/react-router";
import { AgentUsageTab } from "../../features/agent-usage.js";
import { Text } from "../../ui/design-system.js";
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
          <div className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line">
            <header className="grid gap-2">
              <Text as="h2" variant="heading">
                Usage
              </Text>
            </header>
            <AgentUsageTab agentId={agent.id} />
          </div>
        </section>
      )}
    </AsyncState>
  );
}
