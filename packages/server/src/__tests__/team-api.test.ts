import {
  invitationPreviewPath,
  teamInvitationPath,
  teamMemberPath,
  teamMembersConfigPath,
  teamMembersPath,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { InvitationService } from "../services/invitations/index.js";
import type { TeamMembershipService } from "../services/teams/index.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const member = {
  teamId,
  userId,
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin" as const,
  status: "active" as const,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};
const memberSummary = {
  userId,
  displayName: "Admin",
  role: "admin" as const,
};
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    getActiveUserById: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: member.email, displayName: member.displayName },
        memberships: [{ teamId, teamName: "example", teamDisplayName: "Example", role: "admin" }],
      },
    }),
    refresh: vi.fn(),
  };
}

function services() {
  const team = {
    listMembers: vi.fn().mockResolvedValue({ members: [memberSummary] }),
    listMembersConfig: vi.fn().mockResolvedValue({ members: [member] }),
    changeRole: vi.fn().mockResolvedValue(member),
    remove: vi.fn(),
    restore: vi.fn(),
    leave: vi.fn(),
    listComputers: vi.fn().mockResolvedValue({ computers: [] }),
  };
  const invitation = {
    get: vi.fn().mockResolvedValue({
      token: "A".repeat(43),
      inviteUrl: `https://opentag.example.com/invites/${"A".repeat(43)}`,
      role: "member",
      expiresAt: "2026-08-26T00:00:00.000Z",
    }),
    create: vi.fn().mockResolvedValue({
      token: "A".repeat(43),
      inviteUrl: `https://opentag.example.com/invites/${"A".repeat(43)}`,
      role: "member",
      expiresAt: "2026-08-26T00:00:00.000Z",
    }),
    rotate: vi.fn(),
    preview: vi.fn().mockResolvedValue({
      teamDisplayName: "Example",
      role: "member",
      expiresAt: "2026-08-26T00:00:00.000Z",
    }),
    redeem: vi.fn(),
  };
  return { team, invitation };
}

function testApp() {
  const value = services();
  const app = createApp({
    authService: authService(),
    browserAuth: {
      publicOrigin: "https://opentag.example.com",
      refreshTokenTtlSeconds: 3600,
      secureCookies: true,
    },
    teamService: value.team as unknown as TeamMembershipService,
    invitationService: value.invitation as unknown as InvitationService,
  });
  apps.push(app);
  return { app, ...value };
}

describe("Team and invitation HTTP APIs", () => {
  it("uses strict bearer contracts for member and invitation reads", async () => {
    const { app, invitation } = testApp();
    const authorization = { authorization: "Bearer access" };
    expect((await app.inject({ method: "GET", url: teamMembersPath(teamId), headers: authorization })).json()).toEqual({
      members: [memberSummary],
    });
    expect(
      (await app.inject({ method: "GET", url: teamMembersConfigPath(teamId), headers: authorization })).json(),
    ).toEqual({ members: [member] });
    const shown = await app.inject({ method: "GET", url: teamInvitationPath(teamId), headers: authorization });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toMatchObject({ token: "A".repeat(43), role: "member" });
    expect(invitation.get).toHaveBeenCalledWith(userId, teamId);
    expect(invitation.create).not.toHaveBeenCalled();
  });

  it("creates invitation bearers only through an explicit mutation", async () => {
    const { app, invitation } = testApp();
    const response = await app.inject({
      method: "POST",
      url: teamInvitationPath(teamId),
      headers: { authorization: "Bearer access" },
    });
    expect(response.statusCode).toBe(201);
    expect(invitation.create).toHaveBeenCalledWith(userId, teamId);
  });

  it("requires Origin and double-submit CSRF only for cookie-authenticated mutations", async () => {
    const { app, team } = testApp();
    const cookie = "opentag_access=access; opentag_csrf=csrf";
    const rejected = await app.inject({
      method: "PATCH",
      url: teamMemberPath(teamId, userId),
      headers: { cookie },
      payload: { role: "member" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(team.changeRole).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "PATCH",
      url: teamMemberPath(teamId, userId),
      headers: { cookie, origin: "https://opentag.example.com", "x-opentag-csrf": "csrf" },
      payload: { role: "member" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(team.changeRole).toHaveBeenCalledWith(userId, teamId, userId, "member");
  });

  it("keeps invitation preview public and bounded", async () => {
    const { app } = testApp();
    const response = await app.inject({ method: "GET", url: invitationPreviewPath("A".repeat(43)) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      teamDisplayName: "Example",
      role: "member",
      expiresAt: "2026-08-26T00:00:00.000Z",
    });
  });
});
