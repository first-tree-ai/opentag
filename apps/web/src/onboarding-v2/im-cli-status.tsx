import type { ImProvider } from "@opentag/shared/browser";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import type { MessagingCliStatus } from "../setup/index.js";

export type ImCliStatuses = Partial<Record<ImProvider, MessagingCliStatus>>;

export function imCliStatusCopy(status: MessagingCliStatus | undefined): string {
  if (status === "ready") return m.onboarding_v2_im_cli_status_ready();
  if (status === "unavailable") return m.onboarding_v2_im_cli_status_unavailable();
  if (status === "install") return m.onboarding_v2_im_cli_status_install();
  return m.onboarding_v2_im_cli_status_checking();
}

export function ImCliStatusText({
  provider,
  status,
}: {
  provider: ImProvider;
  status: MessagingCliStatus | undefined;
}) {
  return (
    <span data-provider={provider} data-ui="onboarding-v2-im-cli-status">
      {imCliStatusCopy(status)}
    </span>
  );
}

export function ImCliReadinessList({ statuses }: { statuses: ImCliStatuses | undefined }) {
  const rows = [
    ["feishu", `${messagingProviderLabel("feishu")} CLI`],
    ["slack", `${messagingProviderLabel("slack")} CLI`],
  ] as const;
  return (
    <ul
      className="flex flex-col m-0 p-0 list-none rounded-xl bg-kumo-base ring ring-kumo-line overflow-hidden"
      data-ui="onboarding-v2-im-cli-readiness"
    >
      {rows.map(([provider, label]) => (
        <li
          className="flex items-center justify-between gap-3 p-4 border-t border-kumo-line first:border-t-0"
          key={provider}
        >
          <span className="font-medium text-kumo-strong">{label}</span>
          <span className="text-sm text-kumo-subtle">
            <ImCliStatusText provider={provider} status={statuses?.[provider]} />
          </span>
        </li>
      ))}
    </ul>
  );
}
