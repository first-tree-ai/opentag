import { useLocation, useParams } from "react-router-dom";
import { AgentUsageTab } from "../../features/agent-usage.js";
import { Text } from "../../ui/design-system.js";
import { AsyncState, useResource } from "../resource/use-resource.js";
import { AgentObjectHeader } from "./agent-detail-page.js";
import type { AgentDetailView } from "./agent-model.js";
import { loadAgentDetail, markAgentDetailUnconfirmed } from "./agent-model.js";

export function AgentUsagePage() {
  const { agentId = "" } = useParams();
  const location = useLocation();
  const routeState = location.state as { agent?: AgentDetailView } | null;
  const initialAgent = routeState?.agent?.id === agentId ? routeState.agent : undefined;
  const state = useResource(() => loadAgentDetail(agentId), agentId, {
    initialValue: initialAgent,
    onBackgroundError: markAgentDetailUnconfirmed,
  });
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
