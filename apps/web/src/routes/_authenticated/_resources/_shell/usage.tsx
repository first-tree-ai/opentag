import { createFileRoute } from "@tanstack/react-router";
import { CloudUsagePage } from "../../../../features/account/cloud-usage-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/usage")({
  component: CloudUsagePage,
});
