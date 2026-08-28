import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { users, workspaceAdminGrants, workspaces } from "../../db/schema/index.js";
import { isUniqueViolation } from "../../db/unique-violation.js";
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
const LOWER_UUID = "11111111-1111-4111-8111-111111111111";
const HIGHER_UUID = "22222222-2222-4222-8222-222222222222";

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

async function grantWorkspace(
  client: Client,
  input: { accountId: string; grantedAt: Date; id: string; name: string; revoked?: boolean; setupCompletedAt?: Date },
): Promise<string> {
  await client.database.insert(workspaces).values({
    id: input.id,
    name: input.name,
    displayName: input.name,
    setupCompletedAt: input.setupCompletedAt ?? null,
  });
  await client.database.insert(workspaceAdminGrants).values({
    workspaceId: input.id,
    userId: input.accountId,
    grantedByUserId: input.accountId,
    grantedAt: input.grantedAt,
    ...(input.revoked ? { revokedByUserId: input.accountId, revokedAt: LATE } : {}),
  });
  return input.id;
}

/**
 * The Account-native facade resolves every management call through this single compatibility fact. Two
 * partial unique indexes make it a fact rather than a selection: an Account holds one active grant and a
 * Workspace holds one active Admin, so the resolver has exactly one candidate and `workspace_id = ?`
 * means "belongs to this Account". The ordering the resolver still carries is unreachable, so what is
 * pinned here is the pair of constraints plus the revoke-and-replace path they leave open.
 */
describe("Account compatibility scope resolution", () => {
  it("rejects a second active grant for one Account", async () => {
    await withClient(async (client) => {
      const accountId = await createAccount(client, "second-grant@example.com");
      await grantWorkspace(client, { accountId, grantedAt: EARLY, id: LOWER_UUID, name: "first" });

      const thrown = await grantWorkspace(client, {
        accountId,
        grantedAt: LATE,
        id: HIGHER_UUID,
        name: "second",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isUniqueViolation(thrown, "workspace_admin_grants_active_user_unique")).toBe(true);
    });
  });

  it("rejects a second active Admin on one Workspace", async () => {
    await withClient(async (client) => {
      const first = await createAccount(client, "first-admin@example.com");
      const second = await createAccount(client, "second-admin@example.com");
      await grantWorkspace(client, { accountId: first, grantedAt: EARLY, id: LOWER_UUID, name: "shared" });

      const thrown = await client.database
        .insert(workspaceAdminGrants)
        .values({ workspaceId: LOWER_UUID, userId: second, grantedByUserId: first, grantedAt: LATE })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(isUniqueViolation(thrown, "workspace_admin_grants_active_workspace_unique")).toBe(true);
    });
  });

  it("resolves the replacement once the previous grant is revoked", async () => {
    await withClient(async (client) => {
      const accountId = await createAccount(client, "replace@example.com");
      await grantWorkspace(client, {
        accountId,
        grantedAt: EARLY,
        id: LOWER_UUID,
        name: "revoked-first",
        revoked: true,
      });
      await grantWorkspace(client, { accountId, grantedAt: LATE, id: HIGHER_UUID, name: "current" });

      const access = new WorkspaceAdminAccess(client.database);
      expect(await access.resolveCompatibilityWorkspaceId(accountId)).toBe(HIGHER_UUID);
    });
  });

  it("ignores revoked grants and other Accounts", async () => {
    await withClient(async (client) => {
      const accountId = await createAccount(client, "revoked@example.com");
      const otherAccountId = await createAccount(client, "other@example.com");
      await grantWorkspace(client, {
        accountId,
        grantedAt: EARLY,
        id: LOWER_UUID,
        name: "revoked-scope",
        revoked: true,
      });
      await grantWorkspace(client, { accountId: otherAccountId, grantedAt: EARLY, id: HIGHER_UUID, name: "other" });

      const access = new WorkspaceAdminAccess(client.database);
      await expect(access.resolveCompatibilityWorkspaceId(accountId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      expect(await access.resolveCompatibilityWorkspaceId(otherAccountId)).toBe(HIGHER_UUID);
    });
  });

  it("does not disclose a scope to an Account with no grant or a suspended Account", async () => {
    await withClient(async (client) => {
      const withoutGrant = await createAccount(client, "no-grant@example.com");
      const suspended = await createAccount(client, "suspended@example.com", LATE);
      await grantWorkspace(client, { accountId: suspended, grantedAt: EARLY, id: LOWER_UUID, name: "suspended-scope" });

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
