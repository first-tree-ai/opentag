import * as m from "../../paraglide/messages.js";
import type { ComputerConnectState } from "../computer-connect/computer-connect.js";
import type { ComputerConnection } from "./computer-status.js";

/** Operation progress changes the action row, never the last confirmed connection badge. */
export function computerManagementAction(
  connection: ComputerConnection,
  attempt: ComputerConnectState["kind"],
  pollFailed: boolean,
  disconnectUncertain: boolean,
) {
  if (connection === "unconfirmed")
    return {
      description: disconnectUncertain
        ? m.computer_disconnect_unconfirmed()
        : m.computer_status_unavailable_description(),
      label: disconnectUncertain ? m.computer_check_status() : m.common_try_again(),
      retry: true,
    };
  if (connection === "online") return { description: m.computer_online_description(), label: undefined, retry: false };
  const description = attemptDescription(attempt, pollFailed);
  if (description) return { description, label: m.computer_view_instructions(), retry: false };
  return connection === "disconnected"
    ? { description: m.computer_disconnected_description(), label: m.computer_reconnect(), retry: false }
    : { description: m.computer_connect_recovery_wake(), label: m.computer_connect_recovery_help(), retry: false };
}

function attemptDescription(attempt: ComputerConnectState["kind"], pollFailed: boolean): string | undefined {
  switch (attempt) {
    case "issuing":
      return m.computer_connect_issuing();
    case "issued":
      return pollFailed ? m.computer_connect_poll_failed() : m.computer_run_connection_command();
    case "redeemed":
      return pollFailed ? m.computer_connect_poll_failed() : m.computer_connect_registered();
    case "expired":
      return m.computer_connect_expired_status();
    case "issue-failed":
      return m.computer_connect_issue_failed();
    default:
      return undefined;
  }
}
