import { createFileRoute, redirect } from "@tanstack/react-router";

/** Historical deep links go to the existing Account connection surface. */
export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/integrations")({
  beforeLoad: () => {
    throw redirect({ to: "/account" });
  },
});
