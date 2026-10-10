import type { AccountComputerSummary } from "@opentag/shared/browser";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Button, buttonClassName, Icon, Text } from "../../ui/design-system.js";
import { ComputerConnect } from "../computer-connect/computer-connect.js";
import { Page } from "../layout/page.js";
import {
  AsyncState,
  isConfirmedQuerySuccess,
  isTerminalResourceError,
  ResourceRefreshNotice,
  toResourceState,
  usePersistedSettledError,
} from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import { useAgentListQuery, useComputersQuery } from "./agent-queries.js";
import { accountComputerLink, agentSettingsSectionLink } from "./agent-routes.js";
import { ComputerManagement } from "./computer-management.js";

/** All Account Computers are managed in place; existing targeted links focus the requested card. */
export function ComputersPage({ computerId, fromAgent }: { computerId?: string; fromAgent?: string }) {
  const { me } = useAccount();
  const query = useComputersQuery(true);
  const agentsQuery = useAgentListQuery(me.user.id, Boolean(fromAgent));
  const error = usePersistedSettledError(queryKeys.computers(), query);
  const terminalError = error && isTerminalResourceError(error) ? error : null;
  const refreshError = !terminalError && query.data && error ? error : null;
  const state = toResourceState(
    {
      data: query.data,
      error: terminalError ?? (query.data ? null : error),
      isError: Boolean(terminalError || (!query.data && error)),
    },
    (value) => value,
  );
  const confirmed = isConfirmedQuerySuccess(query) && !error;
  const backAgent = agentsQuery.data?.agents.find((agent) => agent.id === fromAgent);

  return (
    <div className="grid w-full min-w-0 max-w-3xl gap-6 wrap-anywhere">
      {backAgent ? (
        <Link
          {...agentSettingsSectionLink(backAgent.id, "computer")}
          className="flex w-fit max-w-full items-start gap-2 rounded-sm text-sm text-kumo-link focus-visible:outline-2 focus-visible:outline-kumo-focus"
        >
          <Icon name="arrow-left" className="mt-0.5 shrink-0" />
          <span className="min-w-0">{m.computer_back_to_agent({ name: backAgent.displayName })}</span>
        </Link>
      ) : null}
      <Page title={m.agents_computers_title()} description={m.agents_computers_description()}>
        <div className="grid min-w-0 gap-6">
          {refreshError ? <ResourceRefreshNotice error={refreshError} onRetry={() => void query.refetch()} /> : null}
          <AsyncState state={state}>
            {({ computers }) => (
              <ComputerContent
                key={computerId ?? "account"}
                computers={computers}
                computerId={computerId}
                fromAgent={fromAgent}
                confirmed={confirmed}
                refreshing={query.isFetching}
                onConnected={() => void query.refetch()}
              />
            )}
          </AsyncState>
          {state.kind === "error" && !terminalError ? (
            <Button className="w-fit" variant="secondary" onClick={() => void query.refetch()}>
              {m.common_try_again()}
            </Button>
          ) : null}
        </div>
      </Page>
    </div>
  );
}

function ComputerContent({
  computers,
  computerId,
  fromAgent,
  confirmed,
  refreshing,
  onConnected,
}: {
  computers: readonly AccountComputerSummary[];
  computerId?: string;
  fromAgent?: string;
  confirmed: boolean;
  refreshing: boolean;
  onConnected: () => void;
}) {
  const navigate = useNavigate();
  const [connecting, setConnecting] = useState(false);
  // Redemption can populate inventory before the daemon starts. Keep the exact attempt mounted
  // until it confirms online, so this intermediate state never offers a second connection attempt.
  const finishConnection = () => {
    setConnecting(false);
    onConnected();
  };
  if (connecting)
    return <FirstComputer connecting onStart={() => setConnecting(true)} onConnected={finishConnection} />;
  if (computers.length === 0)
    return computerId ? (
      <ComputerMissing />
    ) : confirmed ? (
      <FirstComputer connecting={false} onStart={() => setConnecting(true)} onConnected={finishConnection} />
    ) : null;
  return (
    <div className="grid min-w-0 gap-4">
      {computerId && !computers.some((computer) => computer.computerId === computerId) ? <ComputerMissing /> : null}
      {computers.map((computer) => (
        <ComputerManagement
          computer={computer}
          confirmed={confirmed}
          refreshing={refreshing}
          key={computer.computerId}
          requested={computer.computerId === computerId}
          onConnected={onConnected}
          onDeleted={() => void navigate(accountComputerLink(undefined, fromAgent))}
        />
      ))}
    </div>
  );
}

function FirstComputer({
  connecting,
  onStart,
  onConnected,
}: {
  connecting: boolean;
  onStart: () => void;
  onConnected: () => void;
}) {
  return (
    <section aria-labelledby="first-computer-heading" className="grid gap-6 ui-surface bg-kumo-base p-6">
      <div className="grid gap-3">
        <span aria-hidden="true" className="grid size-12 place-items-center rounded-lg bg-kumo-tint">
          <Icon name="laptop" className="size-6" />
        </span>
        <Text as="h2" id="first-computer-heading" variant="heading">
          {m.computer_first_heading()}
        </Text>
        <p className="max-w-prose text-sm text-kumo-subtle">{m.computer_first_description()}</p>
      </div>
      {connecting ? (
        <ComputerConnect intent={{ mode: "create" }} onConnected={onConnected} />
      ) : (
        <Button className="w-fit" onClick={onStart}>
          {m.computer_connect_entry_action()}
        </Button>
      )}
    </section>
  );
}

function ComputerMissing() {
  return (
    <div className="grid gap-3">
      <p role="status">{m.computer_missing()}</p>
      <Link {...accountComputerLink()} className={buttonClassName({ variant: "secondary", className: "w-fit" })}>
        {m.computer_view_all()}
      </Link>
    </div>
  );
}
