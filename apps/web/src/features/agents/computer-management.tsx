import type { AccountComputerSummary } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { ComputerRecovery } from "../computer-connect/computer-recovery.js";
import { ComputerIdentity } from "./computer-status.js";

export function ComputerManagement({
  computer,
  confirmed,
  onConnected,
}: {
  computer: AccountComputerSummary;
  confirmed: boolean;
  onConnected: () => void;
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
    </section>
  );
}
