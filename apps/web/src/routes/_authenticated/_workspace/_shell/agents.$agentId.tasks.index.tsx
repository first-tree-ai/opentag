import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "../../../../features/tasks-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/agents/$agentId/tasks/")({
  component: AgentTasksRoute,
});

function AgentTasksRoute() {
  const { agentId } = Route.useParams();
  return <TasksPage agentId={agentId} />;
}
