import { z } from "zod";
import { ReceiveModeSchema } from "./agent.js";

export const ImProviderSchema = z.enum(["feishu", "slack"]);

export const ImBindingStateSchema = z.enum(["provisioning", "active", "reauthorization_required", "error", "disabled"]);

export const FEISHU_REQUIRED_TENANT_SCOPES = [
  "im:message",
  "im:message:send_as_bot",
  "im:message.group_at_msg:readonly",
  "im:message.group_msg",
  "im:message.p2p_msg:readonly",
  "im:chat.members:read",
  "im:chat:readonly",
  "im:message:readonly",
  "im:message.reactions:read",
  "im:message.reactions:write_only",
  "im:resource",
  "contact:user.id:readonly",
  "docx:document:create",
  "docx:document:readonly",
  "docx:document:write_only",
  "docs:document.media:upload",
  "docs:document.media:download",
  "docs:permission.member:create",
  "docs:permission.member:retrieve",
  "docs:permission.member:update",
  "drive:drive.metadata:readonly",
  "drive:file:upload",
  "drive:file:download",
  "space:document:delete",
  "space:folder:create",
  "wiki:wiki",
  "sheets:spreadsheet:create",
  "sheets:spreadsheet:read",
  "sheets:spreadsheet:write_only",
  "sheets:spreadsheet.meta:read",
  "base:app:create",
  "base:app:read",
  "base:app:update",
  "base:table:create",
  "base:table:read",
  "base:table:update",
  "base:table:delete",
  "base:field:create",
  "base:field:read",
  "base:field:update",
  "base:field:delete",
  "base:record:create",
  "base:record:read",
  "base:record:retrieve",
  "base:record:update",
  "base:record:delete",
  "base:view:read",
  "base:view:write_only",
  "calendar:calendar:create",
  "calendar:calendar:read",
  "calendar:calendar:update",
  "calendar:calendar:delete",
  "calendar:calendar.event:create",
  "calendar:calendar.event:read",
  "calendar:calendar.event:update",
  "calendar:calendar.event:delete",
  "calendar:calendar.event:reply",
  "calendar:calendar.free_busy:read",
  "task:task:read",
  "task:task:write",
  "task:tasklist:read",
  "task:tasklist:write",
  "task:comment:read",
  "task:comment:write",
  "task:attachment:read",
  "task:attachment:write",
] as const;

export function hasRequiredFeishuTenantScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return FEISHU_REQUIRED_TENANT_SCOPES.every((scope) => granted.has(scope));
}

export const SLACK_REQUIRED_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "chat:write",
  "files:read",
  "groups:history",
  "im:history",
  "mpim:history",
] as const;

export const SLACK_SUBSCRIBED_BOT_EVENTS = [
  "app_mention",
  "app_uninstalled",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "tokens_revoked",
] as const;

export function hasRequiredSlackBotScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return SLACK_REQUIRED_BOT_SCOPES.every((scope) => granted.has(scope));
}

export const ImBindingIdentitySchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("feishu"),
      appId: z.string().min(1).max(255),
      // Feishu exposes the external Workspace identifier only after the first verified event.
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
      // Slack auth.test may omit app_id. The configured value is therefore a routing assertion
      // that every independently signed real event must match, not an API-attested identity.
      appIdEvidence: z.literal("configured"),
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
    lastValidatedAt: z.string().datetime().nullable(),
    lastRuntimeObservationAt: z.string().datetime().nullable(),
  })
  .strict();

export const ImBindingHandoffStatusSchema = z.union([
  z.object({ bindingState: z.literal("active"), handoffReady: z.literal(true) }).strict(),
  z.object({ bindingState: z.literal("active"), handoffReady: z.literal(false) }).strict(),
  z
    .object({
      bindingState: z.enum(["provisioning", "reauthorization_required", "error", "disabled"]),
      handoffReady: z.literal(false),
    })
    .strict(),
]);

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

export const SlackAppManifestSchema = z.record(z.string(), z.unknown());
export const SlackConfigurationIntentSchema = z.enum(["create", "reauthorize", "replace"]);

export const SlackIdentityClosureSchema = z
  .object({
    status: z.enum(["pending", "verified"]),
    verifiedAt: z.string().datetime().nullable(),
  })
  .strict();

export const SlackAppConfigurationSchema = z
  .object({
    agentId: z.string().uuid(),
    manifest: SlackAppManifestSchema,
    manifestUrl: z.string().url(),
    eventsUrl: z.string().url(),
    requiredBotScopes: z.array(z.string().min(1).max(160)).max(32),
    subscribedBotEvents: z.array(z.string().min(1).max(160)).max(32),
    currentBinding: z
      .object({
        id: z.string().uuid(),
        appId: z.string().min(1).max(255),
        credentialGeneration: z.number().int().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const ConfigureSlackAppRequestSchema = z
  .object({
    intent: SlackConfigurationIntentSchema,
    expectedBinding: z
      .object({ id: z.string().uuid(), credentialGeneration: z.number().int().min(1) })
      .strict()
      .nullable(),
    appId: z.string().min(1).max(255),
    botAccessToken: z.string().min(1).max(4096),
    signingSecret: z.string().min(1).max(512),
  })
  .strict();

export const SlackConfigurationResultSchema = z
  .object({
    imBindingId: z.string().uuid(),
    agentId: z.string().uuid(),
    appId: z.string().min(1).max(255),
    teamId: z.string().min(1).max(255),
    botUserId: z.string().min(1).max(255),
    credentialGeneration: z.number().int().min(1),
    bindingState: z.literal("active"),
    identityClosure: SlackIdentityClosureSchema,
  })
  .strict();

export const ImBindingCredentialStatusSchema = z.enum(["valid", "invalid"]);

export const ImBindingDiagnosticsSchema = z
  .object({
    imBindingId: z.string().uuid(),
    provider: ImProviderSchema,
    ready: z.boolean(),
    agentRuntimeReadiness: z.enum(["checking", "install", "sign-in", "ready", "unavailable"]),
    providerCliReadiness: z.enum(["checking", "install", "ready", "unavailable"]),
    credentialGeneration: z.number().int().min(0),
    credentialStatus: ImBindingCredentialStatusSchema,
    requiredCapabilities: z.array(z.string().min(1).max(160)).max(128),
    grantedCapabilities: z.array(z.string().min(1).max(160)).max(128),
    missingCapabilities: z.array(z.string().min(1).max(160)).max(128),
    reauthorizationRequired: z.boolean(),
    slackAppId: z
      .object({
        value: z.string().min(1).max(255),
        evidence: z.literal("configured"),
        ingressMatchRequired: z.literal(true),
      })
      .strict()
      .nullable(),
    slackIdentityClosure: SlackIdentityClosureSchema.nullable(),
    connection: z
      .object({
        state: z.enum(["connected", "disconnected"]),
        observedAt: z.string().datetime(),
      })
      .nullable(),
    lastInboundAt: z.string().datetime().nullable(),
    lastValidatedAt: z.string().datetime().nullable(),
    lastRuntimeObservationAt: z.string().datetime().nullable(),
    lastErrorCode: z.string().min(1).max(120).nullable(),
  })
  .strict();

export const SlackBindingActivationSchema = z
  .object({
    intent: SlackConfigurationIntentSchema,
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
export type ImBindingHandoffStatus = z.infer<typeof ImBindingHandoffStatusSchema>;
export type ImBindingAdminDetail = z.infer<typeof ImBindingAdminDetailSchema>;
export type FeishuSetupIntent = z.infer<typeof FeishuSetupIntentSchema>;
export type FeishuSetupState = z.infer<typeof FeishuSetupStateSchema>;
export type FeishuSetupAttempt = z.infer<typeof FeishuSetupAttemptSchema>;
export type SlackAppManifest = z.infer<typeof SlackAppManifestSchema>;
export type SlackConfigurationIntent = z.infer<typeof SlackConfigurationIntentSchema>;
export type SlackIdentityClosure = z.infer<typeof SlackIdentityClosureSchema>;
export type SlackAppConfiguration = z.infer<typeof SlackAppConfigurationSchema>;
export type ConfigureSlackAppRequest = z.infer<typeof ConfigureSlackAppRequestSchema>;
export type SlackConfigurationResult = z.infer<typeof SlackConfigurationResultSchema>;
export type ImBindingCredentialStatus = z.infer<typeof ImBindingCredentialStatusSchema>;
export type ImBindingDiagnostics = z.infer<typeof ImBindingDiagnosticsSchema>;
export type SlackBindingActivation = z.infer<typeof SlackBindingActivationSchema>;
