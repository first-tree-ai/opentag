import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsPage } from "../../../../features/integrations-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/agents/$agentId/integrations")({
  component: IntegrationsPage,
});
