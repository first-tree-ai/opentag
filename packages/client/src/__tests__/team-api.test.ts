import { describe, expect, it, vi } from "vitest";
import { OpenTagApi } from "../api.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const member = {
  teamId,
  userId,
  email: "member@example.com",
  displayName: "Member",
  role: "member",
  status: "active",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};
const memberSummary = { userId, displayName: member.displayName, role: member.role };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenTagApi Team surface", () => {
  it("uses bearer-authenticated Team member contracts", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ members: [memberSummary] }))
      .mockResolvedValueOnce(json({ members: [member] }))
      .mockResolvedValueOnce(json(member));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);
    await expect(api.listTeamMembers("access", teamId)).resolves.toEqual({ members: [memberSummary] });
    await expect(api.listTeamMembersConfig("access", teamId)).resolves.toEqual({ members: [member] });
    await expect(api.updateTeamMember("access", teamId, userId, { role: "member" })).resolves.toEqual(member);
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ role: "member" }) });
  });

  it("returns invitation secrets only from explicit show/create/rotate methods", async () => {
    const invitation = {
      token: "A".repeat(43),
      inviteUrl: `https://opentag.example.com/invites/${"A".repeat(43)}`,
      role: "member",
      expiresAt: "2026-08-26T00:00:00.000Z",
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(invitation));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);
    await expect(api.getTeamInvitation("access", teamId)).resolves.toEqual(invitation);
    await expect(api.createTeamInvitation("access", teamId)).resolves.toEqual(invitation);
    await expect(api.rotateTeamInvitation("access", teamId)).resolves.toEqual(invitation);
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });

  it("returns undefined when no active invitation exists", async () => {
    const api = new OpenTagApi(
      "https://opentag.example.com",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
    );
    await expect(api.getTeamInvitation("access", teamId)).resolves.toBeUndefined();
  });
});
