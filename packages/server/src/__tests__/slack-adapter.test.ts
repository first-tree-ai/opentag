import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { normalizeSlackEnvelope, SlackAdapter } from "../services/im-bindings/slack/adapter.js";
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

  it("validates auth.test identities and classifies rejected OAuth responses", async () => {
    const authTest = vi.fn().mockResolvedValue({ app_id: "A1", team_id: "T1", user_id: "U1", bot_id: "B1" });
    const client = { auth: { test: authTest }, files: { info: vi.fn() } };
    const api = new DefaultSlackApiClient(() => client as never);
    await expect(api.authTest("xoxb-token")).resolves.toEqual({
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
    });
    authTest.mockResolvedValueOnce({ team_id: "T1", user_id: "U1" });
    await expect(api.authTest("xoxb-token")).rejects.toThrow("SLACK_AUTH_IDENTITY_INCOMPLETE");

    const invalid = new DefaultSlackApiClient(
      undefined,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { status: 200 })),
    );
    await expect(
      invalid.oauthAccess({
        clientId: "client",
        clientSecret: "secret",
        code: "code",
        redirectUri: "https://example.com",
      }),
    ).rejects.toThrow("SLACK_AUTH_INVALID");
    const rejected = new DefaultSlackApiClient(
      undefined,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "other_error" }), { status: 200 })),
    );
    await expect(
      rejected.oauthAccess({
        clientId: "client",
        clientSecret: "secret",
        code: "code",
        redirectUri: "https://example.com",
      }),
    ).rejects.toThrow("SLACK_AUTH_REJECTED");
  });

  it("downloads Slack resources and rejects unavailable or oversized responses", async () => {
    const info = vi.fn().mockResolvedValue({
      file: { url_private_download: "https://files.example/download", name: "file.txt", mimetype: "text/plain" },
    });
    const client = { auth: { test: vi.fn() }, files: { info } };
    const api = new DefaultSlackApiClient(() => client as never);
    const fetchGlobal = vi
      .fn()
      .mockResolvedValue(new Response("contents", { status: 200, headers: { "content-length": "8" } }));
    vi.stubGlobal("fetch", fetchGlobal);
    try {
      await expect(
        api.fetchResource({
          messageExternalId: "message",
          providerResourceKey: "file",
          kind: "file",
          token: "xoxb-token",
        }),
      ).resolves.toMatchObject({
        filename: "file.txt",
        mediaType: "text/plain",
        sizeBytes: 8,
        stream: expect.any(Readable),
      });
      expect(info).toHaveBeenCalledWith({ file: "file" });
      expect(fetchGlobal).toHaveBeenCalledWith(
        "https://files.example/download",
        expect.objectContaining({ redirect: "error" }),
      );

      info.mockResolvedValueOnce({ file: {} });
      await expect(
        api.fetchResource({
          messageExternalId: "message",
          providerResourceKey: "missing",
          kind: "file",
          token: "xoxb-token",
        }),
      ).rejects.toThrow("SLACK_RESOURCE_UNAVAILABLE");
      info.mockResolvedValueOnce({ file: { url_private: "https://files.example/private" } });
      fetchGlobal.mockResolvedValueOnce(new Response(null, { status: 403 }));
      await expect(
        api.fetchResource({
          messageExternalId: "message",
          providerResourceKey: "private",
          kind: "file",
          token: "xoxb-token",
        }),
      ).rejects.toThrow("SLACK_RESOURCE_HTTP_403");
      fetchGlobal.mockResolvedValueOnce(
        new Response("too large", { status: 200, headers: { "content-length": "26214401" } }),
      );
      await expect(
        api.fetchResource({
          messageExternalId: "message",
          providerResourceKey: "large",
          kind: "file",
          token: "xoxb-token",
        }),
      ).rejects.toThrow("SLACK_RESOURCE_TOO_LARGE");
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("rejects a successful user-token auth.test response that has no Bot identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          team_id: "T1",
          user_id: "U_HUMAN",
        }),
        { status: 200, headers: { "x-oauth-scopes": "chat:write" } },
      ),
    );
    const api = new DefaultSlackApiClient(undefined, fetchImpl);

    await expect(api.inspectInstallation("xoxp-user-token")).rejects.toThrow("SLACK_AUTH_IDENTITY_INCOMPLETE");
  });

  it("exchanges an OAuth code for a Bot installation without retaining the client secret in errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          token_type: "bot",
          access_token: "xoxb-distributed",
          app_id: "A_OPENTAG",
          bot_user_id: "U_BOT",
          team: { id: "T_TEAM", name: "Workspace" },
          enterprise: null,
        }),
        { status: 200 },
      ),
    );
    const api = new DefaultSlackApiClient(undefined, fetchImpl);

    await expect(
      api.oauthAccess({
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "oauth-code",
        redirectUri: "https://opentag.example.com/api/v1/im-bindings/slack/oauth/callback",
      }),
    ).resolves.toEqual({
      appId: "A_OPENTAG",
      teamId: "T_TEAM",
      enterpriseId: null,
      botUserId: "U_BOT",
      botAccessToken: "xoxb-distributed",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/oauth.v2.access",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
    expect(body).toContain("client_secret=client-secret");
    await expect(
      new DefaultSlackApiClient(
        undefined,
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, token_type: "user" }), { status: 200 })),
      ).oauthAccess({
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "oauth-code",
        redirectUri: "https://opentag.example.com/api/v1/im-bindings/slack/oauth/callback",
      }),
    ).rejects.toThrow("SLACK_AUTH_IDENTITY_INCOMPLETE");
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

  it("preserves the configured App identity when runtime auth.test omits app_id", async () => {
    const adapter = new SlackAdapter({
      api: {
        authTest: vi.fn().mockResolvedValue({ appId: null, teamId: "T1", botUserId: "U1", botId: "B1" }),
      } as never,
      token: "xoxb-secret",
      appId: "A_CONFIGURED",
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
    });

    await expect(adapter.validateBinding()).resolves.toEqual({
      externalAppId: "A_CONFIGURED",
      externalTeamId: "T1",
      externalBotId: "U1",
    });
  });

  it("rejects runtime identity drift and forwards adapter capabilities", async () => {
    const fetchResource = vi.fn().mockResolvedValue({ stream: Readable.from("ok") });
    const api = {
      authTest: vi.fn().mockResolvedValue({ appId: "A_OTHER", teamId: "T1", botUserId: "U1", botId: "B1" }),
      fetchResource,
    };
    const adapter = new SlackAdapter({
      api: api as never,
      token: "xoxb-secret",
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
    });
    await expect(adapter.validateBinding()).rejects.toThrow("SLACK_BINDING_IDENTITY_MISMATCH");
    api.authTest.mockResolvedValueOnce({ appId: null, teamId: "T1", botUserId: "U1", botId: "B1" });
    await expect(adapter.validateBinding()).resolves.toMatchObject({ externalAppId: "A1" });
    const normalized = adapter.normalizeInbound({
      eventId: "Ev-forward",
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
      event: { type: "message", channel: "C1", ts: "1", text: "hello" },
    });
    expect(normalized).toHaveLength(1);
    await expect(
      adapter.fetchResource({ messageExternalId: "1", providerResourceKey: "F1", kind: "file" }),
    ).resolves.toMatchObject({ stream: expect.any(Readable) });
    expect(fetchResource).toHaveBeenCalledWith({
      messageExternalId: "1",
      providerResourceKey: "F1",
      kind: "file",
      token: "xoxb-secret",
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
    expect(preparseSlackRoute(Buffer.from("not-json"))).toBeUndefined();
    expect(preparseSlackRoute(Buffer.from(JSON.stringify({ api_app_id: "A1" })))).toBeUndefined();
    expect(
      preparseSlackRoute(Buffer.from(JSON.stringify({ api_app_id: "A".repeat(256), team_id: "T1" }))),
    ).toBeUndefined();
    expect(verifySlackSignature({ rawBody, timestamp: undefined, signature, signingSecret: "secret", now })).toBe(
      false,
    );
    expect(verifySlackSignature({ rawBody, timestamp, signature: "v0=bad", signingSecret: "secret", now })).toBe(false);
    expect(
      verifySlackSignature({
        rawBody: Buffer.alloc(1024 * 1024 + 1),
        timestamp,
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
        text: "<@U_BOT> hello <@U1>",
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
      message: {
        externalId: "1724025600.123",
        threadKey: "1724025500.000",
        content: {
          fallbackText: "<@U_BOT> hello <@U1>",
          blocks: [
            { type: "mention", externalId: "U_BOT", label: "<@U_BOT>" },
            { type: "text", text: " hello " },
            { type: "mention", externalId: "U1", label: "<@U1>" },
          ],
        },
      },
      mentions: [{ externalId: "U_BOT" }, { externalId: "U1" }],
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

    const [dm] = normalizeSlackEnvelope({
      eventId: "Ev-dm",
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      botId: "B1",
      event: { type: "message", channel: "D1", channel_type: "im", ts: "bad", text: "direct" },
    });
    expect(dm).toMatchObject({
      conversation: { kind: "dm" },
      message: { occurredAt: new Date("1970-01-01T00:00:00.000Z") },
    });
    const [groupDm] = normalizeSlackEnvelope({
      eventId: "Ev-mpim",
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      botId: "B1",
      event: { type: "message", channel: "G1", channel_type: "mpim", ts: "2", text: "group" },
    });
    expect(groupDm?.conversation.kind).toBe("group_dm");
    const large = "x".repeat(24 * 1024 + 32);
    const [bounded] = normalizeSlackEnvelope({
      eventId: "Ev-large",
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      botId: "B1",
      event: { type: "message", channel: "C1", ts: "3", text: large },
    });
    expect(bounded?.message.content).toMatchObject({ truncated: true });
  });

  it("registers the raw-body route without breaking adjacent JSON parsing", async () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    const app = createApp({
      slackEvents: {
        now: () => now,
        imBindings: {
          findSlackInstallationIngress: vi.fn().mockResolvedValue({
            installationId: crypto.randomUUID(),
            generation: 1,
            appId: "A1",
            teamId: "T1",
            botUserId: "U1",
            botId: "B1",
            botAccessToken: "xoxb",
            signingSecret: "secret",
          }),
          recordSlackInstallationObservation: vi.fn().mockResolvedValue(true),
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
});
