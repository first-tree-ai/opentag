import { describe, expect, it, vi } from "vitest";
import { OpenTagApi } from "../api.js";
import * as client from "../index.js";

const grantedAt = "2026-08-19T00:00:00.000Z";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenTagApi Workspace surface", () => {
  it("re-exports the complete public client barrel", () => {
    expect(client.OpenTagApi).toBe(OpenTagApi);
    expect(client.RuntimeConnection).toBeDefined();
    expect(client.SessionBindingStore).toBeDefined();
    expect(client.inspectLocalComputerConfiguration).toBeDefined();
    expect(client.CodexAgentRuntimeFactory).toBeDefined();
  });

  it("exposes only the Phase 1 Workspace compatibility seam", () => {
    const api = new OpenTagApi("https://opentag.example.com", vi.fn<typeof fetch>());

    expect("getWorkspace" in api).toBe(false);
    expect("updateWorkspace" in api).toBe(false);
    expect("listWorkspaceAdmins" in api).toBe(false);
    expect("revokeWorkspaceAdmin" in api).toBe(false);
    expect("previewAdminInvitation" in api).toBe(false);
    expect("acceptAdminInvitation" in api).toBe(false);
    expect("issueComputerConnectCode" in api).toBe(true);
    expect("listAccountComputers" in api).toBe(true);
    expect("listWorkspaceComputers" in api).toBe(false);
    expect("createAgent" in api).toBe(true);
    expect("listAgents" in api).toBe(true);
  });

  it("issues a machine connect code without exposing enrollment revocation", async () => {
    const code = {
      connectCodeId: "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f",
      bootstrapCommand: "opentag computer connect --code secret",
      expiresIn: 900,
      issuedAt: grantedAt,
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(code, 201));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);

    await expect(api.issueComputerConnectCode("access")).resolves.toEqual(code);
    expect("revokeWorkspaceComputer" in api).toBe(false);
  });

  it("reads a connect code's redemption status under the issuing Account", async () => {
    const status = {
      connectCodeId: "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f",
      state: "redeemed" as const,
      computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
      redeemedAt: grantedAt,
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(status));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);

    await expect(api.getComputerConnectCodeStatus("access", status.connectCodeId)).resolves.toEqual(status);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(`https://opentag.example.com/api/v1/computer-connect-codes/${status.connectCodeId}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
  });
});
