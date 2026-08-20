import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { mapSlackWriteResult, normalizeSlackEnvelope, SlackAdapter } from "../services/im-bindings/slack/adapter.js";
import { SlackBindingActivator } from "../services/im-bindings/slack/binding-activator.js";
import { DefaultSlackApiClient, SLACK_WEB_CLIENT_OPTIONS } from "../services/im-bindings/slack/default-api-client.js";
import { preparseSlackRoute, verifySlackSignature } from "../services/im-bindings/slack/signature.js";

describe("Slack installed-binding adapter", () => {
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
      conversation: { externalId: "C1", kind: "channel" },
      message: { externalId: "1724025600.123", threadKey: "1724025500.000" },
      mentions: [{ externalId: "U1" }],
    });
    expect(event?.message.resources[0]).toMatchObject({ providerResourceKey: "F1", kind: "image" });

    const [edited] = normalizeSlackEnvelope({
      eventId: "Ev2",
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
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
        author: { externalId: "U_BOT", kind: "bot" },
        resources: [{ providerResourceKey: "F2" }],
      },
    });

    const [deleted] = normalizeSlackEnvelope({
      eventId: "Ev3",
      appId: "A1",
      teamId: "T1",
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
        author: { externalId: "B1", kind: "bot" },
      },
    });
  });

  it("classifies documented provider errors without retrying them", () => {
    expect(SLACK_WEB_CLIENT_OPTIONS).toEqual({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
    expect(mapSlackWriteResult({ ok: false, error: "invalid_auth" })).toMatchObject({ category: "credential" });
    expect(mapSlackWriteResult({ ok: false, error: "not_in_channel" })).toMatchObject({ category: "deterministic" });
    expect(mapSlackWriteResult({ ok: false, error: "ratelimited", retryAfterSeconds: 3 })).toMatchObject({
      category: "rate_limited",
      retryAfterSeconds: 3,
    });
    expect(mapSlackWriteResult({ ok: false, error: "server_error" })).toMatchObject({ category: "unknown" });
  });

  it("attempts each Slack write exactly once", async () => {
    const postMessage = vi.fn().mockRejectedValue({ data: { error: "server_error" } });
    const add = vi.fn().mockRejectedValue({ data: { error: "ratelimited" }, retryAfter: 4 });
    const createClient = vi.fn(() => ({ chat: { postMessage }, reactions: { add } }));
    const api = new DefaultSlackApiClient(createClient as never);
    await expect(api.postMessage({ token: "xoxb", channel: "C1", text: "hello" })).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    await expect(api.addReaction({ token: "xoxb", channel: "C1", timestamp: "1.2", emoji: "eyes" })).resolves.toEqual({
      ok: false,
      error: "ratelimited",
      retryAfterSeconds: 4,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("maps channel replies and existing thread replies to the correct Slack thread root", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: "3.4" });
    const adapter = new SlackAdapter({
      api: { postMessage } as never,
      token: "xoxb",
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
    });
    await adapter.send({ conversationExternalId: "C1", fallbackText: "root reply", replyToExternalId: "1.2" });
    await adapter.send({
      conversationExternalId: "C1",
      fallbackText: "thread reply",
      threadKey: "1.0",
      replyToExternalId: "1.2",
    });
    expect(postMessage).toHaveBeenNthCalledWith(1, {
      token: "xoxb",
      channel: "C1",
      text: "root reply",
      threadTs: "1.2",
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      token: "xoxb",
      channel: "C1",
      text: "thread reply",
      threadTs: "1.0",
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
    const api = { authTest: vi.fn().mockResolvedValue({ appId: "A2", teamId: "T1", botUserId: "U1" }) };
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
});
