import { agentSlackOAuthStartPath, SLACK_OAUTH_CALLBACK_PATH, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import { hashSecret } from "../services/auth/security.js";
import { SlackConfigurationServiceError } from "../services/im-bindings/slack/index.js";
import { SlackOAuthStateService } from "../services/im-bindings/slack/oauth-state.js";

const secret = "slack-oauth-state-secret-that-is-at-least-32-characters";
const now = new Date("2026-08-19T00:00:00.000Z");
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: "admin@example.com", displayName: "Admin" },
        workspaces: [],
      },
    }),
  };
}

describe("SlackOAuthStateService", () => {
  it("signs a one-time nonce bound to account, agent, intent, and expected generation", async () => {
    const service = new SlackOAuthStateService(secret, { now: () => now });
    const issued = await service.issue({
      userId,
      agentId,
      intent: "reauthorize",
      expectedBinding: { id: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0", credentialGeneration: 4 },
    });
    const payload = decodeJwt(issued.state);
    expect(payload).toMatchObject({
      userId,
      agentId,
      intent: "reauthorize",
      expectedBinding: { id: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0", credentialGeneration: 4 },
    });
    expect(payload).not.toHaveProperty("botAccessToken");
    expect(payload).not.toHaveProperty("signingSecret");
    expect(issued.nonceHash).toBe(hashSecret(String(payload.nonce)));
    expect(issued.payload.sessionBindingHash).toBe(hashSecret(issued.sessionBinding));
    await expect(service.verify(issued.state, issued.sessionBinding)).resolves.toMatchObject({
      userId,
      agentId,
      intent: "reauthorize",
    });
  });

  it("rejects cookie mismatch, expiry, and substitution", async () => {
    const service = new SlackOAuthStateService(secret, { now: () => now, ttlSeconds: 60 });
    const first = await service.issue({ userId, agentId, intent: "create", expectedBinding: null });
    const second = await service.issue({
      userId,
      agentId,
      intent: "reauthorize",
      expectedBinding: { id: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0", credentialGeneration: 1 },
    });
    await expect(service.verify(first.state, second.sessionBinding)).rejects.toMatchObject({
      code: "SLACK_OAUTH_FAILED",
    });
    await expect(service.verify(first.state, undefined)).rejects.toMatchObject({ code: "SLACK_OAUTH_FAILED" });
    const expired = new SlackOAuthStateService(secret, {
      now: () => new Date("2026-08-19T00:02:00.000Z"),
      ttlSeconds: 60,
    });
    await expect(expired.verify(first.state, first.sessionBinding)).rejects.toMatchObject({
      code: "SLACK_OAUTH_FAILED",
    });
  });
});

describe("Slack OAuth HTTP routes", () => {
  it("starts an authenticated install and keeps secrets out of the JSON body", async () => {
    const slackOAuth = {
      start: vi.fn().mockResolvedValue({
        authorizationUrl: `https://slack.com/oauth/v2/authorize?client_id=client&scope=${SLACK_REQUIRED_BOT_SCOPES.join(",")}&state=signed-state`,
        expiresAt: "2026-08-19T00:10:00.000Z",
        sessionBinding: "session-binding-secret",
      }),
      callback: vi.fn(),
    };
    const app = createApp({
      authService: authService(),
      slackOAuth: {
        authService: authService(),
        publicOrigin: "https://opentag.example.com",
        secureCookies: true,
        slackOAuth: slackOAuth as never,
      },
    });
    apps.push(app);

    const started = await app.inject({
      method: "POST",
      url: agentSlackOAuthStartPath(agentId),
      headers: { authorization: "Bearer access", "content-type": "application/json" },
      payload: { intent: "create" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({
      authorizationUrl: expect.stringContaining("https://slack.com/oauth/v2/authorize"),
      expiresAt: "2026-08-19T00:10:00.000Z",
    });
    expect(JSON.stringify(started.json())).not.toContain("session-binding-secret");
    expect(started.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("opentag_slack_oauth_context=")]),
    );
    expect(String(started.headers["set-cookie"])).toContain("HttpOnly");
    expect(slackOAuth.start).toHaveBeenCalledWith(userId, agentId, "create");
  });

  it("redirects public callback success and failures without exposing codes or state", async () => {
    const slackOAuth = {
      start: vi.fn(),
      callback: vi.fn().mockResolvedValueOnce({
        agentId,
        result: { imBindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0" },
      }),
    };
    const app = createApp({
      authService: authService(),
      slackOAuth: {
        authService: authService(),
        publicOrigin: "https://opentag.example.com",
        secureCookies: true,
        slackOAuth: slackOAuth as never,
      },
    });
    apps.push(app);

    const success = await app.inject({
      method: "GET",
      url: `${SLACK_OAUTH_CALLBACK_PATH}?code=slack-oauth-code&state=signed-state`,
      headers: { cookie: "opentag_access=access; opentag_slack_oauth_context=session-binding" },
    });
    expect(success.statusCode).toBe(302);
    expect(success.headers.location).toBe(
      `https://opentag.example.com/agents/${agentId}/settings/messaging?slack_oauth=success`,
    );
    expect(JSON.stringify(success.headers)).not.toContain("slack-oauth-code");
    expect(slackOAuth.callback).toHaveBeenCalledWith({
      // The route resolves the identity now, so a browser holding either credential reaches the same call.
      authenticatedUserId: userId,
      code: "slack-oauth-code",
      sessionBinding: "session-binding",
      state: "signed-state",
    });

    slackOAuth.callback.mockRejectedValueOnce(
      Object.assign(new SlackConfigurationServiceError("SLACK_APP_TEAM_ALREADY_BOUND", 409, "bound"), {
        slackOAuthAgentId: agentId,
      }),
    );
    const conflict = await app.inject({
      method: "GET",
      url: `${SLACK_OAUTH_CALLBACK_PATH}?code=slack-oauth-code&state=signed-state`,
      headers: { cookie: "opentag_access=access; opentag_slack_oauth_context=session-binding" },
    });
    expect(conflict.statusCode).toBe(302);
    expect(conflict.headers.location).toBe(
      `https://opentag.example.com/agents/${agentId}/settings/messaging?slack_oauth_error=SLACK_APP_TEAM_ALREADY_BOUND`,
    );
    expect(JSON.stringify(conflict.headers)).not.toContain("slack-oauth-code");
  });
});
