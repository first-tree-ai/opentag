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
  hideStatus = false,
  actions,
}: {
  computer: Pick<AccountComputerSummary, "displayName" | "platform" | "kind">;
  connection: ComputerConnection;
  /** A command window on the card owns the connection status: show only one. */
  hideStatus?: boolean;
  lastSeenAt?: string | null;
  reserveStatusSpace?: boolean;
  compact?: boolean;
  actions?: ReactNode;
}) {
  const cloud = computer.kind === "cloud";
  const status = computerStatus(connection, cloud);
  const lastOnline = cloud ? null : lastOnlineLine(connection, lastSeenAt);
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
            {/* The Cloud's platform is openTag's to choose and nothing a reader acts on. */}
            {cloud ? m.computer_cloud() : `${m.computer_local()} · ${platformLabel(computer.platform)}`}
            {lastOnline ? <> · {lastOnline}</> : null}
          </p>
        </div>
        <div
          className="col-start-2 row-start-2 flex items-center pt-1 sm:col-start-3 sm:row-start-1 sm:self-center sm:pt-0"
          aria-live="polite"
        >
          {hideStatus ? null : <StatusIndicator {...status} />}
        </div>
        <div className="col-start-3 row-start-1 flex items-center sm:col-start-4 sm:self-center">{actions}</div>
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
            {cloud ? m.computer_cloud() : `${m.computer_local()} · ${platformLabel(computer.platform)}`}
          </p>
        </div>
        <div
          className={`flex flex-wrap content-start items-center gap-x-3 gap-y-2 ${reserveStatusSpace ? "min-h-12 sm:min-h-6" : ""}`}
        >
          {hideStatus ? null : <StatusIndicator {...status} />}
          {lastOnline}
        </div>
      </div>
    </div>
  );
}

/**
 * Every offline or disconnected Local card says when it was last online, so two computers with the same
 * name can be told apart. With no timestamp the line says there is no record rather than "never
 * connected": earlier versions cleared the timestamp on every repair, so a missing value cannot tell a
 * computer that never came online from one whose history was cleared. `undefined` means no reading.
 */
function lastOnlineLine(connection: ComputerConnection, lastSeenAt: string | null | undefined): ReactNode {
  if (connection !== "offline" && connection !== "disconnected") return null;
  if (lastSeenAt === null) return <span className="text-xs text-kumo-subtle">{m.computer_no_last_online()}</span>;
  if (!lastSeenAt) return null;
  return (
    <time className="text-xs text-kumo-subtle" dateTime={lastSeenAt} title={formatDateTime(lastSeenAt)}>
      {m.computer_last_online({ time: formatRelativeTime(lastSeenAt) })}
    </time>
  );
}
