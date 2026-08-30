import { describe, expect, it, vi } from "vitest";
import { OpenTagApi } from "../api.js";
import * as client from "../index.js";

const grantedAt = "2026-08-19T00:00:00.000Z";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenTagApi Account surface", () => {
  it("re-exports the complete public client barrel", () => {
    expect(client.OpenTagApi).toBe(OpenTagApi);
    expect(client.RuntimeConnection).toBeDefined();
    expect(client.SessionBindingStore).toBeDefined();
    expect(client.inspectLocalComputerConfiguration).toBeDefined();
    expect(client.CodexAgentRuntimeFactory).toBeDefined();
  });

  it("exposes Account-native Computer and Agent operations", () => {
    const api = new OpenTagApi("https://opentag.example.com", vi.fn<typeof fetch>());

    expect("issueComputerConnectCode" in api).toBe(true);
    expect("listAccountComputers" in api).toBe(true);
    expect("createAgent" in api).toBe(true);
    expect("listAgents" in api).toBe(true);
  });

  it("issues a Computer connect code", async () => {
    const code = {
      bootstrapCommand: "opentag computer connect --code secret",
      expiresIn: 900,
      issuedAt: grantedAt,
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(code, 201));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);

    await expect(api.issueComputerConnectCode("access")).resolves.toEqual(code);
  });
});
