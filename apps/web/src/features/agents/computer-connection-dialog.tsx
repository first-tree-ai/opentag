import type { AccountComputerSummary } from "@opentag/shared/browser";
import type { RefObject } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Collapsible, Dialog, Icon, StatusIndicator } from "../../ui/design-system.js";
import {
  type ComputerConnectIntent,
  type ComputerConnectLifecycle,
  ComputerConnectPresentation,
} from "../computer-connect/computer-connect.js";
import { ComputerRecoveryInstructions } from "../computer-connect/computer-recovery-instructions.js";

export function ComputerConnectionDialog({
  open,
  computer,
  confirmed,
  intent,
  lifecycle,
  returnFocusRef,
  onClose,
}: {
  open: boolean;
  computer: AccountComputerSummary;
  confirmed: boolean;
  intent: ComputerConnectIntent;
  lifecycle: ComputerConnectLifecycle;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const connected = confirmed && computer.connectionStatus === "online";
  // A completed attempt is history; only the current inventory can confirm the connection.
  const attempted = lifecycle.state.kind !== "idle" && lifecycle.state.kind !== "connected";
  return (
    <Dialog
      open={open}
      title={
        connected
          ? m.computer_connection_restored()
          : attempted
            ? m.computer_reconnect()
            : m.computer_connection_help_title()
      }
      returnFocusRef={returnFocusRef}
      onClose={onClose}
      className="w-[calc(100%-2rem)] sm:w-full sm:max-w-xl"
    >
      {connected ? (
        <div className="grid gap-5">
          <StatusIndicator
            tone="success"
            label={m.computer_connect_connected({ computerName: computer.displayName })}
          />
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              {m.common_done()}
            </Button>
          </div>
        </div>
      ) : attempted ? (
        <ComputerConnectPresentation intent={intent} lifecycle={lifecycle} />
      ) : (
        <div className="grid min-w-0 gap-5">
          <ComputerRecoveryInstructions computer={computer} expandable />
          <Collapsible.Root>
            <Collapsible.Trigger render={<Button variant="ghost" size="compact" className="text-kumo-subtle" />}>
              {m.computer_connect_recovery_repair_help()}
              <Icon name="chevron-right" className="size-4 in-data-[panel-open]:rotate-90" />
            </Collapsible.Trigger>
            <Collapsible.Panel className="grid gap-3 pt-3">
              <p className="text-sm text-kumo-subtle">{m.computer_connect_recovery_repair_scope()}</p>
              <Button className="w-fit" variant="secondary" disabled={!confirmed} onClick={lifecycle.issue}>
                {m.computer_connect_repair_action()}
              </Button>
            </Collapsible.Panel>
          </Collapsible.Root>
        </div>
      )}
    </Dialog>
  );
}
