import { createFileRoute } from "@tanstack/react-router";
import { AgentDetailPage } from "../../../../features/agents/agent-detail-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/")({
  component: AgentDetailRoute,
  validateSearch: (search: Record<string, unknown>): { schedule?: string } => ({
    ...(typeof search.schedule === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.schedule)
      ? { schedule: search.schedule }
      : {}),
  }),
});

function AgentDetailRoute() {
  const { agentId } = Route.useParams();
  const { schedule } = Route.useSearch();
  return <AgentDetailPage agentId={agentId} scheduleId={schedule} />;
}
