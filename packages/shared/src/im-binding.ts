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
    // A receive-mode target the binding cannot serve until the provider grants more scopes.
    pendingReceiveMode: ReceiveModeSchema.nullable(),
    lastInboundAt: z.string().datetime().nullable(),
    lastConfirmedAt: z.string().datetime().nullable(),
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

export const SlackSetupIntentSchema = z.enum(["create", "reauthorize", "replace"]);
export const SlackSetupStateSchema = z.enum([
  "awaiting_credentials",
  "awaiting_verification",
  "succeeded",
  "failed",
  "expired",
  "canceled",
]);

export const SlackSetupIdentitySchema = z
  .object({
    // Slack's auth.test normally omits app_id for a bot token; the signed activation event establishes it.
    appId: z.string().min(1).max(255).nullable(),
    teamId: z.string().min(1).max(255),
    enterpriseId: z.string().min(1).max(255).nullable(),
    botUserId: z.string().min(1).max(255),
  })
  .strict();

export const SlackAppManifestSchema = z.record(z.string(), z.unknown());

export const SlackSetupAttemptSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    intent: SlackSetupIntentSchema,
    state: SlackSetupStateSchema,
    // The generated App manifest, both as a copyable JSON object and as a create-new-App link.
    manifest: SlackAppManifestSchema,
    manifestUrl: z.string().url(),
    eventsUrl: z.string().url(),
    requiredBotScopes: z.array(z.string().min(1).max(160)).max(32),
    // The App currently bound to the Agent, when one exists; reauthorization edits this App in place.
    currentAppId: z.string().min(1).max(255).nullable(),
    identity: SlackSetupIdentitySchema.nullable(),
    // Whether Slack has verified the Events Request URL against the submitted Signing Secret.
    challengeVerified: z.boolean(),
    // Non-secret outcome of the most recent signature verification routed to this attempt.
    lastVerificationErrorCode: z.string().min(1).max(120).nullable(),
    lastVerificationAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime(),
    errorCode: z.string().min(1).max(120).nullable(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const CreateSlackSetupAttemptRequestSchema = z
  .object({ intent: SlackSetupIntentSchema.default("create") })
  .strict();

export const SubmitSlackSetupCredentialsRequestSchema = z
  .object({
    botAccessToken: z.string().min(1).max(4096),
    signingSecret: z.string().min(1).max(512),
  })
  .strict();

export const ImBindingDiagnosticsSchema = z
  .object({
    imBindingId: z.string().uuid(),
    provider: ImProviderSchema,
    ready: z.boolean(),
    agentRuntimeReadiness: z.enum(["checking", "install", "sign-in", "ready", "unavailable"]),
    providerCliReadiness: z.enum(["checking", "install", "ready", "unavailable"]),
    credentialGeneration: z.number().int().min(1),
    reauthorizationRequired: z.boolean(),
    pendingReceiveMode: ReceiveModeSchema.nullable(),
    connection: z
      .object({
        state: z.enum(["connected", "disconnected"]),
        observedAt: z.string().datetime(),
      })
      .nullable(),
    lastInboundAt: z.string().datetime().nullable(),
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
export type ImBindingHandoffStatus = z.infer<typeof ImBindingHandoffStatusSchema>;
export type ImBindingAdminDetail = z.infer<typeof ImBindingAdminDetailSchema>;
export type FeishuSetupIntent = z.infer<typeof FeishuSetupIntentSchema>;
export type FeishuSetupState = z.infer<typeof FeishuSetupStateSchema>;
export type FeishuSetupAttempt = z.infer<typeof FeishuSetupAttemptSchema>;
export type SlackSetupIntent = z.infer<typeof SlackSetupIntentSchema>;
export type SlackSetupState = z.infer<typeof SlackSetupStateSchema>;
export type SlackSetupIdentity = z.infer<typeof SlackSetupIdentitySchema>;
export type SlackAppManifest = z.infer<typeof SlackAppManifestSchema>;
export type SlackSetupAttempt = z.infer<typeof SlackSetupAttemptSchema>;
export type SubmitSlackSetupCredentialsRequest = z.infer<typeof SubmitSlackSetupCredentialsRequestSchema>;
export type ImBindingDiagnostics = z.infer<typeof ImBindingDiagnosticsSchema>;
export type SlackBindingActivation = z.infer<typeof SlackBindingActivationSchema>;
