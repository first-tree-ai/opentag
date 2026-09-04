import { z } from "zod";
import { ReceiveModeSchema } from "./agent.js";
import { IntegrationCredentialExecutionReasonSchema, IntegrationCredentialExecutionStatusSchema } from "./computer.js";

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
  "channels:join",
  "channels:read",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "team:read",
  "users:read",
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

export const ProviderCliHandoffPhaseSchema = z.enum(["preparing_cli", "checking_credentials", "needs_attention"]);

export const ProviderCliHandoffProgressSchema = z
  .object({
    phase: ProviderCliHandoffPhaseSchema,
    reason: IntegrationCredentialExecutionReasonSchema.optional(),
  })
  .strict();

/**
 * The machine-readable identity a cross-Provider messaging start fails with: unbind this exact current binding,
 * then bind any Provider. Mirrors the `messaging-unbind-required` Agent setup blocker.
 */
export const ImBindingUnbindRequiredDetailSchema = z
  .object({
    currentProvider: ImProviderSchema,
    currentBindingId: z.string().uuid(),
    requestedProvider: ImProviderSchema,
  })
  .strict()
  .superRefine((detail, context) => {
    if (detail.currentProvider === detail.requestedProvider) {
      context.addIssue({
        code: "custom",
        path: ["requestedProvider"],
        message: "Unbind is required only when the requested Provider differs from the current Provider",
      });
    }
  });

/**
 * The messaging state a caller observed when it decided on a mutation. Commands carrying one are fenced
 * against the exact current binding: unbound means no configured binding may exist, bound names the exact
 * binding identity and credential generation. Keep in parity with AgentSetupExpectedMessagingStateSchema.
 */
export const ImBindingMessagingExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unbound") }).strict(),
  z
    .object({
      kind: z.literal("bound"),
      provider: ImProviderSchema,
      bindingId: z.string().uuid(),
      credentialGeneration: z.number().int().positive(),
    })
    .strict(),
]);

/** Fixed surfaces a Slack OAuth round trip may return to. Keep in parity with AGENT_SETUP_RETURN_SURFACES. */
export const SLACK_OAUTH_RETURN_SURFACES = ["agent-setup", "agent-messaging-settings"] as const;
export const SlackOAuthReturnSurfaceSchema = z.enum(SLACK_OAUTH_RETURN_SURFACES);

export const ImBindingHandoffStatusSchema = z.union([
  z.object({ bindingState: z.literal("active"), handoffReady: z.literal(true) }).strict(),
  z
    .object({
      bindingState: z.literal("active"),
      handoffReady: z.literal(false),
      providerCli: ProviderCliHandoffProgressSchema.optional(),
    })
    .strict(),
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
  .object({
    intent: FeishuSetupIntentSchema.default("create"),
    expectedMessaging: ImBindingMessagingExpectationSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.intent === "create" && request.expectedMessaging?.kind === "bound") {
      context.addIssue({
        code: "custom",
        path: ["expectedMessaging"],
        message: "Feishu create requires the Agent to be unbound",
      });
    }
  });

/** Names the exact current binding the Account asked to unbind, fencing the mutation against a stale view. */
export const UnbindAgentMessagingRequestSchema = z
  .object({
    provider: ImProviderSchema,
    bindingId: z.string().uuid(),
  })
  .strict();

export const SlackConfigurationIntentSchema = z.enum(["create", "reauthorize"]);

export const SlackIdentityClosureSchema = z
  .object({
    status: z.enum(["pending", "verified"]),
    verifiedAt: z.string().datetime().nullable(),
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

export const StartSlackOAuthRequestSchema = z
  .object({
    intent: SlackConfigurationIntentSchema,
    returnSurface: SlackOAuthReturnSurfaceSchema.optional(),
    expectedMessaging: ImBindingMessagingExpectationSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.intent === "create" && request.expectedMessaging?.kind === "bound") {
      context.addIssue({
        code: "custom",
        path: ["expectedMessaging"],
        message: "Slack create requires the Agent to be unbound",
      });
    }
    if (
      request.intent === "reauthorize" &&
      request.expectedMessaging !== undefined &&
      (request.expectedMessaging.kind !== "bound" || request.expectedMessaging.provider !== "slack")
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedMessaging"],
        message: "Slack reauthorization requires the exact current Slack binding",
      });
    }
  });

export const StartSlackOAuthResponseSchema = z
  .object({
    authorizationUrl: z.string().url(),
    expiresAt: z.string().datetime(),
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
    credentialExecutionReadiness: IntegrationCredentialExecutionStatusSchema,
    credentialExecutionReason: IntegrationCredentialExecutionReasonSchema.optional(),
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
export type ImBindingUnbindRequiredDetail = z.infer<typeof ImBindingUnbindRequiredDetailSchema>;
export type ImBindingMessagingExpectation = z.infer<typeof ImBindingMessagingExpectationSchema>;
export type SlackOAuthReturnSurface = z.infer<typeof SlackOAuthReturnSurfaceSchema>;
export type ImBindingSummary = z.infer<typeof ImBindingSummarySchema>;
export type ImBindingHandoffStatus = z.infer<typeof ImBindingHandoffStatusSchema>;
export type ProviderCliHandoffPhase = z.infer<typeof ProviderCliHandoffPhaseSchema>;
export type ProviderCliHandoffProgress = z.infer<typeof ProviderCliHandoffProgressSchema>;
export type ImBindingAdminDetail = z.infer<typeof ImBindingAdminDetailSchema>;
export type FeishuSetupIntent = z.infer<typeof FeishuSetupIntentSchema>;
export type FeishuSetupState = z.infer<typeof FeishuSetupStateSchema>;
export type FeishuSetupAttempt = z.infer<typeof FeishuSetupAttemptSchema>;
export type SlackConfigurationIntent = z.infer<typeof SlackConfigurationIntentSchema>;
export type UnbindAgentMessagingRequest = z.infer<typeof UnbindAgentMessagingRequestSchema>;
export type SlackIdentityClosure = z.infer<typeof SlackIdentityClosureSchema>;
export type SlackConfigurationResult = z.infer<typeof SlackConfigurationResultSchema>;
export type StartSlackOAuthRequest = z.infer<typeof StartSlackOAuthRequestSchema>;
export type StartSlackOAuthResponse = z.infer<typeof StartSlackOAuthResponseSchema>;
export type ImBindingCredentialStatus = z.infer<typeof ImBindingCredentialStatusSchema>;
export type ImBindingDiagnostics = z.infer<typeof ImBindingDiagnosticsSchema>;
export type SlackBindingActivation = z.infer<typeof SlackBindingActivationSchema>;
