import { createHash } from "node:crypto";
import type { RuntimeCredentialProvider } from "@opentag/shared";
import type { RuntimeGitHubAdmissionResult } from "./github-admission.js";
import type { RuntimeExecutionRecord } from "./types.js";

export function computeImScopeHash(
  execution: RuntimeExecutionRecord,
  provider: RuntimeCredentialProvider,
  bindingId: string,
  credentialGeneration: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        1,
        execution.executionId,
        execution.runId,
        execution.agentRevision,
        execution.placementGeneration,
        execution.purpose,
        provider,
        bindingId,
        credentialGeneration,
        null,
        execution.sandbox
          ? [execution.sandbox.sandboxId, execution.sandbox.resourceUid, execution.sandbox.environmentGeneration]
          : null,
      ]),
    )
    .digest("hex");
}

/** Task and Account authority is pinned independently of routine credential rotation. */
export function computeGitHubScopeHash(
  execution: RuntimeExecutionRecord,
  bindingId: string,
  admission: RuntimeGitHubAdmissionResult,
): string {
  return createHash("sha256")
    .update(
      canonicalJson([
        3,
        execution.executionId,
        execution.runId,
        execution.agentRevision,
        execution.placementGeneration,
        execution.purpose,
        "github",
        bindingId,
        admission.authorizationVersion,
        execution.accountId,
        execution.sessionId,
        execution.source,
        "user-task",
      ]),
    )
    .digest("hex");
}

/** Stable-key JSON so equal scope objects always hash identically regardless of key insertion order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
    return sorted;
  }
  return value;
}
