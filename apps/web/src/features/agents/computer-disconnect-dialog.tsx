import type { AccountComputerSummary, ListAccountComputersResponse } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Dialog, Icon } from "../../ui/design-system.js";

export function ComputerDisconnectDialog({
  computer,
  returnFocusRef,
  onClose,
  onDisconnected,
  onUncertain,
  onCheckStatus,
}: {
  computer: AccountComputerSummary;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDisconnected: () => void;
  onUncertain: () => void;
  onCheckStatus: () => void;
}) {
  const queryClient = useQueryClient();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const disconnect = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await browserApi.disconnectComputer(computer.computerId);
    } catch {
      // A lost response may follow a committed revocation. Ask for a fresh read before another write.
      setUncertain(true);
      setBusy(false);
      onUncertain();
      return;
    }
    await queryClient.cancelQueries({ queryKey: queryKeys.computers() });
    queryClient.setQueryData<ListAccountComputersResponse>(queryKeys.computers(), (current) =>
      current
        ? {
            ...current,
            computers: current.computers.map((item) =>
              item.computerId === computer.computerId
                ? { ...item, connectionStatus: "disconnected", connectedAt: null }
                : item,
            ),
          }
        : current,
    );
    onDisconnected();
  };
  return (
    <Dialog
      title={m.computer_disconnect_title()}
      description={m.computer_disconnect_description()}
      role="alertdialog"
      busy={busy}
      initialFocusRef={cancelRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
      className="w-[calc(100%-2rem)] sm:w-full sm:max-w-lg"
    >
      <div className="grid gap-5">
        <div className="flex min-w-0 items-center gap-3 rounded-lg bg-kumo-tint p-3 text-sm font-medium wrap-anywhere">
          <Icon name="laptop" className="shrink-0" />
          {computer.displayName}
        </div>
        <p className="text-sm text-kumo-subtle">{m.computer_disconnect_preserved()}</p>
        {uncertain ? <Banner role="alert" variant="error" description={m.computer_disconnect_unconfirmed()} /> : null}
        <div className="grid gap-3 sm:flex sm:justify-end">
          <Button
            className="min-h-11 w-full sm:w-auto"
            ref={cancelRef}
            variant="ghost"
            disabled={busy}
            onClick={onClose}
          >
            {uncertain ? m.common_close() : m.computer_keep_connected()}
          </Button>
          {uncertain ? (
            <Button className="min-h-11 w-full sm:w-auto" variant="secondary" onClick={onCheckStatus}>
              {m.computer_check_status()}
            </Button>
          ) : (
            <Button
              className="min-h-11 w-full sm:w-auto sm:min-w-32"
              variant="danger"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              {busy ? m.computer_disconnecting() : m.computer_disconnect()}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
