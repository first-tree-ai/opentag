import { agentSlackAutoSetupPath, agentSlackConfigurationPath } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import { type SlackConfigurationService, SlackConfigurationServiceError } from "../services/im-bindings/slack/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const bindingId = "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0";
const authorization = { authorization: "Bearer test-access" };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const logs: string[] = [];
  const service = {
    view: vi.fn().mockResolvedValue({
      agentDisplayName: "Agent",
      eventsUrl: "https://opentag.example/events",
      allowedIntent: "create",
      blockedReason: null,
      expectedMessaging: { kind: "unbound" },
      preferredRecovery: "credentials",
      binding: null,
      identityClosure: null,
      handoff: null,
    }),
    configureToken: vi.fn().mockResolvedValue({
      agentId,
      imBindingId: bindingId,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      credentialGeneration: 1,
      bindingState: "active",
      identityClosure: { status: "pending", verifiedAt: null },
    }),
  };
  const authService = {
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: { user: { id: userId, email: "qa@example.com", displayName: "QA" }, setupCompletedAt: null },
    }),
  } as unknown as UserAuthService;
  const autoSetup = { run: vi.fn().mockResolvedValue({ status: "authorization_required", ticket: "ticket" }) };
  const app = createApp({
    authService,
    slackConfiguration: {
      service: service as unknown as SlackConfigurationService,
      autoSetup,
      publicOrigin: "https://opentag.example",
    },
    loggerStream: {
      write(chunk: string) {
        logs.push(chunk);
      },
    },
  });
  apps.push(app);
  return { app, service, logs, autoSetup };
}

describe("Slack configuration HTTP boundary", () => {
  it.each(["GET", "POST"] as const)("requires authentication for %s", async (method) => {
    const { app, service } = fixture();
    const response = await app.inject({ method, url: agentSlackConfigurationPath(agentId) });
    expect(response.statusCode).toBe(401);
    expect(service.view).not.toHaveBeenCalled();
    expect(service.configureToken).not.toHaveBeenCalled();
  });

  it("works without official OAuth and uses the authenticated manager identity", async () => {
    const { app, service } = fixture();
    const response = await app.inject({
      method: "GET",
      url: agentSlackConfigurationPath(agentId),
      headers: authorization,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ allowedIntent: "create", expectedMessaging: { kind: "unbound" } });
    expect(service.view).toHaveBeenCalledWith(userId, agentId, "https://opentag.example", undefined);
  });

  it("passes a single validated create request without returning credentials", async () => {
    const { app, service } = fixture();
    const input = {
      intent: "create",
      expectedMessaging: { kind: "unbound" },
      botAccessToken: "test-token-private",
      signingSecret: "test-secret-private",
    };
    const response = await app.inject({
      method: "POST",
      url: agentSlackConfigurationPath(agentId),
      headers: authorization,
      payload: input,
    });
    expect(response.statusCode).toBe(200);
    expect(service.configureToken).toHaveBeenCalledExactlyOnceWith(userId, agentId, input);
    expect(response.body).not.toContain("private");
  });

  it("rejects unknown policy/provenance fields without leaking credential values in logs", async () => {
    const { app, service, logs } = fixture();
    const response = await app.inject({
      method: "POST",
      url: agentSlackConfigurationPath(agentId),
      headers: authorization,
      payload: {
        intent: "create",
        expectedMessaging: { kind: "unbound" },
        botAccessToken: "private-token-DO-NOT-LOG",
        signingSecret: "private-secret-DO-NOT-LOG",
        slack_bot_message_policy: "context_only",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.configureToken).not.toHaveBeenCalled();
    expect(response.body + logs.join("")).not.toContain("DO-NOT-LOG");
  });

  it("requires exact expectation and a changed field on partial update", async () => {
    const { app, service } = fixture();
    const response = await app.inject({
      method: "POST",
      url: agentSlackConfigurationPath(agentId),
      headers: authorization,
      payload: {
        intent: "reauthorize",
        expectedMessaging: { kind: "bound", provider: "slack", bindingId, credentialGeneration: 1 },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.configureToken).not.toHaveBeenCalled();
  });

  it("preserves structured identity/ownership conflict errors", async () => {
    const { app, service } = fixture();
    service.configureToken.mockRejectedValue(
      new SlackConfigurationServiceError("SLACK_BINDING_IDENTITY_MISMATCH", 409, "Use the original App", "credential"),
    );
    const response = await app.inject({
      method: "POST",
      url: agentSlackConfigurationPath(agentId),
      headers: authorization,
      payload: {
        intent: "create",
        expectedMessaging: { kind: "unbound" },
        botAccessToken: "test-token",
        signingSecret: "test-secret",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "SLACK_BINDING_IDENTITY_MISMATCH" } });
  });
});

it("authenticates the automatic route and rejects arbitrary commands or credentials", async () => {
  const { app, autoSetup } = fixture();
  const url = agentSlackAutoSetupPath(agentId);
  expect((await app.inject({ method: "POST", url, payload: { action: "authorize" } })).statusCode).toBe(401);
  expect(autoSetup.run).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        headers: authorization,
        payload: {
          action: "connect",
          challenge: "code",
          computerId: agentId,
          command: "anything",
          botAccessToken: "private",
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(autoSetup.run).not.toHaveBeenCalled();
  const response = await app.inject({ method: "POST", url, headers: authorization, payload: { action: "authorize" } });
  expect(response.json()).toEqual({ status: "authorization_required", ticket: "ticket" });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(autoSetup.run).toHaveBeenCalledExactlyOnceWith(userId, agentId, { action: "authorize" });
});
