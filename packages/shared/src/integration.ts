import { z } from "zod";

export const ImProviderSchema = z.enum(["feishu", "slack"]);
export const ReceiveModeSchema = z.enum(["all_message", "mention_only"]);

export const IntegrationSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    provider: ImProviderSchema,
    status: z.enum(["provisioning", "active", "reauthorization_required", "error", "disabled"]),
    disabledAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const IntegrationIdentitySchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("feishu"),
      appId: z.string().min(1).max(255),
      // Feishu exposes the external Team identifier only after the first verified event.
      // OpenTag fills it from that verified event envelope.
      teamId: z.string().min(1).max(255).nullable(),
      botOpenId: z.string().min(1).max(255),
      teamBrand: z.string().max(255).nullable(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("slack"),
      appId: z.string().min(1).max(255),
      teamId: z.string().min(1).max(255),
      enterpriseId: z.string().min(1).max(255).nullable(),
      botUserId: z.string().min(1).max(255),
    })
    .strict(),
]);

export const IntegrationSummarySchema = z
  .object({
    integration: IntegrationSchema,
    identity: IntegrationIdentitySchema,
    receiveMode: ReceiveModeSchema,
    credentialGeneration: z.number().int().min(1),
    grantedCapabilities: z.array(z.string().min(1).max(160)).max(128),
    reauthorizationRequired: z.boolean(),
    lastInboundAt: z.string().datetime().nullable(),
    lastOutboundAt: z.string().datetime().nullable(),
  })
  .strict();

export const FeishuSetupIntentSchema = z.enum(["create", "reauthorize", "replace"]);
export const FeishuSetupStateSchema = z.enum([
  "awaiting_user",
  "validating",
  "succeeded",
  "failed",
  "expired",
  "canceled",
]);

export const FeishuSetupAttemptSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    intent: FeishuSetupIntentSchema,
    state: FeishuSetupStateSchema,
    qrUrl: z.string().url().nullable(),
    expiresAt: z.string().datetime(),
    errorCode: z.string().min(1).max(120).nullable(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const CreateFeishuSetupAttemptRequestSchema = z
  .object({ intent: FeishuSetupIntentSchema.default("create") })
  .strict();

export const IntegrationDiagnosticsSchema = z
  .object({
    integrationId: z.string().uuid(),
    provider: ImProviderSchema,
    ready: z.boolean(),
    runtimeToolAvailable: z.boolean(),
    credentialGeneration: z.number().int().min(1),
    reauthorizationRequired: z.boolean(),
    connection: z
      .object({
        state: z.enum(["connected", "disconnected"]),
        observedAt: z.string().datetime(),
      })
      .nullable(),
    lastInboundAt: z.string().datetime().nullable(),
    lastOutboundAt: z.string().datetime().nullable(),
    lastErrorCode: z.string().min(1).max(120).nullable(),
  })
  .strict();

export const SlackBindingActivationSchema = z
  .object({
    agentId: z.string().uuid(),
    appId: z.string().min(1).max(255),
    teamId: z.string().min(1).max(255),
    enterpriseId: z.string().min(1).max(255).optional(),
    botUserId: z.string().min(1).max(255),
    grantedBotScopes: z.array(z.string().min(1).max(160)).max(128),
    botAccessToken: z.string().min(1),
    signingSecret: z.string().min(1),
    installedAt: z.coerce.date(),
  })
  .strict();

export type ImProvider = z.infer<typeof ImProviderSchema>;
export type ReceiveMode = z.infer<typeof ReceiveModeSchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
export type IntegrationIdentity = z.infer<typeof IntegrationIdentitySchema>;
export type IntegrationSummary = z.infer<typeof IntegrationSummarySchema>;
export type FeishuSetupIntent = z.infer<typeof FeishuSetupIntentSchema>;
export type FeishuSetupState = z.infer<typeof FeishuSetupStateSchema>;
export type FeishuSetupAttempt = z.infer<typeof FeishuSetupAttemptSchema>;
export type IntegrationDiagnostics = z.infer<typeof IntegrationDiagnosticsSchema>;
export type SlackBindingActivation = z.infer<typeof SlackBindingActivationSchema>;
