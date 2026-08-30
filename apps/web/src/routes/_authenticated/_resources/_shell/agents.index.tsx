import { createFileRoute } from "@tanstack/react-router";
import { AgentsPage } from "../../../../features/agents/agents-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/")({
  component: AgentsPage,
});
