import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_SETUP_RETURN_SURFACES,
  AgentSetupExpectedMessagingStateSchema,
  AgentSetupReturnSurfaceSchema,
} from "../agent-setup.js";
import {
  CreateFeishuSetupAttemptRequestSchema,
  FEISHU_REQUIRED_TENANT_SCOPES,
  FeishuSetupAttemptSchema,
  hasRequiredFeishuTenantScopes,
  hasRequiredSlackBotScopes,
  ImBindingDiagnosticsSchema,
  ImBindingHandoffStatusSchema,
  ImBindingMessagingExpectationSchema,
  ImBindingSummarySchema,
  ImBindingUnbindRequiredDetailSchema,
  SLACK_OAUTH_RETURN_SURFACES,
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SUBSCRIBED_BOT_EVENTS,
  SlackBindingActivationSchema,
  SlackConfigurationResultSchema,
  SlackOAuthReturnSurfaceSchema,
  StartSlackOAuthRequestSchema,
  StartSlackOAuthResponseSchema,
  UnbindAgentMessagingRequestSchema,
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
    expect(hasRequiredSlackBotScopes(SLACK_REQUIRED_BOT_SCOPES.slice(0, 7))).toBe(false);

    const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../docs");
    expect(manifestBotScopes(readFileSync(join(docsRoot, "slack-public-distribution-manifest.yaml"), "utf8"))).toEqual([
      ...SLACK_REQUIRED_BOT_SCOPES,
    ]);
    expect(
      markdownScopeList(readFileSync(join(docsRoot, "slack-app-setup.md"), "utf8"), "Required bot scopes:"),
    ).toEqual([...SLACK_REQUIRED_BOT_SCOPES]);
    expect(
      markdownScopeList(readFileSync(join(docsRoot, "zh-CN/slack-app-setup.md"), "utf8"), "必需 bot scopes："),
    ).toEqual([...SLACK_REQUIRED_BOT_SCOPES]);
    expect(
      markdownScopeList(
        readFileSync(join(docsRoot, "slack-live-acceptance.md"), "utf8"),
        "Exact required bot scopes, in contract order:",
      ),
    ).toEqual([...SLACK_REQUIRED_BOT_SCOPES]);
    expect(
      markdownScopeList(
        readFileSync(join(docsRoot, "zh-CN/slack-live-acceptance.md"), "utf8"),
        "固定必需 bot scopes（契约顺序）：",
      ),
    ).toEqual([...SLACK_REQUIRED_BOT_SCOPES]);
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
      externalTeamId: "workspace-1",
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
        intent: "create",
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

  it("keeps Slack OAuth start and activation results free of secrets and replace intent", () => {
    expect(StartSlackOAuthRequestSchema.parse({ intent: "create" })).toEqual({ intent: "create" });
    expect(StartSlackOAuthRequestSchema.parse({ intent: "reauthorize" })).toEqual({ intent: "reauthorize" });
    expect(() => StartSlackOAuthRequestSchema.parse({ intent: "replace" })).toThrow();
    expect(() => StartSlackOAuthRequestSchema.parse({ intent: "create", state: "secret" })).toThrow();
    expect(StartSlackOAuthRequestSchema.parse({ intent: "create", returnSurface: "agent-setup" })).toEqual({
      intent: "create",
      returnSurface: "agent-setup",
    });
    expect(
      StartSlackOAuthRequestSchema.parse({ intent: "reauthorize", returnSurface: "agent-messaging-settings" }),
    ).toEqual({ intent: "reauthorize", returnSurface: "agent-messaging-settings" });
    const expectedMessaging = {
      kind: "bound" as const,
      provider: "slack" as const,
      bindingId: crypto.randomUUID(),
      credentialGeneration: 4,
    };
    expect(StartSlackOAuthRequestSchema.parse({ intent: "reauthorize", expectedMessaging })).toEqual({
      intent: "reauthorize",
      expectedMessaging,
    });
    expect(() => StartSlackOAuthRequestSchema.parse({ intent: "create", expectedMessaging })).toThrow(
      "Slack create requires the Agent to be unbound",
    );
    // No arbitrary return URL: the return surface is a fixed enum, never caller-controlled navigation.
    expect(() =>
      StartSlackOAuthRequestSchema.parse({ intent: "create", returnSurface: "https://evil.example.com/callback" }),
    ).toThrow();
    expect(() =>
      StartSlackOAuthRequestSchema.parse({ intent: "create", returnUrl: "https://evil.example.com" }),
    ).toThrow();
    expect(() =>
      StartSlackOAuthResponseSchema.parse({
        authorizationUrl: "https://slack.com/oauth/v2/authorize",
        expiresAt: "2026-08-19T00:10:00.000Z",
        sessionBinding: "secret",
      }),
    ).toThrow();
    expect(() =>
      SlackBindingActivationSchema.parse({
        intent: "replace",
        agentId: crypto.randomUUID(),
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        grantedBotScopes: ["chat:write"],
        botAccessToken: "xoxb-secret",
        signingSecret: "signing-secret",
        installedAt: "2026-08-19T00:00:00.000Z",
      }),
    ).toThrow();
    expect(
      SlackConfigurationResultSchema.parse({
        imBindingId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        credentialGeneration: 1,
        bindingState: "active",
        identityClosure: { status: "pending", verifiedAt: null },
      }).identityClosure,
    ).toEqual({ status: "pending", verifiedAt: null });
    expect(() =>
      SlackConfigurationResultSchema.parse({
        imBindingId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        credentialGeneration: 1,
        bindingState: "active",
        identityClosure: { status: "pending", verifiedAt: null },
        signingSecret: "secret",
      }),
    ).toThrow();
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
    expect(
      ImBindingHandoffStatusSchema.parse({
        bindingState: "active",
        handoffReady: false,
        providerCli: { phase: "preparing_cli" },
      }),
    ).toEqual({
      bindingState: "active",
      handoffReady: false,
      providerCli: { phase: "preparing_cli" },
    });
    expect(() =>
      ImBindingHandoffStatusSchema.parse({
        bindingState: "active",
        handoffReady: false,
        credentialGeneration: 1,
      }),
    ).toThrow();
    expect(() =>
      ImBindingHandoffStatusSchema.parse({
        bindingState: "active",
        handoffReady: false,
        providerCli: { phase: "needs_attention", path: "/usr/bin/slack" },
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

  it("fences Feishu setup commands with an optional exact messaging expectation", () => {
    expect(CreateFeishuSetupAttemptRequestSchema.parse({})).toEqual({ intent: "create" });
    expect(
      CreateFeishuSetupAttemptRequestSchema.parse({ intent: "create", expectedMessaging: { kind: "unbound" } }),
    ).toEqual({ intent: "create", expectedMessaging: { kind: "unbound" } });
    const bindingId = crypto.randomUUID();
    const reauthorize = {
      intent: "reauthorize" as const,
      expectedMessaging: { kind: "bound" as const, provider: "feishu" as const, bindingId, credentialGeneration: 2 },
    };
    expect(CreateFeishuSetupAttemptRequestSchema.parse(reauthorize)).toEqual(reauthorize);
    expect(
      CreateFeishuSetupAttemptRequestSchema.parse({
        intent: "replace",
        expectedMessaging: { kind: "bound", provider: "feishu", bindingId, credentialGeneration: 1 },
      }),
    ).toMatchObject({ intent: "replace" });
    expect(() =>
      CreateFeishuSetupAttemptRequestSchema.parse({
        intent: "create",
        expectedMessaging: { kind: "bound", provider: "feishu", bindingId, credentialGeneration: 1 },
      }),
    ).toThrow("Feishu create requires the Agent to be unbound");
    expect(() =>
      CreateFeishuSetupAttemptRequestSchema.parse({ intent: "create", expectedMessaging: { kind: "gone" } }),
    ).toThrow();
    expect(() =>
      CreateFeishuSetupAttemptRequestSchema.parse({
        intent: "reauthorize",
        expectedMessaging: { kind: "bound", provider: "feishu", bindingId, credentialGeneration: 0 },
      }),
    ).toThrow();
  });

  it("keeps the command messaging expectation in parity with the Agent setup contract", () => {
    const documents: unknown[] = [
      { kind: "unbound" },
      { kind: "bound", provider: "feishu", bindingId: crypto.randomUUID(), credentialGeneration: 1 },
      { kind: "bound", provider: "slack", bindingId: crypto.randomUUID(), credentialGeneration: 7 },
      { kind: "unbound", bindingId: crypto.randomUUID() },
      { kind: "bound", provider: "feishu", bindingId: "not-a-uuid", credentialGeneration: 1 },
      { kind: "bound", provider: "feishu", bindingId: crypto.randomUUID(), credentialGeneration: 0 },
      { kind: "bound", provider: "teams", bindingId: crypto.randomUUID(), credentialGeneration: 1 },
      { kind: "detached" },
    ];
    for (const document of documents) {
      const command = ImBindingMessagingExpectationSchema.safeParse(document);
      const setup = AgentSetupExpectedMessagingStateSchema.safeParse(document);
      expect(command.success, JSON.stringify(document)).toBe(setup.success);
      if (command.success && setup.success) expect(command.data).toEqual(setup.data);
    }
  });

  it("keeps the Slack OAuth return surfaces in parity with the Agent setup contract", () => {
    expect(SLACK_OAUTH_RETURN_SURFACES).toEqual(AGENT_SETUP_RETURN_SURFACES);
    for (const surface of AGENT_SETUP_RETURN_SURFACES) {
      expect(SlackOAuthReturnSurfaceSchema.parse(surface)).toBe(AgentSetupReturnSurfaceSchema.parse(surface));
    }
    expect(() => SlackOAuthReturnSurfaceSchema.parse("slack-app")).toThrow();
  });

  it("fences an unbind command to an exact Provider and binding identity", () => {
    const bindingId = crypto.randomUUID();
    expect(UnbindAgentMessagingRequestSchema.parse({ provider: "slack", bindingId })).toEqual({
      provider: "slack",
      bindingId,
    });
    expect(() => UnbindAgentMessagingRequestSchema.parse({ provider: "slack" })).toThrow();
    expect(() =>
      UnbindAgentMessagingRequestSchema.parse({ provider: "slack", bindingId, credentialGeneration: 3 }),
    ).toThrow();
  });

  it("requires a cross-Provider identity for an unbind-required detail", () => {
    const detail = {
      currentProvider: "feishu" as const,
      currentBindingId: crypto.randomUUID(),
      requestedProvider: "slack" as const,
    };
    expect(ImBindingUnbindRequiredDetailSchema.parse(detail)).toEqual(detail);
    expect(() => ImBindingUnbindRequiredDetailSchema.parse({ ...detail, requestedProvider: "feishu" })).toThrow();
    expect(() => ImBindingUnbindRequiredDetailSchema.parse({ ...detail, currentBindingId: "not-a-uuid" })).toThrow();
  });

  it("reports exact credential generation zero and capability gaps in diagnostics", () => {
    const diagnostics = {
      imBindingId: crypto.randomUUID(),
      provider: "slack" as const,
      ready: false,
      agentRuntimeReadiness: "ready" as const,
      providerCliReadiness: "ready" as const,
      credentialExecutionReadiness: "unconfirmed" as const,
      credentialGeneration: 0,
      credentialStatus: "invalid" as const,
      requiredCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
      grantedCapabilities: [],
      missingCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
      reauthorizationRequired: false,
      slackAppId: null,
      slackIdentityClosure: null,
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

function manifestBotScopes(source: string): string[] {
  const block = source.match(/scopes:\n {4}bot:\n((?: {6}- .+\n)+)/);
  if (!block?.[1]) throw new Error("missing manifest bot scopes");
  return [...block[1].matchAll(/^ {6}- (.+)$/gm)].flatMap((match) => (match[1] ? [match[1]] : []));
}

function markdownScopeList(source: string, heading: string): string[] {
  const start = source.indexOf(heading);
  if (start < 0) throw new Error(`missing ${heading}`);
  const scopes: string[] = [];
  for (const line of source.slice(start + heading.length).split("\n")) {
    if (line.trim() === "") {
      if (scopes.length > 0) break;
      continue;
    }
    const item = /^- `([^`]+)`$/.exec(line);
    if (!item?.[1]) break;
    scopes.push(item[1]);
  }
  if (scopes.length === 0) throw new Error(`missing ${heading} list`);
  return scopes;
}
