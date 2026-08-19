import { describe, expect, it, vi } from "vitest";
import { OpenTagApi, OpenTagApiError } from "../api.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const agent = {
  id: agentId,
  teamId,
  managerUserId: "bfcdab09-b57a-44ac-a170-09f7c3af20df",
  computerId,
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex",
  revision: 1,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenTagApi Agent methods", () => {
  it("uses shared Agent paths, methods, bearer auth, and bodies", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(agent, 201))
      .mockResolvedValueOnce(jsonResponse({ agents: [agent] }))
      .mockResolvedValueOnce(jsonResponse(agent))
      .mockResolvedValueOnce(jsonResponse({ ...agent, displayName: "Reviewer", revision: 2 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new OpenTagApi("https://opentag.example", fetchImpl);

    await api.createAgent("access", teamId, {
      computerId,
      displayName: "Code Reviewer",
      name: "code-reviewer",
      runtimeProvider: "codex",
    });
    await api.listAgents("access", teamId);
    await api.getAgent("access", agentId);
    await api.updateAgent("access", agentId, { displayName: "Reviewer", expectedRevision: 1 });
    await api.deleteAgent("access", agentId);

    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      [`https://opentag.example/api/v1/teams/${teamId}/agents`, "POST"],
      [`https://opentag.example/api/v1/teams/${teamId}/agents`, "GET"],
      [`https://opentag.example/api/v1/agents/${agentId}`, "GET"],
      [`https://opentag.example/api/v1/agents/${agentId}`, "PATCH"],
      [`https://opentag.example/api/v1/agents/${agentId}`, "DELETE"],
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
    }
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      computerId,
      displayName: "Code Reviewer",
      name: "code-reviewer",
      runtimeProvider: "codex",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toEqual({
      displayName: "Reviewer",
      expectedRevision: 1,
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
});
