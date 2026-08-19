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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenTagApi Team surface", () => {
  it("uses bearer-authenticated Team member contracts", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ members: [member] }))
      .mockResolvedValueOnce(json(member));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);
    await expect(api.listTeamMembers("access", teamId)).resolves.toEqual({ members: [member] });
    await expect(api.updateTeamMember("access", teamId, userId, { role: "member" })).resolves.toEqual(member);
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ role: "member" }) });
  });

  it("returns invitation secrets only from explicit show/rotate methods", async () => {
    const invitation = {
      token: "A".repeat(43),
      inviteUrl: `https://opentag.example.com/invite/${"A".repeat(43)}`,
      role: "member",
      expiresAt: "2026-08-26T00:00:00.000Z",
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(invitation));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);
    await expect(api.getTeamInvitation("access", teamId)).resolves.toEqual(invitation);
    await expect(api.rotateTeamInvitation("access", teamId)).resolves.toEqual(invitation);
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });
});
