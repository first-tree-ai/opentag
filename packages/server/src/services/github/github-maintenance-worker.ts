/*
 * The bounded periodic GitHub connection maintenance worker.
 *
 * One chained-timeout loop (never overlapping ticks): sweep expired OAuth flows, then a refresh
 * pass and a recheck pass over the due active rows, each bounded by a row batch and a tick budget,
 * and every GitHub call individually time-limited by the API client.
 *
 * Refresh semantics: a claimed attempt completes exactly once through the store CAS. A definitive
 * rejection (invalid grant, dead credential, unsupported token lifetime) fails the row into
 * reauthorization_required; a rate limit releases the claim untouched because the platform
 * provably did not consume the refresh token; any other unknown outcome — timeout, network, 5xx,
 * unreadable response — also fails into reauthorization_required, because a consumed refresh token
 * must never be replayed. Recheck semantics: /user proves the credential and identity, then live
 * admission re-verifies every current binding; revoked permissions bump the authorization version
 * (issued runtime access dies) while the row stays active for reconfiguration, and a dead
 * credential invalidates fail-closed.
 */

import type { GitHubCredentialCipher } from "../github-credential-material.js";
import { GitHubConnectionServiceError } from "./errors.js";
import { GITHUB_API_CLIENT_ERROR_CODES, type GitHubApiClient, GitHubApiClientError } from "./github-api-client.js";
import type {
  GitHubActiveConnectionSnapshot,
  GitHubConnectionRecheckStore,
  GitHubRecheckOutcome,
} from "./github-recheck-store.js";
import {
  type ClaimedGitHubRefresh,
  GITHUB_REFRESH_OUTCOME_UNKNOWN_ERROR_CODE,
  type GitHubCredentialRefreshStore,
} from "./github-refresh-store.js";
import type { GitHubRepositoryAdmissionService } from "./repository-admission.js";

export interface GitHubMaintenanceWorkerOptions {
  refreshStore: GitHubCredentialRefreshStore;
  recheckStore: GitHubConnectionRecheckStore;
  cipher: GitHubCredentialCipher;
  api: GitHubApiClient;
  admission: GitHubRepositoryAdmissionService;
  /** Delay between the end of one tick and the start of the next. */
  intervalMs?: number;
  /** Soft per-tick time budget; the current row always finishes, the next one waits for a tick. */
  tickBudgetMs?: number;
  /** Rows per pass per tick. */
  batchLimit?: number;
  /** Rows whose access token expires inside this window are refreshed. */
  refreshWithinMs?: number;
  now?: () => Date;
  logger?: {
    warn: (bindings: Record<string, unknown>, message: string) => void;
    error: (bindings: Record<string, unknown>, message: string) => void;
  };
}

export interface GitHubMaintenanceTickSummary {
  sweptFlows: number;
  deletedPending: number;
  refresh: { claimed: number; completed: number; failed: number; released: number; skipped: number };
  recheck: { scanned: number; healthy: number; permissionRevoked: number; unauthorized: number; transient: number };
}

/** One recheck load: either the fenced snapshot to verify, or the verdict that ended it early. */
type RecheckSnapshotLoad =
  | { kind: "active"; active: GitHubActiveConnectionSnapshot }
  | { kind: "outcome"; outcome: GitHubRecheckOutcome };

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TICK_BUDGET_MS = 45_000;
const DEFAULT_BATCH_LIMIT = 25;
const DEFAULT_REFRESH_WITHIN_MS = 3_600_000;
const GITHUB_CREDENTIAL_INVALID_CODE = "GITHUB_CREDENTIAL_INVALID";
const GITHUB_PERMISSION_REVOKED_CODE = "GITHUB_PERMISSION_REVOKED";
const GITHUB_IDENTITY_MISMATCH_CODE = "GITHUB_IDENTITY_MISMATCH";
const GITHUB_RATE_LIMITED_CODE = "GITHUB_RATE_LIMITED";
const GITHUB_UPSTREAM_UNAVAILABLE_CODE = "GITHUB_UPSTREAM_UNAVAILABLE";
const GITHUB_UPSTREAM_ERROR_CODE = "GITHUB_UPSTREAM_ERROR";

export class GitHubMaintenanceWorker {
  readonly #refreshStore: GitHubCredentialRefreshStore;
  readonly #recheckStore: GitHubConnectionRecheckStore;
  readonly #cipher: GitHubCredentialCipher;
  readonly #api: GitHubApiClient;
  readonly #admission: GitHubRepositoryAdmissionService;
  readonly #intervalMs: number;
  readonly #tickBudgetMs: number;
  readonly #batchLimit: number;
  readonly #refreshWithinMs: number;
  readonly #now: () => Date;
  readonly #logger: NonNullable<GitHubMaintenanceWorkerOptions["logger"]>;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;
  #stopped = true;

  constructor(options: GitHubMaintenanceWorkerOptions) {
    this.#refreshStore = options.refreshStore;
    this.#recheckStore = options.recheckStore;
    this.#cipher = options.cipher;
    this.#api = options.api;
    this.#admission = options.admission;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#tickBudgetMs = options.tickBudgetMs ?? DEFAULT_TICK_BUDGET_MS;
    this.#batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.#refreshWithinMs = options.refreshWithinMs ?? DEFAULT_REFRESH_WITHIN_MS;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? { warn: () => undefined, error: () => undefined };
  }

  /** Starts the chained-tick loop. Idempotent; ticks never overlap. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#scheduleNext(0);
  }

  /** Stops scheduling and waits for the in-flight tick, if any, to finish its current work. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#inFlight;
  }

  #scheduleNext(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const tick: Promise<void> = Promise.resolve()
        .then(() => this.runTickOnce())
        .then(
          () => undefined,
          (error: unknown) => {
            this.#logger.error(
              { errorName: error instanceof Error ? error.name : typeof error },
              "GitHub maintenance tick failed",
            );
          },
        )
        .finally(() => {
          if (this.#inFlight === tick) this.#inFlight = undefined;
          this.#scheduleNext(this.#intervalMs);
        });
      this.#inFlight = tick;
    }, delayMs);
    this.#timer.unref?.();
  }

  /** One bounded maintenance pass; exposed directly for tests and never concurrent with itself. */
  async runTickOnce(): Promise<GitHubMaintenanceTickSummary> {
    const deadline = this.#now().getTime() + this.#tickBudgetMs;
    const summary: GitHubMaintenanceTickSummary = {
      sweptFlows: 0,
      deletedPending: 0,
      refresh: { claimed: 0, completed: 0, failed: 0, released: 0, skipped: 0 },
      recheck: { scanned: 0, healthy: 0, permissionRevoked: 0, unauthorized: 0, transient: 0 },
    };
    const swept = await this.#recheckStore.sweepExpiredOAuthFlows({ limit: 100 });
    summary.sweptFlows = swept.clearedFlows;
    summary.deletedPending = swept.deletedPending;

    const candidates = await this.#refreshStore.listRefreshDue({
      withinMs: this.#refreshWithinMs,
      limit: this.#batchLimit,
    });
    for (const candidate of candidates) {
      if (this.#now().getTime() >= deadline) break;
      await this.#refreshOne(candidate.connectionId, summary.refresh);
    }

    const due = await this.#recheckStore.listDueForRecheck({ limit: this.#batchLimit });
    for (const entry of due) {
      if (this.#now().getTime() >= deadline) break;
      await this.#recheckOne(entry.connectionId, entry, summary.recheck);
    }
    return summary;
  }

  async #refreshOne(connectionId: string, summary: GitHubMaintenanceTickSummary["refresh"]): Promise<void> {
    const claimed = await this.#refreshStore.claimRefresh(connectionId);
    if (!claimed.claimed) {
      summary.skipped += 1;
      return;
    }
    summary.claimed += 1;
    const claim = claimed.claim;
    try {
      const applied = await this.#exchangeRefresh(claim);
      if (applied) summary.completed += 1;
      else summary.skipped += 1;
    } catch (error) {
      const outcome = await this.#reportRefreshFailure(claim, error);
      if (outcome === "released") summary.released += 1;
      else if (outcome === "failed") summary.failed += 1;
      else summary.skipped += 1;
    }
  }

  /** One rotation of a claimed attempt; the store CAS decides whether the sealed pair lands. */
  async #exchangeRefresh(claim: ClaimedGitHubRefresh): Promise<boolean> {
    const current = this.#decryptClaimed(claim);
    const tokens = await this.#api.refreshUserToken({ refreshToken: current.refreshToken });
    const sealed = this.#cipher.encryptUserCredential(bindingOf(claim), {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
    const applied = await this.#refreshStore.completeRefresh({
      connectionId: claim.connectionId,
      attemptId: claim.attemptId,
      expectedCredentialGeneration: claim.credentialGeneration,
      credential: {
        ciphertext: sealed.ciphertext,
        keyId: sealed.keyId,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
      },
    });
    return applied.applied;
  }

  /**
   * Classifies a failed exchange and reports it through the store. A rate limit provably never
   * consumed the refresh token, so the claim is released untouched; everything else — including an
   * unconfirmed outcome — fails the row into reauthorization_required, because a possibly consumed
   * refresh token must never be replayed.
   */
  async #reportRefreshFailure(claim: ClaimedGitHubRefresh, error: unknown): Promise<"released" | "failed" | "skipped"> {
    if (error instanceof GitHubApiClientError && error.code === GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED) {
      const applied = await this.#refreshStore.releaseRefresh({
        connectionId: claim.connectionId,
        attemptId: claim.attemptId,
        expectedCredentialGeneration: claim.credentialGeneration,
      });
      return applied.applied ? "released" : "skipped";
    }
    const applied = await this.#refreshStore.failRefresh({
      connectionId: claim.connectionId,
      attemptId: claim.attemptId,
      expectedCredentialGeneration: claim.credentialGeneration,
      errorCode: refreshFailureCode(error),
    });
    return applied.applied ? "failed" : "skipped";
  }

  async #recheckOne(
    connectionId: string,
    fencing: { authorizationVersion: bigint; recheckGeneration: bigint },
    summary: GitHubMaintenanceTickSummary["recheck"],
  ): Promise<void> {
    summary.scanned += 1;
    const outcome = await this.#evaluate(connectionId);
    const committed = await this.#recheckStore.commitRecheckResult({
      connectionId,
      expectedAuthorizationVersion: fencing.authorizationVersion,
      expectedRecheckGeneration: fencing.recheckGeneration,
      outcome,
    });
    if (!committed.applied) {
      summary.scanned -= 1;
      return;
    }
    if (outcome.kind === "healthy") summary.healthy += 1;
    else if (outcome.kind === "permission_revoked") summary.permissionRevoked += 1;
    else if (outcome.kind === "unauthorized") summary.unauthorized += 1;
    else summary.transient += 1;
  }

  async #evaluate(connectionId: string): Promise<GitHubRecheckOutcome> {
    const loaded = await this.#loadRecheckSnapshot(connectionId);
    if (loaded.kind === "outcome") return loaded.outcome;
    const accessToken = this.#openAccessToken(loaded.active);
    if (accessToken === null) return { kind: "transient_failure", errorCode: GITHUB_UPSTREAM_ERROR_CODE };
    return this.#verifyAdmission(loaded.active, accessToken);
  }

  /** Reads the fenced snapshot; a missing or unreadable row is already a verdict, not a throw. */
  async #loadRecheckSnapshot(connectionId: string): Promise<RecheckSnapshotLoad> {
    try {
      const active = await this.#recheckStore.getActiveRecheckSnapshot(connectionId);
      if (active === null) {
        return { kind: "outcome", outcome: { kind: "unauthorized", errorCode: GITHUB_CREDENTIAL_INVALID_CODE } };
      }
      return { kind: "active", active };
    } catch {
      return { kind: "outcome", outcome: { kind: "transient_failure", errorCode: GITHUB_UPSTREAM_ERROR_CODE } };
    }
  }

  /** Opens the sealed UAT; an unauthenticated envelope is transient, never a credential verdict. */
  #openAccessToken(snapshot: GitHubActiveConnectionSnapshot): string | null {
    try {
      return this.#cipher.decryptUserCredential(
        {
          connectionId: snapshot.connectionId,
          accountId: snapshot.accountId,
          githubHost: "github.com",
          appId: snapshot.appId,
          githubUserId: snapshot.githubUserId,
        },
        snapshot.credential,
      ).accessToken;
    } catch {
      return null;
    }
  }

  async #verifyAdmission(snapshot: GitHubActiveConnectionSnapshot, accessToken: string): Promise<GitHubRecheckOutcome> {
    try {
      const user = await this.#api.getAuthenticatedUser({ accessToken });
      if (user.id !== snapshot.githubUserId) {
        return { kind: "unauthorized", errorCode: GITHUB_IDENTITY_MISMATCH_CODE };
      }
      if (snapshot.bindings.length === 0) return { kind: "healthy" };
      await this.#admission.verifyAdmission({
        accessToken,
        connectionId: snapshot.connectionId,
        authorizationVersion: snapshot.authorizationVersion,
        githubUserId: snapshot.githubUserId,
        bindings: snapshot.bindings,
      });
      return { kind: "healthy" };
    } catch (error) {
      return classifyRecheckFailure(error);
    }
  }

  #decryptClaimed(claim: ClaimedGitHubRefresh): { refreshToken: string } {
    return this.#cipher.decryptUserCredential(bindingOf(claim), claim.credential);
  }
}

function bindingOf(claim: ClaimedGitHubRefresh) {
  if (claim.githubHost !== "github.com") {
    throw new Error("An active GitHub connection carries an unsupported host");
  }
  return {
    connectionId: claim.connectionId,
    accountId: claim.accountId,
    githubHost: "github.com" as const,
    appId: claim.appId,
    githubUserId: claim.githubUserId,
  };
}

/** A definitive rejection is a dead credential; anything unconfirmed must fail closed. */
function refreshFailureCode(error: unknown): string {
  const definitive =
    error instanceof GitHubApiClientError &&
    (error.code === GITHUB_API_CLIENT_ERROR_CODES.OAUTH_EXCHANGE_REJECTED ||
      error.code === GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID ||
      error.code === GITHUB_API_CLIENT_ERROR_CODES.TOKEN_LIFETIME_UNSUPPORTED);
  return definitive ? GITHUB_CREDENTIAL_INVALID_CODE : GITHUB_REFRESH_OUTCOME_UNKNOWN_ERROR_CODE;
}

/** Maps one verification failure to the recheck verdict the store commits. */
function classifyRecheckFailure(error: unknown): GitHubRecheckOutcome {
  if (error instanceof GitHubConnectionServiceError) {
    return { kind: "permission_revoked", errorCode: GITHUB_PERMISSION_REVOKED_CODE };
  }
  if (error instanceof GitHubApiClientError) {
    if (error.code === GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID) {
      return { kind: "unauthorized", errorCode: GITHUB_CREDENTIAL_INVALID_CODE };
    }
    if (error.code === GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED) {
      return { kind: "transient_failure", errorCode: GITHUB_RATE_LIMITED_CODE };
    }
    return { kind: "transient_failure", errorCode: GITHUB_UPSTREAM_UNAVAILABLE_CODE };
  }
  return { kind: "transient_failure", errorCode: GITHUB_UPSTREAM_ERROR_CODE };
}
