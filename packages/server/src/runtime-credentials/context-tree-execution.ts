import { contextTreeIdentity, type RuntimeExecutionSandbox, type RuntimeExecutionSource } from "@opentag/shared";
import type { RuntimeScopeSnapshot } from "./scope-resolver.js";
import type { RuntimeExecutionRecord } from "./types.js";

export function contextTreeExecutionIsCurrent(
  execution: RuntimeExecutionRecord,
  parent: RuntimeExecutionRecord | undefined,
  snapshot: RuntimeScopeSnapshot,
): boolean {
  const target = execution.contextTree;
  if (
    !target ||
    execution.purpose !== "context-tree" ||
    parent?.purpose !== "execution" ||
    !parent.services?.some((service) => service.service === "context-tree")
  )
    return false;
  const sameOwner = (
    [
      "accountId",
      "agentId",
      "agentRevision",
      "sessionId",
      "computerId",
      "instanceId",
      "connectionId",
      "placementGeneration",
      "computerKind",
    ] as const
  ).every((key) => execution[key] === parent[key]);
  return (
    sameOwner &&
    execution.source.kind !== "validation" &&
    sourceIdentity(execution.source) === sourceIdentity(parent.source) &&
    sandboxIdentity(execution.sandbox) === sandboxIdentity(parent.sandbox) &&
    snapshot.contextTrees?.some((source) => contextTreeIdentity(source) === contextTreeIdentity(target)) === true
  );
}

function sourceIdentity(source: RuntimeExecutionSource): string {
  if (source.kind === "delivery") return JSON.stringify([source.kind, source.deliveryId, source.turnId]);
  if (source.kind === "session-message") return JSON.stringify([source.kind, source.messageId]);
  return JSON.stringify([source.kind, source.validationRunId]);
}

function sandboxIdentity(sandbox: RuntimeExecutionSandbox | undefined): string {
  return JSON.stringify(sandbox ? [sandbox.sandboxId, sandbox.resourceUid, sandbox.environmentGeneration] : null);
}
