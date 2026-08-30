import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { PostAuthenticationService } from "../../services/auth/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

describe("Account bootstrap", () => {
  it("creates only the Account, with no Workspace-era persistence left to provision", async () => {
    const client = createDatabaseClient(databaseUrl);
    try {
      const [account] = await client.database
        .insert(users)
        .values({ displayName: "New Account", email: "new-account@example.com" })
        .returning({ id: users.id });
      if (!account) throw new Error("Account fixture was not created");
      const postAuthentication = new PostAuthenticationService(client.database);

      await expect(postAuthentication.complete(account.id, true)).resolves.toEqual({ userId: account.id });
      await expect(postAuthentication.ensureAccountReady(account.id)).resolves.toEqual({ userId: account.id });

      const [legacyTables] = await client.sql<{ count: number }[]>`
        select count(*)::int as count
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'workspaces',
            'workspace_admin_grants',
            'admin_invitations',
            'workspace_computers',
            'workspace_computer_credentials'
          )
      `;
      expect(legacyTables?.count).toBe(0);
    } finally {
      await client.sql.end();
    }
  });
});
