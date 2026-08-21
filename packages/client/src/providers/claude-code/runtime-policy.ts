import type { EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import type { AgentRuntimePolicy } from "../../agent-runtime/types.js";

export function claudeCodeRuntimePolicy(_snapshot: EffectiveRuntimeSnapshot): AgentRuntimePolicy {
  return {
    fileSystem: "unrestricted",
    network: "enabled",
    approvals: "never",
    tools: { mode: "provider-default" },
  };
}

export function validateClaudeCodeRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
  if (snapshot.execution.approvalPolicy !== "never" || !snapshot.execution.networkAccess) {
    return "configuration_unsupported";
  }
  return undefined;
}
