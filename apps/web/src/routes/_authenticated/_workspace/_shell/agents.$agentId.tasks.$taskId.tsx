import { createFileRoute } from "@tanstack/react-router";
import { TaskDetailPage } from "../../../../features/tasks-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/agents/$agentId/tasks/$taskId")({
  component: AgentTaskDetailRoute,
});

function AgentTaskDetailRoute() {
  const { agentId, taskId } = Route.useParams();
  return <TaskDetailPage agentId={agentId} taskId={taskId} />;
}
