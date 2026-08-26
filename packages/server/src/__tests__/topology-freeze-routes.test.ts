import { randomUUID } from "node:crypto";
import {
  ADMIN_INVITATION_ACCEPT_TEMPLATE,
  ADMIN_INVITATION_PREVIEW_TEMPLATE,
  WORKSPACE_ADMIN_TEMPLATE,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const WORKSPACE_CREATION_PATH = "/api/v1/workspaces";
const INVITATION_CREATION_TEMPLATE = "/api/v1/workspaces/:workspaceId/admin-invitations";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const revokeAdmin = vi.fn().mockResolvedValue(undefined);
  const accept = vi.fn().mockResolvedValue({
    workspace: {
      id: workspaceId,
      name: "example",
      displayName: "Example",
      setupCompletedAt: null,
      grantedAt: "2026-08-26T00:00:00.000Z",
    },
  });
  const preview = vi.fn().mockResolvedValue({
    workspaceDisplayName: "Example",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const app = createApp({
    authService: {
      getAuthenticatedUser: vi.fn().mockResolvedValue({
        me: { user: { id: accountId }, workspaces: [] },
        tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    } as never,
    invitationService: { accept, preview } as never,
    workspaceService: { revokeAdmin } as never,
  });
  apps.push(app);
  return { accept, accountId, app, preview, revokeAdmin, workspaceId };
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

  it("keeps outstanding invitation redemption and Admin revocation available", async () => {
    const value = fixture();
    const token = "A".repeat(43);
    const targetAccountId = randomUUID();

    expect(value.app.hasRoute({ method: "GET", url: ADMIN_INVITATION_PREVIEW_TEMPLATE })).toBe(true);
    expect(value.app.hasRoute({ method: "POST", url: ADMIN_INVITATION_ACCEPT_TEMPLATE })).toBe(true);
    expect(value.app.hasRoute({ method: "DELETE", url: WORKSPACE_ADMIN_TEMPLATE })).toBe(true);

    const preview = await value.app.inject({
      method: "GET",
      url: `/api/v1/admin-invitations/${token}/preview`,
    });
    const accepted = await value.app.inject({
      method: "POST",
      url: `/api/v1/admin-invitations/${token}/accept`,
      headers: { authorization: "Bearer account-token" },
    });
    const revoked = await value.app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${value.workspaceId}/admins/${targetAccountId}`,
      headers: { authorization: "Bearer account-token" },
    });

    expect(preview.statusCode).toBe(200);
    expect(accepted.statusCode).toBe(200);
    expect(revoked.statusCode).toBe(204);
    expect(value.preview).toHaveBeenCalledWith(token);
    expect(value.accept).toHaveBeenCalledWith(value.accountId, token);
    expect(value.revokeAdmin).toHaveBeenCalledWith(value.accountId, value.workspaceId, targetAccountId);
  });
});
