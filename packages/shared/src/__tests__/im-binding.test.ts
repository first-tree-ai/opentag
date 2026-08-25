import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FEISHU_REQUIRED_TENANT_SCOPES,
  FeishuSetupAttemptSchema,
  hasRequiredFeishuTenantScopes,
  hasRequiredSlackBotScopes,
  ImBindingDiagnosticsSchema,
  ImBindingHandoffStatusSchema,
  ImBindingSummarySchema,
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SUBSCRIBED_BOT_EVENTS,
  SlackAppConfigurationSchema,
  SlackBindingActivationSchema,
} from "../im-binding.js";
import { ImContentV1Schema, NormalizedInboundImEventSchema } from "../im-message.js";

describe("IM binding contracts", () => {
  it("defines one exact, duplicate-free Feishu tenant scope contract", () => {
    expect(FEISHU_REQUIRED_TENANT_SCOPES).toHaveLength(66);
    expect(new Set(FEISHU_REQUIRED_TENANT_SCOPES).size).toBe(FEISHU_REQUIRED_TENANT_SCOPES.length);
    expect(createHash("sha256").update(FEISHU_REQUIRED_TENANT_SCOPES.join("\n")).digest("hex")).toBe(
      "d4f0a66168befeed1a43203f55afe238c34ee9f3a50e868d65eec474491c80ac",
    );
    expect(FEISHU_REQUIRED_TENANT_SCOPES).toContain("im:message:send_as_bot");
    expect(FEISHU_REQUIRED_TENANT_SCOPES).toContain("docx:document:write_only");
    expect(FEISHU_REQUIRED_TENANT_SCOPES).toContain("drive:file:download");
    expect(FEISHU_REQUIRED_TENANT_SCOPES).toContain("sheets:spreadsheet:write_only");
    expect(FEISHU_REQUIRED_TENANT_SCOPES).toContain("base:record:update");
    expect(FEISHU_REQUIRED_TENANT_SCOPES).toContain("calendar:calendar.event:reply");
    expect(FEISHU_REQUIRED_TENANT_SCOPES).toContain("task:attachment:write");
    expect(hasRequiredFeishuTenantScopes(FEISHU_REQUIRED_TENANT_SCOPES)).toBe(true);
    expect(hasRequiredFeishuTenantScopes(FEISHU_REQUIRED_TENANT_SCOPES.slice(1))).toBe(false);
  });

  it("defines one fixed, duplicate-free Slack capability contract", () => {
    expect(SLACK_REQUIRED_BOT_SCOPES).toEqual([
      "app_mentions:read",
      "channels:history",
      "chat:write",
      "files:read",
      "groups:history",
      "im:history",
      "mpim:history",
    ]);
    expect(SLACK_SUBSCRIBED_BOT_EVENTS).toEqual([
      "app_mention",
      "app_uninstalled",
      "message.channels",
      "message.groups",
      "message.im",
      "message.mpim",
      "tokens_revoked",
    ]);
    expect(hasRequiredSlackBotScopes(SLACK_REQUIRED_BOT_SCOPES)).toBe(true);
    expect(hasRequiredSlackBotScopes(SLACK_REQUIRED_BOT_SCOPES.slice(1))).toBe(false);
  });

  it("accepts only bounded canonical content", () => {
    expect(
      ImContentV1Schema.parse({
        version: 1,
        fallbackText: "hello",
        blocks: [{ type: "text", text: "hello" }],
      }),
    ).toMatchObject({ truncated: false });
    expect(() =>
      ImContentV1Schema.parse({
        version: 1,
        fallbackText: "x".repeat(64 * 1024),
        blocks: Array.from({ length: 5 }, () => ({ type: "text", text: "x".repeat(64 * 1024) })),
      }),
    ).toThrow("256 KiB");
  });

  it("coerces provider timestamps without admitting raw provider payloads", () => {
    const event = NormalizedInboundImEventSchema.parse({
      providerEventId: "event-1",
      externalAppId: "app-1",
      externalTeamId: "team-1",
      providerContext: { provider: "slack", channelType: "channel" },
      conversation: { externalId: "chat-1", kind: "channel" },
      message: {
        externalId: "message-1",
        revisionKey: "1",
        operation: "created",
        author: { externalId: "user-1", kind: "human" },
        occurredAt: "2026-08-19T00:00:00.000Z",
        content: { version: 1, fallbackText: "hello", blocks: [{ type: "text", text: "hello" }] },
        resources: [],
      },
      mentions: [],
    });
    expect(event.message.occurredAt).toEqual(new Date("2026-08-19T00:00:00.000Z"));
    expect(() => NormalizedInboundImEventSchema.parse({ ...event, raw: {} })).toThrow();
  });

  it("keeps provisioning secrets out of public response schemas", () => {
    expect(() =>
      FeishuSetupAttemptSchema.parse({
        id: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        intent: "create",
        state: "awaiting_user",
        qrUrl: "https://accounts.feishu.cn/device",
        expiresAt: "2026-08-19T00:05:00.000Z",
        errorCode: null,
        completedAt: null,
        createdAt: "2026-08-19T00:00:00.000Z",
        deviceCode: "secret",
      }),
    ).toThrow();
    expect(
      SlackBindingActivationSchema.parse({
        agentId: crypto.randomUUID(),
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        grantedBotScopes: ["chat:write"],
        botAccessToken: "xoxb-secret",
        signingSecret: "signing-secret",
        installedAt: "2026-08-19T00:00:00.000Z",
      }).installedAt,
    ).toBeInstanceOf(Date);
  });

  it("keeps provider identity and credential metadata out of member-safe summaries", () => {
    const base = {
      id: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      provider: "slack",
      bindingState: "active",
      bot: { displayName: "Reviewer", avatarUrl: null },
      receiveMode: "mention_only",
      lastInboundAt: null,
      lastValidatedAt: "2026-08-19T00:00:00.000Z",
      lastRuntimeObservationAt: null,
    };
    expect(ImBindingSummarySchema.parse(base)).toEqual(base);
    expect(() => ImBindingSummarySchema.parse({ ...base, credentialGeneration: 1 })).toThrow();
    expect(() => ImBindingSummarySchema.parse({ ...base, lastConfirmedAt: base.lastValidatedAt })).toThrow();
  });

  it("keeps Slack configuration stateless and secrets out of the response", () => {
    const configuration = {
      agentId: crypto.randomUUID(),
      manifest: { display_information: { name: "Reviewer" } },
      manifestUrl: "https://api.slack.com/apps?new_app=1",
      eventsUrl: "https://opentag.example/api/v1/agents/agent/im-binding/slack/events",
      requiredBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      subscribedBotEvents: [...SLACK_SUBSCRIBED_BOT_EVENTS],
      currentBinding: null,
    };
    expect(SlackAppConfigurationSchema.parse(configuration)).toEqual(configuration);
    expect(() => SlackAppConfigurationSchema.parse({ ...configuration, signingSecret: "secret" })).toThrow();
  });

  it("defines a strict handoff projection without changing the strict summary contract", () => {
    expect(ImBindingHandoffStatusSchema.parse({ bindingState: "active", handoffReady: true })).toEqual({
      bindingState: "active",
      handoffReady: true,
    });
    expect(
      ImBindingHandoffStatusSchema.parse({ bindingState: "reauthorization_required", handoffReady: false }),
    ).toEqual({ bindingState: "reauthorization_required", handoffReady: false });
    expect(() => ImBindingHandoffStatusSchema.parse({ bindingState: "error", handoffReady: true })).toThrow();
    expect(() =>
      ImBindingHandoffStatusSchema.parse({
        bindingState: "active",
        handoffReady: false,
        credentialGeneration: 1,
      }),
    ).toThrow();
    expect(() =>
      ImBindingSummarySchema.parse({
        id: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        provider: "slack",
        bindingState: "active",
        bot: { displayName: null, avatarUrl: null },
        receiveMode: "mention_only",
        lastInboundAt: null,
        lastOutboundAt: null,
        lastValidatedAt: null,
        lastRuntimeObservationAt: null,
        handoffReady: true,
      }),
    ).toThrow();
  });

  it("reports exact credential generation zero and capability gaps in diagnostics", () => {
    const diagnostics = {
      imBindingId: crypto.randomUUID(),
      provider: "slack" as const,
      ready: false,
      agentRuntimeReadiness: "ready" as const,
      providerCliReadiness: "ready" as const,
      credentialGeneration: 0,
      credentialStatus: "invalid" as const,
      requiredCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
      grantedCapabilities: [],
      missingCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
      reauthorizationRequired: false,
      slackAppId: null,
      connection: null,
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
      lastErrorCode: null,
    };
    expect(ImBindingDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(() => ImBindingDiagnosticsSchema.parse({ ...diagnostics, credentialGeneration: -1 })).toThrow();
  });
});
