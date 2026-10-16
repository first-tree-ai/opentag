import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../../../../features/account/account-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/account")({
  validateSearch: (search: Record<string, unknown>): { slackProvision?: true } =>
    search.slackProvision === true || search.slackProvision === "true" ? { slackProvision: true } : {},
  component: AccountRoute,
});

function AccountRoute() {
  const { slackProvision } = Route.useSearch();
  return <AccountPage slackProvision={slackProvision} />;
}
