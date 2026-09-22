import type { AccountComputerSummary } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button } from "../../ui/design-system.js";
import { ComputerRecovery } from "../computer-connect/computer-recovery.js";
import { ComputerDeleteDialog } from "./computer-delete-dialog.js";
import { ComputerIdentity } from "./computer-status.js";

export function ComputerManagement({
  computer,
  confirmed,
  onConnected,
  onDeleted,
}: {
  computer: AccountComputerSummary;
  confirmed: boolean;
  onConnected: () => void;
  onDeleted: (computer: AccountComputerSummary) => void;
}) {
  const cloud = computer.kind === "cloud";
  const connection = confirmed ? computer.connectionStatus : "unconfirmed";
  return (
    <section
      className="grid min-w-0 gap-5 rounded-lg border border-kumo-line bg-kumo-base p-5 wrap-anywhere"
      data-ui="computer-management"
    >
      <ComputerIdentity computer={computer} connection={connection} lastSeenAt={computer.lastSeenAt} />
      {cloud ? <p className="max-w-prose text-sm text-kumo-subtle">{m.computer_cloud_description()}</p> : null}
      {!cloud && computer.connectionStatus === "offline" ? (
        <ComputerRecovery computer={computer} available={confirmed} onConnected={onConnected} />
      ) : null}
      {/* A Cloud computer is managed by the deployment and has no machine credential to revoke. */}
      {cloud ? null : <ComputerDeleteSection computer={computer} onDeleted={onDeleted} />}
    </section>
  );
}

function ComputerDeleteSection({
  computer,
  onDeleted,
}: {
  computer: AccountComputerSummary;
  onDeleted: (computer: AccountComputerSummary) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const descriptionId = `computer-delete-description-${computer.computerId}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-5">
      <p className="max-w-prose text-sm text-kumo-subtle" id={descriptionId}>
        {m.computer_delete_description()}
      </p>
      <Button aria-describedby={descriptionId} ref={buttonRef} variant="danger" onClick={() => setConfirming(true)}>
        {m.computer_delete_button()}
      </Button>
      {confirming ? (
        <ComputerDeleteDialog
          computer={computer}
          returnFocusRef={buttonRef}
          onClose={() => setConfirming(false)}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  );
}
