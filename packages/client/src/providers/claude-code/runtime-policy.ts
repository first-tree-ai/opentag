import type { EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import type { AgentRuntimePolicy } from "../../agent-runtime/types.js";
import { allowedCommandsForPolicy } from "../native-permissions.js";

export function claudeCodeRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): AgentRuntimePolicy {
  return {
    fileSystem: "unrestricted",
    network: "enabled",
    approvals: snapshot.execution.approvalPolicy,
    allowedCommands: allowedCommandsForPolicy(snapshot),
    tools: { mode: "provider-default" },
  };
}

export function validateClaudeCodeRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
  if (!snapshot.execution.networkAccess) {
    return "configuration_unsupported";
  }
  return undefined;
}
