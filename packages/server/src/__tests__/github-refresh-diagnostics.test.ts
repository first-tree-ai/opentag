import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApiClient } from "../services/github/github-api-client.js";
import { GitHubMaintenanceWorker } from "../services/github/github-maintenance-worker.js";
import type { GitHubConnectionRecheckStore } from "../services/github/github-recheck-store.js";
import type { ClaimedGitHubRefresh, GitHubCredentialRefreshStore } from "../services/github/github-refresh-store.js";
import { testCredentialCipher } from "./support/github-fixtures.js";

const SECRET = "NEVER_LOG_THIS_CREDENTIAL_OR_UPSTREAM_TEXT";
const NOW = new Date("2026-10-22T00:00:00Z");

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      access_token: `access_${SECRET}`,
      refresh_token: `refresh_${SECRET}`,
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
      scope: "repo offline_access",
      ...overrides,
    }),
    { status: 200 },
  );
}

function fixture() {
  const binding = {
    connectionId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    githubHost: "github.com" as const,
    oauthClientId: "Ov23testclient",
    githubUserId: "42",
  };
  const cipher = testCredentialCipher();
  const claim: ClaimedGitHubRefresh = {
    ...binding,
    attemptId: "33333333-3333-4333-8333-333333333333",
    credentialGeneration: 7n,
    accessExpiresAt: NOW,
    refreshExpiresAt: new Date("2027-01-01"),
    credential: cipher.encryptUserCredential(binding, { accessToken: SECRET, refreshToken: SECRET }),
  };
  const refreshStore = {
    listRefreshDue: vi.fn<GitHubCredentialRefreshStore["listRefreshDue"]>().mockResolvedValue([claim]),
    claimRefresh: vi.fn<GitHubCredentialRefreshStore["claimRefresh"]>().mockResolvedValue({ claimed: true, claim }),
    completeRefresh: vi.fn<GitHubCredentialRefreshStore["completeRefresh"]>().mockResolvedValue({ applied: true }),
    failRefresh: vi.fn<GitHubCredentialRefreshStore["failRefresh"]>().mockResolvedValue({ applied: true }),
    releaseRefresh: vi.fn<GitHubCredentialRefreshStore["releaseRefresh"]>().mockResolvedValue({ applied: true }),
  };
  const recheckStore = {
    sweepExpiredOAuthFlows: vi.fn().mockResolvedValue({ clearedFlows: 0 }),
    listDueForRecheck: vi.fn().mockResolvedValue([]),
  };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => tokenResponse());
  const api = new GitHubApiClient({
    clientId: binding.oauthClientId,
    clientSecret: SECRET,
    redirectUri: "https://opentag.example.com/callback",
    fetch: fetchImpl,
    now: () => NOW,
  });
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    info: vi.fn((fields: Record<string, unknown>, message: string) => logs.push({ level: "info", fields, message })),
    warn: vi.fn((fields: Record<string, unknown>, message: string) => logs.push({ level: "warn", fields, message })),
    error: vi.fn((fields: Record<string, unknown>, message: string) => logs.push({ level: "error", fields, message })),
  };
  const worker = new GitHubMaintenanceWorker({
    refreshStore: refreshStore as unknown as GitHubCredentialRefreshStore,
    recheckStore: recheckStore as unknown as GitHubConnectionRecheckStore,
    cipher,
    api,
    logger,
    now: () => NOW,
  });
  return { worker, claim, cipher, fetchImpl, api, refreshStore, logger, logs };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GitHub refresh diagnostics", () => {
  it("correlates every phase using monotonic durations and serializable fencing fields", async () => {
    const f = fixture();
    let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => ++monotonic);
    expect((await f.worker.runTickOnce()).refresh.completed).toBe(1);
    expect(f.logs.map(({ fields }) => [fields.phase, fields.outcome])).toEqual([
      ["decrypt", "started"],
      ["decrypt", "completed"],
      ["exchange", "started"],
      ["exchange", "completed"],
      ["seal", "started"],
      ["seal", "completed"],
      ["persist", "started"],
      ["persist", "completed"],
    ]);
    for (const { fields } of f.logs) {
      expect(fields).toMatchObject({
        module: "github-maintenance",
        operation: "github.refresh",
        connectionId: f.claim.connectionId,
        attemptId: f.claim.attemptId,
        credentialGeneration: "7",
      });
      expect(fields.durationMs).toBeGreaterThanOrEqual(0);
      expect(fields.elapsedMs).toBeGreaterThanOrEqual(fields.durationMs as number);
    }
    expect(f.logs.at(-1)?.fields.casApplied).toBe(true);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.refreshStore.completeRefresh).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        connectionId: f.claim.connectionId,
        attemptId: f.claim.attemptId,
        expectedCredentialGeneration: 7n,
      }),
    );
    expect(JSON.stringify(f.logs)).not.toContain(SECRET);
    expect(JSON.stringify(f.logs)).not.toContain(f.claim.credential.ciphertext);
  });

  it.each(["decrypt", "seal", "persist"] as const)(
    "identifies a local %s failure without logging its text",
    async (phase) => {
      const f = fixture();
      const error = Object.assign(new Error(`Bearer ${SECRET} https://example.com/?token=${SECRET}`), {
        name: SECRET,
        code: SECRET,
      });
      if (phase === "decrypt")
        vi.spyOn(f.cipher, "decryptUserCredential").mockImplementation(() => {
          throw error;
        });
      if (phase === "seal")
        vi.spyOn(f.cipher, "encryptUserCredential").mockImplementation(() => {
          throw error;
        });
      if (phase === "persist") f.refreshStore.completeRefresh.mockRejectedValue(error);
      const summary = await f.worker.runTickOnce();
      expect(f.logs.find((log) => log.level === "warn")?.fields).toMatchObject({ phase, outcome: "failed" });
      expect(f.fetchImpl).toHaveBeenCalledTimes(phase === "decrypt" ? 0 : 1);
      if (phase === "decrypt") {
        expect(summary.refresh.released).toBe(1);
        expect(f.refreshStore.failRefresh).not.toHaveBeenCalled();
        expect(f.refreshStore.releaseRefresh).toHaveBeenCalledTimes(1);
        expect(f.logs.at(-1)?.fields).toMatchObject({ phase: "settle", outcome: "released", casApplied: true });
        expect(f.logs.at(-1)?.fields.errorCode).toBeUndefined();
      } else {
        expect(summary.refresh.failed).toBe(1);
        expect(f.refreshStore.failRefresh).toHaveBeenCalledExactlyOnceWith({
          connectionId: f.claim.connectionId,
          attemptId: f.claim.attemptId,
          expectedCredentialGeneration: 7n,
          errorCode: "GITHUB_REFRESH_OUTCOME_UNKNOWN",
        });
      }
      expect(JSON.stringify(f.logs)).not.toContain(SECRET);
      expect(JSON.stringify(f.logs)).not.toContain(f.claim.credential.ciphertext);
    },
  );

  it.each([
    ["5xx", () => new Response(SECRET, { status: 502 }), "GITHUB_UPSTREAM_UNAVAILABLE", 502, "failed"],
    ["invalid JSON", () => new Response(SECRET, { status: 200 }), "GITHUB_API_RESPONSE_INVALID", 200, "failed"],
    [
      "rejected grant",
      () => tokenResponse({ error: "bad_refresh_token", error_description: SECRET }),
      "GITHUB_OAUTH_EXCHANGE_REJECTED",
      200,
      "failed",
    ],
    [
      "unsupported expiry",
      () => tokenResponse({ expires_in: undefined }),
      "GITHUB_TOKEN_LIFETIME_UNSUPPORTED",
      200,
      "failed",
    ],
    ["rate limit", () => new Response(SECRET, { status: 429 }), "GITHUB_RATE_LIMITED", 429, "released"],
  ] as const)(
    "records the real HTTP status on %s without changing settlement",
    async (_label, response, errorCode, status, outcome) => {
      const f = fixture();
      f.fetchImpl.mockImplementation(async () => response());
      const summary = await f.worker.runTickOnce();
      expect(f.logs.find((log) => log.level === "warn")?.fields).toMatchObject({
        phase: "exchange",
        errorCode,
        status,
      });
      expect(f.logs.at(-1)?.fields).toMatchObject({ phase: "settle", outcome, casApplied: true });
      expect(summary.refresh[outcome]).toBe(1);
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(f.logs)).not.toContain(SECRET);
    },
  );

  it.each(["ECONNRESET", SECRET])("allowlists transport cause code %s", async (code) => {
    const f = fixture();
    f.fetchImpl.mockRejectedValue(new TypeError(SECRET, { cause: Object.assign(new Error(SECRET), { code }) }));
    expect((await f.worker.runTickOnce()).refresh.failed).toBe(1);
    const failure = f.logs.find((log) => log.level === "warn")?.fields;
    expect(failure?.transportCode).toBe(code === "ECONNRESET" ? code : undefined);
    expect(failure?.status).toBeUndefined();
    expect(JSON.stringify(f.logs)).not.toContain(SECRET);
  });

  it("distinguishes the unchanged request deadline without replaying the grant", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetchImpl.mockImplementation(async () => new Promise<Response>(() => undefined));
    const pending = f.worker.runTickOnce();
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).refresh.failed).toBe(1);
    expect(f.logs.find((log) => log.level === "warn")?.fields).toMatchObject({
      phase: "exchange",
      errorCode: "GITHUB_UPSTREAM_UNAVAILABLE",
      transportCode: "request_timeout",
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.refreshStore.failRefresh).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ errorCode: "GITHUB_REFRESH_OUTCOME_UNKNOWN" }),
    );
  });

  it("records a stale completion without invalidating the connection", async () => {
    const f = fixture();
    f.refreshStore.completeRefresh.mockResolvedValue({ applied: false, reason: "stale" });
    expect((await f.worker.runTickOnce()).refresh.skipped).toBe(1);
    expect(f.logs.at(-1)?.fields).toMatchObject({ phase: "persist", outcome: "skipped", casApplied: false });
    expect(f.refreshStore.failRefresh).not.toHaveBeenCalled();
    expect(f.refreshStore.releaseRefresh).not.toHaveBeenCalled();
  });

  it("records a stale failure CAS without reporting reauthorization as applied", async () => {
    const f = fixture();
    f.fetchImpl.mockRejectedValue(new Error(SECRET));
    f.refreshStore.failRefresh.mockResolvedValue({ applied: false, reason: "stale" });
    expect((await f.worker.runTickOnce()).refresh.skipped).toBe(1);
    expect(f.logs.at(-1)?.fields).toMatchObject({ phase: "settle", outcome: "skipped", casApplied: false });
    expect(f.logs.at(-1)?.fields.errorCode).toBeUndefined();
  });

  it("preserves the original failure record when failure settlement also throws", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () => new Response(SECRET, { status: 502 }));
    const settlementError = new Error(SECRET);
    f.refreshStore.failRefresh.mockRejectedValue(settlementError);
    await expect(f.worker.runTickOnce()).rejects.toBe(settlementError);
    expect(f.logs.find((log) => log.level === "warn")?.fields).toMatchObject({ phase: "exchange", status: 502 });
    expect(f.logs.at(-1)).toMatchObject({
      level: "error",
      fields: { phase: "settle", failurePhase: "exchange", outcome: "failed" },
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.logs)).not.toContain(SECRET);
  });

  it.each([false, true])("a throwing logger leaves refresh success/failure unchanged (failure=%s)", async (failure) => {
    const f = fixture();
    for (const sink of Object.values(f.logger))
      sink.mockImplementation(() => {
        throw new Error(SECRET);
      });
    if (failure) f.fetchImpl.mockRejectedValue(new Error(SECRET));
    expect((await f.worker.runTickOnce()).refresh[failure ? "failed" : "completed"]).toBe(1);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.refreshStore.failRefresh).toHaveBeenCalledTimes(failure ? 1 : 0);
  });

  it("does not let throwing error accessors change settlement", async () => {
    const f = fixture();
    vi.spyOn(f.api, "refreshUserToken").mockRejectedValue(
      Object.defineProperty(new Error(SECRET), "code", {
        get() {
          throw new Error(SECRET);
        },
      }),
    );
    expect((await f.worker.runTickOnce()).refresh.failed).toBe(1);
    expect(JSON.stringify(f.logs)).not.toContain(SECRET);
  });
});
