import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { githubConnections, users } from "../../db/schema/index.js";
import { GitHubConnectionService } from "../../services/github/github-connection-service.js";
import { GitHubCredentialRefreshStore } from "../../services/github/github-refresh-store.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let accountId: string;
let connectionId: string;
let clock: Date;

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
  clock = new Date("2030-01-01T00:00:00Z");
  const [account] = await client.database
    .insert(users)
    .values({ displayName: "Account", email: "refresh@example.com" })
    .returning();
  if (!account) throw new Error("Missing test Account");
  accountId = account.id;
  const [connection] = await client.database
    .insert(githubConnections)
    .values({
      accountId,
      githubHost: "github.com",
      appId: "123",
      githubUserId: "456",
      githubLogin: "owner",
      status: "active",
      credentialCiphertext: "encrypted-pair",
      credentialKeyId: "key-1",
      credentialGeneration: 1n,
      accessExpiresAt: new Date(clock.getTime() + 60_000),
      refreshExpiresAt: new Date(clock.getTime() + 86_400_000),
      nextRecheckAt: clock,
    })
    .returning();
  if (!connection) throw new Error("Missing test connection");
  connectionId = connection.id;
});

describe("GitHub one-time refresh safety", () => {
  it("does not exchange the same token again after a worker loses its result", async () => {
    const store = new GitHubCredentialRefreshStore(client.database, { now: () => clock, claimTtlMs: 1000 });
    const first = await store.claimRefresh(connectionId);
    expect(first.claimed).toBe(true);
    clock = new Date(clock.getTime() + 1001);
    expect((await store.claimRefresh(connectionId)).claimed).toBe(false);
    const [row] = await client.database.select().from(githubConnections).where(eq(githubConnections.id, connectionId));
    expect(row).toMatchObject({
      status: "reauthorization_required",
      authorizationVersion: 2n,
      credentialCiphertext: null,
      refreshStatus: "unknown",
    });
  });

  it("beginning OAuth cannot erase a live refresh claim and permit duplicate consumption", async () => {
    const options = { now: () => clock };
    const refresh = new GitHubCredentialRefreshStore(client.database, options);
    expect((await refresh.claimRefresh(connectionId)).claimed).toBe(true);
    await new GitHubConnectionService(client.database, options).beginAuthorizationFlow(accountId, connectionId, {
      intent: "reauthorize",
      loginSessionHash: "b".repeat(64),
    });
    const [duringOAuth] = await client.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, connectionId));
    expect(duringOAuth?.refreshStatus).toBe("claimed");
    expect((await refresh.claimRefresh(connectionId)).claimed).toBe(false);
  });

  it("cannot leave a connection active with an unknown refresh outcome", async () => {
    await expect(
      client.database
        .update(githubConnections)
        .set({ refreshStatus: "unknown" })
        .where(eq(githubConnections.id, connectionId)),
    ).rejects.toThrow();
  });
});
