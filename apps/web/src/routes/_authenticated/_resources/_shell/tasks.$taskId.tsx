import { createFileRoute } from "@tanstack/react-router";
import { TaskDetailPage } from "../../../../features/tasks-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/tasks/$taskId")({
  component: TaskDetailRoute,
});

function TaskDetailRoute() {
  const { taskId } = Route.useParams();
  return <TaskDetailPage taskId={taskId} />;
}
