import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const WORKSPACE_CREATION_PATH = "/api/v1/workspaces";
const WORKSPACE_COMPUTERS_TEMPLATE = "/api/v1/workspaces/:workspaceId/computers";
const WORKSPACE_SETUP_COMPLETE_TEMPLATE = "/api/v1/workspaces/:workspaceId/setup/complete";
const INVITATION_CREATION_TEMPLATE = "/api/v1/workspaces/:workspaceId/admin-invitations";
const INVITATION_PREVIEW_TEMPLATE = "/api/v1/admin-invitations/:token/preview";
const INVITATION_ACCEPT_TEMPLATE = "/api/v1/admin-invitations/:token/accept";
const WORKSPACE_BY_ID_TEMPLATE = "/api/v1/workspaces/:workspaceId";
const WORKSPACE_ADMINS_TEMPLATE = "/api/v1/workspaces/:workspaceId/admins";
const WORKSPACE_ADMIN_TEMPLATE = "/api/v1/workspaces/:workspaceId/admins/:accountId";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const app = createApp({
    authService: {
      getAuthenticatedUser: vi.fn().mockResolvedValue({
        me: { user: { id: accountId }, setupCompletedAt: null },
        tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    } as never,
    accountSetupService: { completeForAccount: vi.fn() } as never,
  });
  apps.push(app);
  return { app, workspaceId };
}

describe("Workspace topology freeze", () => {
  it("registers no route that creates a Workspace or issues an Admin invitation", async () => {
    const value = fixture();

    expect(value.app.hasRoute({ method: "POST", url: WORKSPACE_CREATION_PATH })).toBe(false);
    expect(value.app.hasRoute({ method: "POST", url: INVITATION_CREATION_TEMPLATE })).toBe(false);

    const [workspaceResponse, invitationResponse] = await Promise.all([
      value.app.inject({
        method: "POST",
        url: WORKSPACE_CREATION_PATH,
        headers: { authorization: "Bearer account-token" },
      }),
      value.app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${value.workspaceId}/admin-invitations`,
        headers: { authorization: "Bearer account-token" },
      }),
    ]);
    expect(workspaceResponse.statusCode).toBe(404);
    expect(invitationResponse.statusCode).toBe(404);
  });

  it("retires Workspace profile, Admin, invitation, Computer, and setup routes", async () => {
    const value = fixture();
    const token = "A".repeat(43);
    const targetAccountId = randomUUID();

    expect(value.app.hasRoute({ method: "GET", url: INVITATION_PREVIEW_TEMPLATE })).toBe(false);
    expect(value.app.hasRoute({ method: "POST", url: INVITATION_ACCEPT_TEMPLATE })).toBe(false);
    expect(value.app.hasRoute({ method: "GET", url: WORKSPACE_BY_ID_TEMPLATE })).toBe(false);
    expect(value.app.hasRoute({ method: "PATCH", url: WORKSPACE_BY_ID_TEMPLATE })).toBe(false);
    expect(value.app.hasRoute({ method: "GET", url: WORKSPACE_ADMINS_TEMPLATE })).toBe(false);
    expect(value.app.hasRoute({ method: "DELETE", url: WORKSPACE_ADMIN_TEMPLATE })).toBe(false);
    expect(value.app.hasRoute({ method: "GET", url: WORKSPACE_COMPUTERS_TEMPLATE })).toBe(false);
    expect(value.app.hasRoute({ method: "POST", url: WORKSPACE_SETUP_COMPLETE_TEMPLATE })).toBe(false);

    const retired = await Promise.all([
      value.app.inject({ method: "GET", url: `/api/v1/admin-invitations/${token}/preview` }),
      value.app.inject({ method: "POST", url: `/api/v1/admin-invitations/${token}/accept` }),
      value.app.inject({ method: "GET", url: `/api/v1/workspaces/${value.workspaceId}` }),
      value.app.inject({ method: "PATCH", url: `/api/v1/workspaces/${value.workspaceId}` }),
      value.app.inject({ method: "GET", url: `/api/v1/workspaces/${value.workspaceId}/admins` }),
      value.app.inject({
        method: "DELETE",
        url: `/api/v1/workspaces/${value.workspaceId}/admins/${targetAccountId}`,
      }),
    ]);
    expect(retired.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
  });
});
