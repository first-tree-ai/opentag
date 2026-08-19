import { z } from "zod";

export const AgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
export const AgentDisplayNameSchema = z.string().trim().min(1).max(120);
export const AgentRuntimeProviderSchema = z.enum(["codex", "claude-code"]);

export const AgentSchema = z
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

export const CreateAgentRequestSchema = z
  .object({
    name: AgentNameSchema,
    displayName: AgentDisplayNameSchema,
    runtimeProvider: AgentRuntimeProviderSchema,
    computerId: z.string().uuid(),
  })
  .strict();

export const UpdateAgentRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    displayName: AgentDisplayNameSchema,
  })
  .strict();

export const ListAgentsResponseSchema = z
  .object({
    agents: z.array(AgentSchema),
  })
  .strict();

export type AgentName = z.infer<typeof AgentNameSchema>;
export type AgentDisplayName = z.infer<typeof AgentDisplayNameSchema>;
export type AgentRuntimeProvider = z.infer<typeof AgentRuntimeProviderSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;
