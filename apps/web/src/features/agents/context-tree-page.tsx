import { useQuery, useQueryClient } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { PageHeader } from "../../components/kumo/page-header/page-header.js";
import * as m from "../../paraglide/messages.js";
import { syncAgentQueries } from "../../query/agent-sync.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, SkeletonLine } from "../../ui/design-system.js";
import {
  AsyncState,
  isTerminalResourceError,
  ResourceRefreshNotice,
  toResourceState,
  usePersistedSettledError,
} from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import { useAgentDetailView } from "./agent-queries.js";
import { ContextTreeSettings } from "./agent-settings/context-tree-settings.js";

export function ContextTreePage({ agentId }: { agentId: string }) {
  const { me } = useAccount();
  const agentState = useAgentDetailView(agentId, { watched: true, accountId: me.user.id });
  return (
    <AsyncState state={agentState}>
      {(agent) => (
        <ContextTreeConfig
          key={agentId}
          agentId={agentId}
          computerKind={agent.computerKind ?? "local"}
          online={agent.availability.dependencies.computer.state === "ready"}
        />
      )}
    </AsyncState>
  );
}

function ContextTreeConfig({
  agentId,
  computerKind,
  online,
}: {
  agentId: string;
  computerKind: "local" | "cloud";
  online: boolean;
}) {
  const queryClient = useQueryClient();
  const key = queryKeys.agents.config(agentId);
  const query = useQuery({ queryKey: key, queryFn: () => browserApi.agentConfig(agentId) });
  const error = usePersistedSettledError(key, query);
  const state = toResourceState({ ...query, error, isError: error !== null }, (config) => config);
  if (state.kind === "ready")
    return (
      <ContextTreeSettings
        config={state.value}
        computerKind={computerKind}
        online={online}
        unconfirmed={error !== null || query.fetchStatus === "paused"}
        refreshNotice={error ? <ResourceRefreshNotice error={error} onRetry={() => void query.refetch()} /> : undefined}
        onChanged={() => void syncAgentQueries(queryClient, agentId)}
      />
    );
  return (
    <div className="grid gap-6">
      <PageHeader
        title={m.agent_settings_context_tree_title()}
        description={m.agent_settings_context_tree_description()}
      />
      {state.kind === "loading" ? (
        <div role="status" className="grid gap-4 py-8">
          <span className="sr-only">{m.common_loading()}</span>
          <SkeletonLine className="w-1/2" />
          <SkeletonLine className="w-3/4" />
        </div>
      ) : (
        <div className="grid justify-items-start gap-3">
          <Banner variant="error" role="alert" description={m.agent_settings_context_tree_load_error()} />
          {isTerminalResourceError(state.error) ? null : (
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {m.common_retry()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
