import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const now = new Date("2026-08-20T00:00:00.000Z");
const timestamp = String(Math.floor(now.getTime() / 1000));
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function binding() {
  return {
    imBindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
    generation: 5,
    appId: "A1",
    teamId: "T1",
    botUserId: "U_BOT",
    botId: "B_BOT",
    botAccessToken: "xoxb-sensitive",
    signingSecret: "signing-sensitive",
  };
}

function signedRequest(
  envelope: Record<string, unknown>,
  signingSecret = binding().signingSecret,
  extraHeaders: Record<string, string> = {},
) {
  const payload = JSON.stringify(envelope);
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${payload}`).digest("hex")}`;
  return {
    method: "POST" as const,
    url: "/api/v1/im-bindings/slack/events",
    payload,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      ...extraHeaders,
    },
  };
}

function captureLogs() {
  let logs = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  return { stream, logs: () => logs };
}

function createServices(overrides: Record<string, unknown> = {}, loggerStream?: Writable) {
  const current = binding();
  const imBindings = {
    findSlackIngressBinding: vi.fn().mockResolvedValue(current),
    findSlackIngressBindingForAgent: vi.fn().mockResolvedValue(current),
    disableFromProvider: vi.fn().mockResolvedValue(undefined),
    requireReauthorization: vi.fn().mockResolvedValue(undefined),
  };
  const inbox = { ingest: vi.fn().mockResolvedValue(undefined) };
  const adapter = {
    classifyInbound: vi.fn().mockReturnValue({ accepted: true, eventType: "app_mention", subtype: undefined }),
    normalizeInbound: vi.fn().mockReturnValue([]),
  };
  const createAdapter = vi.fn(() => adapter);
  const app = createApp({
    loggerStream,
    slackEvents: {
      now: () => now,
      imBindings: imBindings as never,
      inbox: inbox as never,
      createAdapter: createAdapter as never,
      ...overrides,
    },
  });
  apps.push(app);
  return { app, imBindings, inbox, adapter, createAdapter, current };
}

describe("Slack Events API ingress", () => {
  it("uses the Agent Events URL for signing-secret proof and first-event activation", async () => {
    const setup = {
      verifyChallenge: vi.fn().mockResolvedValue("challenge-ok"),
      tryActivateFromEvent: vi.fn().mockResolvedValue({ status: "activated", binding: binding() }),
    };
    const { app, adapter } = createServices({ setup });
    const agentEventsUrl = "/api/v1/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/im-binding/slack/events";
    const challenge = await app.inject({
      ...signedRequest({ type: "url_verification", challenge: "challenge-ok" }),
      url: agentEventsUrl,
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toEqual({ challenge: "challenge-ok" });
    expect(setup.verifyChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
        rawBody: expect.any(Buffer),
        timestamp,
      }),
    );

    const event = {
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: "Ev-activate",
      event: { type: "app_mention", channel: "C1", text: "<@U_BOT> test", ts: "1.0" },
    };
    const activated = await app.inject({ ...signedRequest(event), url: agentEventsUrl });
    expect(activated.statusCode).toBe(200);
    expect(setup.tryActivateFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24", appId: "A1", teamId: "T1" }),
    );
    expect(adapter.normalizeInbound).toHaveBeenCalled();
  });

  it("keeps serving the active binding while a pending attempt still awaits URL verification", async () => {
    const setup = {
      verifyChallenge: vi.fn(),
      tryActivateFromEvent: vi.fn().mockResolvedValue({ status: "awaiting_challenge" }),
    };
    const { app, adapter, inbox, current } = createServices({ setup });
    adapter.normalizeInbound.mockReturnValue([{ providerEventId: "Ev-live" }]);

    const response = await app.inject({
      ...signedRequest({
        type: "event_callback",
        api_app_id: "A1",
        team_id: "T1",
        event_id: "Ev-live",
        event: { type: "app_mention", text: "hi" },
      }),
      url: "/api/v1/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/im-binding/slack/events",
    });

    expect(response.statusCode).toBe(200);
    expect(inbox.ingest).toHaveBeenCalledWith(
      current.imBindingId,
      current.generation,
      { providerEventId: "Ev-live" },
      undefined,
      { provider: "slack" },
    );
  });

  it("acknowledges a pending-attempt event without ingesting when no binding is active yet", async () => {
    const setup = {
      verifyChallenge: vi.fn(),
      tryActivateFromEvent: vi.fn().mockResolvedValue({ status: "awaiting_challenge" }),
    };
    const { app, imBindings, inbox } = createServices({ setup });
    imBindings.findSlackIngressBindingForAgent.mockResolvedValue(undefined);
    const request = {
      ...signedRequest({
        type: "event_callback",
        api_app_id: "A1",
        team_id: "T1",
        event_id: "Ev-early",
        event: { type: "app_mention", text: "hi" },
      }),
      url: "/api/v1/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/im-binding/slack/events",
    };

    const pending = await app.inject(request);
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ ok: true, pending: "url_verification" });
    expect(inbox.ingest).not.toHaveBeenCalled();

    setup.tryActivateFromEvent.mockResolvedValue({ status: "unmatched" });
    const missing = await app.inject(request);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "binding_not_found" });
  });

  it("rejects non-buffer and unroutable bodies before credential lookup", async () => {
    const { app, imBindings } = createServices();
    const nonBuffer = await app.inject({
      method: "POST",
      url: "/api/v1/im-bindings/slack/events",
      headers: { "content-type": "text/plain" },
      payload: "not-json",
    });
    expect(nonBuffer.statusCode).toBe(400);
    expect(nonBuffer.json()).toEqual({ error: "invalid_body" });

    const unroutable = await app.inject({
      method: "POST",
      url: "/api/v1/im-bindings/slack/events",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ type: "event_callback" }),
    });
    expect(unroutable.statusCode).toBe(400);
    expect(unroutable.json()).toEqual({ error: "invalid_route" });
    expect(imBindings.findSlackIngressBinding).not.toHaveBeenCalled();
  });

  it("rejects missing bindings, invalid signatures, and mismatched verified identities", async () => {
    const missing = createServices();
    missing.imBindings.findSlackIngressBinding.mockResolvedValue(undefined);
    const envelope = { type: "url_verification", api_app_id: "A1", team_id: "T1", challenge: "ok" };
    const missingResponse = await missing.app.inject(signedRequest(envelope));
    expect(missingResponse.statusCode).toBe(404);

    const invalid = createServices();
    const invalidResponse = await invalid.app.inject(signedRequest(envelope, "wrong-secret"));
    expect(invalidResponse.statusCode).toBe(401);
    expect(invalidResponse.json()).toEqual({ error: "invalid_signature" });

    const mismatched = createServices();
    mismatched.imBindings.findSlackIngressBinding.mockResolvedValue({ ...binding(), appId: "A2" });
    const mismatchResponse = await mismatched.app.inject(signedRequest(envelope));
    expect(mismatchResponse.statusCode).toBe(401);
    expect(mismatchResponse.json()).toEqual({ error: "binding_mismatch" });
  });

  it("validates URL verification and event callback envelope fields", async () => {
    const { app } = createServices();
    const invalidChallenge = await app.inject(
      signedRequest({ type: "url_verification", api_app_id: "A1", team_id: "T1" }),
    );
    expect(invalidChallenge.statusCode).toBe(400);
    expect(invalidChallenge.json()).toEqual({ error: "invalid_challenge" });

    const malformed = await app.inject(
      signedRequest({ type: "event_callback", api_app_id: "A1", team_id: "T1", event_id: "Ev1" }),
    );
    expect(malformed.statusCode).toBe(200);
    expect(malformed.json()).toEqual({ ok: true, ignored: "malformed_envelope" });
    expect(malformed.headers["x-slack-no-retry"]).toBeUndefined();
  });

  it("answers 4xx with x-slack-no-retry only for signature and routing rejections", async () => {
    const unroutable = createServices();
    unroutable.imBindings.findSlackIngressBinding.mockResolvedValue(undefined);
    const envelope = {
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: "Ev1",
      event: { type: "app_mention" },
    };
    const missing = await unroutable.app.inject(signedRequest(envelope));
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["x-slack-no-retry"]).toBe("1");

    const invalid = createServices();
    const badSignature = await invalid.app.inject(signedRequest(envelope, "wrong-secret"));
    expect(badSignature.statusCode).toBe(401);
    expect(badSignature.headers["x-slack-no-retry"]).toBe("1");
    expect(invalid.inbox.ingest).not.toHaveBeenCalled();

    const mismatched = createServices();
    mismatched.imBindings.findSlackIngressBinding.mockResolvedValue({ ...binding(), teamId: "T2" });
    const mismatch = await mismatched.app.inject(signedRequest(envelope));
    expect(mismatch.statusCode).toBe(401);
    expect(mismatch.json()).toEqual({ error: "binding_mismatch" });
    expect(mismatch.headers["x-slack-no-retry"]).toBe("1");

    const agentRoute = createServices({ setup: { verifyChallenge: vi.fn(), tryActivateFromEvent: vi.fn() } });
    const invalidRoute = await agentRoute.app.inject({
      ...signedRequest({ type: "event_callback", event_id: "Ev1", event: { type: "app_mention" } }),
      url: "/api/v1/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/im-binding/slack/events",
    });
    expect(invalidRoute.statusCode).toBe(400);
    expect(invalidRoute.json()).toEqual({ error: "invalid_route" });
    expect(invalidRoute.headers["x-slack-no-retry"]).toBe("1");
  });

  it("acknowledges envelopes and events OpenTag does not process with 200 instead of burning Slack's failure budget", async () => {
    const { app, adapter, inbox, createAdapter } = createServices();
    const base = { api_app_id: "A1", team_id: "T1" };

    const unknownEnvelope = await app.inject(signedRequest({ ...base, type: "some_future_envelope" }));
    expect(unknownEnvelope.statusCode).toBe(200);
    expect(unknownEnvelope.json()).toEqual({ ok: true, ignored: "unsupported_envelope" });
    expect(unknownEnvelope.headers["x-slack-no-retry"]).toBeUndefined();
    expect(createAdapter).not.toHaveBeenCalled();

    adapter.classifyInbound.mockReturnValueOnce({
      accepted: false,
      reason: "unsupported_event",
      eventType: "app_home_opened",
      subtype: undefined,
    });
    const unsupportedEvent = await app.inject(
      signedRequest({
        ...base,
        type: "event_callback",
        event_id: "Ev-home",
        event: { type: "app_home_opened", user: "U2", tab: "messages" },
      }),
    );
    expect(unsupportedEvent.statusCode).toBe(200);
    expect(unsupportedEvent.json()).toEqual({ ok: true, ignored: "unsupported_event" });

    adapter.classifyInbound.mockReturnValueOnce({
      accepted: false,
      reason: "ignored_subtype",
      eventType: "message",
      subtype: "channel_join",
    });
    const ignoredSubtype = await app.inject(
      signedRequest({
        ...base,
        type: "event_callback",
        event_id: "Ev-join",
        event: { type: "message", subtype: "channel_join", channel: "C1", ts: "1.0" },
      }),
    );
    expect(ignoredSubtype.statusCode).toBe(200);
    expect(ignoredSubtype.json()).toEqual({ ok: true, ignored: "ignored_subtype" });
    expect(adapter.normalizeInbound).not.toHaveBeenCalled();
    expect(inbox.ingest).not.toHaveBeenCalled();
  });

  it("acknowledges app_rate_limited without ingesting and records it for operators", async () => {
    const capture = captureLogs();
    const { app, inbox, createAdapter, current } = createServices({}, capture.stream);
    const response = await app.inject(
      signedRequest({
        type: "app_rate_limited",
        token: "verification-token",
        team_id: "T1",
        minute_rate_limited: 1_724_025_600,
        api_app_id: "A1",
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ignored: "app_rate_limited" });
    expect(response.headers["x-slack-no-retry"]).toBeUndefined();
    expect(createAdapter).not.toHaveBeenCalled();
    expect(inbox.ingest).not.toHaveBeenCalled();
    expect(capture.logs()).toContain("SLACK_APP_RATE_LIMITED");
    expect(capture.logs()).toContain(current.imBindingId);
    expect(capture.logs()).not.toContain("verification-token");
  });

  it("passes Slack retry metadata into ingest and keeps retries eligible on transient failures", async () => {
    const { app, adapter, inbox, current } = createServices();
    adapter.normalizeInbound.mockReturnValue([{ providerEventId: "Ev-retry" }]);
    const envelope = {
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: "Ev-retry",
      event: { type: "app_mention", channel: "C1", text: "hi", ts: "1.0" },
    };
    const retried = await app.inject(
      signedRequest(envelope, undefined, { "x-slack-retry-num": "2", "x-slack-retry-reason": "http_timeout" }),
    );
    expect(retried.statusCode).toBe(200);
    expect(inbox.ingest).toHaveBeenLastCalledWith(
      current.imBindingId,
      current.generation,
      { providerEventId: "Ev-retry" },
      undefined,
      { provider: "slack", retry: { num: 2, reason: "http_timeout" } },
    );

    inbox.ingest.mockRejectedValueOnce(new Error("database unavailable"));
    const failed = await app.inject(
      signedRequest(envelope, undefined, { "x-slack-retry-num": "3", "x-slack-retry-reason": "http_error" }),
    );
    expect(failed.statusCode).toBe(500);
    expect(failed.headers["x-slack-no-retry"]).toBeUndefined();
  });

  it("disables an uninstalled binding and fences Slack token revocation", async () => {
    const { app, imBindings, current } = createServices();
    const base = { type: "event_callback", api_app_id: "A1", team_id: "T1", event_id: "Ev1" };

    await expect(app.inject(signedRequest({ ...base, event: { type: "app_uninstalled" } }))).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(imBindings.disableFromProvider).toHaveBeenCalledWith(current.imBindingId);

    await app.inject(
      signedRequest({ ...base, event_id: "Ev2", event: { type: "tokens_revoked", tokens: { bot: ["OTHER"] } } }),
    );
    expect(imBindings.requireReauthorization).not.toHaveBeenCalled();

    await app.inject(
      signedRequest({
        ...base,
        event_id: "Ev3",
        event: { type: "tokens_revoked", tokens: { oauth: ["U_OTHER"], bot: [current.botUserId] } },
      }),
    );
    expect(imBindings.requireReauthorization).toHaveBeenCalledWith(current.imBindingId, "SLACK_TOKEN_REVOKED");
  });

  it("ingests every normalized event with the verified binding generation", async () => {
    const { app, adapter, inbox, createAdapter, current } = createServices();
    const events = [{ providerEventId: "Ev1:1" }, { providerEventId: "Ev1:2" }];
    adapter.normalizeInbound.mockReturnValue(events);
    const envelope = {
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: "Ev1",
      event_time: 1_724_025_600,
      event: { type: "app_mention", channel: "C1", text: "hello" },
    };

    const response = await app.inject(signedRequest(envelope));

    expect(response.statusCode).toBe(200);
    expect(createAdapter).toHaveBeenCalledWith(current);
    expect(adapter.normalizeInbound).toHaveBeenCalledWith({
      eventId: "Ev1",
      appId: current.appId,
      teamId: current.teamId,
      botUserId: current.botUserId,
      botId: current.botId,
      event: envelope.event,
      eventTime: envelope.event_time,
    });
    expect(inbox.ingest.mock.calls).toEqual([
      [current.imBindingId, current.generation, events[0], undefined, { provider: "slack" }],
      [current.imBindingId, current.generation, events[1], undefined, { provider: "slack" }],
    ]);
  });

  it.each(["adapter factory", "normalization", "inbox ingestion"])(
    "does not expose credentials or raw provider failures from %s",
    async (failurePoint) => {
      let logs = "";
      const loggerStream = new Writable({
        write(chunk, _encoding, callback) {
          logs += chunk.toString();
          callback();
        },
      });
      const { app, adapter, createAdapter, inbox } = createServices({}, loggerStream);
      const failure = new Error("raw-provider-error xoxb-sensitive signing-sensitive");
      if (failurePoint === "adapter factory")
        createAdapter.mockImplementation(() => {
          throw failure;
        });
      if (failurePoint === "normalization")
        adapter.normalizeInbound.mockImplementation(() => {
          throw failure;
        });
      if (failurePoint === "inbox ingestion") {
        adapter.normalizeInbound.mockReturnValue([{ providerEventId: "Ev1" }]);
        inbox.ingest.mockRejectedValue(failure);
      }
      const response = await app.inject(
        signedRequest({
          type: "event_callback",
          api_app_id: "A1",
          team_id: "T1",
          event_id: "Ev1",
          event: { type: "app_mention", text: "raw-request-body-detail" },
        }),
      );

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR", category: "transient" } });
      expect(response.body).not.toContain("raw-provider-error");
      expect(response.body).not.toContain("xoxb-sensitive");
      expect(response.body).not.toContain("signing-sensitive");
      expect(response.body).not.toContain("raw-request-body-detail");
      expect(logs).toContain("SLACK_EVENT_PROCESSING_FAILED");
      expect(logs).not.toContain("raw-provider-error");
      expect(logs).not.toContain("xoxb-sensitive");
      expect(logs).not.toContain("signing-sensitive");
      expect(logs).not.toContain("raw-request-body-detail");
    },
  );
});
