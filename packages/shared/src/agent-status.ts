import { z } from "zod";
import { AgentRuntimeProviderSchema, AgentStatusSchema } from "./agent.js";
import { CloudAvailabilitySchema } from "./cloud-product.js";
import { ProviderReadinessStatusSchema } from "./computer.js";
import { API_V1_PREFIX } from "./http-paths.js";
import { ImBindingSummarySchema } from "./im-binding.js";

export const AGENT_STATUS_BATCH_LIMIT = 100;
export const AGENT_STATUS_HEADER = "x-opentag-agent-status";
export const AGENT_STATUS_VERSION = "1";
export const AGENT_STATUS_PATH = `${API_V1_PREFIX}/agents/status`;
export const AgentStatusIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(AGENT_STATUS_BATCH_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length, "Agent IDs must be unique");
export const AgentStatusQuerySchema = z
  .object({
    ids: z
      .string()
      .transform((value) => value.split(","))
      .pipe(AgentStatusIdsSchema),
  })
  .strict();

export const AgentStatusReasonSchema = z.enum([
  "computer_not_bound",
  "computer_access_required",
  "computer_offline",
  "agent_paused",
  "runtime_unavailable",
  "runtime_check_timed_out",
  "self_check_report_stale",
  "im_not_connected",
  "im_provisioning",
  "im_reauthorization_required",
  "im_error",
  "messaging_cli_unavailable",
  "messaging_cli_check_timed_out",
  "credential_validation_failed",
  "credential_validation_timeout",
  "credential_rate_limited",
  "credential_provider_unreachable",
  "first_validation",
  "legacy_checking",
]);
export const AgentStatusSnapshotSchema = z
  .object({
    agentId: z.string().uuid(),
    agentRevision: z.number().int().positive(),
    agentUpdatedAt: z.iso.datetime(),
    agentStatus: AgentStatusSchema,
    observedAt: z.iso.datetime(),
    checkedAt: z.iso.datetime().nullable(),
    state: z.enum(["ready", "problem", "computer_offline", "initializing"]),
    reason: AgentStatusReasonSchema.nullable(),
    computer: z
      .object({
        computerId: z.string().uuid(),
        kind: z.enum(["local", "cloud"]),
        displayName: z.string(),
        platform: z.enum(["darwin", "linux", "win32"]),
        online: z.boolean(),
        lastSeenAt: z.iso.datetime().nullable(),
      })
      .strict()
      .nullable(),
    runtimeProvider: AgentRuntimeProviderSchema,
    runtimeStatus: ProviderReadinessStatusSchema.nullable(),
    messaging: ImBindingSummarySchema.nullable(),
    cloud: CloudAvailabilitySchema.optional(),
  })
  .strict();
export const AgentStatusResponseSchema = z
  .object({
    statuses: z.array(AgentStatusSnapshotSchema).max(AGENT_STATUS_BATCH_LIMIT),
  })
  .strict();
export type AgentStatusSnapshot = z.infer<typeof AgentStatusSnapshotSchema>;
export type AgentStatusResponse = z.infer<typeof AgentStatusResponseSchema>;
export type AgentStatusReason = z.infer<typeof AgentStatusReasonSchema>;

export function agentStatusesPath(ids: readonly string[]): string {
  const parsed = AgentStatusIdsSchema.parse([...ids]);
  return `${AGENT_STATUS_PATH}?${new URLSearchParams({ ids: parsed.join(",") })}`;
}
