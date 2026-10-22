import { createFileRoute } from "@tanstack/react-router";
import { ResourceLayout } from "../../features/shell/resource-layout.js";

export const Route = createFileRoute("/_authenticated/_resources")({
  component: ResourceLayout,
});
