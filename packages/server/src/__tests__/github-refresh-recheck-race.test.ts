import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubConnections } from "../db/schema/index.js";
import { GitHubConnectionService } from "../services/github/github-connection-service.js";
import { GitHubConnectionRecheckStore } from "../services/github/github-recheck-store.js";
import { GitHubCredentialRefreshStore } from "../services/github/github-refresh-store.js";
import { sha256Hex } from "../services/github/hashes.js";
import { createAccount, GITHUB_TEST_APP_ID, testCredentialCipher } from "./support/github-fixtures.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => {
  await unit?.close();
});

describe("GitHub refresh and recheck concurrency", () => {
  it("does not let an old credential verdict destroy a successfully refreshed credential", async () => {
    const now = new Date("2026-09-16T00:00:00.000Z");
    const cipher = testCredentialCipher();
    const account = await createAccount(unit);
    const connections = new GitHubConnectionService(unit.database, { now: () => now });
    const refresh = new GitHubCredentialRefreshStore(unit.database, { now: () => now });
    const recheck = new GitHubConnectionRecheckStore(unit.database, { now: () => now });
    const loginSessionHash = sha256Hex("account:session");
    const { flow } = await connections.createConnection(account.id, { appId: GITHUB_TEST_APP_ID, loginSessionHash });
    const claimed = await connections.claimOAuthCallback({ stateHash: sha256Hex(flow.state), loginSessionHash });
    await connections.completeAuthorization(account.id, {
      connectionId: claimed.connectionId,
      flowId: claimed.flowId,
      stateHash: sha256Hex(flow.state),
      loginSessionHash,
      expectedAuthorizationVersion: claimed.expectedAuthorizationVersion,
      githubUserId: "42",
      githubLogin: "octocat",
      credential: (binding) => ({
        ...cipher.encryptUserCredential(binding, { accessToken: "old-access", refreshToken: "old-refresh" }),
        accessExpiresAt: new Date(now.getTime() + 60_000),
        refreshExpiresAt: new Date(now.getTime() + 86_400_000),
      }),
    });
    await unit.database
      .update(githubConnections)
      .set({ nextRecheckAt: now })
      .where(eq(githubConnections.id, flow.connectionId));
    const [due] = await recheck.listDueForRecheck({ limit: 1 });
    if (!due) throw new Error("Missing due recheck");
    const acquired = await refresh.claimRefresh(flow.connectionId);
    if (!acquired.claimed) throw new Error("Missing refresh claim");
    const nextCredential = {
      ...cipher.encryptUserCredential(
        {
          connectionId: flow.connectionId,
          accountId: account.id,
          githubHost: "github.com",
          appId: GITHUB_TEST_APP_ID,
          githubUserId: "42",
        },
        { accessToken: "new-access", refreshToken: "new-refresh" },
      ),
      accessExpiresAt: new Date(now.getTime() + 3_600_000),
      refreshExpiresAt: new Date(now.getTime() + 86_400_000),
    };
    expect(
      await refresh.completeRefresh({
        connectionId: flow.connectionId,
        attemptId: acquired.claim.attemptId,
        expectedCredentialGeneration: acquired.claim.credentialGeneration,
        credential: nextCredential,
      }),
    ).toEqual({ applied: true });
    const result = await recheck.commitRecheckResult({
      connectionId: flow.connectionId,
      expectedAuthorizationVersion: due.authorizationVersion,
      expectedRecheckGeneration: due.recheckGeneration,
      outcome: { kind: "unauthorized", errorCode: "GITHUB_CREDENTIAL_INVALID" },
    });
    expect(result).toEqual({ applied: false, reason: "stale" });
    const [row] = await unit.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, flow.connectionId));
    expect(row).toMatchObject({
      status: "active",
      authorizationVersion: due.authorizationVersion,
      credentialCiphertext: nextCredential.ciphertext,
      credentialGeneration: due.credentialGeneration + 1n,
    });
  });
});
