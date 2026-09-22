import type { AccountComputerSummary } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, StatusIndicator, Text } from "../../ui/design-system.js";
import { ComputerConnect } from "../computer-connect/computer-connect.js";
import { Page } from "../layout/page.js";
import {
  AsyncState,
  isTerminalResourceError,
  ResourceRefreshNotice,
  toResourceState,
  usePersistedSettledError,
} from "../resource/resource-state.js";
import { useComputersQuery } from "./agent-queries.js";
import { ComputerDeleteDialog } from "./computer-delete-dialog.js";

/**
 * Lists the Account's connected Computers and keeps the connection flow available as its own
 * management surface. A Computer can be connected before an Agent exists, so this page cannot be
 * folded into the Agent list without making that first-run path unnecessarily indirect.
 */
export function ComputersPage() {
  // The one Computers entry every surface reads, watched because this page is where an operator
  // waits for a Computer to come back.
  const query = useComputersQuery(true);
  const persistedError = usePersistedSettledError(queryKeys.computers(), {
    error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
    isError: query.isError,
    isSuccess: query.isSuccess,
  });
  const terminalError = persistedError && isTerminalResourceError(persistedError) ? persistedError : null;
  const refreshError =
    !terminalError && query.data && query.isError && persistedError && !isTerminalResourceError(persistedError)
      ? persistedError
      : null;
  const state = toResourceState(
    {
      data: query.data,
      error: terminalError ?? (query.data ? null : persistedError),
      isError: terminalError !== null || (Boolean(persistedError) && !query.data),
    },
    (value) => value,
  );
  const [connecting, setConnecting] = useState(false);

  return (
    <Page title={m.agents_computers_title()} description={m.agents_computers_description()}>
      {refreshError ? <ResourceRefreshNotice error={refreshError} onRetry={() => void query.refetch()} /> : null}
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

export function ComputerList({ computers }: { computers: readonly AccountComputerSummary[] }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [deletedName, setDeletedName] = useState<string>();
  return (
    <section
      aria-labelledby="connected-computers-heading"
      className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
    >
      <Text as="h2" id="connected-computers-heading" ref={headingRef} tabIndex={-1} variant="heading">
        {m.agents_connected_computers()}
      </Text>
      {deletedName ? (
        <Banner role="status" variant="secondary" description={m.agents_computer_deleted({ name: deletedName })} />
      ) : null}
      {computers.length === 0 ? (
        <Text as="p" variant="secondary">
          {m.agents_no_computers_connected()}
        </Text>
      ) : (
        <ul className="grid divide-y divide-kumo-line">
          {computers.map((computer) => (
            <ComputerListItem
              computer={computer}
              key={computer.computerId}
              onDeleted={(deleted) => {
                setDeletedName(deleted.displayName);
                // The row and its Delete button are gone, so focus lands on the list it left.
                headingRef.current?.focus();
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ComputerListItem({
  computer,
  onDeleted,
}: {
  computer: AccountComputerSummary;
  onDeleted: (computer: AccountComputerSummary) => void;
}) {
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const online = computer.connectionStatus === "online";
  const platform = computer.platform === "darwin" ? "macOS" : computer.platform === "win32" ? "Windows" : "Linux";
  const agentCount = computer.agentIds.length;
  // A Cloud Computer is managed by the deployment and has no machine credential to revoke.
  const deletable = computer.kind !== "cloud";
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="grid min-w-0 gap-1">
        <strong className="truncate text-sm font-medium text-kumo-strong">{computer.displayName}</strong>
        <span className="text-sm text-kumo-subtle">
          {platform} ·{" "}
          {agentCount === 1
            ? m.agents_computer_agent_count_single({ count: agentCount })
            : m.agents_computer_agent_count_plural({ count: agentCount })}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <StatusIndicator
          label={online ? m.agents_computer_online() : m.agents_computer_offline()}
          tone={online ? "success" : "warning"}
        />
        {deletable ? (
          <Button
            aria-label={m.agents_computer_delete_button_label({ name: computer.displayName })}
            ref={deleteButtonRef}
            size="compact"
            variant="secondary"
            onClick={() => setConfirming(true)}
          >
            {m.agents_computer_delete_button()}
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <ComputerDeleteDialog
          computer={computer}
          returnFocusRef={deleteButtonRef}
          onClose={() => setConfirming(false)}
          onDeleted={onDeleted}
        />
      ) : null}
    </li>
  );
}
