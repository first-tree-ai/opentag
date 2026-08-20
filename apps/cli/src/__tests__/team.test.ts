import { describe, expect, it, vi } from "vitest";
import { runTeamInvitationShow, runTeamMemberList, runTeamMemberRole } from "../index.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const member = {
  teamId,
  userId,
  email: "member@example.com",
  displayName: "Member",
  role: "member" as const,
  status: "active" as const,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};

function api() {
  return {
    me: vi.fn().mockResolvedValue({
      user: { id: userId, email: member.email, displayName: member.displayName },
      memberships: [{ teamId, teamName: "example", teamDisplayName: "Example", role: "admin" }],
    }),
    listTeamMembersConfig: vi.fn().mockResolvedValue({ members: [member] }),
    updateTeamMember: vi.fn().mockResolvedValue(member),
    removeTeamMember: vi.fn(),
    restoreTeamMember: vi.fn(),
    leaveTeam: vi.fn(),
    getTeamInvitation: vi.fn().mockResolvedValue({
      token: "A".repeat(43),
      inviteUrl: `https://opentag.example.com/invites/${"A".repeat(43)}`,
      role: "member",
      expiresAt: "2026-08-26T00:00:00.000Z",
    }),
    rotateTeamInvitation: vi.fn(),
  };
}

describe("Team CLI core", () => {
  it("selects Team authority from /me and delegates member operations to the API", async () => {
    const client = api();
    await expect(runTeamMemberList({ accessToken: "access", api: client })).resolves.toEqual([member]);
    await runTeamMemberRole(userId, "member", { accessToken: "access", api: client });
    expect(client.updateTeamMember).toHaveBeenCalledWith("access", teamId, userId, { role: "member" });
  });

  it("exposes the bearer invitation only through the explicit invitation command", async () => {
    const client = api();
    await expect(runTeamInvitationShow({ accessToken: "access", api: client })).resolves.toMatchObject({
      inviteUrl: expect.stringContaining("/invites/"),
    });
  });
});
