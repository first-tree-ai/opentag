import type { EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import type { AgentRuntimePolicy } from "../../agent-runtime/types.js";

export function codexRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): AgentRuntimePolicy {
  return {
    fileSystem: "workspace-write",
    network: snapshot.execution.networkAccess ? "enabled" : "disabled",
    approvals: "never",
    tools: { mode: "provider-default" },
  };
}

export function validateCodexRuntimePolicy(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
  if (snapshot.execution.approvalPolicy !== "never" || !snapshot.execution.networkAccess) {
    return "configuration_unsupported";
  }
  return undefined;
}
