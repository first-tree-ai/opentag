import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "../../../../features/navigation/redirect.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/skills")({
  component: () => <Redirect replace to="/agents" />,
});
