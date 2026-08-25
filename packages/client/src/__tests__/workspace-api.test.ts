import { describe, expect, it, vi } from "vitest";
import { OpenTagApi } from "../api.js";

const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const accountId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const grantedAt = "2026-08-19T00:00:00.000Z";
const admin = { userId: accountId, displayName: "Admin", grantedAt };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenTagApi Workspace surface", () => {
  it("creates and updates a Workspace by stable UUID", async () => {
    const created = {
      id: workspaceId,
      name: "workspace",
      displayName: "Workspace",
      setupCompletedAt: null,
      createdAt: grantedAt,
      grantedAt,
      updatedAt: grantedAt,
    };
    const { createdAt: _createdAt, grantedAt: _grantedAt, ...profile } = created;
    const updated = { ...profile, name: "renamed-workspace", displayName: "Renamed Workspace" };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(created, 201))
      .mockResolvedValueOnce(json(updated));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);

    await expect(api.createWorkspace("access", { name: "workspace", displayName: "Workspace" })).resolves.toEqual(
      created,
    );
    await expect(api.updateWorkspace("access", workspaceId, { name: "renamed-workspace" })).resolves.toEqual(updated);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
  });

  it("lists and revokes roleless Workspace Admin grants", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ admins: [admin] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);

    await expect(api.listWorkspaceAdmins("access", workspaceId)).resolves.toEqual({ admins: [admin] });
    await expect(api.revokeWorkspaceAdmin("access", workspaceId, accountId)).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[1]?.[0]).toEqual(
      new URL(`https://opentag.example.com/api/v1/workspaces/${workspaceId}/admins/${accountId}`),
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("creates, previews, and explicitly accepts a single-use Admin invitation", async () => {
    const token = "A".repeat(43);
    const invitation = {
      token,
      inviteUrl: `https://opentag.example.com/invites/${token}`,
      expiresAt: "2026-08-26T00:00:00.000Z",
    };
    const preview = { workspaceDisplayName: "Workspace", expiresAt: invitation.expiresAt };
    const acceptance = {
      workspace: {
        id: workspaceId,
        name: "workspace",
        displayName: "Workspace",
        setupCompletedAt: null,
        grantedAt,
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(invitation, 201))
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json(acceptance));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);

    await expect(api.createWorkspaceAdminInvitation("access", workspaceId)).resolves.toEqual(invitation);
    await expect(api.previewAdminInvitation(token)).resolves.toEqual(preview);
    await expect(api.acceptAdminInvitation("access", token)).resolves.toEqual(acceptance);
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
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
