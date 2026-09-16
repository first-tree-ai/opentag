import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { githubConnections, users } from "../../db/schema/index.js";
import {
  GitHubConnectionRecheckStore,
  GitHubConnectionService,
  GitHubCredentialRefreshStore,
  type GitHubOAuthCompletionProof,
  sha256Hex,
} from "../../services/github/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
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
  clock = new Date("2026-09-16T00:00:00.000Z");
});

const sessionHash = "a".repeat(64);

function connections() {
  return new GitHubConnectionService(client.database, { now: () => clock });
}

function refreshStore() {
  return new GitHubCredentialRefreshStore(client.database, { now: () => clock });
}

function recheckStore() {
  return new GitHubConnectionRecheckStore(client.database, { now: () => clock });
}

function credential(suffix = "") {
  return {
    ciphertext: `encrypted-uat-refresh-pair${suffix}`,
    keyId: "key-2026-09",
    accessExpiresAt: new Date(clock.getTime() + 8 * 3_600_000),
    refreshExpiresAt: new Date(clock.getTime() + 180 * 86_400_000),
  };
}

async function activeConnection(email: string) {
  const [account] = await client.database.insert(users).values({ displayName: "Owner", email }).returning();
  if (!account) throw new Error("Missing test Account");
  const service = connections();
  const { flow } = await service.createConnection(account.id, { appId: "871235", loginSessionHash: sessionHash });
  const stateHash = sha256Hex(flow.state);
  const claim = await service.claimOAuthCallback({ stateHash, loginSessionHash: sessionHash });
  const proof: GitHubOAuthCompletionProof = {
    connectionId: flow.connectionId,
    flowId: claim.flowId,
    stateHash,
    loginSessionHash: sessionHash,
    expectedAuthorizationVersion: claim.expectedAuthorizationVersion,
    githubUserId: "424242",
    githubLogin: "octocat",
    credential: () => credential(),
  };
  const { connection } = await service.completeAuthorization(account.id, proof);
  return { accountId: account.id, connection };
}

async function rowOf(connectionId: string) {
  const [row] = await client.database.select().from(githubConnections).where(eq(githubConnections.id, connectionId));
  if (!row) throw new Error("Missing connection row");
  return row;
}

describe("GitHub credential refresh CAS", () => {
  it("lets exactly one refresh winner commit and rejects the rest", async () => {
    const { connection } = await activeConnection("winner@example.com");
    const store = refreshStore();

    const first = await store.claimRefresh(connection.id);
    expect(first.claimed).toBe(true);
    if (!first.claimed) throw new Error("Missing claim");
    expect(first.claim.credentialGeneration).toBe(1n);
    expect(first.claim.credential.ciphertext).toBe("encrypted-uat-refresh-pair");

    expect((await store.claimRefresh(connection.id)).claimed).toBe(false);

    const stale = await store.completeRefresh({
      connectionId: connection.id,
      attemptId: first.claim.attemptId,
      expectedCredentialGeneration: 99n,
      credential: credential("-new"),
    });
    expect(stale).toEqual({ applied: false, reason: "stale" });

    const won = await store.completeRefresh({
      connectionId: connection.id,
      attemptId: first.claim.attemptId,
      expectedCredentialGeneration: first.claim.credentialGeneration,
      credential: credential("-new"),
    });
    expect(won).toEqual({ applied: true });

    const row = await rowOf(connection.id);
    expect(row).toMatchObject({
      status: "active",
      credentialCiphertext: "encrypted-uat-refresh-pair-new",
      credentialGeneration: 2n,
      authorizationVersion: 2n,
      refreshStatus: "idle",
      refreshAttemptId: null,
    });

    const late = await store.completeRefresh({
      connectionId: connection.id,
      attemptId: first.claim.attemptId,
      expectedCredentialGeneration: 1n,
      credential: credential("-late"),
    });
    expect(late).toEqual({ applied: false, reason: "stale" });
    expect((await rowOf(connection.id)).credentialCiphertext).toBe("encrypted-uat-refresh-pair-new");
  });

  it("moves a failed refresh into reauthorization_required with secrets cleared", async () => {
    const { connection } = await activeConnection("fail@example.com");
    const store = refreshStore();
    const claim = await store.claimRefresh(connection.id);
    if (!claim.claimed) throw new Error("Missing claim");

    const failed = await store.failRefresh({
      connectionId: connection.id,
      attemptId: claim.claim.attemptId,
      expectedCredentialGeneration: claim.claim.credentialGeneration,
      errorCode: "GITHUB_REFRESH_OUTCOME_UNKNOWN",
    });
    expect(failed).toEqual({ applied: true });

    const row = await rowOf(connection.id);
    expect(row).toMatchObject({
      status: "reauthorization_required",
      authorizationVersion: 3n,
      credentialCiphertext: null,
      credentialKeyId: null,
      oauthStateHash: null,
      refreshStatus: "unknown",
      nextRecheckAt: null,
      lastErrorCode: "GITHUB_REFRESH_OUTCOME_UNKNOWN",
    });

    expect(await store.listRefreshDue({ withinMs: 365 * 86_400_000, limit: 10 })).toEqual([]);
    expect((await store.claimRefresh(connection.id)).claimed).toBe(false);
  });

  it("rejects late refresh writes after disconnect without resurrecting the row", async () => {
    const { accountId, connection } = await activeConnection("late-refresh@example.com");
    const store = refreshStore();
    const claim = await store.claimRefresh(connection.id);
    if (!claim.claimed) throw new Error("Missing claim");

    await connections().disconnect(accountId, connection.id);

    expect(
      await store.completeRefresh({
        connectionId: connection.id,
        attemptId: claim.claim.attemptId,
        expectedCredentialGeneration: claim.claim.credentialGeneration,
        credential: credential("-new"),
      }),
    ).toEqual({ applied: false, reason: "not_active" });
    expect(
      await store.failRefresh({
        connectionId: connection.id,
        attemptId: claim.claim.attemptId,
        expectedCredentialGeneration: claim.claim.credentialGeneration,
        errorCode: "GITHUB_REFRESH_OUTCOME_UNKNOWN",
      }),
    ).toEqual({ applied: false, reason: "not_active" });
    expect((await store.claimRefresh(connection.id)).claimed).toBe(false);

    expect(await rowOf(connection.id)).toMatchObject({
      status: "revoked",
      credentialCiphertext: null,
      refreshStatus: "idle",
    });
  });

  it("lists only refresh-due rows: idle, unknown, or expired claims on active connections", async () => {
    const { connection } = await activeConnection("due@example.com");
    const store = refreshStore();
    expect(await store.listRefreshDue({ withinMs: 7 * 3_600_000, limit: 10 })).toEqual([]);
    const due = await store.listRefreshDue({ withinMs: 9 * 3_600_000, limit: 10 });
    expect(due.map((entry) => entry.connectionId)).toEqual([connection.id]);
    expect(due[0]).toMatchObject({ credentialGeneration: 1n, githubUserId: "424242" });
  });
});

describe("GitHub periodic recheck", () => {
  it("invalidates credentials while replacing arbitrary provider error text with a safe code", async () => {
    const { connection } = await activeConnection("safe-error@example.com");
    expect(
      await recheckStore().commitRecheckResult({
        connectionId: connection.id,
        expectedAuthorizationVersion: 2n,
        expectedRecheckGeneration: 0n,
        outcome: { kind: "unauthorized", errorCode: "UPSTREAM_TOKEN_github_secret_value" },
      }),
    ).toEqual({ applied: true });
    expect(await rowOf(connection.id)).toMatchObject({
      status: "reauthorization_required",
      credentialCiphertext: null,
      lastErrorCode: "GITHUB_UPSTREAM_ERROR",
    });
  });
  it("scans clean active rows whose recheck is due", async () => {
    const { connection } = await activeConnection("scan@example.com");
    const store = recheckStore();
    expect(await store.listDueForRecheck({ limit: 10 })).toEqual([]);

    clock = new Date(clock.getTime() + 31 * 60_000);
    const due = await store.listDueForRecheck({ limit: 10 });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      connectionId: connection.id,
      githubUserId: "424242",
      authorizationVersion: 2n,
      recheckGeneration: 0n,
      credentialGeneration: 1n,
    });
    const [row] = await client.database
      .select({ recheckRequired: githubConnections.recheckRequired })
      .from(githubConnections)
      .where(eq(githubConnections.id, connection.id));
    expect(row?.recheckRequired).toBe(false);
  });

  it("commits a healthy recheck with CAS and schedules the next due", async () => {
    const { connection } = await activeConnection("healthy@example.com");
    const store = recheckStore();
    clock = new Date(clock.getTime() + 31 * 60_000);

    const committed = await store.commitRecheckResult({
      connectionId: connection.id,
      expectedAuthorizationVersion: 2n,
      expectedRecheckGeneration: 0n,
      outcome: { kind: "healthy" },
    });
    expect(committed).toEqual({ applied: true });
    expect(await rowOf(connection.id)).toMatchObject({
      status: "active",
      recheckRequired: false,
      recheckGeneration: 1n,
      lastVerifiedAt: clock,
      nextRecheckAt: new Date(clock.getTime() + 5 * 60_000),
      lastErrorCode: null,
    });

    const stale = await store.commitRecheckResult({
      connectionId: connection.id,
      expectedAuthorizationVersion: 2n,
      expectedRecheckGeneration: 0n,
      outcome: { kind: "healthy" },
    });
    expect(stale).toEqual({ applied: false, reason: "stale" });
    expect((await rowOf(connection.id)).recheckGeneration).toBe(1n);
  });

  it("keeps a transient failure active with a bounded retry and never lets stale commits overwrite it", async () => {
    const { connection } = await activeConnection("transient@example.com");
    const store = recheckStore();
    clock = new Date(clock.getTime() + 31 * 60_000);

    const transient = await store.commitRecheckResult({
      connectionId: connection.id,
      expectedAuthorizationVersion: 2n,
      expectedRecheckGeneration: 0n,
      outcome: { kind: "transient_failure", errorCode: "GITHUB_UPSTREAM_UNAVAILABLE" },
    });
    expect(transient).toEqual({ applied: true });
    expect(await rowOf(connection.id)).toMatchObject({
      status: "active",
      recheckRequired: true,
      recheckGeneration: 1n,
      nextRecheckAt: new Date(clock.getTime() + 5 * 60_000),
      lastErrorCode: "GITHUB_UPSTREAM_UNAVAILABLE",
    });

    const staleAllow = await store.commitRecheckResult({
      connectionId: connection.id,
      expectedAuthorizationVersion: 2n,
      expectedRecheckGeneration: 0n,
      outcome: { kind: "healthy" },
    });
    expect(staleAllow).toEqual({ applied: false, reason: "stale" });
    expect((await rowOf(connection.id)).lastErrorCode).toBe("GITHUB_UPSTREAM_UNAVAILABLE");
  });

  it("moves an unauthorized recheck into reauthorization_required with secrets cleared", async () => {
    const { connection } = await activeConnection("unauthorized@example.com");
    const store = recheckStore();
    clock = new Date(clock.getTime() + 31 * 60_000);

    const committed = await store.commitRecheckResult({
      connectionId: connection.id,
      expectedAuthorizationVersion: 2n,
      expectedRecheckGeneration: 0n,
      outcome: { kind: "unauthorized", errorCode: "GITHUB_CREDENTIAL_INVALID" },
    });
    expect(committed).toEqual({ applied: true });
    expect(await rowOf(connection.id)).toMatchObject({
      status: "reauthorization_required",
      authorizationVersion: 3n,
      credentialCiphertext: null,
      credentialKeyId: null,
      refreshStatus: "idle",
      nextRecheckAt: null,
      recheckGeneration: 1n,
      lastErrorCode: "GITHUB_CREDENTIAL_INVALID",
    });
    expect(await store.listDueForRecheck({ limit: 10 })).toEqual([]);
  });

  it("pulls the next recheck forward for affected active rows only", async () => {
    const first = await activeConnection("dirty-one@example.com");
    const second = await activeConnection("dirty-two@example.com");
    const store = recheckStore();
    await connections().disconnect(second.accountId, second.connection.id);

    const marked = await store.markRecheckDue({
      connectionIds: [first.connection.id, second.connection.id],
      dueAt: clock,
    });
    expect(marked).toBe(1);
    expect(await rowOf(first.connection.id)).toMatchObject({
      recheckRequired: true,
      nextRecheckAt: clock,
      recheckGeneration: 1n,
      authorizationVersion: 2n,
    });
    expect(await store.listDueForRecheck({ limit: 10 })).toHaveLength(1);
    expect(await rowOf(second.connection.id)).toMatchObject({ status: "revoked", recheckRequired: false });
  });
});
