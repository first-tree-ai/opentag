import type { ChannelName } from "@opentag/shared";
import { CloudRunAdminError } from "./errors.js";

/**
 * Deterministic Cloud Run Instance identity. One Instance per Sandbox environment generation:
 * the name is a pure function of (environment, sandboxId, generation), so a retry after an
 * unknown create result converges on the same resource instead of allocating a duplicate.
 * Ownership is additionally proven by labels — the full sandbox/session identity in hex — which
 * the adapter validates before adopting or deleting any pre-existing resource.
 */

const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,48}$/;
const LABEL_VALUE_PATTERN = /^[a-z0-9_-]{0,63}$/;

export const RUNNER_INSTANCE_LABELS = {
  managedBy: "managed-by",
  environment: "opentag-env",
  generation: "opentag-gen",
  sandbox: "opentag-sandbox",
  session: "opentag-session",
} as const;

export const RUNNER_INSTANCE_MANAGED_BY = "opentag";

const ENVIRONMENT_PREFIX: Record<ChannelName, string> = { dev: "d", staging: "s", prod: "p" };

export interface RunnerInstanceIdentityInput {
  environment: ChannelName;
  sandboxId: string;
  sessionId: string;
  environmentGeneration: number;
}

function hexOf(uuid: string): string {
  const hex = uuid.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new CloudRunAdminError("invalid", "Sandbox identity is not a UUID");
  return hex;
}

/** Deterministic instance id: `ot-{env}-{32 hex}-{generation base36}`, < 50 chars, DNS-safe. */
export function runnerInstanceId(input: RunnerInstanceIdentityInput): string {
  if (!Number.isSafeInteger(input.environmentGeneration) || input.environmentGeneration < 1) {
    throw new CloudRunAdminError("invalid", "Environment generation must be a positive integer");
  }
  const prefix = ENVIRONMENT_PREFIX[input.environment];
  if (!prefix)
    throw new CloudRunAdminError("invalid", `Unsupported environment for Runner naming: ${input.environment}`);
  const id = `ot-${prefix}-${hexOf(input.sandboxId)}-${input.environmentGeneration.toString(36)}`;
  if (!INSTANCE_ID_PATTERN.test(id)) throw new CloudRunAdminError("invalid", "Derived instance id is not DNS-safe");
  return id;
}

/** Full v2 resource name, known before create because the instance id is deterministic. */
export function runnerInstanceResourceName(project: string, region: string, instanceId: string): string {
  return `projects/${project}/locations/${region}/instances/${instanceId}`;
}

/** Ownership labels proving a resource belongs to exactly this Sandbox environment generation. */
export function runnerInstanceLabels(input: RunnerInstanceIdentityInput): Record<string, string> {
  const labels: Record<string, string> = {
    [RUNNER_INSTANCE_LABELS.managedBy]: RUNNER_INSTANCE_MANAGED_BY,
    [RUNNER_INSTANCE_LABELS.environment]: input.environment,
    [RUNNER_INSTANCE_LABELS.generation]: String(input.environmentGeneration),
    [RUNNER_INSTANCE_LABELS.sandbox]: hexOf(input.sandboxId),
    [RUNNER_INSTANCE_LABELS.session]: hexOf(input.sessionId),
  };
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_VALUE_PATTERN.test(value)) {
      throw new CloudRunAdminError("invalid", `Derived label ${key} is not a GCP label value`);
    }
  }
  return labels;
}

/** True only when every ownership label of the expected Sandbox generation is present and exact. */
export function runnerInstanceLabelsMatch(
  labels: Record<string, string> | undefined,
  input: RunnerInstanceIdentityInput,
): boolean {
  if (!labels) return false;
  const expected = runnerInstanceLabels(input);
  return Object.entries(expected).every(([key, value]) => labels[key] === value);
}
