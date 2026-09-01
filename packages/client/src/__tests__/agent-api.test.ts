import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OpenTagApi, OpenTagApiError } from "../api.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const createdByUserId = "bfcdab09-b57a-44ac-a170-09f7c3af20df";
const creationIntentId = "a3adbe5e-8e8e-4ac2-a013-b026684ab185";
const agent = {
  id: agentId,
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
  it("covers computer, session, optional binding, and resource API surfaces", async () => {
    const installationId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
    const computerId = "9fd8c3db-9fb6-4e0b-8ca9-f0f830c4a1a5";
    const sessionId = "d8e7b4dc-e6f7-4c84-a63b-4f4a39ccfdb9";
    const attempt = {
      id: "f645f26d-9184-4f2f-98a1-4ee83ae6a603",
      agentId,
      intent: "create",
      state: "awaiting_user",
      qrUrl: null,
      expiresAt: "2026-08-19T01:00:00.000Z",
      errorCode: null,
      completedAt: null,
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    const token = { accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", expiresIn: 3_600 };
    const me = {
      user: { id: createdByUserId, email: "user@example.com", displayName: "User" },
      setupCompletedAt: null,
    };
    const computers = {
      computers: [
        {
          computerId,
          displayName: "Laptop",
          platform: "linux",
          connectionStatus: "online",
          connectedAt: "2026-08-19T00:00:00.000Z",
          lastSeenAt: "2026-08-19T00:00:00.000Z",
          observedAt: "2026-08-19T00:00:00.000Z",
          createdAt: "2026-08-18T00:00:00.000Z",
          agentIds: [agentId],
        },
      ],
    };
    const command = { messageId: randomUUID(), status: "accepted", sessionId };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ computerId, installationId, machineToken: "otmc_secret" }))
      .mockResolvedValueOnce(jsonResponse(token))
      .mockResolvedValueOnce(jsonResponse(me))
      .mockResolvedValueOnce(jsonResponse(computers))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(attempt))
      .mockResolvedValueOnce(new Response("resource-body"))
      .mockResolvedValueOnce(jsonResponse(command, 202))
      .mockResolvedValueOnce(jsonResponse(command, 202))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const api = new OpenTagApi("https://opentag.example", fetchImpl);
    await expect(
      api.exchangeComputerConnectCode({
        code: "1234567890abcdef",
        installationId,
        displayName: "Laptop",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
      }),
    ).resolves.toMatchObject({ computerId, installationId });
    await expect(api.refresh("refresh-token")).resolves.toEqual(token);
    await expect(api.me("access-token")).resolves.toEqual(me);
    await expect(api.listAccountComputers("access-token")).resolves.toEqual(computers);
    await expect(api.getAgentImBindingConfig("access-token", agentId)).resolves.toBeUndefined();
    await expect(api.cancelFeishuSetupAttempt("access-token", attempt.id)).resolves.toEqual(attempt);
    await expect(
      api.openImResource("machine-token", "message-1", 0, {
        sessionId,
        instanceId: randomUUID(),
        placementGeneration: 1,
      }),
    ).resolves.toBeInstanceOf(Response);
    await expect(api.createInternalSession("proof", { messageId: randomUUID(), message: "hello" })).resolves.toEqual(
      command,
    );
    await expect(
      api.sendSessionMessage("proof", { messageId: randomUUID(), targetSessionId: sessionId, message: "hello" }),
    ).resolves.toEqual(command);
    await expect(api.listInternalSessions("proof", { recursive: true, limit: 10, cursor: "next" })).resolves.toEqual({
      items: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it("maps network, optional-response, no-content, and fallback HTTP failures", async () => {
    const network = new OpenTagApi(
      "https://opentag.example",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    );
    await expect(network.listAgents("access")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      category: "transient",
    });

    const optionalInvalid = new OpenTagApi(
      "https://opentag.example",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({})),
    );
    await expect(optionalInvalid.getAgentImBinding("access", agentId)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });

    const noContent = new OpenTagApi(
      "https://opentag.example",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 200)),
    );
    await expect(noContent.deleteAgent("access", agentId)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

    for (const [status, category] of [
      [400, "validation"],
      [429, "rate_limit"],
      [503, "transient"],
    ] as const) {
      const api = new OpenTagApi(
        "https://opentag.example",
        vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status })),
      );
      await expect(api.listAgents("access")).rejects.toMatchObject({ category });
    }

    const resourceFailure = new OpenTagApi(
      "https://opentag.example",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status: 500 })),
    );
    await expect(
      resourceFailure.openImResource("machine-token", "message-1", 0, {
        sessionId: randomUUID(),
        instanceId: randomUUID(),
        placementGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

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
      .mockResolvedValueOnce(jsonResponse({ ...agent, computerId, revision: 4 }))
      .mockResolvedValueOnce(jsonResponse({ status: "passed" }))
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
    await api.rebindAgentComputer("access", agentId, computerId);
    await api.testAgentRuntime("access", agentId, {
      expectedRevision: 1,
      expectedRuntimeConfigRevision: 1,
    });
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
      [`https://opentag.example/api/v1/agents/${agentId}/computer/rebind`, "POST"],
      [`https://opentag.example/api/v1/agents/${agentId}/runtime-test`, "POST"],
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
    expect(JSON.parse(String(fetchImpl.mock.calls[8]?.[1]?.body))).toEqual({ computerId });
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
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", category: "validation", status: 400 });
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

  it("starts first-party Slack OAuth without a customer-owned configuration write", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        authorizationUrl: "https://slack.com/oauth/v2/authorize?client_id=client&state=signed-state",
        expiresAt: "2026-08-19T00:10:00.000Z",
      }),
    );
    const api = new OpenTagApi("https://opentag.example", fetchImpl);
    await expect(api.startSlackOAuth("access", agentId, { intent: "create" })).resolves.toMatchObject({
      authorizationUrl: expect.stringContaining("https://slack.com/oauth/v2/authorize"),
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => [new URL(url).pathname, init?.method ?? "GET"])).toEqual([
      [`/api/v1/agents/${agentId}/im-binding/slack/oauth/start`, "POST"],
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ intent: "create" }));
  });
});
