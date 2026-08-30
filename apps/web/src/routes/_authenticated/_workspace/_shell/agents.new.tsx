import { createFileRoute } from "@tanstack/react-router";
import { NewAgentPage } from "../../../../features/agents/new-agent-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/agents/new")({
  component: NewAgentPage,
});
