import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const now = new Date("2026-08-20T00:00:00.000Z");
const timestamp = String(Math.floor(now.getTime() / 1000));
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function installation() {
  return {
    installationId: "8f2c1b0a-4d3e-4c5b-9a76-1e2f3a4b5c6d",
    generation: 5,
    workspaceId: "2c4e6a80-1111-2222-3333-444455556666",
    appId: "A1",
    teamId: "T1",
    botUserId: "U_BOT",
    botId: "B_BOT",
    botAccessToken: "xoxb-sensitive",
    signingSecret: "signing-sensitive",
  };
}

function defaultRoute() {
  return {
    imBindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
    agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
    installationId: installation().installationId,
    generation: 5,
    routeKind: "default" as const,
  };
}

function signedRequest(envelope: Record<string, unknown>, signingSecret = installation().signingSecret) {
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
    },
  };
}

function matchingBotAuthorization() {
  return [{ team_id: installation().teamId, user_id: installation().botUserId, is_bot: true }];
}

function createServices(overrides: Record<string, unknown> = {}, loggerStream?: Writable) {
  const current = installation();
  const routed = defaultRoute();
  const imBindings = {
    findSlackInstallationIngress: vi.fn().mockResolvedValue(current),
    findSlackInstallationIngressForAgent: vi.fn().mockResolvedValue(current),
    resolveSlackDefaultRoute: vi.fn().mockResolvedValue(routed),
    recordSlackInstallationObservation: vi.fn().mockResolvedValue(true),
    recordSlackInstallationIdentityClosure: vi.fn().mockResolvedValue(true),
    disableSlackInstallationFromProvider: vi.fn().mockResolvedValue(true),
    requireSlackInstallationReauthorization: vi.fn().mockResolvedValue(true),
  };
  const inbox = { ingest: vi.fn().mockResolvedValue(undefined) };
  const adapter = { normalizeInbound: vi.fn().mockReturnValue([]) };
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
  it("verifies the Agent Events URL signature before parsing JSON", async () => {
    const { app, imBindings } = createServices();
    const agentEventsUrl = "/api/v1/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/im-binding/slack/events";
    const payload = "{not-json";
    const invalidSignature = await app.inject({
      method: "POST",
      url: agentEventsUrl,
      payload,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(invalidSignature.statusCode).toBe(401);
    expect(invalidSignature.json()).toEqual({ error: "invalid_signature" });
    expect(imBindings.findSlackInstallationIngressForAgent).toHaveBeenCalled();

    const signature = `v0=${createHmac("sha256", installation().signingSecret).update(`v0:${timestamp}:${payload}`).digest("hex")}`;
    const verifiedInvalidJson = await app.inject({
      method: "POST",
      url: agentEventsUrl,
      payload,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });
    expect(verifiedInvalidJson.statusCode).toBe(400);
    expect(verifiedInvalidJson.json()).toEqual({ error: "invalid_json" });
  });

  it("uses the Agent Events URL only for signed runtime observation and delivery", async () => {
    const { app, adapter, imBindings } = createServices();
    const agentEventsUrl = "/api/v1/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/im-binding/slack/events";
    const challenge = await app.inject({
      ...signedRequest({
        type: "url_verification",
        challenge: "challenge-ok",
      }),
      url: agentEventsUrl,
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toEqual({ challenge: "challenge-ok" });
    expect(imBindings.recordSlackInstallationObservation).toHaveBeenCalledWith(
      installation().installationId,
      installation().generation,
    );

    const event = {
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      authorizations: matchingBotAuthorization(),
      event_id: "Ev-runtime",
      event: { type: "app_mention", channel: "C1", text: "<@U_BOT> test", ts: "1.0" },
    };
    const delivered = await app.inject({ ...signedRequest(event), url: agentEventsUrl });
    expect(delivered.statusCode).toBe(200);
    expect(adapter.normalizeInbound).toHaveBeenCalled();
    expect(imBindings.recordSlackInstallationIdentityClosure).toHaveBeenCalledWith(
      installation().installationId,
      installation().generation,
    );
  });

  it("requires an active binding and its Signing Secret for the identity-less URL challenge", async () => {
    const agentEventsUrl = "/api/v1/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/im-binding/slack/events";
    const missing = createServices();
    missing.imBindings.findSlackInstallationIngressForAgent.mockResolvedValue(undefined);
    const payload = { type: "url_verification", challenge: "challenge-ok" };
    expect((await missing.app.inject({ ...signedRequest(payload), url: agentEventsUrl })).statusCode).toBe(404);

    const invalid = createServices();
    const response = await invalid.app.inject({ ...signedRequest(payload, "wrong-secret"), url: agentEventsUrl });
    expect(response.statusCode).toBe(401);
    expect(invalid.imBindings.recordSlackInstallationObservation).not.toHaveBeenCalled();
  });

  it("verifies identity-less URL challenges for the first-party Slack App signing secret", async () => {
    const { app, imBindings } = createServices({}, undefined);
    const payload = { type: "url_verification", challenge: "first-party-challenge" };
    const unsigned = await app.inject({
      method: "POST",
      url: "/api/v1/im-bindings/slack/events",
      payload: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(unsigned.statusCode).toBe(400);
    expect(unsigned.json()).toEqual({ error: "invalid_route" });

    const firstParty = createApp({
      slackEvents: {
        now: () => now,
        firstPartySigningSecret: "first-party-signing",
        imBindings: imBindings as never,
        inbox: { ingest: vi.fn() } as never,
        createAdapter: vi.fn() as never,
      },
    });
    apps.push(firstParty);
    const malformed = "not-json";
    const malformedSignature = `v0=${createHmac("sha256", "first-party-signing").update(`v0:${timestamp}:${malformed}`).digest("hex")}`;
    const malformedResponse = await firstParty.inject({
      method: "POST",
      url: "/api/v1/im-bindings/slack/events",
      payload: malformed,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": malformedSignature,
      },
    });
    expect(malformedResponse.statusCode).toBe(400);
    expect(malformedResponse.json()).toEqual({ error: "invalid_route" });
    const invalid = await firstParty.inject(signedRequest(payload, "wrong-secret"));
    expect(invalid.statusCode).toBe(401);
    const verified = await firstParty.inject(signedRequest(payload, "first-party-signing"));
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ challenge: "first-party-challenge" });
    expect(imBindings.recordSlackInstallationObservation).not.toHaveBeenCalled();
    expect(imBindings.findSlackInstallationIngress).not.toHaveBeenCalled();
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
    expect(imBindings.findSlackInstallationIngress).not.toHaveBeenCalled();
  });

  it("rejects missing bindings, invalid signatures, and mismatched verified identities", async () => {
    const missing = createServices();
    missing.imBindings.findSlackInstallationIngress.mockResolvedValue(undefined);
    const envelope = { type: "url_verification", api_app_id: "A1", team_id: "T1", challenge: "ok" };
    const missingResponse = await missing.app.inject(signedRequest(envelope));
    expect(missingResponse.statusCode).toBe(404);

    const invalid = createServices();
    const invalidResponse = await invalid.app.inject(signedRequest(envelope, "wrong-secret"));
    expect(invalidResponse.statusCode).toBe(401);
    expect(invalidResponse.json()).toEqual({ error: "invalid_signature" });

    const mismatched = createServices();
    mismatched.imBindings.findSlackInstallationIngress.mockResolvedValue({ ...installation(), appId: "A2" });
    const mismatchResponse = await mismatched.app.inject(signedRequest(envelope));
    expect(mismatchResponse.statusCode).toBe(401);
    expect(mismatchResponse.json()).toEqual({ error: "binding_mismatch" });

    const agentMismatch = createServices();
    const agentMismatchResponse = await agentMismatch.app.inject({
      ...signedRequest({
        type: "event_callback",
        api_app_id: "A2",
        team_id: "T1",
        event_id: "Ev-agent-mismatch",
        event: { type: "app_mention" },
      }),
      url: "/api/v1/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/im-binding/slack/events",
    });
    expect(agentMismatchResponse.statusCode).toBe(401);
    expect(agentMismatchResponse.json()).toEqual({ error: "binding_mismatch" });
  });

  it("validates URL verification and event callback envelope fields", async () => {
    const { app } = createServices();
    const invalidChallenge = await app.inject(
      signedRequest({ type: "url_verification", api_app_id: "A1", team_id: "T1" }),
    );
    expect(invalidChallenge.statusCode).toBe(400);
    expect(invalidChallenge.json()).toEqual({ error: "invalid_challenge" });

    const unsupported = await app.inject(
      signedRequest({ type: "event_callback", api_app_id: "A1", team_id: "T1", event_id: "Ev1" }),
    );
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toEqual({ error: "unsupported_envelope" });
  });

  it.each([
    ["missing", undefined],
    ["human", [{ team_id: "T1", user_id: "U_BOT", is_bot: false }]],
    ["wrong Team", [{ team_id: "T2", user_id: "U_BOT", is_bot: true }]],
    ["wrong Bot User", [{ team_id: "T1", user_id: "U_OTHER", is_bot: true }]],
  ])("rejects %s authorizations before ordinary event side effects", async (_label, authorizations) => {
    const { app, imBindings, inbox, createAdapter } = createServices();
    const response = await app.inject(
      signedRequest({
        type: "event_callback",
        api_app_id: "A1",
        team_id: "T1",
        ...(authorizations ? { authorizations } : {}),
        event_id: "Ev-auth",
        event: { type: "app_mention", channel: "C1", text: "hello" },
      }),
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "binding_mismatch" });
    expect(imBindings.recordSlackInstallationIdentityClosure).not.toHaveBeenCalled();
    expect(imBindings.recordSlackInstallationObservation).not.toHaveBeenCalled();
    expect(imBindings.disableSlackInstallationFromProvider).not.toHaveBeenCalled();
    expect(imBindings.requireSlackInstallationReauthorization).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
    expect(inbox.ingest).not.toHaveBeenCalled();
  });

  it("acknowledges a stale generation without running event side effects", async () => {
    const { app, imBindings, inbox, createAdapter } = createServices();
    imBindings.recordSlackInstallationIdentityClosure.mockResolvedValue(false);
    const response = await app.inject(
      signedRequest({
        type: "event_callback",
        api_app_id: "A1",
        team_id: "T1",
        authorizations: matchingBotAuthorization(),
        event_id: "Ev-stale",
        event: { type: "app_mention", channel: "C1", text: "hello" },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(imBindings.recordSlackInstallationIdentityClosure).toHaveBeenCalledWith(
      installation().installationId,
      installation().generation,
    );
    expect(imBindings.disableSlackInstallationFromProvider).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
    expect(inbox.ingest).not.toHaveBeenCalled();
  });

  it("acknowledges verified events without delivery when no default Agent route exists", async () => {
    const { app, imBindings, inbox, createAdapter } = createServices();
    imBindings.resolveSlackDefaultRoute.mockResolvedValue(undefined);
    const response = await app.inject(
      signedRequest({
        type: "event_callback",
        api_app_id: "A1",
        team_id: "T1",
        authorizations: matchingBotAuthorization(),
        event_id: "Ev-unrouted",
        event: { type: "app_mention", channel: "C1", text: "hello" },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(imBindings.recordSlackInstallationIdentityClosure).toHaveBeenCalled();
    expect(imBindings.resolveSlackDefaultRoute).toHaveBeenCalledWith(installation().installationId);
    expect(createAdapter).not.toHaveBeenCalled();
    expect(inbox.ingest).not.toHaveBeenCalled();
  });

  it("disables an uninstalled binding and fences Slack token revocation", async () => {
    const { app, imBindings, createAdapter, current } = createServices();
    const base = {
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: "Ev1",
    };
    const appUninstalled = {
      ...base,
      authorizations: [{ team_id: "T1", user_id: "U_INSTALLER", is_bot: false, is_enterprise_install: false }],
      event: { type: "app_uninstalled" },
    };

    const invalidSignature = await app.inject(signedRequest(appUninstalled, "wrong-secret"));
    expect(invalidSignature.statusCode).toBe(401);
    const mismatchedIdentity = await app.inject(signedRequest({ ...appUninstalled, api_app_id: "A_OTHER" }));
    expect(mismatchedIdentity.statusCode).toBe(401);
    expect(imBindings.disableSlackInstallationFromProvider).not.toHaveBeenCalled();

    await expect(app.inject(signedRequest(appUninstalled))).resolves.toMatchObject({ statusCode: 200 });
    expect(imBindings.disableSlackInstallationFromProvider).toHaveBeenCalledWith(
      current.installationId,
      current.generation,
    );

    await app.inject(
      signedRequest({ ...base, event_id: "Ev2", event: { type: "tokens_revoked", tokens: { bot: ["OTHER"] } } }),
    );
    expect(imBindings.requireSlackInstallationReauthorization).not.toHaveBeenCalled();
    await app.inject(
      signedRequest({
        ...base,
        event_id: "Ev2-bot-id",
        event: { type: "tokens_revoked", tokens: { oauth: ["U_OTHER"], bot: [current.botId] } },
      }),
    );
    expect(imBindings.requireSlackInstallationReauthorization).not.toHaveBeenCalled();

    await app.inject(
      signedRequest({
        ...base,
        event_id: "Ev3",
        event: { type: "tokens_revoked", tokens: { oauth: ["U_OTHER"], bot: [current.botUserId] } },
      }),
    );
    expect(imBindings.requireSlackInstallationReauthorization).toHaveBeenCalledWith(
      current.installationId,
      current.generation,
      "SLACK_TOKEN_REVOKED",
    );
    expect(imBindings.recordSlackInstallationIdentityClosure).not.toHaveBeenCalled();
    expect(imBindings.recordSlackInstallationObservation).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("ingests every normalized event with the verified binding generation", async () => {
    const { app, adapter, inbox, createAdapter, current } = createServices();
    const events = [{ providerEventId: "Ev1:1" }, { providerEventId: "Ev1:2" }];
    adapter.normalizeInbound.mockReturnValue(events);
    const envelope = {
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      authorizations: matchingBotAuthorization(),
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
      [defaultRoute().imBindingId, current.generation, events[0], undefined, { provider: "slack" }],
      [defaultRoute().imBindingId, current.generation, events[1], undefined, { provider: "slack" }],
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
          authorizations: matchingBotAuthorization(),
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

  it("claims a durable receipt before acknowledging and records asynchronous failures", async () => {
    const receipts = {
      claim: vi.fn().mockResolvedValue({ accepted: true, duplicate: false, receiptId: "receipt-1" }),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const { app, inbox, adapter } = createServices({ receipts: receipts as never });
    inbox.ingest.mockRejectedValue(new Error("provider processing failed"));
    adapter.normalizeInbound.mockReturnValue([{ providerEventId: "Ev-async-failure" }]);
    const response = await app.inject(
      signedRequest({
        type: "event_callback",
        api_app_id: "A1",
        team_id: "T1",
        authorizations: matchingBotAuthorization(),
        event_id: "Ev-async-failure",
        event: { type: "app_mention", channel: "C1", text: "hello" },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(receipts.claim).toHaveBeenCalledWith({
      installationId: installation().installationId,
      credentialGeneration: installation().generation,
      eventId: "Ev-async-failure",
    });
    await vi.waitFor(() =>
      expect(receipts.markFailed).toHaveBeenCalledWith("receipt-1", "SLACK_EVENT_PROCESSING_FAILED"),
    );
  });

  it("acknowledges duplicate receipts without normalizing or ingesting again", async () => {
    const receipts = {
      claim: vi.fn().mockResolvedValue({
        accepted: false,
        duplicate: true,
        receiptId: "receipt-existing",
        status: "processed",
      }),
      markProcessed: vi.fn(),
      markFailed: vi.fn(),
    };
    const { app, inbox, createAdapter } = createServices({ receipts: receipts as never });
    const response = await app.inject(
      signedRequest({
        type: "event_callback",
        api_app_id: "A1",
        team_id: "T1",
        authorizations: matchingBotAuthorization(),
        event_id: "Ev-duplicate",
        event: { type: "app_mention", channel: "C1", text: "hello" },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(createAdapter).not.toHaveBeenCalled();
    expect(inbox.ingest).not.toHaveBeenCalled();
  });
});
