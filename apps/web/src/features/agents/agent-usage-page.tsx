import { AgentUsageTab } from "../../features/agent-usage.js";

export function AgentUsagePage({ agentId }: { agentId: string }) {
  return <AgentUsageTab agentId={agentId} />;
}
