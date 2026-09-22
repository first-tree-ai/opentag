import type { AccountComputerSummary } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { resourceSuccessObservation } from "../../query/session-cache.js";
import { Button, DropdownMenu, Icon } from "../../ui/design-system.js";
import { type ComputerConnectAdapter, ComputerConnectLifecycleRoot } from "../computer-connect/computer-connect.js";
import { ComputerConnectionDialog } from "./computer-connection-dialog.js";
import { ComputerDeleteDialog } from "./computer-delete-dialog.js";
import { ComputerDisconnectDialog } from "./computer-disconnect-dialog.js";
import { computerManagementAction } from "./computer-management-action.js";
import { ComputerIdentity } from "./computer-status.js";

export function ComputerManagement({
  computer,
  confirmed,
  refreshing = false,
  adapter,
  onConnected,
  onDeleted,
}: {
  computer: AccountComputerSummary;
  confirmed: boolean;
  refreshing?: boolean;
  adapter?: ComputerConnectAdapter;
  onConnected: () => void;
  onDeleted: (computer: AccountComputerSummary) => void;
}) {
  const [dialog, setDialog] = useState<"help" | "disconnect" | "delete" | null>(null);
  const queryClient = useQueryClient();
  const [uncertainAfter, setUncertainAfter] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  const actionRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const cloud = computer.kind === "cloud";
  const observation = resourceSuccessObservation(queryClient, queryKeys.computers())?.seq ?? 0;
  const uncertain = uncertainAfter !== undefined && observation <= uncertainAfter;
  const known = confirmed && !uncertain;
  const connection = known ? computer.connectionStatus : "unconfirmed";
  const intent = { mode: "repair" as const, target: computer };
  const close = () => {
    setDialog(null);
    if (dialog === "disconnect" || dialog === "delete") window.setTimeout(() => menuRef.current?.focus());
  };
  return (
    <ComputerConnectLifecycleRoot key={attempt} intent={intent} adapter={adapter} onConnected={onConnected}>
      {(lifecycle) => {
        const action = computerManagementAction(connection, lifecycle.state.kind, Boolean(lifecycle.error), uncertain);
        const openHelp = () => {
          setDialog("help");
          if (
            connection === "disconnected" &&
            (lifecycle.state.kind === "idle" || lifecycle.state.kind === "connected")
          )
            lifecycle.issue();
        };
        const closeHelp = () => {
          close();
          if (lifecycle.state.kind === "connected") lifecycle.reset();
        };
        return (
          <section
            ref={cardRef}
            tabIndex={-1}
            className="grid min-w-0 gap-5 rounded-lg border border-kumo-line bg-kumo-base p-5 outline-none focus-visible:outline-2 focus-visible:outline-kumo-focus wrap-anywhere"
            data-ui="computer-management"
          >
            <ComputerIdentity
              reserveStatusSpace
              computer={computer}
              connection={connection}
              lastSeenAt={computer.lastSeenAt}
            />
            <ManagementFooter
              cloud={cloud}
              computer={computer}
              known={known}
              action={action}
              refreshing={refreshing}
              actionRef={actionRef}
              menuRef={menuRef}
              onRetry={onConnected}
              onHelp={openHelp}
              onDialog={setDialog}
            />
            <ComputerConnectionDialog
              open={dialog === "help"}
              computer={computer}
              confirmed={known}
              intent={intent}
              lifecycle={lifecycle}
              onClose={closeHelp}
              returnFocusRef={action.label ? actionRef : cardRef}
            />
            {dialog === "disconnect" ? (
              <ComputerDisconnectDialog
                computer={computer}
                returnFocusRef={menuRef}
                onClose={close}
                onDisconnected={() => {
                  close();
                  setUncertainAfter(undefined);
                  setAttempt((value) => value + 1);
                  onConnected();
                }}
                onUncertain={() => {
                  // Read the cache at failure time, not the render that started the request.
                  // The dialog has cancelled older reads; only a subsequent Server read can clear this latch.
                  setUncertainAfter(resourceSuccessObservation(queryClient, queryKeys.computers())?.seq ?? 0);
                }}
                onCheckStatus={() => {
                  close();
                  onConnected();
                }}
              />
            ) : null}
            {dialog === "delete" ? (
              <ComputerDeleteDialog
                computer={computer}
                returnFocusRef={menuRef}
                onClose={close}
                onDeleted={onDeleted}
              />
            ) : null}
          </section>
        );
      }}
    </ComputerConnectLifecycleRoot>
  );
}

function ManagementFooter({
  cloud,
  computer,
  known,
  action,
  refreshing,
  actionRef,
  menuRef,
  onRetry,
  onHelp,
  onDialog,
}: {
  cloud: boolean;
  computer: AccountComputerSummary;
  known: boolean;
  action: ReturnType<typeof computerManagementAction>;
  refreshing: boolean;
  actionRef: RefObject<HTMLButtonElement | null>;
  menuRef: RefObject<HTMLButtonElement | null>;
  onRetry: () => void;
  onHelp: () => void;
  onDialog: (dialog: "disconnect" | "delete") => void;
}) {
  return (
    <>
      {cloud ? (
        <p className="text-sm text-kumo-subtle">{m.computer_cloud_description()}</p>
      ) : (
        <div
          className="grid min-w-0 gap-4 border-t border-kumo-line pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          data-ui="computer-management-footer"
        >
          <p className="flex min-h-16 items-center text-sm text-kumo-subtle sm:min-h-11" aria-live="polite">
            {action.description}
          </p>
          <div className="flex items-center justify-end gap-2">
            <div className="flex min-h-11 w-44 items-center justify-end" data-ui="computer-primary-slot">
              {action.label ? (
                <Button
                  ref={actionRef}
                  className="min-h-11"
                  variant="secondary"
                  disabled={action.retry && refreshing}
                  onClick={action.retry ? onRetry : onHelp}
                >
                  {action.retry && refreshing ? m.computer_checking_status() : action.label}
                </Button>
              ) : null}
            </div>
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
                {computer.connectionStatus !== "disconnected" ? (
                  <DropdownMenu.Item disabled={!known} onClick={() => onDialog("disconnect")}>
                    {m.computer_disconnect()}
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item disabled={!known} onClick={() => onDialog("delete")}>
                  {m.computer_delete_button()}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
        </div>
      )}
    </>
  );
}
