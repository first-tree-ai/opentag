import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "../../../../features/navigation/redirect.js";
import { TasksPage } from "../../../../features/tasks-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/tasks/")({
  component: TasksIndexRoute,
});

function TasksIndexRoute() {
  if (import.meta.env.DEV) return <TasksPage showExamples />;
  return <Redirect replace to="/agents" />;
}
