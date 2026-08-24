import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  classifySlackInboundEvent,
  normalizeSlackEnvelope,
  SlackAdapter,
} from "../services/im-bindings/slack/adapter.js";
import { SlackBindingActivator } from "../services/im-bindings/slack/binding-activator.js";
import { DefaultSlackApiClient } from "../services/im-bindings/slack/default-api-client.js";
import { preparseSlackRoute, verifySlackSignature } from "../services/im-bindings/slack/signature.js";

describe("Slack installed-binding adapter", () => {
  it("derives installation identity and granted scopes from Slack instead of browser input", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          app_id: "A1",
          team_id: "T1",
          enterprise_id: "E1",
          user_id: "U1",
          bot_id: "B1",
        }),
        { status: 200, headers: { "x-oauth-scopes": "chat:write, app_mentions:read, im:history" } },
      ),
    );
    const api = new DefaultSlackApiClient(undefined, fetchImpl);

    await expect(api.inspectInstallation("xoxb-secret")).resolves.toEqual({
      appId: "A1",
      teamId: "T1",
      enterpriseId: "E1",
      botUserId: "U1",
      botId: "B1",
      grantedBotScopes: ["app_mentions:read", "chat:write", "im:history"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/auth.test",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer xoxb-secret" }) }),
    );
  });

  it("accepts Slack's documented bot-token identity when auth.test omits app_id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          team_id: "T1",
          user_id: "U1",
          bot_id: "B1",
        }),
        { status: 200, headers: { "x-oauth-scopes": "im:history, chat:write, app_mentions:read, files:read" } },
      ),
    );
    const api = new DefaultSlackApiClient(undefined, fetchImpl);

    await expect(api.inspectInstallation("xoxb-secret")).resolves.toEqual({
      appId: null,
      teamId: "T1",
      enterpriseId: null,
      botUserId: "U1",
      botId: "B1",
      grantedBotScopes: ["app_mentions:read", "chat:write", "files:read", "im:history"],
    });
  });

  it("bounds auth.test with a timeout and reports upstream unavailability without credential detail", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "TimeoutError"));
    const api = new DefaultSlackApiClient(undefined, fetchImpl);

    await expect(api.inspectInstallation("xoxb-secret")).rejects.toThrow("SLACK_AUTH_UPSTREAM_UNAVAILABLE");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/auth.test",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("preserves the signed-event App identity when runtime auth.test omits app_id", async () => {
    const adapter = new SlackAdapter({
      api: {
        authTest: vi.fn().mockResolvedValue({ appId: null, teamId: "T1", botUserId: "U1", botId: "B1" }),
      } as never,
      token: "xoxb-secret",
      appId: "A_SIGNED_EVENT",
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
    });

    await expect(adapter.validateBinding()).resolves.toEqual({
      externalAppId: "A_SIGNED_EVENT",
      externalTeamId: "T1",
      externalBotId: "U1",
    });
  });

  it("verifies the raw body and rejects replayed timestamps", () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const rawBody = Buffer.from(JSON.stringify({ api_app_id: "A1", team_id: "T1" }));
    const signature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:`).update(rawBody).digest("hex")}`;
    expect(preparseSlackRoute(rawBody)).toEqual({ appId: "A1", teamId: "T1" });
    expect(verifySlackSignature({ rawBody, timestamp, signature, signingSecret: "secret", now })).toBe(true);
    expect(
      verifySlackSignature({
        rawBody,
        timestamp: String(Number(timestamp) - 301),
        signature,
        signingSecret: "secret",
        now,
      }),
    ).toBe(false);
  });

  it("normalizes mentions, threads, edits, and provider resources", () => {
    const [event] = normalizeSlackEnvelope({
      eventId: "Ev1",
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      botId: "B_BOT",
      event: {
        type: "app_mention",
        channel: "C1",
        channel_type: "channel",
        user: "U2",
        text: "hello <@U1>",
        ts: "1724025600.123",
        event_ts: "1724025600.124",
        thread_ts: "1724025500.000",
        files: [{ id: "F1", name: "a.png", mimetype: "image/png", size: 12 }],
      },
    });
    expect(event).toMatchObject({
      providerEventId: "Ev1",
      providerContext: { provider: "slack", channelType: "channel", threadTs: "1724025500.000" },
      conversation: { externalId: "C1", kind: "channel" },
      message: { externalId: "1724025600.123", threadKey: "1724025500.000" },
      mentions: [{ externalId: "U1" }],
    });
    expect(event?.message.resources[0]).toMatchObject({ providerResourceKey: "F1", kind: "image" });

    const [botMessage] = normalizeSlackEnvelope({
      eventId: "Ev-bot",
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      botId: "B1",
      event: {
        type: "message",
        subtype: "bot_message",
        channel: "C1",
        text: "official bot_message shape",
        ts: "1724025600.500",
        bot_id: "B1",
      },
    });
    expect(botMessage).toMatchObject({
      message: { author: { externalId: "B1", kind: "bot", isSelf: true } },
    });

    const [edited] = normalizeSlackEnvelope({
      eventId: "Ev2",
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      botId: "B1",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "1724025601.000",
        event_ts: "1724025601.100",
        message: {
          ts: "1724025600.123",
          text: "edited by bot",
          thread_ts: "1724025500.000",
          bot_id: "B1",
          bot_profile: { app_id: "A1" },
          files: [{ id: "F2", name: "b.txt", mimetype: "text/plain", size: 2 }],
        },
      },
    });
    expect(edited).toMatchObject({
      message: {
        operation: "edited",
        externalId: "1724025600.123",
        threadKey: "1724025500.000",
        author: { externalId: "U_BOT", kind: "bot", isSelf: true },
        resources: [{ providerResourceKey: "F2" }],
      },
    });

    const [deleted] = normalizeSlackEnvelope({
      eventId: "Ev3",
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      botId: "B1",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        ts: "1724025602.000",
        deleted_ts: "1724025600.123",
        event_ts: "1724025602.100",
        previous_message: {
          ts: "1724025600.123",
          text: "deleted bot reply",
          thread_ts: "1724025500.000",
          bot_id: "B1",
        },
      },
    });
    expect(deleted).toMatchObject({
      message: {
        operation: "deleted",
        externalId: "1724025600.123",
        threadKey: "1724025500.000",
        author: { externalId: "B1", kind: "bot", isSelf: true },
      },
    });
  });

  it("registers the raw-body route without breaking adjacent JSON parsing", async () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    const app = createApp({
      slackEvents: {
        now: () => now,
        imBindings: {
          findSlackIngressBinding: vi.fn().mockResolvedValue({
            imBindingId: crypto.randomUUID(),
            generation: 1,
            appId: "A1",
            teamId: "T1",
            botUserId: "U1",
            botId: "B1",
            botAccessToken: "xoxb",
            signingSecret: "secret",
          }),
        } as never,
        inbox: {} as never,
        createAdapter: vi.fn() as never,
      },
    });
    app.post("/json-neighbor", async (request) => request.body);
    await app.ready();
    const raw = JSON.stringify({ type: "url_verification", api_app_id: "A1", team_id: "T1", challenge: "ok" });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const signature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:${raw}`).digest("hex")}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/im-bindings/slack/events",
      payload: raw,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "ok" });
    const neighbor = await app.inject({ method: "POST", url: "/json-neighbor", payload: { ok: true } });
    expect(neighbor.json()).toEqual({ ok: true });
    await app.close();
  });

  it("validates installation identity before activation", async () => {
    const activateSlack = vi.fn().mockResolvedValue("im-binding-id");
    const api = {
      inspectInstallation: vi.fn().mockResolvedValue({
        appId: "A2",
        teamId: "T1",
        enterpriseId: null,
        botUserId: "U1",
        botId: "B1",
        grantedBotScopes: ["chat:write"],
      }),
    };
    const activator = new SlackBindingActivator({ activateSlack } as never, api as never);
    await expect(
      activator.activate({
        agentId: crypto.randomUUID(),
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        grantedBotScopes: ["chat:write"],
        botAccessToken: "xoxb-token",
        signingSecret: "secret",
        installedAt: new Date(),
      }),
    ).rejects.toThrow("SLACK_BINDING_IDENTITY_MISMATCH");
    expect(activateSlack).not.toHaveBeenCalled();
  });

  it("does not let the direct activator trust a caller App ID when auth.test omits it", async () => {
    const activateSlack = vi.fn();
    const api = {
      inspectInstallation: vi.fn().mockResolvedValue({
        appId: null,
        teamId: "T1",
        enterpriseId: null,
        botUserId: "U1",
        botId: "B1",
        grantedBotScopes: ["chat:write"],
      }),
    };
    const activator = new SlackBindingActivator({ activateSlack } as never, api as never);

    await expect(
      activator.activate({
        agentId: crypto.randomUUID(),
        appId: "A_BROWSER",
        teamId: "T1",
        botUserId: "U1",
        grantedBotScopes: ["chat:write"],
        botAccessToken: "xoxb-token",
        signingSecret: "secret",
        installedAt: new Date(),
      }),
    ).rejects.toThrow("SLACK_BINDING_IDENTITY_MISMATCH");
    expect(activateSlack).not.toHaveBeenCalled();
  });

  it("persists the verified Slack bot ID namespace during activation", async () => {
    const activateSlack = vi.fn().mockResolvedValue("im-binding-id");
    const api = {
      inspectInstallation: vi.fn().mockResolvedValue({
        appId: "A1",
        teamId: "T1",
        enterpriseId: "E1",
        botUserId: "U1",
        botId: "B1",
        grantedBotScopes: ["app_mentions:read", "chat:write", "files:read", "im:history"],
      }),
    };
    const activator = new SlackBindingActivator({ activateSlack } as never, api as never);
    const input = {
      agentId: crypto.randomUUID(),
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      grantedBotScopes: ["chat:write"],
      botAccessToken: "xoxb-token",
      signingSecret: "secret",
      installedAt: new Date(),
    };

    await expect(activator.activate(input)).resolves.toBe("im-binding-id");
    expect(activateSlack).toHaveBeenCalledWith(
      {
        ...input,
        enterpriseId: "E1",
        grantedBotScopes: ["app_mentions:read", "chat:write", "files:read", "im:history"],
      },
      "B1",
    );
  });
});

describe("Slack message subtype policy", () => {
  const identity = { eventId: "Ev-subtype", appId: "A1", teamId: "T1", botUserId: "U_BOT", botId: "B_BOT" };
  const base = { channel: "C1", channel_type: "channel", user: "U2", ts: "1724025600.100", event_ts: "1724025600.100" };

  it("treats file_share as a user message and keeps its shared files as resources", () => {
    const event = {
      type: "message",
      subtype: "file_share",
      ...base,
      text: "<@U_BOT> look at this",
      files: [{ id: "F1", name: "report.pdf", mimetype: "application/pdf", size: 1024 }],
    };
    expect(classifySlackInboundEvent(event)).toMatchObject({
      accepted: true,
      eventType: "message",
      subtype: "file_share",
    });
    const [normalized] = normalizeSlackEnvelope({ ...identity, event });
    expect(normalized).toMatchObject({
      message: {
        operation: "created",
        externalId: "1724025600.100",
        author: { externalId: "U2", kind: "human", isSelf: false },
        resources: [{ providerResourceKey: "F1", kind: "file", filename: "report.pdf", mediaType: "application/pdf" }],
      },
      mentions: [{ externalId: "U_BOT" }],
    });
  });

  it("treats thread_broadcast as a thread reply keyed by the payload thread_ts", () => {
    const event = {
      type: "message",
      subtype: "thread_broadcast",
      ...base,
      text: "broadcast to channel",
      thread_ts: "1724025500.000",
      root: { ts: "1724025500.000", user: "U3", text: "root" },
    };
    expect(classifySlackInboundEvent(event)).toMatchObject({ accepted: true, subtype: "thread_broadcast" });
    const [normalized] = normalizeSlackEnvelope({ ...identity, event });
    expect(normalized).toMatchObject({
      providerContext: { provider: "slack", threadTs: "1724025500.000" },
      message: { operation: "created", externalId: "1724025600.100", threadKey: "1724025500.000" },
    });
  });

  it("keeps message_changed as an edit whose nested message files become resources", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel: "C1",
      ts: "1724025601.000",
      event_ts: "1724025601.000",
      message: {
        ts: "1724025600.100",
        user: "U2",
        text: "edited text",
        files: [{ id: "F9", name: "diagram.png", mimetype: "image/png", size: 7 }],
      },
      previous_message: { ts: "1724025600.100", user: "U2", text: "original" },
    };
    expect(classifySlackInboundEvent(event)).toMatchObject({ accepted: true, subtype: "message_changed" });
    const [normalized] = normalizeSlackEnvelope({ ...identity, event });
    expect(normalized).toMatchObject({
      message: {
        operation: "edited",
        externalId: "1724025600.100",
        author: { externalId: "U2", kind: "human" },
        resources: [{ providerResourceKey: "F9", kind: "image" }],
      },
    });
  });

  it("keeps message_deleted as a deletion even though Slack marks it hidden", () => {
    const event = {
      type: "message",
      subtype: "message_deleted",
      hidden: true,
      channel: "C1",
      ts: "1724025602.000",
      deleted_ts: "1724025600.100",
      event_ts: "1724025602.000",
      previous_message: { ts: "1724025600.100", user: "U2", text: "gone" },
    };
    expect(classifySlackInboundEvent(event)).toMatchObject({ accepted: true, subtype: "message_deleted" });
    expect(normalizeSlackEnvelope({ ...identity, event })[0]).toMatchObject({
      message: { operation: "deleted", externalId: "1724025600.100" },
    });
  });

  it("applies the self filter to bot_message and keeps foreign integrations as bot authors", () => {
    const own = { type: "message", subtype: "bot_message", ...base, user: undefined, bot_id: "B_BOT", text: "mine" };
    expect(normalizeSlackEnvelope({ ...identity, event: own })[0]?.message.author).toMatchObject({
      kind: "bot",
      isSelf: true,
    });
    const foreign = { ...own, bot_id: "B_OTHER" };
    expect(normalizeSlackEnvelope({ ...identity, event: foreign })[0]?.message.author).toMatchObject({
      externalId: "B_OTHER",
      kind: "bot",
      isSelf: false,
    });
  });

  it.each([
    "channel_join",
    "channel_leave",
    "channel_topic",
    "channel_purpose",
    "channel_name",
    "pinned_item",
    "unknown_future_subtype",
  ])("drops the %s subtype without normalizing anything", (subtype) => {
    const event = { type: "message", subtype, ...base, text: "system notice" };
    expect(classifySlackInboundEvent(event)).toEqual({
      accepted: false,
      reason: "ignored_subtype",
      eventType: "message",
      subtype,
    });
    expect(normalizeSlackEnvelope({ ...identity, event })).toEqual([]);
  });

  it("drops hidden messages that are not edit or delete revisions", () => {
    const event = { type: "message", ...base, hidden: true, text: "should not be displayed" };
    expect(classifySlackInboundEvent(event)).toEqual({
      accepted: false,
      reason: "hidden_message",
      eventType: "message",
      subtype: undefined,
    });
    expect(normalizeSlackEnvelope({ ...identity, event })).toEqual([]);
    const hiddenFileShare = { ...event, subtype: "file_share", files: [{ id: "F1" }] };
    expect(classifySlackInboundEvent(hiddenFileShare)).toMatchObject({ accepted: false, reason: "hidden_message" });
  });

  it("reports unsupported event types and malformed message events without throwing", () => {
    expect(classifySlackInboundEvent({ type: "app_home_opened", user: "U2", tab: "messages" })).toEqual({
      accepted: false,
      reason: "unsupported_event",
      eventType: "app_home_opened",
      subtype: undefined,
    });
    expect(classifySlackInboundEvent({ type: "message", text: "no channel or ts" })).toMatchObject({
      accepted: false,
      reason: "unsupported_event",
      eventType: "message",
    });
    expect(classifySlackInboundEvent(null)).toMatchObject({ accepted: false, reason: "unsupported_event" });
    expect(classifySlackInboundEvent({ type: 42 })).toMatchObject({ accepted: false, eventType: undefined });
  });

  it("normalizes app_mention and message.channels deliveries of one mention to the same revision identity", () => {
    const mention = normalizeSlackEnvelope({
      ...identity,
      eventId: "Ev-mention",
      event: { type: "app_mention", ...base, text: "<@U_BOT> hi" },
    })[0];
    const channelMessage = normalizeSlackEnvelope({
      ...identity,
      eventId: "Ev-channel",
      event: { type: "message", ...base, text: "<@U_BOT> hi" },
    })[0];
    expect(mention?.providerEventId).not.toBe(channelMessage?.providerEventId);
    expect(channelMessage?.conversation).toEqual(mention?.conversation);
    expect(channelMessage?.message).toMatchObject({
      externalId: mention?.message.externalId,
      revisionKey: mention?.message.revisionKey,
      operation: "created",
    });
  });
});
