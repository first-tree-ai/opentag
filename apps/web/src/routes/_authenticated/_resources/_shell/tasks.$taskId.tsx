import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "../../../../features/navigation/redirect.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/tasks/$taskId")({
  component: LegacyTaskDetailRoute,
});

function LegacyTaskDetailRoute() {
  return <Redirect replace to="/agents" />;
}
