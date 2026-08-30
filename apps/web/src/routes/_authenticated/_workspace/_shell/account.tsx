import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../../../../features/account/account-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/account")({
  component: AccountPage,
});
