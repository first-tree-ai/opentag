import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "../../../../features/navigation/redirect.js";
import { TaskDetailPage } from "../../../../features/tasks-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/tasks/$taskId")({
  component: TaskDetailRoute,
  validateSearch: (search: Record<string, unknown>): { examples?: true } => ({
    examples: search.examples === true || search.examples === "true" ? true : undefined,
  }),
});

function TaskDetailRoute() {
  const { taskId } = Route.useParams();
  const { examples } = Route.useSearch();
  if (import.meta.env.DEV && examples === true) return <TaskDetailPage showExamples taskId={taskId} />;
  return <Redirect replace to="/agents" />;
}
