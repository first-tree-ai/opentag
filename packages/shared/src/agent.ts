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

export const AGENT_USAGE_WINDOW_DAYS = 30;
export const AGENT_USAGE_WINDOW_OPTIONS = [7, AGENT_USAGE_WINDOW_DAYS, 90] as const;
export const AgentUsageWindowDaysSchema = z.union([
  z.literal(AGENT_USAGE_WINDOW_OPTIONS[0]),
  z.literal(AGENT_USAGE_WINDOW_OPTIONS[1]),
  z.literal(AGENT_USAGE_WINDOW_OPTIONS[2]),
]);

export const AgentListActivitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }).strict(),
  z
    .object({
      state: z.literal("working"),
      startedAt: z.string().datetime(),
    })
    .strict(),
]);

export const AgentUsageSummarySchema = z
  .object({
    windowDays: z.literal(AGENT_USAGE_WINDOW_DAYS),
    tasks: z.number().int().safe().nonnegative(),
    failed: z.number().int().safe().nonnegative(),
    tokens: z.number().int().safe().nonnegative(),
  })
  .strict();

const AgentUsageTokenBreakdownSchema = z
  .object({
    inputTokens: z.number().int().safe().nonnegative(),
    cachedInputTokens: z.number().int().safe().nonnegative(),
    outputTokens: z.number().int().safe().nonnegative(),
    tokens: z.number().int().safe().nonnegative(),
  })
  .strict();

export const AgentUsageDetailSchema = z
  .object({
    windowDays: AgentUsageWindowDaysSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    tasks: z.number().int().safe().nonnegative(),
    measuredTasks: z.number().int().safe().nonnegative(),
    failed: z.number().int().safe().nonnegative(),
    ...AgentUsageTokenBreakdownSchema.shape,
    daily: z.array(
      z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          tasks: z.number().int().safe().nonnegative(),
          measuredTasks: z.number().int().safe().nonnegative(),
          ...AgentUsageTokenBreakdownSchema.shape,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((usage, context) => {
    const validateTokenBreakdown = (
      breakdown: z.infer<typeof AgentUsageTokenBreakdownSchema>,
      path: readonly (number | string)[],
    ) => {
      if (breakdown.tokens !== breakdown.inputTokens + breakdown.outputTokens) {
        context.addIssue({
          code: "custom",
          path: [...path, "tokens"],
          message: "Total Tokens must equal input and output Tokens",
        });
      }
    };
    if (usage.failed > usage.tasks) {
      context.addIssue({ code: "custom", path: ["failed"], message: "Failed Tasks cannot exceed Tasks" });
    }
    if (usage.measuredTasks > usage.tasks) {
      context.addIssue({ code: "custom", path: ["measuredTasks"], message: "Measured Tasks cannot exceed Tasks" });
    }
    if (new Date(usage.startedAt).getTime() > new Date(usage.endedAt).getTime()) {
      context.addIssue({ code: "custom", path: ["startedAt"], message: "Usage start cannot follow usage end" });
    }
    validateTokenBreakdown(usage, []);
    for (const [index, point] of usage.daily.entries()) {
      if (point.measuredTasks > point.tasks) {
        context.addIssue({
          code: "custom",
          path: ["daily", index, "measuredTasks"],
          message: "Measured Tasks cannot exceed Tasks",
        });
      }
      if (index > 0 && point.date <= (usage.daily[index - 1]?.date ?? "")) {
        context.addIssue({
          code: "custom",
          path: ["daily", index, "date"],
          message: "Daily usage dates must be unique and ordered",
        });
      }
      validateTokenBreakdown(point, ["daily", index]);
    }
  });

export const AgentListItemSchema = AgentSummarySchema.extend({
  activity: AgentListActivitySchema,
  usage: AgentUsageSummarySchema,
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
    agents: z.array(AgentListItemSchema),
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
export type AgentListActivity = z.infer<typeof AgentListActivitySchema>;
export type AgentUsageSummary = z.infer<typeof AgentUsageSummarySchema>;
export type AgentUsageWindowDays = z.infer<typeof AgentUsageWindowDaysSchema>;
export type AgentUsageDetail = z.infer<typeof AgentUsageDetailSchema>;
export type AgentListItem = z.infer<typeof AgentListItemSchema>;
export type AgentAdminConfig = z.infer<typeof AgentAdminConfigSchema>;
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;
