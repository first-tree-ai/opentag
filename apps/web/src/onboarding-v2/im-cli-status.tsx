import * as m from "../paraglide/messages.js";
import type { MessagingCliStatus } from "../setup/index.js";
import type { MessagingProvider, ReadinessFacts } from "./flow.js";

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
  provider: MessagingProvider;
  status: MessagingCliStatus | undefined;
}) {
  return (
    <span data-provider={provider} data-ui="onboarding-v2-im-cli-status">
      {imCliStatusCopy(status)}
    </span>
  );
}

export function ImCliReadinessList({ readiness }: { readiness: ReadinessFacts | undefined }) {
  const rows = [
    ["feishu", m.onboarding_v2_im_cli_lark_label()],
    ["slack", m.onboarding_v2_im_cli_slack_label()],
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
            <ImCliStatusText provider={provider} status={readiness?.messagingCli[provider]} />
          </span>
        </li>
      ))}
    </ul>
  );
}
