import type { WorkspaceComputerSummary } from "@opentag/shared/browser";
import { browserApi } from "../../api.js";
import { StatusIndicator, Text } from "../../ui/design-system.js";
import { Page } from "../layout/page.js";
import { AsyncState, useResource } from "../resource/use-resource.js";
import { useAccount } from "../session/session-context.js";
import { ComputerSetup } from "./computer-setup.js";

/**
 * Lists the Account's enrolled Computers and keeps the connection flow available as its own
 * management surface. A Computer can be enrolled before an Agent exists, so this page cannot be
 * folded into the Agent list without making that first-run path unnecessarily indirect.
 */
export function ComputersPage() {
  const { me } = useAccount();
  const state = useResource(() => browserApi.computers(), me.user.id, {
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });

  return (
    <Page title="Computers" description="Enroll and recover the Computers used by your Agents.">
      <AsyncState state={state}>
        {(value) => (
          <div className="grid gap-6">
            <ComputerList computers={value.computers} />
            <ComputerSetup />
          </div>
        )}
      </AsyncState>
    </Page>
  );
}

export function ComputerList({ computers }: { computers: readonly WorkspaceComputerSummary[] }) {
  return (
    <section
      aria-labelledby="enrolled-computers-heading"
      className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
    >
      <Text as="h2" id="enrolled-computers-heading" variant="heading">
        Enrolled Computers
      </Text>
      {computers.length === 0 ? (
        <Text as="p" variant="secondary">
          No Computers are enrolled yet.
        </Text>
      ) : (
        <ul className="grid divide-y divide-kumo-line">
          {computers.map((computer) => (
            <ComputerListItem computer={computer} key={computer.computerId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ComputerListItem({ computer }: { computer: WorkspaceComputerSummary }) {
  const online = computer.connectionStatus === "online";
  const platform = computer.platform === "darwin" ? "macOS" : computer.platform === "win32" ? "Windows" : "Linux";
  const agentCount = computer.agentIds.length;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="grid min-w-0 gap-1">
        <strong className="truncate text-sm font-medium text-kumo-strong">{computer.displayName}</strong>
        <span className="text-sm text-kumo-subtle">
          {platform} · {agentCount} {agentCount === 1 ? "Agent" : "Agents"}
        </span>
      </div>
      <StatusIndicator label={online ? "Online" : "Offline"} tone={online ? "success" : "warning"} />
    </li>
  );
}
