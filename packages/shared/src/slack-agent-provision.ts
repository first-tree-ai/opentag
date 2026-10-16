import { z } from "zod";
import { AgentAdminConfigSchema, CreateAgentRequestSchema, CreateAgentRuntimeConfigSchema } from "./agent.js";
import { SlackAgentProvisionCodeSchema } from "./auth.js";
import { SlackConfigurationViewSchema } from "./slack-configuration.js";

export const SlackProvisionCredentialsSchema = z
  .object({
    appId: z.string().trim().min(1).max(255),
    teamId: z.string().trim().min(1).max(255),
    botUserId: z.string().trim().min(1).max(255),
    botAccessToken: z.string().trim().min(1).max(4096),
    signingSecret: z.string().trim().min(1).max(512),
  })
  .strict();

export const ProvisionSlackAgentRequestSchema = z
  .object({
    code: SlackAgentProvisionCodeSchema,
    agent: CreateAgentRequestSchema.omit({ computerId: true })
      .required({ creationIntentId: true })
      .extend({
        runtimeConfig: CreateAgentRuntimeConfigSchema.omit({ permissions: true, maxDurationMs: true }).optional(),
      }),
    slack: SlackProvisionCredentialsSchema,
  })
  .strict();

export const ProvisionSlackAgentResponseSchema = z
  .object({
    agent: AgentAdminConfigSchema,
    slack: SlackConfigurationViewSchema,
    interactionsUrl: z.string().url(),
  })
  .strict();

export type SlackProvisionCredentials = z.infer<typeof SlackProvisionCredentialsSchema>;
export type ProvisionSlackAgentRequest = z.infer<typeof ProvisionSlackAgentRequestSchema>;
export type ProvisionSlackAgentResponse = z.infer<typeof ProvisionSlackAgentResponseSchema>;
