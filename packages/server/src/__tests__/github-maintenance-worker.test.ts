import { createHmac } from "node:crypto";
import type { GitHubRepositoryBinding } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { GitHubWebhookService } from "../services/github/github-webhook.js";
import { sha256Hex } from "../services/github/hashes.js";
import { GitHubRepositoryAdmissionService } from "../services/github/repository-admission.js";
import {
  createAccount,
  GITHUB_TEST_APP_ID,
  installation,
  installationsPage,
  repositoriesPage,
  repository,
  stubGitHubApi,
  testCredentialCipher,
  tokenMaterial,
} from "./support/github-fixtures.js";
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
    refreshStore: new GitHubCredentialRefreshStore(unit.database, { now: () => clock }),
    recheckStore: new GitHubConnectionRecheckStore(unit.database, { now: () => clock }),
  };
}

function workerFor(api: GitHubApiClient, options: { batchLimit?: number } = {}) {
  const { refreshStore, recheckStore } = stores();
  return new GitHubMaintenanceWorker({
    refreshStore,
    recheckStore,
    cipher,
    api,
    admission: new GitHubRepositoryAdmissionService({ api, appId: GITHUB_TEST_APP_ID, now: () => clock }),
    now: () => clock,
    ...(options.batchLimit !== undefined ? { batchLimit: options.batchLimit } : {}),
  });
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
    appId: GITHUB_TEST_APP_ID,
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
    api.listUserInstallations.mockResolvedValue(installationsPage([]));
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.refresh.completed).toBe(1);
    expect(api.refreshUserToken).toHaveBeenCalledTimes(1);
    expect(api.refreshUserToken.mock.calls[0]?.[0]).toEqual({ refreshToken: "ghr_current" });
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.credentialGeneration).toBe(2n);
    expect(row?.refreshStatus).toBe("idle");
    const opened = cipher.decryptUserCredential(
      {
        connectionId,
        accountId: row?.accountId as string,
        githubHost: "github.com",
        appId: GITHUB_TEST_APP_ID,
        githubUserId: "42",
      },
      { ciphertext: row?.credentialCiphertext as string, keyId: row?.credentialKeyId as string },
    );
    expect(opened).toEqual({ accessToken: "ghu_next", refreshToken: "ghr_next" });
    // A second tick finds nothing due: the new token is outside the refresh window.
    const second = await workerFor(api.asClient()).runTickOnce();
    expect(second.refresh.claimed).toBe(0);
  });

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
        appId: GITHUB_TEST_APP_ID,
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
        appId: GITHUB_TEST_APP_ID,
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
    api.listUserInstallations.mockResolvedValue(installationsPage([]));
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
    api.listUserInstallations.mockResolvedValue(installationsPage([]));
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
        appId: GITHUB_TEST_APP_ID,
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
      appId: GITHUB_TEST_APP_ID,
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
    api.listUserInstallations.mockResolvedValue(installationsPage([]));
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
    api.listUserInstallations.mockResolvedValue(installationsPage([installation()]));
    api.listInstallationRepositories.mockResolvedValue(repositoriesPage([repository()]));
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.healthy).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.recheckRequired).toBe(false);
    expect(row?.lastVerifiedAt).toEqual(clock);
    expect(row?.nextRecheckAt?.getTime()).toBe(clock.getTime() + 5 * 60_000);
  });

  it("invalidates issued access on a user scope reduction without killing the credential", async () => {
    const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
    const { connectionId } = await activeConnection({
      bindings: [binding(agentId, "write")],
      accessExpiresInMs: 8 * 3_600_000,
    });
    await makeRecheckDue(connectionId);
    const before = await rowOf(connectionId);
    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    api.listUserInstallations.mockResolvedValue(installationsPage([installation()]));
    // The user lost push: only pull remains. No webhook ever arrived — the periodic scan catches it.
    api.listInstallationRepositories.mockResolvedValue(
      repositoriesPage([repository({ permissions: { admin: false, pull: true, push: false } })]),
    );
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.permissionRevoked).toBe(1);
    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.authorizationVersion).toBe((before?.authorizationVersion ?? 0n) + 1n);
    expect(row?.recheckRequired).toBe(true);
    expect(row?.lastErrorCode).toBe("GITHUB_PERMISSION_REVOKED");
    expect(row?.credentialCiphertext).toBeTruthy();
  });

  it("takes a webhook-marked installation deletion through the worker to a runtime invalidation", async () => {
    const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
    const { connectionId } = await activeConnection({
      bindings: [binding(agentId)],
      accessExpiresInMs: 8 * 3_600_000,
    });
    const before = await rowOf(connectionId);
    const { recheckStore } = stores();
    const webhook = new GitHubWebhookService({ webhookSecret: "webhook-secret", recheckStore, now: () => clock });
    const payload = Buffer.from(JSON.stringify({ action: "deleted", installation: { id: 55123456 } }), "utf8");
    const verdict = await webhook.handle({
      rawBody: payload,
      signature256: `sha256=${createHmac("sha256", "webhook-secret").update(payload).digest("hex")}`,
      event: "installation",
      deliveryId: "delivery-installation-deleted",
    });
    expect(verdict).toMatchObject({ status: "processed", recheckMarkedConnections: 1 });

    // The webhook itself does not bump the authorization version: the worker's authoritative
    // admission is what invalidates issued runtime access.
    const marked = await rowOf(connectionId);
    expect(marked?.authorizationVersion).toBe(before?.authorizationVersion);
    expect(marked?.recheckRequired).toBe(true);

    const api = stubGitHubApi();
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    // The installation is gone, so the connected user can no longer reach any repository through it.
    api.listUserInstallations.mockResolvedValue(installationsPage([]));
    const summary = await workerFor(api.asClient()).runTickOnce();
    expect(summary.recheck.permissionRevoked).toBe(1);

    const row = await rowOf(connectionId);
    expect(row?.status).toBe("active");
    expect(row?.authorizationVersion).toBe((before?.authorizationVersion ?? 0n) + 1n);
    expect(row?.recheckRequired).toBe(true);
    expect(row?.lastErrorCode).toBe("GITHUB_PERMISSION_REVOKED");
    expect(row?.credentialCiphertext).toBe(before?.credentialCiphertext);
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
    api.listUserInstallations.mockResolvedValue(installationsPage([]));
    const summary = await workerFor(api.asClient(), { batchLimit: 1 }).runTickOnce();
    expect(summary.refresh.completed).toBe(1);
    expect(summary.recheck.transient).toBe(1);
    expect(summary.recheck.unauthorized).toBe(0);
    // The deferred recheck never presented the expired token to GitHub.
    expect(api.getAuthenticatedUser).not.toHaveBeenCalled();
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
        appId: GITHUB_TEST_APP_ID,
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
    api.getAuthenticatedUser.mockImplementation(() => {
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
    await recheckStore.invalidateActiveConnections({
      connectionIds: [connectionId],
      errorCode: "GITHUB_CREDENTIAL_INVALID",
    });
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
      appId: GITHUB_TEST_APP_ID,
      loginSessionHash,
    });
    const swept = await recheckStore.sweepExpiredOAuthFlows({ limit: 100 });
    expect(swept.deletedPending).toBe(1);
    const rows = await unit.database.select().from(githubConnections);
    expect(rows).toHaveLength(0);
  });
});
