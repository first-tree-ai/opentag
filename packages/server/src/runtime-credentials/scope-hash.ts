import { createHash } from "node:crypto";
import type { RuntimeCredentialProvider } from "@opentag/shared";
import type { RuntimeGitHubAdmissionBinding, RuntimeGitHubAdmissionResult } from "./github-admission.js";
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

/**
 * Exact GitHub admission proof hash: authorization revision plus the full sorted repository scope
 * (repository identity, role/access, and the entire Agent scope: ref, publish mode, and task
 * delegation). `credentialGeneration` is deliberately excluded so a normal UAT token refresh does
 * not revoke unchanged scopes.
 */
export function computeGitHubScopeHash(
  execution: RuntimeExecutionRecord,
  bindingId: string,
  admission: RuntimeGitHubAdmissionResult,
): string {
  const repositories = admission.bindings
    .map(gitHubScopeTuple)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return createHash("sha256")
    .update(
      canonicalJson([
        2,
        execution.executionId,
        execution.runId,
        execution.agentRevision,
        execution.placementGeneration,
        execution.purpose,
        "github",
        bindingId,
        admission.authorizationVersion,
        repositories,
      ]),
    )
    .digest("hex");
}

function gitHubScopeTuple(binding: RuntimeGitHubAdmissionBinding) {
  return [binding.repositoryId, binding.fullName, binding.role, binding.access, binding.scope ?? null] as const;
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
