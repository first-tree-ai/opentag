import { useQuery } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { AsyncState, toResourceState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import { useAgentDetailView } from "./agent-queries.js";
import { RuntimeConfigurationForm } from "./agent-settings/runtime-configuration.js";

export function AgentInstructionsPage({ agentId }: { agentId: string }) {
  const { me } = useAccount();
  const agentState = useAgentDetailView(agentId, { watched: true, accountId: me.user.id });
  const configState = toResourceState(
    useQuery({ queryKey: queryKeys.agents.config(agentId), queryFn: () => browserApi.agentConfig(agentId) }),
  );
  return (
    <AsyncState state={agentState}>
      {(agent) => (
        <AsyncState state={configState}>
          {(config) => (
            <RuntimeConfigurationForm
              key={config.id}
              computerKind={agent.computerKind}
              initialConfig={config}
              save={(input) => browserApi.updateAgent(agentId, input)}
              section="instructions"
            />
          )}
        </AsyncState>
      )}
    </AsyncState>
  );
}
