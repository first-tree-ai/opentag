import type { EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import type { AgentRuntimePolicy } from "../../agent-runtime/types.js";

/** Pi's permission extension provides a decision gate, rather than OS isolation. */
export function piRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): AgentRuntimePolicy {
  return {
    fileSystem: "unrestricted",
    network: "enabled",
    approvals: snapshot.execution.approvalPolicy,
    permissionRules: snapshot.execution.permissions?.rules,
    tools: { mode: "provider-default" },
  };
}

export function validatePiRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
  if (!snapshot.execution.networkAccess) {
    return "configuration_unsupported";
  }
  return undefined;
}
