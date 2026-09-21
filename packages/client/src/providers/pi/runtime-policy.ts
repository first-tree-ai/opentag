import type { EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import type { AgentRuntimePolicy } from "../../agent-runtime/types.js";

/**
 * Pi has no OS filesystem sandbox and no approval gate. Product policy must stay unrestricted
 * writes plus network; anything stricter is rejected instead of being silently ignored.
 */
export function piRuntimePolicy(_snapshot: EffectiveRuntimeSnapshot): AgentRuntimePolicy {
  return {
    fileSystem: "unrestricted",
    network: "enabled",
    approvals: "never",
    tools: { mode: "provider-default" },
  };
}

export function validatePiRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
  if (snapshot.execution.approvalPolicy !== "never" || !snapshot.execution.networkAccess) {
    return "configuration_unsupported";
  }
  return undefined;
}
