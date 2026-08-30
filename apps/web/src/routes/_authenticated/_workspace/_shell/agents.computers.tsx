import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "../../../../features/navigation/redirect.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/agents/computers")({
  component: () => <Redirect replace to="/agents" />,
});
