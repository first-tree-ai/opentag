import { z } from "zod";
import {
  OPENTAG_MESSAGE_TOOLS,
  OPENTAG_PLATFORM_INSTRUCTIONS,
  RUNTIME_ALLOWED_TOOLS_MAX_COUNT,
  RuntimeInstructionSchema,
  RuntimeInstructionsSchema,
  RuntimeMaxDurationMsSchema,
  RuntimeModelSchema,
  RuntimeReasoningEffortSchema,
} from "./runtime-config.js";

export const AgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
export const AgentDisplayNameSchema = z.string().trim().min(1).max(120);
export const AgentRuntimeProviderSchema = z.enum(["codex", "claude-code"]);

const OpenTagMessageToolSchema = z.enum(OPENTAG_MESSAGE_TOOLS);
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
const AgentAllowedToolsInputSchema = z
  .array(OpenTagMessageToolSchema)
  .max(RUNTIME_ALLOWED_TOOLS_MAX_COUNT)
  .superRefine((toolIds, context) => {
    if (new Set(toolIds).size !== toolIds.length) {
      context.addIssue({ code: "custom", message: "Agent tool IDs must be unique" });
    }
  })
  .transform((toolIds) => [...toolIds].sort());
const AgentAllowedToolsSchema = z
  .array(OpenTagMessageToolSchema)
  .max(RUNTIME_ALLOWED_TOOLS_MAX_COUNT)
  .superRefine((toolIds, context) => {
    if (new Set(toolIds).size !== toolIds.length) {
      context.addIssue({ code: "custom", message: "Agent tool IDs must be unique" });
    }
    if (toolIds.some((toolId, index) => index > 0 && toolId < (toolIds[index - 1] ?? ""))) {
      context.addIssue({ code: "custom", message: "Agent tool IDs must use canonical order" });
    }
  });

export const AgentRuntimeConfigSchema = z
  .object({
    revision: z.number().int().safe().positive(),
    model: RuntimeModelSchema.nullable(),
    reasoningEffort: RuntimeReasoningEffortSchema.nullable(),
    instructions: AgentInstructionsSchema,
    allowedTools: AgentAllowedToolsSchema,
    maxDurationMs: RuntimeMaxDurationMsSchema.nullable(),
  })
  .strict();

export const CreateAgentRuntimeConfigSchema = z
  .object({
    model: RuntimeModelSchema.nullable().optional(),
    reasoningEffort: RuntimeReasoningEffortSchema.nullable().optional(),
    instructions: AgentInstructionsSchema.optional(),
    allowedTools: AgentAllowedToolsInputSchema.optional(),
    maxDurationMs: RuntimeMaxDurationMsSchema.nullable().optional(),
  })
  .strict();

export const UpdateAgentRuntimeConfigSchema = z
  .object({
    model: RuntimeModelSchema.nullable().optional(),
    reasoningEffort: RuntimeReasoningEffortSchema.nullable().optional(),
    instructions: AgentInstructionsSchema.optional(),
    allowedTools: AgentAllowedToolsInputSchema.optional(),
    maxDurationMs: RuntimeMaxDurationMsSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one runtime config field must be updated",
  });

const AgentBaseSchema = z
  .object({
    id: z.string().uuid(),
    teamId: z.string().uuid(),
    managerUserId: z.string().uuid(),
    computerId: z.string().uuid(),
    name: AgentNameSchema,
    displayName: AgentDisplayNameSchema,
    runtimeProvider: AgentRuntimeProviderSchema,
    revision: z.number().int().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AgentSchema = AgentBaseSchema.extend({
  runtimeConfig: AgentRuntimeConfigSchema,
}).strict();

export const AgentSummarySchema = AgentBaseSchema.extend({
  runtimeConfigRevision: z.number().int().safe().positive(),
}).strict();

export const CreateAgentRequestSchema = z
  .object({
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
    runtimeConfig: UpdateAgentRuntimeConfigSchema.optional(),
  })
  .strict()
  .refine((value) => value.displayName !== undefined || value.runtimeConfig !== undefined, {
    message: "At least one Agent field must be updated",
  });

export const ListAgentsResponseSchema = z
  .object({
    agents: z.array(AgentSummarySchema),
  })
  .strict();

export type AgentName = z.infer<typeof AgentNameSchema>;
export type AgentDisplayName = z.infer<typeof AgentDisplayNameSchema>;
export type AgentRuntimeProvider = z.infer<typeof AgentRuntimeProviderSchema>;
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;
export type CreateAgentRuntimeConfig = z.infer<typeof CreateAgentRuntimeConfigSchema>;
export type UpdateAgentRuntimeConfig = z.infer<typeof UpdateAgentRuntimeConfigSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;
