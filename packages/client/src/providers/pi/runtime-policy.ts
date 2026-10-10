import type { EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import type { AgentRuntimePolicy } from "../../agent-runtime/types.js";

export function piRuntimePolicy(): AgentRuntimePolicy {
  return {
    fileSystem: "unrestricted",
    network: "enabled",
    approvals: "never",
    tools: { mode: "provider-default" },
  };
}

export function validatePiRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
  if (!snapshot.execution.networkAccess || snapshot.execution.approvalPolicy !== "never") {
    return "configuration_unsupported";
  }
  return undefined;
}
