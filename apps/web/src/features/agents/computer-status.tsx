import type { AccountComputerSummary } from "@opentag/shared/browser";
import { formatDateTime, formatRelativeTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Icon, StatusIndicator, Text } from "../../ui/design-system.js";
import { platformLabel } from "./agent-presentation.js";

export type ComputerConnection = "online" | "offline" | "unconfirmed";

export function ComputerIdentity({
  computer,
  connection,
  lastSeenAt,
}: {
  computer: Pick<AccountComputerSummary, "displayName" | "platform" | "kind">;
  connection: ComputerConnection;
  lastSeenAt?: string | null;
}) {
  const cloud = computer.kind === "cloud";
  const status =
    connection === "unconfirmed"
      ? { label: m.agent_settings_computer_unconfirmed(), tone: "neutral" as const }
      : cloud
        ? { label: m.computer_managed(), tone: "neutral" as const }
        : connection === "online"
          ? { label: m.agent_settings_computer_online(), tone: "success" as const }
          : { label: m.agent_settings_computer_offline(), tone: "warning" as const };
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusIndicator {...status} />
          {!cloud && connection === "offline" && lastSeenAt ? (
            <time className="text-xs text-kumo-subtle" dateTime={lastSeenAt} title={formatDateTime(lastSeenAt)}>
              {m.computer_last_online({ time: formatRelativeTime(lastSeenAt) })}
            </time>
          ) : null}
        </div>
      </div>
    </div>
  );
}
