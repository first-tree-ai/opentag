import type { AccountComputerSummary } from "@opentag/shared/browser";
import { type RefObject, useEffect, useRef, useState } from "react";
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
  // The repair window opens only on request: issuing a command for every offline computer on load
  // makes a long page and leaves unused commands behind. A link that names this computer (Reconnect,
  // Restore connection) is that request, so the named card arrives with its window open.
  const [recovering, setRecovering] = useState(requested);
  const menuRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const cloud = computer.kind === "cloud";
  const connection = confirmed ? computer.connectionStatus : "unconfirmed";

  useEffect(() => {
    // A link that names this computer lands on its card.
    if (requested) cardRef.current?.focus();
  }, [requested]);

  useEffect(() => {
    if (connection === "online") setRecovering(false);
  }, [connection]);

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
        hideStatus={recovering && !cloud && confirmed && connection !== "online"}
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
        <ComputerRepairArea
          adapter={adapter}
          cardRef={cardRef}
          computer={computer}
          confirmed={confirmed}
          recovering={recovering}
          refreshing={refreshing}
          restoreRef={restoreRef}
          onConnected={onConnected}
          onRecover={() => setRecovering(true)}
        />
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

/**
 * Below an offline card: one Restore action, or once pressed, the shared command window in place.
 * While the inventory read is uncertain it offers Check status instead and keeps an open attempt.
 */
function ComputerRepairArea({
  adapter,
  cardRef,
  computer,
  confirmed,
  recovering,
  refreshing,
  restoreRef,
  onConnected,
  onRecover,
}: {
  adapter?: ComputerConnectAdapter;
  cardRef: RefObject<HTMLElement | null>;
  computer: AccountComputerSummary;
  confirmed: boolean;
  recovering: boolean;
  refreshing: boolean;
  restoreRef: RefObject<HTMLButtonElement | null>;
  onConnected: () => void;
  onRecover: () => void;
}) {
  if (confirmed && !recovering) {
    return (
      <div className="min-w-0 sm:ml-13">
        <Button ref={restoreRef} className="w-fit" variant="secondary" onClick={onRecover}>
          {m.computer_recovery_heading()}
        </Button>
      </div>
    );
  }
  return (
    <div className={confirmed ? "min-w-0 border-t border-kumo-line pt-5 sm:ml-13" : "min-w-0"}>
      {recovering ? (
        <ComputerRecovery
          computer={computer}
          adapter={adapter}
          available={confirmed}
          focusOnMount
          returnFocusRef={cardRef}
          onConnected={onConnected}
        />
      ) : null}
      {confirmed ? null : (
        <Button className="w-fit" variant="secondary" disabled={refreshing} onClick={onConnected}>
          {refreshing ? m.computer_checking_status() : m.computer_check_status()}
        </Button>
      )}
    </div>
  );
}
