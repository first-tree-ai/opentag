import { createFileRoute } from "@tanstack/react-router";
import { ComputersPage } from "../../../../features/agents/computers-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/computers")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { computerId?: string; connect?: "another"; fromAgent?: string } => ({
    computerId: typeof search.computerId === "string" ? search.computerId : undefined,
    connect: search.connect === "another" ? "another" : undefined,
    fromAgent: typeof search.fromAgent === "string" ? search.fromAgent : undefined,
  }),
  component: ComputerRoute,
});

function ComputerRoute() {
  return <ComputersPage {...Route.useSearch()} />;
}
