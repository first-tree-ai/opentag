import type { AccountComputerSummary } from "@opentag/shared/browser";
import type { ReactNode } from "react";
import { formatDateTime, formatRelativeTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Icon, StatusIndicator, Text } from "../../ui/design-system.js";
import { platformLabel } from "./agent-presentation.js";

export type ComputerConnection = "online" | "offline" | "disconnected" | "unconfirmed";

function computerStatus(connection: ComputerConnection, cloud: boolean) {
  if (connection === "unconfirmed") return { label: m.computer_status_unavailable(), tone: "neutral" as const };
  if (cloud || connection === "online") return { label: m.agent_settings_computer_online(), tone: "success" as const };
  if (connection === "disconnected") return { label: m.computer_disconnected(), tone: "neutral" as const };
  return { label: m.agent_settings_computer_offline(), tone: "warning" as const };
}

export function ComputerIdentity({
  computer,
  connection,
  lastSeenAt,
  reserveStatusSpace = false,
  compact = false,
  actions,
}: {
  computer: Pick<AccountComputerSummary, "displayName" | "platform" | "kind">;
  connection: ComputerConnection;
  lastSeenAt?: string | null;
  reserveStatusSpace?: boolean;
  compact?: boolean;
  actions?: ReactNode;
}) {
  const cloud = computer.kind === "cloud";
  const status = computerStatus(connection, cloud);
  const lastOnline =
    !cloud && connection === "offline" && lastSeenAt ? (
      <time className="text-xs text-kumo-subtle" dateTime={lastSeenAt} title={formatDateTime(lastSeenAt)}>
        {m.computer_last_online({ time: formatRelativeTime(lastSeenAt) })}
      </time>
    ) : null;
  if (compact) {
    return (
      <div
        className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)_2.75rem] items-start gap-x-3 gap-y-2 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto_2.75rem] wrap-anywhere"
        data-ui="computer-identity"
      >
        <span aria-hidden="true" className="grid size-10 place-items-center rounded-lg bg-kumo-tint">
          <Icon name={cloud ? "model" : "laptop"} className="size-5" />
        </span>
        <div className="grid min-w-0 gap-1">
          <Text as="h2" variant="heading">
            {computer.displayName}
          </Text>
          <p className="text-sm text-kumo-subtle">
            {cloud ? m.computer_cloud() : m.computer_local()} · {platformLabel(computer.platform)}
            {lastOnline ? <> · {lastOnline}</> : null}
          </p>
        </div>
        <div className="col-start-2 row-start-2 pt-1 sm:col-start-3 sm:row-start-1" aria-live="polite">
          <StatusIndicator {...status} />
        </div>
        <div className="col-start-3 row-start-1 sm:col-start-4">{actions}</div>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-start gap-4 wrap-anywhere" data-ui="computer-identity">
      <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-lg bg-kumo-tint">
        <Icon name={cloud ? "model" : "laptop"} className="size-6" />
      </span>
      <div className="grid min-w-0 gap-2">
        <div className="grid gap-1">
          <div className="min-w-0">
            <Text as="h2" variant="heading">
              {computer.displayName}
            </Text>
          </div>
          <p className="text-sm text-kumo-subtle">
            {cloud ? m.computer_cloud() : m.computer_local()} · {platformLabel(computer.platform)}
          </p>
        </div>
        <div
          className={`flex flex-wrap content-start items-center gap-x-3 gap-y-2 ${reserveStatusSpace ? "min-h-12 sm:min-h-6" : ""}`}
        >
          <StatusIndicator {...status} />
          {lastOnline}
        </div>
      </div>
    </div>
  );
}
