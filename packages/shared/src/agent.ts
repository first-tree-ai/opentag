import { z } from "zod";
import {
  OPENTAG_PLATFORM_INSTRUCTIONS,
  RuntimeInstructionSchema,
  RuntimeInstructionsSchema,
  RuntimeMaxDurationMsSchema,
  RuntimeModelSchema,
  RuntimeReasoningEffortSchema,
} from "./runtime-config.js";

export const AgentNameSchema = z
  .string()
  .trim()
  .min(1, "Agent name is required")
  .max(64, "Agent name must be at most 64 characters")
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "Agent name must start with a lowercase letter or number and contain only lowercase letters, numbers, and hyphens",
  );
export const AgentDisplayNameSchema = z.string().trim().min(1).max(120);
const AgentCreationIntentIdSchema = z.string().uuid();
export const AGENT_RUNTIME_PROVIDERS = ["codex", "claude-code"] as const;
export const AgentRuntimeProviderSchema = z.enum(AGENT_RUNTIME_PROVIDERS);
export const ReceiveModeSchema = z.enum(["all_message", "mention_only"]);
export const AgentStatusSchema = z.enum(["active", "suspended"]);

const AgentInstructionsSchema = RuntimeInstructionSchema.superRefine((instructions, context) => {
  const combined = RuntimeInstructionsSchema.safeParse({
    platform: OPENTAG_PLATFORM_INSTRUCTIONS,
    agent: instructions,
  });
  if (!combined.success) {
    context.addIssue({
      code: "custom",
      message: "Platform and Agent instructions exceed the combined 24 KiB limit",
    });
  }
});
export const AgentRuntimeConfigSchema = z
  .object({
    revision: z.number().int().safe().positive(),
    model: RuntimeModelSchema.nullable(),
    reasoningEffort: RuntimeReasoningEffortSchema.nullable(),
    instructions: AgentInstructionsSchema,
    maxDurationMs: RuntimeMaxDurationMsSchema.nullable(),
  })
  .strict();

export const CreateAgentRuntimeConfigSchema = z
  .object({
    model: RuntimeModelSchema.nullable().optional(),
    reasoningEffort: RuntimeReasoningEffortSchema.nullable().optional(),
    instructions: AgentInstructionsSchema.optional(),
    maxDurationMs: RuntimeMaxDurationMsSchema.nullable().optional(),
  })
  .strict();

export const UpdateAgentRuntimeConfigSchema = z
  .object({
    model: RuntimeModelSchema.nullable().optional(),
    reasoningEffort: RuntimeReasoningEffortSchema.nullable().optional(),
    instructions: AgentInstructionsSchema.optional(),
    maxDurationMs: RuntimeMaxDurationMsSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one runtime config field must be updated",
  });

const AgentIdentitySchema = z
  .object({
    id: z.string().uuid(),
    teamId: z.string().uuid(),
    name: AgentNameSchema,
    displayName: AgentDisplayNameSchema,
    runtimeProvider: AgentRuntimeProviderSchema,
    receiveMode: ReceiveModeSchema,
    status: AgentStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AgentSummarySchema = AgentIdentitySchema.extend({
  manager: z
    .object({
      userId: z.string().uuid(),
      displayName: z.string().min(1),
    })
    .strict(),
  computer: z
    .object({
      id: z.string().uuid(),
      displayName: z.string().min(1),
      platform: z.enum(["darwin", "linux", "win32"]),
    })
    .strict(),
}).strict();

export const AgentDetailSchema = AgentSummarySchema.extend({
  viewerCapabilities: z.object({ canManage: z.boolean() }).strict(),
}).strict();

export const AgentAdminConfigSchema = AgentIdentitySchema.extend({
  managerUserId: z.string().uuid(),
  computerId: z.string().uuid(),
  revision: z.number().int().min(1),
  runtimeConfig: AgentRuntimeConfigSchema,
}).strict();

export const CreateAgentRequestSchema = z
  .object({
    creationIntentId: AgentCreationIntentIdSchema.optional(),
    name: AgentNameSchema,
    displayName: AgentDisplayNameSchema,
    runtimeProvider: AgentRuntimeProviderSchema,
    computerId: z.string().uuid(),
    runtimeConfig: CreateAgentRuntimeConfigSchema.optional(),
  })
  .strict();

export const UpdateAgentRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    displayName: AgentDisplayNameSchema.optional(),
    receiveMode: ReceiveModeSchema.optional(),
    runtimeConfig: UpdateAgentRuntimeConfigSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.displayName !== undefined || value.receiveMode !== undefined || value.runtimeConfig !== undefined,
    { message: "At least one Agent field must be updated" },
  );

export const ListAgentsResponseSchema = z
  .object({
    agents: z.array(AgentSummarySchema),
  })
  .strict();

export type AgentName = z.infer<typeof AgentNameSchema>;
export type AgentDisplayName = z.infer<typeof AgentDisplayNameSchema>;
export type AgentRuntimeProvider = z.infer<typeof AgentRuntimeProviderSchema>;
export type ReceiveMode = z.infer<typeof ReceiveModeSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;
export type CreateAgentRuntimeConfig = z.infer<typeof CreateAgentRuntimeConfigSchema>;
export type UpdateAgentRuntimeConfig = z.infer<typeof UpdateAgentRuntimeConfigSchema>;
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type AgentDetail = z.infer<typeof AgentDetailSchema>;
export type AgentAdminConfig = z.infer<typeof AgentAdminConfigSchema>;
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;
