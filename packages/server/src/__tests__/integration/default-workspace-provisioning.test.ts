import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { users, workspaceAdminGrants, workspaces } from "../../db/schema/index.js";
import { PostAuthenticationService } from "../../services/auth/index.js";
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

describe("default Workspace provisioning", () => {
  it("provisions one internal default Workspace and rejects duplicate new-Account provisioning", async () => {
    const client = createDatabaseClient(databaseUrl);
    try {
      await bootstrapInitialAdmin(client.database, {
        displayName: "Admin",
        email: "admin@example.com",
        workspaceDisplayName: "Example",
        workspaceName: "example",
      });
      const [account] = await client.database
        .insert(users)
        .values({ displayName: "New Account", email: "new-account@example.com" })
        .returning({ id: users.id });
      if (!account) throw new Error("Account fixture was not created");
      const postAuthentication = new PostAuthenticationService(
        client.database,
        new WorkspaceAdminAccess(client.database),
      );

      await postAuthentication.complete(account.id, true);
      await expect(postAuthentication.complete(account.id, true)).rejects.toThrow(
        "A newly created Account must not already have an active Workspace grant",
      );
      const grants = await client.database
        .select({ workspaceId: workspaceAdminGrants.workspaceId })
        .from(workspaceAdminGrants)
        .innerJoin(workspaces, eq(workspaces.id, workspaceAdminGrants.workspaceId))
        .where(and(eq(workspaceAdminGrants.userId, account.id), isNull(workspaceAdminGrants.revokedAt)));

      expect(grants).toHaveLength(1);
    } finally {
      await client.sql.end();
    }
  });
});
