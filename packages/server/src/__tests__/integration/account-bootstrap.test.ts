import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBetterAuth } from "../../auth/better-auth.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers, users } from "../../db/schema/index.js";
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
      const auth = createBetterAuth(client.database, {
        publicUrl: "http://localhost:8000",
        secret: "account-bootstrap-secret-at-least-32-characters",
        secureCookies: false,
        sessionTtlSeconds: 120,
      });
      const context = await auth.$context;
      expect((await context.internalAdapter.createSession(account.id)).userId).toBe(account.id);

      expect(await client.database.select({ id: computers.id }).from(computers)).toEqual([]);
    } finally {
      await client.sql.end();
    }
  });
});
