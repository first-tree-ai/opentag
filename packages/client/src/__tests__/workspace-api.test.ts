import { describe, expect, it, vi } from "vitest";
import { OpenTagApi } from "../api.js";

const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const grantedAt = "2026-08-19T00:00:00.000Z";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenTagApi Workspace surface", () => {
  it("exposes only the Phase 1 Workspace compatibility seam", () => {
    const api = new OpenTagApi("https://opentag.example.com", vi.fn<typeof fetch>());

    expect("getWorkspace" in api).toBe(false);
    expect("updateWorkspace" in api).toBe(false);
    expect("listWorkspaceAdmins" in api).toBe(false);
    expect("revokeWorkspaceAdmin" in api).toBe(false);
    expect("previewAdminInvitation" in api).toBe(false);
    expect("acceptAdminInvitation" in api).toBe(false);
    expect("issueComputerConnectCode" in api).toBe(true);
    expect("listWorkspaceComputers" in api).toBe(true);
    expect("createAgent" in api).toBe(true);
    expect("listAgents" in api).toBe(true);
  });

  it("issues a machine connect code without exposing enrollment revocation", async () => {
    const code = {
      bootstrapCommand: "opentag computer connect --code secret",
      expiresIn: 900,
      issuedAt: grantedAt,
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(code, 201));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);

    await expect(api.issueComputerConnectCode("access", workspaceId)).resolves.toEqual(code);
    expect("revokeWorkspaceComputer" in api).toBe(false);
  });
});
