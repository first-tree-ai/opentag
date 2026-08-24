import {
  HTTP_PATHS,
  invitationPreviewPath,
  teamByIdPath,
  teamInvitationPath,
  teamMemberPath,
  teamMembersConfigPath,
  teamMembersPath,
  teamSetupCompletePath,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import type { InvitationService } from "../services/invitations/index.js";
import { type TeamMembershipService, type TeamSetupService, TeamSetupServiceError } from "../services/teams/index.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
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
    updateSelfProfile: vi.fn(),
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
    createTeam: vi.fn().mockResolvedValue({
      id: teamId,
      name: "first-tree",
      displayName: "First Tree AI",
      role: "admin",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    }),
    updateTeamProfile: vi.fn().mockResolvedValue({
      id: teamId,
      name: "renamed-team",
      displayName: "Renamed Team",
      updatedAt: "2026-08-20T00:00:00.000Z",
    }),
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
  const setup = {
    complete: vi.fn().mockResolvedValue({ setupCompletedAt: "2026-08-20T00:10:00.000Z" }),
  };
  return { team, invitation, setup };
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
    teamSetupService: value.setup as unknown as TeamSetupService,
    invitationService: value.invitation as unknown as InvitationService,
  });
  apps.push(app);
  return { app, ...value };
}

describe("Team and invitation HTTP APIs", () => {
  it("completes Team setup through the authenticated admin boundary", async () => {
    const { app, setup } = testApp();
    const response = await app.inject({
      method: "POST",
      url: teamSetupCompletePath(teamId),
      headers: { authorization: "Bearer access" },
      payload: { agentId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ setupCompletedAt: "2026-08-20T00:10:00.000Z" });
    expect(setup.complete).toHaveBeenCalledWith(userId, teamId, agentId);
  });

  it("rejects an unready Team setup with a stable conflict error", async () => {
    const { app, setup } = testApp();
    setup.complete.mockRejectedValueOnce(
      new TeamSetupServiceError("TEAM_SETUP_NOT_READY", 409, "The Agent handoff is not ready to complete Team setup"),
    );
    const response = await app.inject({
      method: "POST",
      url: teamSetupCompletePath(teamId),
      headers: { authorization: "Bearer access" },
      payload: { agentId },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "TEAM_SETUP_NOT_READY" } });
  });

  it("updates the Team profile through an authenticated PATCH", async () => {
    const { app, team } = testApp();
    const response = await app.inject({
      method: "PATCH",
      url: teamByIdPath(teamId),
      headers: { authorization: "Bearer access" },
      payload: { name: "  RENAMED-TEAM  ", displayName: "  Renamed Team  " },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: teamId, name: "renamed-team", displayName: "Renamed Team" });
    expect(team.updateTeamProfile).toHaveBeenCalledWith(userId, teamId, {
      name: "renamed-team",
      displayName: "Renamed Team",
    });
  });

  it("creates a Team through an authenticated POST and normalizes the canonical name", async () => {
    const { app, team } = testApp();
    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.teams,
      headers: { authorization: "Bearer access" },
      payload: { name: "  First-Tree  ", displayName: "  First Tree AI  " },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: teamId,
      name: "first-tree",
      displayName: "First Tree AI",
      role: "admin",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(team.createTeam).toHaveBeenCalledWith(userId, { name: "first-tree", displayName: "First Tree AI" });
  });

  it("maps a canonical Team name collision to 409 instead of a server error", async () => {
    const { app, team } = testApp();
    team.createTeam.mockRejectedValueOnce(
      new AuthServiceError("TEAM_NAME_CONFLICT", "deterministic", "Another Team already uses this canonical name", 409),
    );
    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.teams,
      headers: { authorization: "Bearer access" },
      payload: { name: "example", displayName: "Example" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "TEAM_NAME_CONFLICT", message: "Another Team already uses this canonical name" },
    });
  });

  it("maps an exhausted Team allowance to 409 with its own code", async () => {
    const { app, team } = testApp();
    team.createTeam.mockRejectedValueOnce(
      new AuthServiceError(
        "TEAM_LIMIT_REACHED",
        "deterministic",
        "A user can hold at most 50 active Team memberships",
        409,
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.teams,
      headers: { authorization: "Bearer access" },
      payload: { name: "one-too-many", displayName: "One Too Many" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "TEAM_LIMIT_REACHED", message: "A user can hold at most 50 active Team memberships" },
    });
  });

  it("rejects unauthenticated and malformed Team creation without reaching the service", async () => {
    const { app, team } = testApp();
    expect(
      (await app.inject({ method: "POST", url: HTTP_PATHS.teams, payload: { name: "a", displayName: "A" } }))
        .statusCode,
    ).toBe(401);
    const invalid = await app.inject({
      method: "POST",
      url: HTTP_PATHS.teams,
      headers: { authorization: "Bearer access" },
      payload: { name: "not a slug", displayName: "Example" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(team.createTeam).not.toHaveBeenCalled();
  });

  it("requires Origin and double-submit CSRF for cookie-authenticated Team creation", async () => {
    const { app, team } = testApp();
    const cookie = "opentag_access=access; opentag_csrf=csrf";
    const payload = { name: "first-tree", displayName: "First Tree AI" };
    expect((await app.inject({ method: "POST", url: HTTP_PATHS.teams, headers: { cookie }, payload })).statusCode).toBe(
      403,
    );
    expect(team.createTeam).not.toHaveBeenCalled();
    const accepted = await app.inject({
      method: "POST",
      url: HTTP_PATHS.teams,
      headers: { cookie, origin: "https://opentag.example.com", "x-opentag-csrf": "csrf" },
      payload,
    });
    expect(accepted.statusCode).toBe(201);
    expect(team.createTeam).toHaveBeenCalledTimes(1);
  });

  it("preserves the Team Admin permission error at the HTTP boundary", async () => {
    const { app, team } = testApp();
    team.updateTeamProfile.mockRejectedValueOnce(
      new AuthServiceError("MEMBERSHIP_FORBIDDEN", "deterministic", "Team admin access is required", 403),
    );
    const response = await app.inject({
      method: "PATCH",
      url: teamByIdPath(teamId),
      headers: { authorization: "Bearer access" },
      payload: { displayName: "Denied" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "MEMBERSHIP_FORBIDDEN" } });
  });

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
