import type { EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import type { AgentRuntimePolicy } from "../../agent-runtime/types.js";
import { allowedCommandsForPolicy } from "../native-permissions.js";

export function codexRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): AgentRuntimePolicy {
  return {
    fileSystem: snapshot.execution.approvalPolicy === "never" ? "unrestricted" : "workspace-write",
    network: snapshot.execution.networkAccess ? "enabled" : "disabled",
    approvals: snapshot.execution.approvalPolicy,
    allowedCommands: allowedCommandsForPolicy(snapshot),
    tools: { mode: "provider-default" },
  };
}

export function validateCodexRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
  if (snapshot.execution.approvalPolicy === "never" && !snapshot.execution.networkAccess) {
    return "configuration_unsupported";
  }
  return undefined;
}
