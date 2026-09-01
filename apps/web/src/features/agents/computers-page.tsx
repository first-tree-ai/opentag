import type { ListWorkspaceComputersResponse, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import { formatDateTime, formatRelativeTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Dialog, StatusIndicator, Text } from "../../ui/design-system.js";
import { ComputerConnect } from "../computer-connect/computer-connect.js";
import { Page } from "../layout/page.js";
import { AsyncState, toResourceState } from "../resource/resource-state.js";
import { useComputersQuery } from "./agent-queries.js";

/**
 * Lists the Account's enrolled Computers and keeps the connection flow available as its own
 * management surface. A Computer can be enrolled before an Agent exists, so this page cannot be
 * folded into the Agent list without making that first-run path unnecessarily indirect.
 */
export function ComputersPage() {
  // The one Computers entry every surface reads, watched because this page is where an operator
  // waits for a Computer to come back.
  const query = useComputersQuery(true);
  const state = toResourceState(query);
  const [connecting, setConnecting] = useState(false);

  return (
    <Page title={m.agents_computers_title()} description={m.agents_computers_description()}>
      <AsyncState state={state}>
        {(value) => (
          <div className="grid gap-6">
            <ComputerList computers={value.computers} />
            <section
              aria-labelledby="connect-computer-heading"
              className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
            >
              <div className="grid gap-1">
                <Text as="h2" id="connect-computer-heading" variant="heading">
                  {m.computer_connect_entry_title()}
                </Text>
                <Text as="p" variant="secondary">
                  {m.computer_connect_entry_description()}
                </Text>
              </div>
              {connecting ? (
                <>
                  <ComputerConnect intent={{ mode: "create" }} onConnected={() => void query.refetch()} />
                  <Button className="w-fit" size="compact" variant="secondary" onClick={() => setConnecting(false)}>
                    {m.computer_connect_entry_close()}
                  </Button>
                </>
              ) : (
                <Button className="w-fit" onClick={() => setConnecting(true)}>
                  {m.computer_connect_entry_action()}
                </Button>
              )}
            </section>
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
        {m.agents_enrolled_computers()}
      </Text>
      {computers.length === 0 ? (
        <Text as="p" variant="secondary">
          {m.agents_no_computers_enrolled()}
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
  const queryClient = useQueryClient();
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<"blocked" | "failed" | undefined>();
  const platform = computer.platform === "darwin" ? "macOS" : computer.platform === "win32" ? "Windows" : "Linux";
  const agentCount = computer.agentIds.length;
  const status = computerStatus(computer);

  async function removeComputer() {
    try {
      setRemoving(true);
      setRemoveError(undefined);
      await browserApi.removeComputer(computer.computerId);
      // A confirmed removal is stronger than a Computers read that may have started before it.
      // Cancel that read and evict the row locally; later watched reads confirm the new Server state.
      await queryClient.cancelQueries({ queryKey: queryKeys.computers() });
      queryClient.setQueryData<ListWorkspaceComputersResponse>(queryKeys.computers(), (current) =>
        current
          ? { ...current, computers: current.computers.filter((item) => item.computerId !== computer.computerId) }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.root() });
    } catch (error) {
      setRemoveError(error instanceof ApiError && error.code === "COMPUTER_REMOVAL_BLOCKED" ? "blocked" : "failed");
      setRemoving(false);
    }
  }

  return (
    <>
      <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
        <div className="grid min-w-0 gap-1">
          <strong className="truncate text-sm font-medium text-kumo-strong">{computer.displayName}</strong>
          <span className="text-sm text-kumo-subtle">
            {platform} · {computerAgentCount(agentCount)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <StatusIndicator detail={status.detail} label={status.label} title={status.title} tone={status.tone} />
          <Button
            aria-label={m.agents_remove_computer_named({ name: computer.displayName })}
            ref={removeButtonRef}
            size="compact"
            variant="ghost"
            onClick={() => {
              setRemoveError(undefined);
              setConfirmingRemoval(true);
            }}
          >
            {m.agents_remove_computer()}
          </Button>
        </div>
      </li>
      {confirmingRemoval ? (
        <Dialog
          busy={removing}
          description={removeComputerDescription(agentCount)}
          returnFocusRef={removeButtonRef}
          role="alertdialog"
          title={m.agents_remove_computer_confirm_title({ name: computer.displayName })}
          onClose={() => {
            setConfirmingRemoval(false);
            setRemoveError(undefined);
          }}
        >
          <div className="grid gap-4">
            {removeError ? (
              <Banner
                role="alert"
                variant="error"
                description={
                  removeError === "blocked" ? m.agents_remove_computer_blocked() : m.agents_remove_computer_failed()
                }
              />
            ) : null}
            <div className="flex flex-wrap justify-end gap-3">
              <Button disabled={removing} variant="ghost" onClick={() => setConfirmingRemoval(false)}>
                {m.common_cancel()}
              </Button>
              <Button disabled={removing} variant="danger" onClick={() => void removeComputer()}>
                {removing ? m.agents_removing_computer() : m.agents_remove_computer()}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function computerAgentCount(count: number): string {
  return count === 1
    ? m.agents_computer_agent_count_single({ count })
    : m.agents_computer_agent_count_plural({ count });
}

function removeComputerDescription(agentCount: number): string {
  if (agentCount === 0) return m.agents_remove_computer_confirm_description();
  if (agentCount === 1) return m.agents_remove_computer_confirm_description_single();
  return m.agents_remove_computer_confirm_description_plural({ count: agentCount });
}

function computerStatus(computer: WorkspaceComputerSummary) {
  if (computer.connectionStatus === "online") {
    return { detail: undefined, label: m.agents_computer_online(), title: undefined, tone: "success" as const };
  }
  return {
    detail: computer.lastSeenAt
      ? m.agents_computer_last_seen({ when: formatRelativeTime(computer.lastSeenAt) })
      : m.agents_computer_never_online(),
    label: m.agents_computer_offline(),
    title: computer.lastSeenAt ? formatDateTime(computer.lastSeenAt) : undefined,
    tone: "neutral" as const,
  };
}
