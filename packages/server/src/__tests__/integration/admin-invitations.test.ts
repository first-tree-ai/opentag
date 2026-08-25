import { invitationAcceptPath } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { adminInvitations, users, workspaceAdminGrants } from "../../db/schema/index.js";
import { AuthService, AuthTokenService, hashSecret } from "../../services/auth/index.js";
import { validateOAuthNext } from "../../services/auth/oauth/state.js";
import { InvitationService } from "../../services/invitations/index.js";
import { WorkspaceAdminAccess } from "../../services/workspace-admin-access/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const jwtSecret = "admin-invitation-test-secret-at-least-32-characters";
let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function fixture() {
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    workspaceDisplayName: "Example",
    workspaceName: "example",
  });
  const auth = new AuthService(client.database, new AuthTokenService(jwtSecret, 900, 3600));
  const workspaceAdmins = new WorkspaceAdminAccess(client.database);
  const invitations = new InvitationService(client.database, "https://opentag.example.com/base", { workspaceAdmins });
  return { ...client, auth, bootstrap, invitations, workspaceAdmins };
}

async function createAccount(value: Awaited<ReturnType<typeof fixture>>, email: string): Promise<string> {
  const [account] = await value.database
    .insert(users)
    .values({ displayName: email, email })
    .returning({ id: users.id });
  if (!account) throw new Error("Account fixture was not created");
  return account.id;
}

describe("Admin invitation lifecycle", () => {
  it("creates one canonical Web/OAuth invitation destination", async () => {
    const value = await fixture();
    try {
      const invitation = await value.invitations.create(value.bootstrap.userId, value.bootstrap.workspaceId);
      const inviteUrl = new URL(invitation.inviteUrl);
      expect(inviteUrl.origin).toBe("https://opentag.example.com");
      expect(inviteUrl.pathname).toBe(`/invites/${invitation.token}`);
      expect(validateOAuthNext(inviteUrl.pathname)).toBe(inviteUrl.pathname);
    } finally {
      await value.sql.end();
    }
  });

  it("consumes an invitation through the real route when the recipient is already an active Admin", async () => {
    const value = await fixture();
    const app = createApp({ authService: value.auth, invitationService: value.invitations });
    try {
      const tokens = await value.auth.exchangeConnectCode(value.bootstrap.connectCode);
      const invitation = await value.invitations.create(value.bootstrap.userId, value.bootstrap.workspaceId);
      const secondAccountId = await createAccount(value, "second@example.com");
      const grantsBefore = await value.database
        .select({ id: workspaceAdminGrants.id })
        .from(workspaceAdminGrants)
        .where(
          and(
            eq(workspaceAdminGrants.workspaceId, value.bootstrap.workspaceId),
            isNull(workspaceAdminGrants.revokedAt),
          ),
        );

      const response = await app.inject({
        method: "POST",
        url: invitationAcceptPath(invitation.token),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ workspace: { id: value.bootstrap.workspaceId } });
      const grantsAfter = await value.database
        .select({ id: workspaceAdminGrants.id })
        .from(workspaceAdminGrants)
        .where(
          and(
            eq(workspaceAdminGrants.workspaceId, value.bootstrap.workspaceId),
            isNull(workspaceAdminGrants.revokedAt),
          ),
        );
      expect(grantsAfter).toHaveLength(grantsBefore.length);
      const [consumed] = await value.database
        .select()
        .from(adminInvitations)
        .where(eq(adminInvitations.tokenHash, hashSecret(invitation.token)));
      expect(consumed).toMatchObject({ acceptedByUserId: value.bootstrap.userId });
      expect(consumed?.acceptedAt).toBeInstanceOf(Date);
      await expect(value.invitations.accept(secondAccountId, invitation.token)).rejects.toMatchObject({
        code: "INVITATION_INVALID",
        statusCode: 404,
      });
    } finally {
      await app.close();
      await value.sql.end();
    }
  });

  it("allows only one of two Accounts to consume an invitation concurrently", async () => {
    const value = await fixture();
    try {
      const invitation = await value.invitations.create(value.bootstrap.userId, value.bootstrap.workspaceId);
      const [firstAccountId, secondAccountId] = await Promise.all([
        createAccount(value, "first@example.com"),
        createAccount(value, "second@example.com"),
      ]);
      const results = await Promise.allSettled([
        value.invitations.accept(firstAccountId, invitation.token),
        value.invitations.accept(secondAccountId, invitation.token),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "INVITATION_INVALID", statusCode: 404 },
      });
      const active = await value.database
        .select({ userId: workspaceAdminGrants.userId })
        .from(workspaceAdminGrants)
        .where(
          and(
            eq(workspaceAdminGrants.workspaceId, value.bootstrap.workspaceId),
            isNull(workspaceAdminGrants.revokedAt),
          ),
        );
      expect(active).toHaveLength(2);
    } finally {
      await value.sql.end();
    }
  });

  it("preserves one active Admin when two equal Admins concurrently revoke each other", async () => {
    const value = await fixture();
    try {
      const secondAccountId = await createAccount(value, "second@example.com");
      const invitation = await value.invitations.create(value.bootstrap.userId, value.bootstrap.workspaceId);
      await value.invitations.accept(secondAccountId, invitation.token);

      const results = await Promise.allSettled([
        value.workspaceAdmins.revokeAdmin(value.bootstrap.userId, value.bootstrap.workspaceId, secondAccountId),
        value.workspaceAdmins.revokeAdmin(secondAccountId, value.bootstrap.workspaceId, value.bootstrap.userId),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const active = await value.database
        .select({ userId: workspaceAdminGrants.userId })
        .from(workspaceAdminGrants)
        .where(
          and(
            eq(workspaceAdminGrants.workspaceId, value.bootstrap.workspaceId),
            isNull(workspaceAdminGrants.revokedAt),
          ),
        );
      expect(active).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("rejects revoking the last active Admin", async () => {
    const value = await fixture();
    try {
      await expect(
        value.workspaceAdmins.revokeAdmin(value.bootstrap.userId, value.bootstrap.workspaceId, value.bootstrap.userId),
      ).rejects.toMatchObject({ code: "WORKSPACE_LAST_ADMIN", statusCode: 409 });
    } finally {
      await value.sql.end();
    }
  });
});
