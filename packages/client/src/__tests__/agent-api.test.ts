import { describe, expect, it, vi } from "vitest";
import { OpenTagApi, OpenTagApiError } from "../api.js";

const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const createdByUserId = "bfcdab09-b57a-44ac-a170-09f7c3af20df";
const creationIntentId = "a3adbe5e-8e8e-4ac2-a013-b026684ab185";
const agent = {
  id: agentId,
  workspaceId,
  createdByUserId,
  computerId,
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex",
  receiveMode: "all_message",
  status: "active",
  revision: 1,
  runtimeConfig: {
    revision: 1,
    model: null,
    reasoningEffort: null,
    instructions: "Follow instructions.",
    maxDurationMs: null,
  },
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};
const {
  runtimeConfig: _runtimeConfig,
  revision: _revision,
  createdByUserId: safeCreatedByUserId,
  computerId: safeComputerId,
  ...agentBase
} = agent;
const agentSummary = {
  ...agentBase,
  createdBy: { userId: safeCreatedByUserId, displayName: "Creator" },
  computer: {
    computerId: safeComputerId,
    displayName: "Laptop",
    platform: "linux",
  },
};
const agentListItem = {
  ...agentSummary,
  activity: { state: "idle" },
  usage: { windowDays: 30, tasks: 12, failed: 1, tokens: 42_000 },
};
const agentDetail = { ...agentSummary, activity: { state: "idle" } };
const agentUsage = {
  windowDays: 30,
  startedAt: "2026-07-25T12:00:00.000Z",
  endedAt: "2026-08-24T12:00:00.000Z",
  tasks: 2,
  measuredTasks: 1,
  failed: 0,
  inputTokens: 10,
  cachedInputTokens: 2,
  outputTokens: 4,
  tokens: 14,
  daily: [
    {
      date: "2026-08-24",
      tasks: 2,
      measuredTasks: 1,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      tokens: 14,
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenTagApi Agent methods", () => {
  it("uses shared Agent paths, methods, bearer auth, and bodies", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(agent, 201))
      .mockResolvedValueOnce(jsonResponse({ agents: [agentListItem] }))
      .mockResolvedValueOnce(jsonResponse(agentDetail))
      .mockResolvedValueOnce(jsonResponse(agentUsage))
      .mockResolvedValueOnce(jsonResponse(agent))
      .mockResolvedValueOnce(jsonResponse({ ...agent, displayName: "Reviewer", revision: 2 }))
      .mockResolvedValueOnce(jsonResponse({ ...agent, status: "suspended", revision: 2 }))
      .mockResolvedValueOnce(jsonResponse({ ...agent, revision: 3 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new OpenTagApi("https://opentag.example", fetchImpl);

    await api.createAgent("access", {
      creationIntentId,
      computerId,
      displayName: "Code Reviewer",
      name: "code-reviewer",
      runtimeProvider: "codex",
      runtimeConfig: { instructions: "Custom instructions", maxDurationMs: 60_000 },
    });
    await api.listAgents("access");
    await api.getAgent("access", agentId);
    await api.getAgentUsage("access", agentId, 30);
    await api.getAgentConfig("access", agentId);
    await api.updateAgent("access", agentId, {
      displayName: "Reviewer",
      expectedRevision: 1,
      runtimeConfig: { model: null, reasoningEffort: "high" },
    });
    await api.suspendAgent("access", agentId);
    await api.reactivateAgent("access", agentId);
    await api.deleteAgent("access", agentId);

    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      ["https://opentag.example/api/v1/agents", "POST"],
      ["https://opentag.example/api/v1/agents", "GET"],
      [`https://opentag.example/api/v1/agents/${agentId}`, "GET"],
      [`https://opentag.example/api/v1/agents/${agentId}/usage?days=30`, "GET"],
      [`https://opentag.example/api/v1/agents/${agentId}/config`, "GET"],
      [`https://opentag.example/api/v1/agents/${agentId}`, "PATCH"],
      [`https://opentag.example/api/v1/agents/${agentId}/suspend`, "POST"],
      [`https://opentag.example/api/v1/agents/${agentId}/reactivate`, "POST"],
      [`https://opentag.example/api/v1/agents/${agentId}`, "DELETE"],
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
    }
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      creationIntentId,
      computerId,
      displayName: "Code Reviewer",
      name: "code-reviewer",
      runtimeProvider: "codex",
      runtimeConfig: { instructions: "Custom instructions", maxDurationMs: 60_000 },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[5]?.[1]?.body))).toEqual({
      displayName: "Reviewer",
      expectedRevision: 1,
      runtimeConfig: { model: null, reasoningEffort: "high" },
    });
  });

  it("preserves typed Agent errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "AGENT_REVISION_CONFLICT",
            category: "deterministic",
            message: "The Agent changed since it was read",
          },
        },
        409,
      ),
    );
    const api = new OpenTagApi("https://opentag.example", fetchImpl);
    const error = await api
      .updateAgent("access", agentId, { displayName: "Reviewer", expectedRevision: 1 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenTagApiError);
    expect(error).toMatchObject({ code: "AGENT_REVISION_CONFLICT", status: 409 });
  });

  it("preserves validated request issues without trusting malformed envelopes", async () => {
    const issue = { path: ["name"], code: "invalid_format", message: "Use a lowercase Agent name" };
    const typedApi = new OpenTagApi(
      "https://opentag.example",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "VALIDATION_ERROR",
              category: "validation",
              message: "The request payload is invalid",
              issues: [issue],
            },
          },
          400,
        ),
      ),
    );
    await expect(
      typedApi.createAgent("access", {
        computerId,
        displayName: "Bestony",
        name: "Bestony",
        runtimeProvider: "codex",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400, issues: [issue] });

    const malformedApi = new OpenTagApi(
      "https://opentag.example",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "VALIDATION_ERROR",
              category: "validation",
              message: "Do not trust this",
              issues: [{ ...issue, input: "secret" }],
            },
          },
          400,
        ),
      ),
    );
    await expect(
      malformedApi.createAgent("access", {
        computerId,
        displayName: "Bestony",
        name: "Bestony",
        runtimeProvider: "codex",
      }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN", status: 400, message: "Authentication failed" });
  });

  it("rejects an invalid success response", async () => {
    const api = new OpenTagApi("https://opentag.example", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({})));
    await expect(api.getAgent("access", agentId)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      category: "transient",
    });
  });

  it("uses typed ImBinding setup, diagnostics, and disable contracts", async () => {
    const imBindingId = "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0";
    const attemptId = "f645f26d-9184-4f2f-98a1-4ee83ae6a603";
    const attempt = {
      id: attemptId,
      agentId,
      intent: "create",
      state: "awaiting_user",
      qrUrl: "https://open.feishu.cn/qr/example",
      expiresAt: "2026-08-19T01:00:00.000Z",
      errorCode: null,
      completedAt: null,
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(attempt, 201))
      .mockResolvedValueOnce(jsonResponse(attempt))
      .mockResolvedValueOnce(
        jsonResponse({
          imBindingId,
          provider: "feishu",
          ready: false,
          agentRuntimeReadiness: "ready",
          providerCliReadiness: "install",
          credentialGeneration: 1,
          credentialStatus: "valid",
          requiredCapabilities: [],
          grantedCapabilities: [],
          missingCapabilities: [],
          reauthorizationRequired: false,
          slackAppId: null,
          slackIdentityClosure: null,
          connection: null,
          lastInboundAt: null,
          lastValidatedAt: null,
          lastRuntimeObservationAt: null,
          lastErrorCode: null,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new OpenTagApi("https://opentag.example", fetchImpl);
    await expect(api.getAgentImBinding("access", agentId)).resolves.toBeUndefined();
    await api.createFeishuSetupAttempt("access", agentId);
    await api.getFeishuSetupAttempt("access", attemptId);
    await api.getImBindingDiagnostics("access", imBindingId);
    await api.disableImBinding("access", imBindingId);
    expect(fetchImpl.mock.calls.map(([url, init]) => [new URL(url).pathname, init?.method ?? "GET"])).toEqual([
      [`/api/v1/agents/${agentId}/im-binding`, "GET"],
      [`/api/v1/agents/${agentId}/im-binding/feishu/setup-attempts`, "POST"],
      [`/api/v1/im-bindings/feishu/setup-attempts/${attemptId}`, "GET"],
      [`/api/v1/im-bindings/${imBindingId}/diagnostics`, "GET"],
      [`/api/v1/im-bindings/${imBindingId}/disable`, "POST"],
    ]);
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ intent: "create" }));
  });

  it("uses the stateless Slack guide and one atomic configuration write", async () => {
    const imBindingId = "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0";
    const requiredBotScopes = [
      "app_mentions:read",
      "channels:history",
      "chat:write",
      "files:read",
      "groups:history",
      "im:history",
      "mpim:history",
    ];
    const subscribedBotEvents = [
      "app_mention",
      "app_uninstalled",
      "message.channels",
      "message.groups",
      "message.im",
      "message.mpim",
      "tokens_revoked",
    ];
    const configuration = {
      agentId,
      manifest: {
        oauth_config: { scopes: { bot: requiredBotScopes } },
        settings: { event_subscriptions: { bot_events: subscribedBotEvents } },
      },
      manifestUrl: "https://api.slack.com/apps?new_app=1&manifest_json=example",
      eventsUrl: `https://opentag.example/api/v1/agents/${agentId}/im-binding/slack/events`,
      requiredBotScopes,
      subscribedBotEvents,
      currentBinding: null,
    };
    const detail = {
      id: imBindingId,
      agentId,
      provider: "slack",
      bindingState: "active",
      bot: { displayName: "Reviewer", avatarUrl: null },
      receiveMode: "mention_only",
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
      identity: {
        provider: "slack",
        appId: "A1",
        teamId: "T1",
        enterpriseId: null,
        botUserId: "U1",
        appIdEvidence: "configured",
      },
      credentialGeneration: 1,
      grantedCapabilities: requiredBotScopes,
      reauthorizationRequired: false,
      lastErrorCode: null,
    };
    const input = {
      intent: "create" as const,
      expectedBinding: null,
      appId: "A1",
      botAccessToken: "xoxb-secret",
      signingSecret: "signing-secret",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(configuration))
      .mockResolvedValueOnce(
        jsonResponse({
          imBindingId: detail.id,
          agentId,
          appId: "A1",
          teamId: "T1",
          botUserId: "U1",
          credentialGeneration: 1,
          bindingState: "active",
          identityClosure: { status: "pending", verifiedAt: null },
        }),
      );
    const api = new OpenTagApi("https://opentag.example", fetchImpl);

    await expect(api.getSlackAppConfiguration("access", agentId)).resolves.toEqual(configuration);
    await expect(api.configureSlackApp("access", agentId, input)).resolves.toMatchObject({
      imBindingId: detail.id,
      credentialGeneration: 1,
      identityClosure: { status: "pending", verifiedAt: null },
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => [new URL(url).pathname, init?.method ?? "GET"])).toEqual([
      [`/api/v1/agents/${agentId}/im-binding/slack/configuration`, "GET"],
      [`/api/v1/agents/${agentId}/im-binding/slack/configuration`, "PUT"],
    ]);
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(input));
  });
});
