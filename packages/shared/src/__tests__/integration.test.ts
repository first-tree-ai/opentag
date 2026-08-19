import { describe, expect, it } from "vitest";
import { ImContentV1Schema, NormalizedInboundImEventSchema } from "../im-message.js";
import { FeishuSetupAttemptSchema, IntegrationSummarySchema, SlackBindingActivationSchema } from "../integration.js";

describe("IM integration contracts", () => {
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

  it("requires a provider-specific identity in Integration summaries", () => {
    const base = {
      integration: {
        id: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        provider: "slack",
        status: "active",
        disabledAt: null,
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
      },
      receiveMode: "mention_only",
      credentialGeneration: 1,
      grantedCapabilities: ["chat:write"],
      reauthorizationRequired: false,
      lastInboundAt: null,
      lastOutboundAt: null,
    };
    expect(
      IntegrationSummarySchema.parse({
        ...base,
        identity: { provider: "slack", appId: "A1", teamId: "T1", enterpriseId: null, botUserId: "U1" },
      }).identity.provider,
    ).toBe("slack");
  });
});
