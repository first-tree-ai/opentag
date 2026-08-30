import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../../../../features/account/account-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/account")({
  component: AccountPage,
});
