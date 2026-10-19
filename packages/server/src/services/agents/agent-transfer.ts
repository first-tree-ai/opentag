/**
 * Contract of the operator-only "transfer an Agent to another Account" mutation.
 *
 * Every rejection is decided while the Agent row is locked, so the whole failure surface is this
 * closed union instead of a raw constraint violation. All members are deterministic: repeating the
 * command with the same database state produces the same reason. There is no HTTP mapping, because
 * the only caller is the admin CLI (`src/admin/transfer-agent.ts`).
 *
 * `slack: "keep"` is supported for a Slack binding only. `im_bindings`, `slack_installations` and
 * the sealed Slack credential carry no Account column — the credential envelope is bound to the
 * installation id alone — so a kept installation keeps working under the new owner. A Feishu
 * binding is rejected instead: its credential material and tenant setup are the source Account's
 * own app authorization, which this operation cannot re-anchor.
 */
export type AgentTransferRejection =
  | "agent_not_found"
  | "agent_not_suspended"
  | "target_account_not_found"
  | "same_account"
  | "name_conflict"
  | "sessions_blocked"
  | "im_binding_keep_unsupported";

const REJECTION_MESSAGES: Record<AgentTransferRejection, string> = {
  agent_not_found: "The Agent does not exist or is deleted",
  agent_not_suspended: "An Agent must be suspended before it can be transferred",
  target_account_not_found: "The target Account does not exist",
  same_account: "The target Account already owns the Agent",
  name_conflict: "The target Account already has a non-deleted Agent with this name",
  sessions_blocked:
    "The Agent cannot be transferred while Sessions have pending delivery, unreported Turns, or uncertain custody",
  im_binding_keep_unsupported: "Only a Slack messaging binding can be kept across a transfer",
};

export class AgentTransferError extends Error {
  constructor(readonly reason: AgentTransferRejection) {
    super(REJECTION_MESSAGES[reason]);
    this.name = "AgentTransferError";
  }
}

export interface AgentTransferInput {
  agentId: string;
  /** `disable` tears the messaging binding down; `keep` leaves a Slack binding serving the Agent. */
  slack: "disable" | "keep";
  targetAccountId: string;
}

export interface AgentTransferResult {
  agentId: string;
  imBinding: "disabled" | "kept" | "none";
  previousComputerId: string | null;
  revision: number;
  /** Runtime config fields reset because they were only valid under the previous Computer. */
  runtimeConfigReset: ("contextTrees" | "model")[];
  /**
   * Schedules paused because their pinned target Session ends with the transfer. The rows stay so the
   * new owner can see what existed, but a paused Schedule never dispatches.
   */
  schedulesPaused: number;
  slack: "disable" | "keep";
  sourceAccountId: string;
  targetAccountId: string;
}
