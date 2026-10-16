import type { AccountComputerSummary } from "@opentag/shared/browser";
import { type RefObject, useRef } from "react";
import * as m from "../../paraglide/messages.js";
import { useRemaining } from "../../setup/index.js";
import { Button, Loader, StatusIndicator } from "../../ui/design-system.js";
import {
  type ComputerConnectAdapter,
  type ComputerConnectLifecycle,
  ComputerConnectLifecycleRoot,
} from "./computer-connect.js";
import { ComputerRecoveryInstructions } from "./computer-recovery-instructions.js";

type RecoveryComputer = Pick<AccountComputerSummary, "computerId" | "displayName" | "platform">;

/** One complete assistant task, with optional targeted authorization and observed connection results. */
export function ComputerRecovery({
  computer,
  adapter,
  available = true,
  returnFocusRef,
  onConnected,
}: {
  readonly computer: RecoveryComputer;
  readonly adapter?: ComputerConnectAdapter;
  /** Hide controls during inventory uncertainty while retaining the exact attempt. */
  readonly available?: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly onConnected: () => void;
}) {
  const recoveryRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={recoveryRef}
      tabIndex={-1}
      className="min-w-0 outline-none focus-visible:outline-2 focus-visible:outline-kumo-focus"
    >
      <ComputerConnectLifecycleRoot
        adapter={adapter}
        autoIssue={available}
        intent={{ mode: "repair", target: computer }}
        onConnected={onConnected}
      >
        {(lifecycle) =>
          available ? (
            <RecoveryHelp computer={computer} lifecycle={lifecycle} returnFocusRef={returnFocusRef ?? recoveryRef} />
          ) : null
        }
      </ComputerConnectLifecycleRoot>
    </div>
  );
}

function RecoveryHelp({
  computer,
  lifecycle,
  returnFocusRef,
}: {
  readonly computer: RecoveryComputer;
  readonly lifecycle: ComputerConnectLifecycle;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { error, state } = lifecycle;
  return (
    <div
      className="grid min-w-0 gap-3 text-sm"
      data-ui="computer-recovery"
      data-state={state.kind}
      aria-busy={state.kind === "idle" || state.kind === "issuing"}
    >
      <RecoveryContent computer={computer} lifecycle={lifecycle} returnFocusRef={returnFocusRef} />
      {error && state.kind !== "issue-failed" && state.kind !== "expired" ? (
        <p className="text-kumo-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RecoveryContent({
  computer,
  lifecycle,
  returnFocusRef,
}: {
  readonly computer: RecoveryComputer;
  readonly lifecycle: ComputerConnectLifecycle;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { issue, state } = lifecycle;
  switch (state.kind) {
    case "issued":
      return <IssuedRecovery computer={computer} issued={state.issued} returnFocusRef={returnFocusRef} />;
    case "idle":
    case "issuing":
      return (
        <p className="flex items-center gap-2 text-kumo-subtle" role="status">
          <Loader size="sm" aria-hidden="true" />
          {m.computer_connect_recovery_preparing()}
        </p>
      );
    case "expired":
    case "issue-failed":
      return (
        <div className="grid justify-items-start gap-3">
          <p className="text-kumo-subtle" role="status">
            {state.kind === "expired"
              ? m.computer_connect_recovery_expired()
              : m.computer_connect_recovery_prepare_failed()}
          </p>
          <Button variant="secondary" size="compact" onClick={issue}>
            {state.kind === "expired" ? m.computer_connect_recovery_update() : m.common_try_again()}
          </Button>
        </div>
      );
    case "redeemed":
      return (
        <p className="text-kumo-subtle" role="status">
          {m.computer_connect_recovery_waiting()}
        </p>
      );
    case "connected":
      return <StatusIndicator label={m.computer_connection_restored()} tone="success" />;
  }
}

function IssuedRecovery({
  computer,
  issued,
  returnFocusRef,
}: {
  readonly computer: RecoveryComputer;
  readonly issued: Extract<ComputerConnectLifecycle["state"], { kind: "issued" }>["issued"];
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const remaining = useRemaining(issued.expiresAt);
  return remaining > 0 ? (
    <ComputerRecoveryInstructions computer={computer} command={issued.command} returnFocusRef={returnFocusRef} />
  ) : (
    <p className="flex items-center gap-2 text-kumo-subtle" role="status">
      <Loader size="sm" aria-hidden="true" />
      {m.computer_connect_recovery_verifying()}
    </p>
  );
}
