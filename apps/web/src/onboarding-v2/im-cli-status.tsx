import type { AgentSetupImCliComponentStatus, ImCliProvider } from "@opentag/shared/browser";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";

/**
 * One required IM CLI's displayed status. `waiting` is the missing-report word the Server
 * contract uses; it is never a stand-in for a real checking observation. The vocabulary is the
 * shared schema's component status — Web never invents a second wire-status vocabulary.
 */
export type ImCliDisplayStatus = AgentSetupImCliComponentStatus;

export type ImCliStatuses = Partial<Record<ImCliProvider, ImCliDisplayStatus>>;

export function imCliStatusCopy(status: ImCliDisplayStatus | undefined): string {
  if (status === "ready") return m.onboarding_v2_im_cli_status_ready();
  if (status === "unavailable") return m.onboarding_v2_im_cli_status_unavailable();
  if (status === "install") return m.onboarding_v2_im_cli_status_install();
  if (status === "checking") return m.onboarding_v2_im_cli_status_checking();
  // Absent status stays absent-looking: waiting, never a fabricated checking state.
  return m.onboarding_v2_im_cli_status_waiting();
}

export function ImCliStatusText({
  provider,
  status,
}: {
  provider: ImCliProvider;
  status: ImCliDisplayStatus | undefined;
}) {
  return (
    <span data-provider={provider} data-ui="onboarding-v2-im-cli-status">
      {imCliStatusCopy(status)}
    </span>
  );
}

/**
 * The required IM CLI readiness rows in the Server-supplied provider order. The list renders only
 * the required Providers the snapshot names; each row shows the component status the Server
 * projected for that exact Provider.
 */
export function ImCliReadinessList({
  providers,
  statuses,
}: {
  providers: readonly ImCliProvider[];
  statuses: ImCliStatuses | undefined;
}) {
  const rows = providers.map((provider) => [provider, `${messagingProviderLabel(provider)} CLI`] as const);
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
