import { redactSensitive } from "@opentag/shared";
import type { AgentInteractionRequest, JsonValue } from "../agent-runtime/types.js";

/** What a person is asked to approve: the Provider's message and the redacted action, without transport metadata. */
export function approvalDescription(request: Pick<AgentInteractionRequest, "message" | "details">): string {
  const details = request.details;
  const action =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details.command ?? details.permissions ?? details.grantRoot ?? details)
      : details;
  return [...new Set([request.message, action ? describeApprovalAction(redactSensitive(action)) : undefined])]
    .filter(Boolean)
    .join("\n\n");
}

export function approvalCommandPresentation(details: JsonValue | undefined, message: string | undefined) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  if (typeof details.command !== "string" || details.command.length === 0) return {};
  return {
    commandPresentation: {
      command: redactSensitive(details.command),
      reason: message && message !== details.command ? redactSensitive(message) : "",
    },
  };
}

function describeApprovalAction(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(describeApprovalAction).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "threadId",
            "turnId",
            "itemId",
            "approvalId",
            "environmentId",
            "reason",
            "cwd",
            "commandActions",
            "availableDecisions",
            "proposedExecpolicyAmendment",
          ].includes(key),
      )
      .map(
        ([key, entry]) =>
          `${key.replaceAll(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")}: ${key === "arguments" ? JSON.stringify(entry, null, 2) : describeApprovalAction(entry)}`,
      )
      .join("\n");
  }
  return String(value);
}
