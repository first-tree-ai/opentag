import type { WorkspaceComputerSummary } from "@opentag/shared/browser";
import { StatusIndicator, Text } from "../../ui/design-system.js";
import { Page } from "../layout/page.js";
import { AsyncState, toResourceState } from "../resource/resource-state.js";
import { resolveAccountComputer } from "./account-computer.js";
import { useComputersQuery } from "./agent-queries.js";
import { ComputerSetup } from "./computer-setup.js";

/**
 * The Account's Computer, and the way to get it answering again. A Computer can be connected before
 * an Agent exists, so this page cannot be folded into the Agent list without making that first-run
 * path unnecessarily indirect — and because it is the one Computer surface that needs no Agent, it
 * has to carry the exit for a machine that stops answering before the Account has one.
 *
 * Which exit it is, is the whole point. Enrolment appears only while the Account has no Computer,
 * because the command it hands out creates a *new* machine. A Computer that is merely unreachable
 * gets a repair of that exact machine instead, which keeps its identity, its Agents and its place
 * rather than leaving a second Computer beside the one it replaced.
 */
export function ComputersPage() {
  // The one Computers entry every surface reads, watched because this page is where an operator
  // waits for a Computer to come back.
  const state = toResourceState(useComputersQuery(true));

  return (
    <Page title="Computer" description="The Computer your Agents run on.">
      <AsyncState state={state}>
        {(value) => {
          const computer = resolveAccountComputer(value.computers, (candidate) => ({
            connectionStatus: candidate.connectionStatus,
            runtimeReady: (candidate.providerReadiness ?? []).some((provider) => provider.status === "ready"),
            agentCount: candidate.agentIds.length,
            displayName: candidate.displayName,
          }));
          return (
            <div className="grid gap-6">
              <ComputerList computers={computer ? [computer] : []} />
              {computer === undefined ? <ComputerSetup /> : null}
              {computer?.connectionStatus === "offline" ? (
                <ComputerSetup target={{ computerId: computer.computerId, displayName: computer.displayName }} />
              ) : null}
            </div>
          );
        }}
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
        Your Computer
      </Text>
      {computers.length === 0 ? (
        <Text as="p" variant="secondary">
          No Computer is connected yet.
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
