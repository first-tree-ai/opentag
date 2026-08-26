import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { users, workspaceAdminGrants, workspaces } from "../../db/schema/index.js";
import { WorkspaceAdminAccess } from "../../services/workspace-admin-access/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const EARLY = new Date("2026-08-01T00:00:00.000Z");
const LATE = new Date("2026-08-20T00:00:00.000Z");
const FIRST_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SECOND_WORKSPACE = "22222222-2222-4222-8222-222222222222";

type Client = ReturnType<typeof createDatabaseClient>;

async function withClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const client = createDatabaseClient(databaseUrl);
  try {
    return await operation(client);
  } finally {
    await client.sql.end();
  }
}

async function createAccount(client: Client, email: string, suspendedAt: Date | null = null): Promise<string> {
  const [account] = await client.database
    .insert(users)
    .values({ displayName: "Account", email, suspendedAt })
    .returning({ id: users.id });
  if (!account) throw new Error("Account fixture was not created");
  return account.id;
}

async function createWorkspace(client: Client, id: string, name: string, setupCompletedAt?: Date): Promise<string> {
  await client.database
    .insert(workspaces)
    .values({ id, name, displayName: name, setupCompletedAt: setupCompletedAt ?? null });
  return id;
}

async function grant(
  client: Client,
  input: { accountId: string; grantedAt: Date; revoked?: boolean; workspaceId: string },
): Promise<void> {
  await client.database.insert(workspaceAdminGrants).values({
    workspaceId: input.workspaceId,
    userId: input.accountId,
    grantedByUserId: input.accountId,
    grantedAt: input.grantedAt,
    ...(input.revoked ? { revokedByUserId: input.accountId, revokedAt: LATE } : {}),
  });
}

/**
 * The Account-native facade resolves every management call through this single compatibility fact. The
 * internal Workspace is a 1:1 shadow of the Account, enforced by a unique index rather than by convention,
 * so resolution has exactly one candidate and no client ever chooses a scope.
 */
describe("Account compatibility scope resolution", () => {
  it("resolves the single active grant", async () => {
    await withClient(async (client) => {
      const accountId = await createAccount(client, "single@example.com");
      await createWorkspace(client, FIRST_WORKSPACE, "only");
      await grant(client, { accountId, grantedAt: EARLY, workspaceId: FIRST_WORKSPACE });

      const access = new WorkspaceAdminAccess(client.database);
      expect(await access.resolveCompatibilityWorkspaceId(accountId)).toBe(FIRST_WORKSPACE);
    });
  });

  it("rejects a second active grant for the same Account", async () => {
    await withClient(async (client) => {
      const accountId = await createAccount(client, "duplicate@example.com");
      await createWorkspace(client, FIRST_WORKSPACE, "first");
      await createWorkspace(client, SECOND_WORKSPACE, "second");
      await grant(client, { accountId, grantedAt: EARLY, workspaceId: FIRST_WORKSPACE });

      await expect(grant(client, { accountId, grantedAt: LATE, workspaceId: SECOND_WORKSPACE })).rejects.toThrow(
        /workspace_admin_grants_active_user_unique/,
      );

      const access = new WorkspaceAdminAccess(client.database);
      expect(await access.resolveCompatibilityWorkspaceId(accountId)).toBe(FIRST_WORKSPACE);
    });
  });

  it("allows a replacement grant once the previous one is revoked", async () => {
    await withClient(async (client) => {
      const accountId = await createAccount(client, "regrant@example.com");
      await createWorkspace(client, FIRST_WORKSPACE, "first");
      await createWorkspace(client, SECOND_WORKSPACE, "second");
      await grant(client, { accountId, grantedAt: EARLY, revoked: true, workspaceId: FIRST_WORKSPACE });
      await grant(client, { accountId, grantedAt: LATE, workspaceId: SECOND_WORKSPACE });

      const access = new WorkspaceAdminAccess(client.database);
      expect(await access.resolveCompatibilityWorkspaceId(accountId)).toBe(SECOND_WORKSPACE);
    });
  });

  it("ignores revoked grants and never resolves another Account's scope", async () => {
    await withClient(async (client) => {
      const accountId = await createAccount(client, "revoked@example.com");
      const otherAccountId = await createAccount(client, "other@example.com");
      await createWorkspace(client, FIRST_WORKSPACE, "revoked-scope");
      await createWorkspace(client, SECOND_WORKSPACE, "other-scope");
      await grant(client, { accountId, grantedAt: EARLY, revoked: true, workspaceId: FIRST_WORKSPACE });
      await grant(client, { accountId: otherAccountId, grantedAt: EARLY, workspaceId: SECOND_WORKSPACE });

      const access = new WorkspaceAdminAccess(client.database);
      await expect(access.resolveCompatibilityWorkspaceId(accountId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      expect(await access.resolveCompatibilityWorkspaceId(otherAccountId)).toBe(SECOND_WORKSPACE);
    });
  });

  it("does not disclose a scope to an Account with no grant or a suspended Account", async () => {
    await withClient(async (client) => {
      const withoutGrant = await createAccount(client, "no-grant@example.com");
      const suspended = await createAccount(client, "suspended@example.com", LATE);
      await createWorkspace(client, FIRST_WORKSPACE, "suspended-scope");
      await grant(client, { accountId: suspended, grantedAt: EARLY, workspaceId: FIRST_WORKSPACE });

      const access = new WorkspaceAdminAccess(client.database);
      for (const accountId of [withoutGrant, suspended]) {
        await expect(access.resolveCompatibilityWorkspaceId(accountId)).rejects.toMatchObject({
          code: "RESOURCE_NOT_FOUND",
          statusCode: 404,
        });
      }
    });
  });
});
