import { describe, expect, it, vi } from "vitest";
import { OpenTagApi, OpenTagApiError } from "../api.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const creationIntentId = "a3adbe5e-8e8e-4ac2-a013-b026684ab185";
const agent = {
  id: agentId,
  teamId,
  managerUserId: "bfcdab09-b57a-44ac-a170-09f7c3af20df",
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
    allowedTools: ["opentag_message_react", "opentag_message_reply", "opentag_message_send"],
    maxDurationMs: null,
  },
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};
const {
  runtimeConfig: _runtimeConfig,
  revision: _revision,
  managerUserId,
  computerId: safeComputerId,
  ...agentBase
} = agent;
const agentSummary = {
  ...agentBase,
  manager: { userId: managerUserId, displayName: "Manager" },
  computer: { id: safeComputerId, displayName: "Laptop", platform: "linux" },
};
const agentDetail = { ...agentSummary, viewerCapabilities: { canManage: true } };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenTagApi Agent methods", () => {
  it("uses shared Agent paths, methods, bearer auth, and bodies", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(agent, 201))
      .mockResolvedValueOnce(jsonResponse({ agents: [agentSummary] }))
      .mockResolvedValueOnce(jsonResponse(agentDetail))
      .mockResolvedValueOnce(jsonResponse(agent))
      .mockResolvedValueOnce(jsonResponse({ ...agent, displayName: "Reviewer", revision: 2 }))
      .mockResolvedValueOnce(jsonResponse({ ...agent, status: "suspended", revision: 2 }))
      .mockResolvedValueOnce(jsonResponse({ ...agent, revision: 3 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new OpenTagApi("https://opentag.example", fetchImpl);

    await api.createAgent("access", teamId, {
      creationIntentId,
      computerId,
      displayName: "Code Reviewer",
      name: "code-reviewer",
      runtimeProvider: "codex",
      runtimeConfig: { instructions: "Custom instructions", maxDurationMs: 60_000 },
    });
    await api.listAgents("access", teamId);
    await api.getAgent("access", agentId);
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
      [`https://opentag.example/api/v1/teams/${teamId}/agents`, "POST"],
      [`https://opentag.example/api/v1/teams/${teamId}/agents`, "GET"],
      [`https://opentag.example/api/v1/agents/${agentId}`, "GET"],
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
    expect(JSON.parse(String(fetchImpl.mock.calls[4]?.[1]?.body))).toEqual({
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
          runtimeToolAvailable: false,
          credentialGeneration: 1,
          reauthorizationRequired: false,
          connection: null,
          lastInboundAt: null,
          lastOutboundAt: null,
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
});
