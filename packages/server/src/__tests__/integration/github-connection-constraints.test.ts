import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { githubConnections, users } from "../../db/schema/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let accountId: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);
afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});
beforeEach(async () => {
  await testDatabase.reset();
  const [account] = await client.database
    .insert(users)
    .values({ displayName: "Account", email: "account@example.com" })
    .returning();
  if (!account) throw new Error("Missing test Account");
  accountId = account.id;
});

function pending() {
  return { accountId, githubHost: "github.com", appId: "123" };
}

describe("GitHub connection SQL boundaries", () => {
  it("rejects a half-populated refresh claim even while idle", async () => {
    await expect(
      client.database.insert(githubConnections).values({
        ...pending(),
        refreshAttemptId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      client.database.insert(githubConnections).values({
        ...pending(),
        refreshClaimUntil: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("rejects OAuth state without its flow and encrypted context", async () => {
    await expect(
      client.database.insert(githubConnections).values({
        ...pending(),
        oauthStateHash: "a".repeat(64),
      }),
    ).rejects.toThrow();
  });

  it("rejects encrypted OAuth context without the matching state and flow", async () => {
    await expect(
      client.database.insert(githubConnections).values({
        ...pending(),
        oauthContextCiphertext: "encrypted-context",
        oauthContextKeyId: "key-1",
      }),
    ).rejects.toThrow();
  });

  it("keeps terminal rows secret-free and outside the current-connection unique key", async () => {
    await client.database.insert(githubConnections).values({ ...pending(), status: "revoked" });
    await client.database.insert(githubConnections).values(pending());
    await expect(client.database.insert(githubConnections).values(pending())).rejects.toThrow();
    await expect(
      client.database.insert(githubConnections).values({
        ...pending(),
        status: "superseded",
        credentialCiphertext: "secret",
        credentialKeyId: "key-1",
        accessExpiresAt: new Date(),
        refreshExpiresAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
