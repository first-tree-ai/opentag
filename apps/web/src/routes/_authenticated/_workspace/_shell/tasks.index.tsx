import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "../../../../features/tasks-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/tasks/")({
  component: TasksPage,
});
