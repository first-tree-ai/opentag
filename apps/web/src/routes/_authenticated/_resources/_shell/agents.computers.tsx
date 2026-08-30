import { createFileRoute } from "@tanstack/react-router";
import { ComputersPage } from "../../../../features/agents/computers-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/computers")({
  component: ComputersPage,
});
