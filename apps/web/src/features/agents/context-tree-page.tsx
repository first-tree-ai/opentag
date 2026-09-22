import { useQuery, useQueryClient } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { syncAgentQueries } from "../../query/agent-sync.js";
import { queryKeys } from "../../query/keys.js";
import { AsyncState, toResourceState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import { useAgentDetailView } from "./agent-queries.js";
import { ContextTreeSettings } from "./agent-settings/context-tree-settings.js";

export function ContextTreePage({ agentId }: { agentId: string }) {
  const { me } = useAccount();
  const queryClient = useQueryClient();
  const agentState = useAgentDetailView(agentId, { watched: true, accountId: me.user.id });
  const configState = toResourceState(
    useQuery({ queryKey: queryKeys.agents.config(agentId), queryFn: () => browserApi.agentConfig(agentId) }),
  );
  return (
    <AsyncState state={agentState}>
      {(agent) => (
        <AsyncState state={configState}>
          {(config) => (
            <ContextTreeSettings
              config={config}
              computerName={agent.computer?.displayName ?? ""}
              computerKind={agent.computerKind}
              online={agent.availability.dependencies.computer.state === "ready"}
              // A write can change the Agent and its config together, so both are dropped.
              onChanged={() => void syncAgentQueries(queryClient, agentId)}
            />
          )}
        </AsyncState>
      )}
    </AsyncState>
  );
}
