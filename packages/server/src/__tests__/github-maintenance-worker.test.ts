import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { githubConnections } from "../db/schema/index.js";
import {
  GITHUB_API_CLIENT_ERROR_CODES,
  type GitHubApiClient,
  GitHubApiClientError,
} from "../services/github/github-api-client.js";
import { GitHubConnectionService } from "../services/github/github-connection-service.js";
import { GitHubMaintenanceWorker } from "../services/github/github-maintenance-worker.js";
import { GitHubConnectionRecheckStore } from "../services/github/github-recheck-store.js";
import {
  GITHUB_REFRESH_OUTCOME_UNKNOWN_ERROR_CODE,
  GitHubCredentialRefreshStore,
} from "../services/github/github-refresh-store.js";
import { sha256Hex } from "../services/github/hashes.js";
import {
  createAccount,
  GITHUB_TEST_CLIENT_ID,
  stubGitHubApi,
  testCredentialCipher,
  tokenMaterial,
} from "./support/github-fixtures.js";
import type { GitHubRepositoryBinding } from "./support/legacy-github-fixtures.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
let clock: Date;
const cipher = testCredentialCipher();
const loginSessionHash = sha256Hex("account:session");

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unit?.close();
});

beforeEach(async () => {
  await unit.reset();
  clock = new Date("2026-09-16T00:00:00.000Z");
});

function stores() {
  return {
    connections: new GitHubConnectionService(unit.database, { now: () => clock }),
    refreshStore: new GitHubCredentialRefreshStore(unit.database, {
      oauthClientId: "Ov23testclient",
      now: () => clock,
    }),
    recheckStore: new GitHubConnectionRecheckStore(unit.database, {
      oauthClientId: "Ov23testclient",
      now: () => clock,
    }),
  };
}

function workerFor(
  api: GitHubApiClient,
  options: {
    batchLimit?: number;
    intervalMs?: number;
    tickBudgetMs?: number;
    refreshWithinMs?: number;
    logger?: {
      warn: (bindings: Record<string, unknown>, message: string) => void;
      error: (bindings: Record<string, unknown>, message: string) => void;
    };
  } = {},
) {
  const { refreshStore, recheckStore } = stores();
  return new GitHubMaintenanceWorker({
    refreshStore,
    recheckStore,
    cipher,
    api,

    now: () => clock,
    ...(options.batchLimit !== undefined ? { batchLimit: options.batchLimit } : {}),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.tickBudgetMs !== undefined ? { tickBudgetMs: options.tickBudgetMs } : {}),
    ...(options.refreshWithinMs !== undefined ? { refreshWithinMs: options.refreshWithinMs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

/**
 * Builds a worker over stores the test owns, so individual store methods can be spied on. The
 * `workerFor` helper above creates its own stores, which is right for behaviour tests and wrong
 * for these.
 */
function workerWithStores(api: GitHubApiClient, options: { tickBudgetMs?: number; intervalMs?: number } = {}) {
  const owned = stores();
  const worker = new GitHubMaintenanceWorker({
    refreshStore: owned.refreshStore,
    recheckStore: owned.recheckStore,
    cipher,
    api,

    now: () => clock,
    ...(options.tickBudgetMs !== undefined ? { tickBudgetMs: options.tickBudgetMs } : {}),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
  });
  return { worker, ...owned };
}

/** An active connection with a real cipher-sealed UAT pair. */
async function activeConnection(
  options: {
    accessToken?: string;
    refreshToken?: string;
    bindings?: GitHubRepositoryBinding[];
    /** Milliseconds until the access token expires; default inside the refresh window. */
    accessExpiresInMs?: number;
  } = {},
) {
  const account = await createAccount(unit);
  const { connections } = stores();
  const { flow } = await connections.createConnection(account.id, {
    oauthClientId: GITHUB_TEST_CLIENT_ID,
    loginSessionHash,
  });
  const accessToken = options.accessToken ?? "ghu_current";
  const refreshToken = options.refreshToken ?? "ghr_current";
  const claimed = await stores().connections.claimOAuthCallback({
    stateHash: sha256Hex(flow.state),
    loginSessionHash,
  });
  await stores().connections.completeAuthorization(account.id, {
    connectionId: claimed.connectionId,
    flowId: claimed.flowId,
    stateHash: sha256Hex(flow.state),
    loginSessionHash,
    expectedAuthorizationVersion: claimed.expectedAuthorizationVersion,
    githubUserId: "42",
    githubLogin: "octocat",
    credential: (bindingValue) => {
      const material = cipher.encryptUserCredential(bindingValue, { accessToken, refreshToken });
      return {
        ciphertext: material.ciphertext,
        keyId: material.keyId,
        accessExpiresAt: new Date(clock.getTime() + (options.accessExpiresInMs ?? 30 * 60_000)),
        refreshExpiresAt: new Date(clock.getTime() + 180 * 86_400_000),
      };
    },
  });
  if (options.bindings) {
    await unit.database
      .update(githubConnections)
      .set({ repositoryBindings: options.bindings })
      .where(eq(githubConnections.id, flow.connectionId));
  }
  return { accountId: account.id, connectionId: flow.connectionId, flow };
}

/** Forces the connection's next recheck into the past so the worker scans it. */
async function makeRecheckDue(connectionId: string) {
  await unit.database
    .update(githubConnections)
    .set({ nextRecheckAt: new Date(clock.getTime() - 1_000) })
    .where(eq(githubConnections.id, connectionId));
}

function binding(agentId: string, access: "read" | "write" = "write"): GitHubRepositoryBinding {
  return {
    bindingId: crypto.randomUUID(),
    installationId: "55123456",
    repositoryId: "987654321",
    fullNameDisplay: "octocat/hello-world",
    agentScopes: [
      access === "write"
        ? { agentId, role: "code", access: "write", publish: "direct" }
        : { agentId, role: "code", access: "read" },
    ],
  };
}

async function rowOf(connectionId: string) {
  const [row] = await unit.database.select().from(githubConnections).where(eq(githubConnections.id, connectionId));
  return row;
}

describe("GitHubMaintenanceWorker refresh pass", () => {
  it("refreshes a due connection once, rotating the sealed credential and generation", async () => {
    const { connectionId } = await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockResolvedValue(tokenMaterial({ accessToken: "ghu_next", refreshToken: "ghr_next" }));

    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.completed).toBe(1);
    expect(api.refreshUserToken).toHaveBeenCalledTimes(1);
    expect(api.refreshUserToken.mock.calls[0]?.[0]).toEqual({ refreshToken: "ghr_current" });
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.credentialGeneration).toBe(2n);
    expect(row?.refreshStatus).toBe("idle");
    expect(api.validateOAuthToken).not.toHaveBeenCalled();
    expect(api.getAuthenticatedUser).not.toHaveBeenCalled();
    const opened = cipher.decryptUserCredential(
      {
        connectionId,
        accountId: row?.accountId as string,
        githubHost: "github.com",
        oauthClientId: GITHUB_TEST_CLIENT_ID,
        githubUserId: "42",
      },
      { ciphertext: row?.credentialCiphertext as string, keyId: row?.credentialKeyId as string },
    );
    expect(opened).toEqual({ accessToken: "ghu_next", refreshToken: "ghr_next" });
    // A second tick finds nothing due: the new token is outside the refresh window.
    const second = await workerFor(api.asClient()).runTickOnce();
    expect(second.refresh.claimed).toBe(0);
  });

  it.each([
    ["rate limit", GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED],
    ["timeout or 5xx", GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE],
    ["malformed response", GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID],
  ])("retains the rotated pair after a recheck %s without replaying the refresh", async (_label, code) => {
    const { connectionId } = await activeConnection();
    await makeRecheckDue(connectionId);
    const before = await rowOf(connectionId);
    const api = stubGitHubApi();
    api.refreshUserToken.mockResolvedValue(tokenMaterial({ accessToken: "ghu_next", refreshToken: "ghr_next" }));
    api.getAuthenticatedUser.mockRejectedValueOnce(new GitHubApiClientError(code, "recheck failed"));
    const worker = workerFor(api.asClient());

    const result = await worker.runTickOnce();
    expect(result.refresh).toMatchObject({ completed: 1, failed: 0, released: 0 });
    expect(result.recheck).toMatchObject({ transient: 1, unauthorized: 0 });
    const rotated = await rowOf(connectionId);
    if (!rotated?.credentialCiphertext || !rotated.credentialKeyId) throw new Error("Missing rotated credential");
    expect(rotated).toMatchObject({
      status: "active",
      credentialGeneration: 2n,
      authorizationVersion: before?.authorizationVersion,
      refreshStatus: "idle",
      refreshAttemptId: null,
      recheckRequired: true,
    });
    expect(
      cipher.decryptUserCredential(
        {
          connectionId,
          accountId: rotated.accountId,
          githubHost: "github.com",
          oauthClientId: GITHUB_TEST_CLIENT_ID,
          githubUserId: "42",
        },
        { ciphertext: rotated.credentialCiphertext, keyId: rotated.credentialKeyId },
      ),
    ).toEqual({ accessToken: "ghu_next", refreshToken: "ghr_next" });
    expect(api.getAuthenticatedUser).toHaveBeenCalledWith({ accessToken: "ghu_next" });

    clock = new Date(clock.getTime() + 6 * 60_000);
    const recovered = await worker.runTickOnce();
    expect(recovered.refresh.claimed).toBe(0);
    expect(recovered.recheck.healthy).toBe(1);
    expect(await rowOf(connectionId)).toMatchObject({
      credentialCiphertext: rotated?.credentialCiphertext,
      credentialGeneration: 2n,
      authorizationVersion: before?.authorizationVersion,
      recheckRequired: false,
    });
    expect(api.refreshUserToken).toHaveBeenCalledExactlyOnceWith({ refreshToken: "ghr_current" });
    expect(api.validateOAuthToken).not.toHaveBeenCalled();
  });

  it.each(["identity mismatch", "revoked repo scope"])(
    "invalidates a rotated pair on a definite %s",
    async (failure) => {
      const { connectionId } = await activeConnection();
      await makeRecheckDue(connectionId);
      const api = stubGitHubApi();
      api.refreshUserToken.mockResolvedValue(tokenMaterial());
      if (failure === "identity mismatch") api.getAuthenticatedUser.mockResolvedValue({ id: "999", login: "foreign" });
      else
        api.getAuthenticatedUser.mockRejectedValue(
          new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID, "Missing repo scope"),
        );
      const worker = workerFor(api.asClient());

      const result = await worker.runTickOnce();
      expect(result.refresh.completed).toBe(1);
      expect(result.recheck.unauthorized).toBe(1);
      expect(await rowOf(connectionId)).toMatchObject({
        status: "reauthorization_required",
        credentialCiphertext: null,
      });
      expect((await worker.runTickOnce()).refresh.claimed).toBe(0);
      expect(api.refreshUserToken).toHaveBeenCalledTimes(1);
      expect(api.validateOAuthToken).not.toHaveBeenCalled();
    },
  );

  it("marks reauthorization on a definitive rejection and never replays the grant", async () => {
    const { connectionId } = await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockRejectedValue(
      new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.OAUTH_EXCHANGE_REJECTED, "invalid_grant"),
    );
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.failed).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("reauthorization_required");
    expect(row?.credentialCiphertext).toBeNull();
    expect(row?.lastErrorCode).toBe("GITHUB_CREDENTIAL_INVALID");
    expect(api.refreshUserToken).toHaveBeenCalledTimes(1);
  });

  it("marks reauthorization on an unknown exchange outcome instead of replaying the refresh token", async () => {
    const { connectionId } = await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockRejectedValue(
      new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE, "timeout"),
    );
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.failed).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("reauthorization_required");
    expect(row?.lastErrorCode).toBe(GITHUB_REFRESH_OUTCOME_UNKNOWN_ERROR_CODE);
    expect(row?.refreshStatus).toBe("unknown");
    // No retry happens afterwards: the row is no longer active, so no claim is possible.
    const second = await workerFor(api.asClient()).runTickOnce();
    expect(second.refresh.claimed).toBe(0);
    expect(api.refreshUserToken).toHaveBeenCalledTimes(1);
  });

  it("releases the claim untouched when GitHub rate-limits the exchange", async () => {
    const { connectionId } = await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockRejectedValue(
      new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED, "slow down", {
        status: 429,
        retryAfterSeconds: 60,
      }),
    );
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.released).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.refreshStatus).toBe("idle");
    expect(row?.credentialCiphertext).toBeTruthy();
    // The connection is claimable again with the still-valid token.
    api.refreshUserToken.mockResolvedValue(tokenMaterial());
    const second = await workerFor(api.asClient()).runTickOnce();
    expect(second.refresh.completed).toBe(1);
  });

  it("releases the claim without destroying the credential when the envelope fails local authentication", async () => {
    const { accountId, connectionId } = await activeConnection();
    const before = await rowOf(connectionId);
    // The stored envelope no longer authenticates against the row's binding (here: sealed for a
    // different connection ID). GitHub is never contacted, so the still-valid credential pair must
    // survive and the claim must release for a later retry — never a blind reauthorization.
    const foreign = cipher.encryptUserCredential(
      {
        connectionId: crypto.randomUUID(),
        accountId,
        githubHost: "github.com",
        oauthClientId: GITHUB_TEST_CLIENT_ID,
        githubUserId: "42",
      },
      { accessToken: "ghu_current", refreshToken: "ghr_current" },
    );
    await unit.database
      .update(githubConnections)
      .set({ credentialCiphertext: foreign.ciphertext })
      .where(eq(githubConnections.id, connectionId));

    const api = stubGitHubApi();
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.released).toBe(1);
    expect(summary.refresh.failed).toBe(0);
    expect(api.refreshUserToken).not.toHaveBeenCalled();
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.refreshStatus).toBe("idle");
    expect(row?.credentialCiphertext).toBe(foreign.ciphertext);
    expect(row?.authorizationVersion).toBe(before?.authorizationVersion);

    // Once the envelope authenticates again, the next claim completes normally.
    const repaired = cipher.encryptUserCredential(
      {
        connectionId,
        accountId,
        githubHost: "github.com",
        oauthClientId: GITHUB_TEST_CLIENT_ID,
        githubUserId: "42",
      },
      { accessToken: "ghu_current", refreshToken: "ghr_current" },
    );
    await unit.database
      .update(githubConnections)
      .set({ credentialCiphertext: repaired.ciphertext })
      .where(eq(githubConnections.id, connectionId));
    api.refreshUserToken.mockResolvedValue(tokenMaterial({ accessToken: "ghu_next", refreshToken: "ghr_next" }));
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });

    const second = await workerFor(api.asClient()).runTickOnce();
    expect(second.refresh.completed).toBe(1);
  });

  it("keeps the refreshed pair when a verdict against the old credential lands late", async () => {
    const { accountId, connectionId } = await activeConnection();
    await makeRecheckDue(connectionId);
    // The recheck fencing captured here evaluates the pre-refresh credential.
    const { recheckStore } = stores();
    const [stale] = await recheckStore.listDueForRecheck({ limit: 10 });
    if (!stale) throw new Error("expected a due recheck");
    const api = stubGitHubApi();
    api.refreshUserToken.mockResolvedValue(tokenMaterial({ accessToken: "ghu_next", refreshToken: "ghr_next" }));
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });

    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.completed).toBe(1);
    // The tick's recheck pass fenced after the rotation and verified the new pair healthy.
    expect(summary.recheck.healthy).toBe(1);

    // The delayed verdict against the old credential must be dropped, not applied.
    const staleCommit = await recheckStore.commitRecheckResult({
      connectionId,
      expectedAuthorizationVersion: stale.authorizationVersion,
      expectedRecheckGeneration: stale.recheckGeneration,
      outcome: { kind: "unauthorized", errorCode: "GITHUB_CREDENTIAL_INVALID" },
    });
    expect(staleCommit).toEqual({ applied: false, reason: "stale" });
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.refreshStatus).toBe("idle");
    expect(row?.credentialGeneration).toBe(2n);
    expect(row?.authorizationVersion).toBe(stale.authorizationVersion);
    expect(row?.lastErrorCode).toBeNull();
    expect(row?.recheckRequired).toBe(false);
    expect(row?.nextRecheckAt?.getTime()).toBe(clock.getTime() + 5 * 60_000);
    const opened = cipher.decryptUserCredential(
      {
        connectionId,
        accountId,
        githubHost: "github.com",
        oauthClientId: GITHUB_TEST_CLIENT_ID,
        githubUserId: "42",
      },
      { ciphertext: row?.credentialCiphertext as string, keyId: row?.credentialKeyId as string },
    );
    expect(opened).toEqual({ accessToken: "ghu_next", refreshToken: "ghr_next" });

    // The next scheduled recheck evaluates the current credential normally.
    await makeRecheckDue(connectionId);
    const second = await workerFor(api.asClient()).runTickOnce();
    expect(second.recheck.healthy).toBe(1);
  });

  it("keeps the OAuth proof bound while a refresh runs against the same row", async () => {
    const account = await createAccount(unit);
    const { connections } = stores();
    const { flow } = await connections.createConnection(account.id, {
      oauthClientId: GITHUB_TEST_CLIENT_ID,
      loginSessionHash,
    });
    const claimed = await connections.claimOAuthCallback({ stateHash: sha256Hex(flow.state), loginSessionHash });
    await connections.completeAuthorization(account.id, {
      connectionId: claimed.connectionId,
      flowId: claimed.flowId,
      stateHash: sha256Hex(flow.state),
      loginSessionHash,
      expectedAuthorizationVersion: claimed.expectedAuthorizationVersion,
      githubUserId: "42",
      githubLogin: "octocat",
      credential: (binding) => {
        const material = cipher.encryptUserCredential(binding, { accessToken: "ghu_old", refreshToken: "ghr_old" });
        return {
          ciphertext: material.ciphertext,
          keyId: material.keyId,
          accessExpiresAt: new Date(clock.getTime() + 30 * 60_000),
          refreshExpiresAt: new Date(clock.getTime() + 180 * 86_400_000),
        };
      },
    });
    // A reauthorization flow begins (PKCE slot sealed); a refresh completes against the same row.
    const reauth = await connections.beginAuthorizationFlow(account.id, flow.connectionId, {
      intent: "reauthorize",
      loginSessionHash,
      oauthSecret: (binding) => cipher.encryptOAuthSecret(binding, "v".repeat(64)),
    });
    const api = stubGitHubApi();
    api.refreshUserToken.mockResolvedValue(tokenMaterial({ accessToken: "ghu_rotated" }));
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });

    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.completed).toBe(1);
    // The flow proof is still bound: the callback completes with the original verifier.
    const reauthClaimed = await connections.claimOAuthCallback({
      stateHash: sha256Hex(reauth.state),
      loginSessionHash,
    });
    const completion = await connections.completeAuthorization(account.id, {
      connectionId: reauthClaimed.connectionId,
      flowId: reauthClaimed.flowId,
      stateHash: sha256Hex(reauth.state),
      loginSessionHash,
      expectedAuthorizationVersion: reauthClaimed.expectedAuthorizationVersion,
      githubUserId: "42",
      githubLogin: "octocat",
      credential: (bindingValue) => {
        const material = cipher.encryptUserCredential(bindingValue, {
          accessToken: "ghu_reauth",
          refreshToken: "ghr_reauth",
        });
        return {
          ciphertext: material.ciphertext,
          keyId: material.keyId,
          accessExpiresAt: new Date(clock.getTime() + 8 * 3_600_000),
          refreshExpiresAt: new Date(clock.getTime() + 180 * 86_400_000),
        };
      },
    });
    expect(completion.connection.status).toBe("active");
    // A late refresh write from the pre-activation claim can never land.
    const row = await rowOf(flow.connectionId);
    expect(row?.refreshStatus).toBe("idle");
  });
});

describe("GitHubMaintenanceWorker recheck pass", () => {
  it("marks a healthy connection verified and schedules the next recheck", async () => {
    const { connectionId } = await activeConnection({
      bindings: [binding("1a63a21e-f6c7-4474-91ea-4dabf0566a24")],
      accessExpiresInMs: 8 * 3_600_000,
    });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });

    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.healthy).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.recheckRequired).toBe(false);
    expect(row?.lastVerifiedAt).toEqual(clock);
    expect(row?.nextRecheckAt?.getTime()).toBe(clock.getTime() + 5 * 60_000);
  });

  it("ignores retained repository configuration during connection rechecks", async () => {
    const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
    const { connectionId } = await activeConnection({
      bindings: [binding(agentId, "write")],
      accessExpiresInMs: 8 * 3_600_000,
    });
    await makeRecheckDue(connectionId);
    const before = await rowOf(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });

    // Rights are checked per operation; the connection worker checks credential identity only.

    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.healthy).toBe(1);

    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.authorizationVersion).toBe(before?.authorizationVersion);
    expect(row?.recheckRequired).toBe(false);
    expect(row?.lastErrorCode).toBeNull();
    expect(row?.credentialCiphertext).toBeTruthy();
  });

  it("invalidates fail-closed when the credential is dead upstream", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockRejectedValue(
      new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID, "401", { status: 401 }),
    );
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.unauthorized).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("reauthorization_required");
    expect(row?.credentialCiphertext).toBeNull();
    expect(row?.lastErrorCode).toBe("GITHUB_CREDENTIAL_INVALID");
  });

  it("defers a recheck whose access token is expired instead of clearing the recoverable credential", async () => {
    // Both connections expired beyond the access-token lifetime while their refresh tokens remain
    // valid. A one-row batch leaves the second connection unrefreshed when its recheck runs; the
    // recheck must defer to the refresh pass rather than read the expected 401 as a dead credential.
    const first = await activeConnection();
    const second = await activeConnection();
    await unit.database
      .update(githubConnections)
      .set({
        accessExpiresAt: new Date(clock.getTime() - 2 * 3_600_000),
        nextRecheckAt: new Date(clock.getTime() - 1_000),
      })
      .where(eq(githubConnections.id, first.connectionId));
    await unit.database
      .update(githubConnections)
      .set({
        accessExpiresAt: new Date(clock.getTime() - 1 * 3_600_000),
        nextRecheckAt: new Date(clock.getTime() - 2_000),
      })
      .where(eq(githubConnections.id, second.connectionId));
    const secondBefore = await rowOf(second.connectionId);

    const api = stubGitHubApi();
    api.refreshUserToken.mockResolvedValue(tokenMaterial());
    // GitHub rejects the expired access token but accepts the refreshed one.
    api.getAuthenticatedUser.mockImplementation(({ accessToken }: { accessToken: string }) =>
      accessToken === "ghu_current"
        ? Promise.reject(
            new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID, "401", { status: 401 }),
          )
        : Promise.resolve({ id: "42", login: "octocat" }),
    );

    const summary = await workerFor(api.asClient(), { batchLimit: 1 }).runTickOnce();
    expect(summary.refresh.completed).toBe(1);
    expect(summary.recheck.transient).toBe(1);
    expect(summary.recheck.unauthorized).toBe(0);
    // The deferred recheck never presented the expired token to GitHub.
    expect(api.getAuthenticatedUser).not.toHaveBeenCalledWith(expect.objectContaining({ accessToken: "ghu_current" }));
    const deferred = await rowOf(second.connectionId);
    expect(deferred?.status).toBe("active");
    expect(deferred?.credentialCiphertext).toBe(secondBefore?.credentialCiphertext);
    expect(deferred?.lastErrorCode).toBe("GITHUB_ACCESS_TOKEN_EXPIRED");
    expect(deferred?.recheckRequired).toBe(true);

    // The refresh pass then recovers the credential and the following recheck verifies healthy.
    clock = new Date(clock.getTime() + 6 * 60_000);
    const recovery = await workerFor(api.asClient()).runTickOnce();
    expect(recovery.refresh.completed).toBe(1);
    expect(recovery.recheck.healthy).toBe(2);
    const recovered = await rowOf(second.connectionId);
    expect(recovered?.status).toBe("active");
    expect(recovered?.refreshStatus).toBe("idle");
    const opened = cipher.decryptUserCredential(
      {
        connectionId: second.connectionId,
        accountId: recovered?.accountId as string,
        githubHost: "github.com",
        oauthClientId: GITHUB_TEST_CLIENT_ID,
        githubUserId: "42",
      },
      { ciphertext: recovered?.credentialCiphertext as string, keyId: recovered?.credentialKeyId as string },
    );
    expect(opened).toEqual({ accessToken: "ghu_access", refreshToken: "ghr_refresh" });
  });

  it("defers when the access token expires while the credential check is in flight", async () => {
    // The first connection absorbs the single refresh slot; the second is still unrefreshed when
    // its recheck runs. Its token is live at the snapshot but expires before the 401 arrives.
    const first = await activeConnection();
    const second = await activeConnection();
    await unit.database
      .update(githubConnections)
      .set({
        accessExpiresAt: new Date(clock.getTime() + 60_000),
        nextRecheckAt: new Date(clock.getTime() - 1_000),
      })
      .where(eq(githubConnections.id, first.connectionId));
    await unit.database
      .update(githubConnections)
      .set({
        accessExpiresAt: new Date(clock.getTime() + 5 * 60_000),
        nextRecheckAt: new Date(clock.getTime() - 2_000),
      })
      .where(eq(githubConnections.id, second.connectionId));
    const secondBefore = await rowOf(second.connectionId);

    const api = stubGitHubApi();
    api.refreshUserToken.mockResolvedValue(tokenMaterial());
    api.getAuthenticatedUser.mockImplementation(({ accessToken }: { accessToken: string }) => {
      if (accessToken !== "ghu_current") return Promise.resolve({ id: "42", login: "octocat" });
      // The credential check is slow: the rejection arrives after the presented token expired.
      clock = new Date(clock.getTime() + 10 * 60_000);
      return Promise.reject(
        new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID, "401", { status: 401 }),
      );
    });
    const summary = await workerFor(api.asClient(), { batchLimit: 1 }).runTickOnce();
    expect(summary.refresh.completed).toBe(1);
    expect(summary.recheck.transient).toBe(1);
    expect(summary.recheck.unauthorized).toBe(0);
    const row = await rowOf(second.connectionId);
    expect(row?.status).toBe("active");
    expect(row?.credentialCiphertext).toBe(secondBefore?.credentialCiphertext);
    expect(row?.lastErrorCode).toBe("GITHUB_ACCESS_TOKEN_EXPIRED");
    expect(row?.recheckRequired).toBe(true);
  });

  it("still invalidates fail-closed on a true identity mismatch with an unexpired token", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockResolvedValue({ id: "77", login: "someone-else" });
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.unauthorized).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("reauthorization_required");
    expect(row?.credentialCiphertext).toBeNull();
    expect(row?.lastErrorCode).toBe("GITHUB_IDENTITY_MISMATCH");
  });

  it("keeps the row active and retries on a transient upstream failure", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockRejectedValue(
      new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE, "503"),
    );
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.transient).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.recheckRequired).toBe(true);
    expect(row?.nextRecheckAt?.getTime()).toBe(clock.getTime() + 5 * 60_000);
  });

  it("never lets a stale recheck overwrite a newer invalidation", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const { recheckStore } = stores();
    const [due] = await recheckStore.listDueForRecheck({ limit: 10 });
    if (!due) throw new Error("expected a due connection");
    await unit.database
      .update(githubConnections)
      .set({
        status: "reauthorization_required",
        authorizationVersion: 99n,
        credentialCiphertext: null,
        credentialKeyId: null,
        accessExpiresAt: null,
        refreshExpiresAt: null,
        nextRecheckAt: null,
      })
      .where(eq(githubConnections.id, connectionId));
    const committed = await recheckStore.commitRecheckResult({
      connectionId,
      expectedAuthorizationVersion: due.authorizationVersion,
      expectedRecheckGeneration: due.recheckGeneration,
      outcome: { kind: "healthy" },
    });
    expect(committed).toEqual({ applied: false, reason: "not_active" });
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("reauthorization_required");
  });

  it("sweeps an expired pending flow so the Account can reconnect", async () => {
    const account = await createAccount(unit);
    const { recheckStore } = stores();
    // The flow was begun ten minutes ago and has now expired.
    const stale = new Date(clock.getTime() - 11 * 60_000);
    await new GitHubConnectionService(unit.database, { now: () => stale }).createConnection(account.id, {
      oauthClientId: GITHUB_TEST_CLIENT_ID,
      loginSessionHash,
    });
    const swept = await recheckStore.sweepExpiredOAuthFlows({ limit: 100 });
    expect(swept.clearedFlows).toBe(1);
    const rows = await unit.database.select().from(githubConnections);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oauthContext).toBeNull();
    expect(rows[0]?.status).toBe("pending");
  });
});

describe("GitHubMaintenanceWorker tick scheduling", () => {
  it("runs the first tick immediately, reschedules, and is idempotent on start", async () => {
    const api = stubGitHubApi();
    const worker = workerFor(api.asClient(), { intervalMs: 30_000 });
    const tick = vi.spyOn(worker, "runTickOnce");
    worker.start();
    // The first tick is scheduled with a zero delay, so it lands on the next macrotask.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tick).toHaveBeenCalledTimes(1);
    // A second start while running must not arm a second timer.
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tick).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it("logs a failed tick by error name and keeps the loop alive", async () => {
    const failures: { bindings: Record<string, unknown>; message: string }[] = [];
    const api = stubGitHubApi();
    const worker = workerFor(api.asClient(), {
      intervalMs: 1,
      logger: { error: (bindings, message) => failures.push({ bindings, message }), warn: () => undefined },
    });
    vi.spyOn(worker, "runTickOnce")
      .mockRejectedValueOnce(new TypeError("database is gone"))
      .mockResolvedValueOnce({
        sweptFlows: 0,
        refresh: { claimed: 0, completed: 0, failed: 0, released: 0, skipped: 0 },
        recheck: { scanned: 0, healthy: 0, unauthorized: 0, transient: 0 },
      });
    worker.start();
    await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 2_000 });
    await worker.stop();
    expect(failures[0]?.bindings).toEqual({ errorName: "TypeError" });
    expect(failures[0]?.message).toBe("GitHub maintenance tick failed");
  });

  it("records a non-Error tick failure by its type instead of a name", async () => {
    const failures: { bindings: Record<string, unknown>; message: string }[] = [];
    const api = stubGitHubApi();
    const worker = workerFor(api.asClient(), {
      intervalMs: 1,
      logger: { error: (bindings, message) => failures.push({ bindings, message }), warn: () => undefined },
    });
    vi.spyOn(worker, "runTickOnce").mockRejectedValueOnce("plain string failure");
    worker.start();
    await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 2_000 });
    await worker.stop();
    expect(failures[0]?.bindings).toEqual({ errorName: "string" });
  });

  it("stops scheduling and is safe to stop twice or before any start", async () => {
    const api = stubGitHubApi();
    const worker = workerFor(api.asClient(), { intervalMs: 2 });
    const tick = vi.spyOn(worker, "runTickOnce");
    worker.start();
    await vi.waitFor(() => expect(tick).toHaveBeenCalled(), { timeout: 2_000 });
    await worker.stop();
    const settled = tick.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tick.mock.calls.length).toBe(settled);
    await expect(worker.stop()).resolves.toBeUndefined();
    await expect(workerFor(api.asClient()).stop()).resolves.toBeUndefined();
  });
});

describe("GitHubMaintenanceWorker guards and defaults", () => {
  it("constructs with every documented default option omitted", async () => {
    const api = stubGitHubApi();
    const { refreshStore, recheckStore } = stores();
    const worker = new GitHubMaintenanceWorker({
      refreshStore,
      recheckStore,
      cipher,
      api: api.asClient(),
    });
    // Defaults are live: a fresh construction still performs a real bounded pass.
    await expect(worker.runTickOnce()).resolves.toEqual({
      sweptFlows: 0,
      refresh: { claimed: 0, completed: 0, failed: 0, released: 0, skipped: 0 },
      recheck: { scanned: 0, healthy: 0, unauthorized: 0, transient: 0 },
    });
  });

  it("contains a rejected tick through the default logger and its own no-op sinks", async () => {
    const api = stubGitHubApi();
    // No logger option at all: the worker installs its own silent warning/error sinks.
    const worker = workerFor(api.asClient(), { intervalMs: 1 });
    vi.spyOn(worker, "runTickOnce").mockRejectedValueOnce(new TypeError("database is gone"));
    worker.start();
    // Nothing may escape the chained tick; the default sink swallows the failure and the loop
    // keeps scheduling until it is explicitly stopped.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it("returns from the scheduler without arming a timer when stopped mid-tick", async () => {
    const api = stubGitHubApi();
    const worker = workerFor(api.asClient(), { intervalMs: 5 });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tick = vi.spyOn(worker, "runTickOnce").mockImplementation(async () => {
      started();
      await gate;
      return {
        sweptFlows: 0,
        refresh: { claimed: 0, completed: 0, failed: 0, released: 0, skipped: 0 },
        recheck: { scanned: 0, healthy: 0, unauthorized: 0, transient: 0 },
      };
    });
    worker.start();
    await running;
    // `stop()` clears the pending timer and flips `#stopped`; the in-flight tick then completes and
    // its `finally` calls `#scheduleNext`, which must observe the stop and arm nothing.
    const stopping = worker.stop();
    release();
    await stopping;
    expect(tick).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("skips a refresh candidate whose claim could not be taken", async () => {
    const { connectionId } = await activeConnection();
    const { refreshStore } = stores();
    // Holding the claim elsewhere makes the worker's own claim fail, which counts as skipped.
    expect((await refreshStore.claimRefresh(connectionId)).claimed).toBe(true);
    const api = stubGitHubApi();
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.claimed).toBe(0);
    expect(api.refreshUserToken).not.toHaveBeenCalled();
  });

  it("skips a candidate another worker claimed between the scan and the claim", async () => {
    const { connectionId } = await activeConnection();
    const api = stubGitHubApi();
    const { worker, refreshStore } = workerWithStores(api.asClient());
    // The due scan saw an idle row; a concurrent worker then took the claim. The worker's own
    // claim therefore loses the CAS and the candidate is counted as skipped, never attempted.
    const due = await refreshStore.listRefreshDue({ withinMs: 3_600_000, limit: 25 });
    expect(due).toHaveLength(1);
    const held = await refreshStore.claimRefresh(connectionId);
    expect(held.claimed).toBe(true);
    vi.spyOn(refreshStore, "listRefreshDue").mockResolvedValue(due);
    const summary = await worker.runTickOnce();
    expect(summary.refresh.claimed).toBe(0);
    expect(summary.refresh.skipped).toBe(1);
    expect(api.refreshUserToken).not.toHaveBeenCalled();
  });

  it("counts a refresh whose CAS lost the race as skipped, never as completed", async () => {
    await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockResolvedValue(tokenMaterial({ accessToken: "ghu_next", refreshToken: "ghr_next" }));
    const { worker, refreshStore } = workerWithStores(api.asClient());
    const complete = refreshStore.completeRefresh.bind(refreshStore);
    // The claim is voided underneath the exchange, so the rotation can no longer apply.
    vi.spyOn(refreshStore, "completeRefresh").mockImplementation(async (input) => {
      await refreshStore.releaseRefresh({
        connectionId: input.connectionId,
        attemptId: input.attemptId,
        expectedCredentialGeneration: input.expectedCredentialGeneration,
      });
      return complete(input);
    });
    const summary = await worker.runTickOnce();
    expect(summary.refresh.skipped).toBe(1);
    expect(summary.refresh.completed).toBe(0);
  });

  it("counts a failed refresh whose CAS lost the race as skipped", async () => {
    await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockRejectedValue(
      new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID, "dead"),
    );
    const { worker, refreshStore } = workerWithStores(api.asClient());
    const fail = refreshStore.failRefresh.bind(refreshStore);
    // The claim was already released, so the fail-closed report has nothing left to write.
    vi.spyOn(refreshStore, "failRefresh").mockImplementation(async (input) => {
      await refreshStore.releaseRefresh({
        connectionId: input.connectionId,
        attemptId: input.attemptId,
        expectedCredentialGeneration: input.expectedCredentialGeneration,
      });
      return fail(input);
    });
    const summary = await worker.runTickOnce();
    expect(summary.refresh.skipped).toBe(1);
    expect(summary.refresh.failed).toBe(0);
  });

  it("counts a released refresh whose CAS lost the race as skipped", async () => {
    await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockRejectedValue(
      new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED, "slow down", { status: 429 }),
    );
    const { worker, refreshStore } = workerWithStores(api.asClient());
    const release = refreshStore.releaseRefresh.bind(refreshStore);
    // The release applies for real, then reports back as if another writer had already won.
    vi.spyOn(refreshStore, "releaseRefresh").mockImplementation(async (input) => {
      await release(input);
      return { applied: false, reason: "stale" };
    });
    const summary = await worker.runTickOnce();
    expect(summary.refresh.skipped).toBe(1);
    expect(summary.refresh.released).toBe(0);
  });

  it("stops the refresh pass when the tick budget is already spent", async () => {
    await activeConnection();
    await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockResolvedValue(tokenMaterial());
    // A zero budget means the deadline has already passed when the loop starts.
    const summary = await workerFor(api.asClient(), { tickBudgetMs: 0 }).runTickOnce();
    expect(summary.refresh.claimed).toBe(0);
    expect(api.refreshUserToken).not.toHaveBeenCalled();
  });

  it("stops the recheck pass when the tick budget is already spent", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const summary = await workerFor(api.asClient(), { tickBudgetMs: 0 }).runTickOnce();
    expect(summary.recheck.scanned).toBe(0);
    expect(api.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it("narrows the refresh window so a healthy connection is not claimed", async () => {
    await activeConnection();
    const api = stubGitHubApi();
    // The access token expires in 30 minutes; a one-minute window leaves it out of scope.
    const summary = await workerFor(api.asClient(), { refreshWithinMs: 60_000 }).runTickOnce();
    expect(summary.refresh.claimed).toBe(0);
  });
});

describe("GitHubMaintenanceWorker recheck verdicts", () => {
  it("reports a transient failure when the recheck snapshot cannot be read", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    const { worker, recheckStore } = workerWithStores(api.asClient());
    // The row was removed between the due scan and the snapshot load.
    vi.spyOn(recheckStore, "getActiveRecheckSnapshot").mockRejectedValue(new Error("row vanished"));
    const summary = await worker.runTickOnce();
    expect(summary.recheck.transient).toBe(1);
    expect(api.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it("reports an unauthorized outcome when the row is no longer active", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    const { worker, recheckStore } = workerWithStores(api.asClient());
    vi.spyOn(recheckStore, "getActiveRecheckSnapshot").mockResolvedValue(null);
    const summary = await worker.runTickOnce();
    expect(summary.recheck.unauthorized).toBe(1);
    expect(api.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it("reports a transient failure when the sealed envelope cannot be opened for the read", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    const { worker, recheckStore } = workerWithStores(api.asClient());
    const snapshot = await recheckStore.getActiveRecheckSnapshot(connectionId);
    if (!snapshot) throw new Error("expected a snapshot");
    // AAD mismatch: the sealed envelope no longer authenticates against this row's binding, so no
    // credential verdict is possible and the row must stay active for a later retry.
    vi.spyOn(recheckStore, "getActiveRecheckSnapshot").mockResolvedValue({
      ...snapshot,
      accountId: crypto.randomUUID(),
    });
    const summary = await worker.runTickOnce();
    expect(summary.recheck.transient).toBe(1);
    expect(api.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it("reports a rate limit as its own transient code", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockRejectedValue(
      new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED, "slow down", { status: 429 }),
    );
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.transient).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.lastErrorCode).toBe("GITHUB_RATE_LIMITED");
  });

  it("reports an unrecognized failure as an upstream error", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockRejectedValue(new TypeError("socket hang up"));
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.transient).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.lastErrorCode).toBe("GITHUB_UPSTREAM_ERROR");
  });

  it("drops a recheck commit that lost the fencing race", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const { worker, recheckStore } = workerWithStores(api.asClient());
    const commit = recheckStore.commitRecheckResult.bind(recheckStore);
    // A concurrent invalidation bumps the authorization version before the commit lands.
    vi.spyOn(recheckStore, "commitRecheckResult").mockImplementation(async (input) => {
      await unit.database
        .update(githubConnections)
        .set({
          status: "reauthorization_required",
          authorizationVersion: 99n,
          credentialCiphertext: null,
          credentialKeyId: null,
          accessExpiresAt: null,
          refreshExpiresAt: null,
          nextRecheckAt: null,
        })
        .where(eq(githubConnections.id, input.connectionId));
      return commit(input);
    });
    const summary = await worker.runTickOnce();
    expect(summary.recheck.scanned).toBe(0);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("reauthorization_required");
  });

  it("verifies admission with no bindings without calling the admission service", async () => {
    const { connectionId } = await activeConnection({ accessExpiresInMs: 8 * 3_600_000 });
    await makeRecheckDue(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.healthy).toBe(1);
  });
});

describe("GitHubMaintenanceWorker refresh failure classification", () => {
  it.each([
    ["an unsupported token lifetime", GITHUB_API_CLIENT_ERROR_CODES.TOKEN_LIFETIME_UNSUPPORTED],
    ["a dead credential", GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID],
    ["a rejected grant", GITHUB_API_CLIENT_ERROR_CODES.OAUTH_EXCHANGE_REJECTED],
  ] as const)("fails the row on %s with the credential-invalid code", async (_label, code) => {
    const { connectionId } = await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockRejectedValue(new GitHubApiClientError(code, "rejected"));
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.failed).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("reauthorization_required");
    expect(row?.lastErrorCode).toBe("GITHUB_CREDENTIAL_INVALID");
  });

  it.each([
    ["a 5xx", new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE, "down")],
    ["a plain transport error", new TypeError("socket hang up")],
  ])("fails the row on %s with the unconfirmed-outcome code", async (_label, error) => {
    const { connectionId } = await activeConnection();
    const api = stubGitHubApi();
    api.refreshUserToken.mockRejectedValue(error);
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.failed).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("reauthorization_required");
    expect(row?.lastErrorCode).toBe(GITHUB_REFRESH_OUTCOME_UNKNOWN_ERROR_CODE);
  });

  it("releases a claim whose connection carries an unsupported host", async () => {
    const { connectionId } = await activeConnection();
    await unit.database
      .update(githubConnections)
      .set({ githubHost: "github.example.com" })
      .where(eq(githubConnections.id, connectionId));
    const api = stubGitHubApi();
    const summary = await workerFor(api.asClient()).runTickOnce();
    // The host is rejected before anything is presented to GitHub, so the claim is released intact.
    expect(summary.refresh.claimed).toBe(0);
    expect(api.refreshUserToken).not.toHaveBeenCalled();
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.credentialCiphertext).toBeTruthy();
  });
});
