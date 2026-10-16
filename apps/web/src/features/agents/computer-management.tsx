import type { AccountComputerSummary } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, DropdownMenu, Icon } from "../../ui/design-system.js";
import type { ComputerConnectAdapter } from "../computer-connect/computer-connect.js";
import { ComputerRecovery } from "../computer-connect/computer-recovery.js";
import { ComputerDeleteDialog } from "./computer-delete-dialog.js";
import { ComputerIdentity } from "./computer-status.js";

export function ComputerManagement({
  computer,
  confirmed,
  refreshing = false,
  adapter,
  requested = false,
  onConnected,
  onDeleted,
}: {
  computer: AccountComputerSummary;
  confirmed: boolean;
  refreshing?: boolean;
  adapter?: ComputerConnectAdapter;
  requested?: boolean;
  onConnected: () => void;
  onDeleted: (computer: AccountComputerSummary) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const cloud = computer.kind === "cloud";
  const connection = confirmed ? computer.connectionStatus : "unconfirmed";

  useEffect(() => {
    if (requested) cardRef.current?.focus();
  }, [requested]);

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      className="grid min-w-0 gap-5 ui-surface bg-kumo-base p-5 outline-none focus-visible:outline-2 focus-visible:outline-kumo-focus wrap-anywhere"
      data-ui="computer-management"
    >
      <ComputerIdentity
        compact
        computer={computer}
        connection={connection}
        lastSeenAt={computer.lastSeenAt}
        actions={
          cloud ? undefined : (
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button
                    ref={menuRef}
                    className="min-h-11 min-w-11"
                    variant="ghost"
                    shape="square"
                    aria-label={m.computer_more_actions()}
                  />
                }
              >
                <Icon name="more-vertical" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Item disabled={!confirmed} onClick={() => setDeleting(true)}>
                  {m.computer_remove_action()}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          )
        }
      />
      {!cloud && connection !== "online" ? (
        <div className={confirmed ? "min-w-0 border-t border-kumo-line pt-5 sm:ml-13" : "min-w-0"}>
          <ComputerRecovery
            computer={computer}
            adapter={adapter}
            available={confirmed}
            returnFocusRef={cardRef}
            onConnected={onConnected}
          />
          {!confirmed ? (
            <Button className="w-fit" variant="secondary" disabled={refreshing} onClick={onConnected}>
              {refreshing ? m.computer_checking_status() : m.computer_check_status()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {deleting ? (
        <ComputerDeleteDialog
          computer={computer}
          returnFocusRef={menuRef}
          onClose={() => setDeleting(false)}
          onDeleted={onDeleted}
        />
      ) : null}
    </section>
  );
}
