import type { AccountComputerSummary, ListAccountComputersResponse } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Dialog, Field, KumoInputControl } from "../../ui/design-system.js";

/**
 * Confirms and performs a Computer deletion. The server revokes the Computer's machine credential, so
 * the dialog makes the operator type the name, warns when the machine is online (it is disconnected
 * immediately), and refuses up front while Agents still run there, mirroring the server's own refusal.
 */
export function ComputerDeleteDialog({
  computer,
  returnFocusRef,
  onClose,
  onDeleted,
}: {
  computer: AccountComputerSummary;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDeleted: (computer: AccountComputerSummary) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmationText, setConfirmationText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const agentCount = computer.agentIds.length;
  const inUse = agentCount > 0;
  const inputId = `computer-delete-confirmation-${computer.computerId}`;

  async function deleteComputer() {
    try {
      setBusy(true);
      setError(undefined);
      await browserApi.deleteComputer(computer.computerId);
      // A confirmed delete is stronger than a racing list refresh: drop the row first, then revalidate.
      await queryClient.cancelQueries({ queryKey: queryKeys.computers() });
      queryClient.setQueryData<ListAccountComputersResponse>(queryKeys.computers(), (current) =>
        current
          ? { ...current, computers: current.computers.filter((item) => item.computerId !== computer.computerId) }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.computers() });
      onDeleted(computer);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === "COMPUTER_IN_USE"
          ? m.agents_computer_delete_in_use()
          : m.agents_computer_delete_failed(),
      );
      setBusy(false);
    }
  }

  return (
    <Dialog
      busy={busy}
      description={m.agents_computer_delete_confirm_description()}
      returnFocusRef={returnFocusRef}
      role="alertdialog"
      title={m.agents_computer_delete_confirm_title({ name: computer.displayName })}
      onClose={onClose}
    >
      <div className="grid gap-4">
        {inUse ? <Banner variant="error" description={m.agents_computer_delete_in_use()} /> : null}
        {!inUse && computer.connectionStatus === "online" ? (
          <Banner variant="secondary" description={m.agents_computer_delete_online_warning()} />
        ) : null}
        {inUse ? null : (
          <Field htmlFor={inputId} label={m.agents_computer_delete_confirm_label({ name: computer.displayName })}>
            <KumoInputControl
              autoComplete="off"
              id={inputId}
              value={confirmationText}
              onChange={(event) => setConfirmationText(event.currentTarget.value)}
            />
          </Field>
        )}
        {error ? <Banner variant="error" role="alert" description={error} /> : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button disabled={busy} variant="ghost" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button
            disabled={busy || inUse || confirmationText !== computer.displayName}
            variant="danger"
            onClick={() => void deleteComputer()}
          >
            {busy ? m.agents_computer_deleting() : m.agents_computer_delete_final_button()}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
