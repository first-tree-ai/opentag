import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { computers, users } from "../../db/schema/index.js";
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
  it("creates only the Account and provisions no owned resources", async () => {
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

      expect(await client.database.select({ id: computers.id }).from(computers)).toEqual([]);
    } finally {
      await client.sql.end();
    }
  });
});
