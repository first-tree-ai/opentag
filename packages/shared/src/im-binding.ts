import { z } from "zod";
import { ReceiveModeSchema } from "./agent.js";

export const ImProviderSchema = z.enum(["feishu", "slack"]);

export const ImBindingStateSchema = z.enum(["provisioning", "active", "reauthorization_required", "error", "disabled"]);

export const ImBindingIdentitySchema = z.discriminatedUnion("provider", [
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

export const ImBindingSummarySchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    provider: ImProviderSchema,
    bindingState: ImBindingStateSchema,
    bot: z
      .object({
        displayName: z.string().max(255).nullable(),
        avatarUrl: z.string().url().nullable(),
      })
      .strict(),
    receiveMode: ReceiveModeSchema,
    lastInboundAt: z.string().datetime().nullable(),
    lastOutboundAt: z.string().datetime().nullable(),
    lastConfirmedAt: z.string().datetime().nullable(),
  })
  .strict();

export const ImBindingAdminDetailSchema = ImBindingSummarySchema.extend({
  identity: ImBindingIdentitySchema,
  credentialGeneration: z.number().int().min(1),
  grantedCapabilities: z.array(z.string().min(1).max(160)).max(128),
  reauthorizationRequired: z.boolean(),
  lastErrorCode: z.string().min(1).max(120).nullable(),
}).strict();

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

export const ImBindingDiagnosticsSchema = z
  .object({
    imBindingId: z.string().uuid(),
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
export type ImBindingState = z.infer<typeof ImBindingStateSchema>;
export type ImBindingIdentity = z.infer<typeof ImBindingIdentitySchema>;
export type ImBindingSummary = z.infer<typeof ImBindingSummarySchema>;
export type ImBindingAdminDetail = z.infer<typeof ImBindingAdminDetailSchema>;
export type FeishuSetupIntent = z.infer<typeof FeishuSetupIntentSchema>;
export type FeishuSetupState = z.infer<typeof FeishuSetupStateSchema>;
export type FeishuSetupAttempt = z.infer<typeof FeishuSetupAttemptSchema>;
export type ImBindingDiagnostics = z.infer<typeof ImBindingDiagnosticsSchema>;
export type SlackBindingActivation = z.infer<typeof SlackBindingActivationSchema>;
