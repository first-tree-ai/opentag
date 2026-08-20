import { type EffectiveRuntimeSnapshot, type InputRejectReason, OPENTAG_MESSAGE_TOOLS } from "@opentag/shared";
import type { AgentRuntimePolicy } from "../../agent-runtime/types.js";

const OPENTAG_TOOL_SET: ReadonlySet<string> = new Set(OPENTAG_MESSAGE_TOOLS);

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
  if (snapshot.allowedTools.some((tool) => !OPENTAG_TOOL_SET.has(tool))) return "configuration_unsupported";
  return undefined;
}
