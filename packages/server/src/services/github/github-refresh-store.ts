import { randomUUID } from "node:crypto";
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { githubConnections } from "../../db/schema/index.js";
import { assertGitHubCredentialMaterial, type GitHubConnectionCredentialMaterial } from "./credentials.js";
import { boundedGitHubErrorCode } from "./errors.js";
import type { GitHubConnectionRow } from "./rows.js";
import { GITHUB_REFRESH_CLAIM_TTL_MS, githubWorkerBatchLimit } from "./timing.js";

export interface GitHubRefreshCandidate {
  connectionId: string;
  accountId: string;
  githubHost: string;
  appId: string;
  githubUserId: string;
  credentialGeneration: bigint;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

/** Internal: a claimed refresh lease plus the ciphertext the worker exchanges. Never logged. */
export interface ClaimedGitHubRefresh extends GitHubRefreshCandidate {
  attemptId: string;
  credential: { ciphertext: string; keyId: string };
}

export type GitHubRefreshClaimResult =
  | { claimed: true; claim: ClaimedGitHubRefresh }
  | { claimed: false; reason: "not_found" | "not_active" | "already_claimed" | "refresh_outcome_unknown" };

export type GitHubRefreshWriteResult =
  | { applied: true }
  | { applied: false; reason: "not_found" | "not_active" | "stale" };

/** Controlled code recorded when a refresh attempt's outcome can no longer be confirmed. */
export const GITHUB_REFRESH_OUTCOME_UNKNOWN_ERROR_CODE = "GITHUB_REFRESH_OUTCOME_UNKNOWN";

/**
 * The single-row refresh CAS group. One worker claims an attempt from idle; a successful exchange
 * updates only credential fields and bumps credential_generation (never the binding configuration).
 * An expired claim is never silently re-claimed and an uncertain or rejected exchange never blindly
 * reuses the old refresh token: the discovering caller atomically moves the row to
 * reauthorization_required with secrets cleared. Late writes match active + attempt + old generation
 * and can never resurrect a disconnected or superseded row.
 */
export class GitHubCredentialRefreshStore {
  private readonly now: () => Date;
  private readonly claimTtlMs: number;

  constructor(
    private readonly database: DatabaseClient,
    options: { now?: () => Date; claimTtlMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.claimTtlMs = options.claimTtlMs ?? GITHUB_REFRESH_CLAIM_TTL_MS;
  }

  async listRefreshDue(input: { withinMs: number; limit: number }): Promise<GitHubRefreshCandidate[]> {
    const now = this.now();
    const rows = await this.database
      .select()
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.status, "active"),
          lt(githubConnections.accessExpiresAt, new Date(now.getTime() + input.withinMs)),
          or(
            eq(githubConnections.refreshStatus, "idle"),
            eq(githubConnections.refreshStatus, "unknown"),
            and(eq(githubConnections.refreshStatus, "claimed"), lt(githubConnections.refreshClaimUntil, now)),
          ),
        ),
      )
      .orderBy(asc(githubConnections.accessExpiresAt))
      .limit(githubWorkerBatchLimit(input.limit));
    return rows.map(toRefreshCandidate);
  }

  async claimRefresh(connectionId: string): Promise<GitHubRefreshClaimResult> {
    const now = this.now();
    const attemptId = randomUUID();
    const [claimed] = await this.database
      .update(githubConnections)
      .set({
        refreshAttemptId: attemptId,
        refreshClaimUntil: new Date(now.getTime() + this.claimTtlMs),
        refreshStatus: "claimed",
        updatedAt: now,
      })
      .where(
        and(
          eq(githubConnections.id, connectionId),
          eq(githubConnections.status, "active"),
          eq(githubConnections.refreshStatus, "idle"),
        ),
      )
      .returning();
    if (claimed) {
      return { claimed: true, claim: toClaimedRefresh(claimed, attemptId) };
    }
    const [row] = await this.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, connectionId))
      .limit(1);
    if (!row) return { claimed: false, reason: "not_found" };
    if (row.status !== "active") return { claimed: false, reason: "not_active" };
    if (
      row.refreshStatus === "claimed" &&
      row.refreshClaimUntil !== null &&
      row.refreshClaimUntil.getTime() > now.getTime()
    ) {
      return { claimed: false, reason: "already_claimed" };
    }
    // The previous attempt's outcome can no longer be confirmed — the claim expired without a
    // report, or a voided claim left the slot unknown. The old refresh token is never reused:
    // the row fails closed into reauthorization_required instead of permitting a second exchange.
    const [voided] = await this.database
      .update(githubConnections)
      .set(reauthorizationClearingFields(now))
      .where(
        and(
          eq(githubConnections.id, connectionId),
          eq(githubConnections.status, "active"),
          or(
            eq(githubConnections.refreshStatus, "unknown"),
            and(eq(githubConnections.refreshStatus, "claimed"), lt(githubConnections.refreshClaimUntil, now)),
          ),
        ),
      )
      .returning({ id: githubConnections.id });
    if (voided) return { claimed: false, reason: "refresh_outcome_unknown" };
    if (row.refreshStatus === "claimed") return { claimed: false, reason: "already_claimed" };
    return { claimed: false, reason: "not_active" };
  }

  async completeRefresh(input: {
    connectionId: string;
    attemptId: string;
    expectedCredentialGeneration: bigint;
    credential: GitHubConnectionCredentialMaterial;
  }): Promise<GitHubRefreshWriteResult> {
    const now = this.now();
    assertGitHubCredentialMaterial(input.credential, now);
    const [updated] = await this.database
      .update(githubConnections)
      .set({
        credentialCiphertext: input.credential.ciphertext,
        credentialKeyId: input.credential.keyId,
        accessExpiresAt: input.credential.accessExpiresAt,
        refreshExpiresAt: input.credential.refreshExpiresAt,
        credentialGeneration: input.expectedCredentialGeneration + 1n,
        refreshAttemptId: null,
        refreshClaimUntil: null,
        refreshStatus: "idle",
        updatedAt: now,
      })
      .where(
        and(
          eq(githubConnections.id, input.connectionId),
          eq(githubConnections.status, "active"),
          eq(githubConnections.refreshStatus, "claimed"),
          eq(githubConnections.refreshAttemptId, input.attemptId),
          eq(githubConnections.credentialGeneration, input.expectedCredentialGeneration),
        ),
      )
      .returning({ id: githubConnections.id });
    if (updated) return { applied: true };
    return this.staleReason(input.connectionId);
  }

  async failRefresh(input: {
    connectionId: string;
    attemptId: string;
    expectedCredentialGeneration: bigint;
    errorCode: string;
  }): Promise<GitHubRefreshWriteResult> {
    const now = this.now();
    const [updated] = await this.database
      .update(githubConnections)
      .set(reauthorizationClearingFields(now, input.errorCode))
      .where(
        and(
          eq(githubConnections.id, input.connectionId),
          eq(githubConnections.status, "active"),
          eq(githubConnections.refreshAttemptId, input.attemptId),
          eq(githubConnections.credentialGeneration, input.expectedCredentialGeneration),
        ),
      )
      .returning({ id: githubConnections.id });
    if (updated) return { applied: true };
    return this.staleReason(input.connectionId);
  }

  /**
   * Releases a claim back to idle, consumed by exactly one caller: the worker after GitHub
   * provably never consumed the refresh token (a rate-limited exchange). The credential is
   * untouched and the row stays due, so the next tick retries with the same, still-valid token.
   */
  async releaseRefresh(input: {
    connectionId: string;
    attemptId: string;
    expectedCredentialGeneration: bigint;
  }): Promise<GitHubRefreshWriteResult> {
    const now = this.now();
    const [updated] = await this.database
      .update(githubConnections)
      .set({
        refreshAttemptId: null,
        refreshClaimUntil: null,
        refreshStatus: "idle",
        updatedAt: now,
      })
      .where(
        and(
          eq(githubConnections.id, input.connectionId),
          eq(githubConnections.status, "active"),
          eq(githubConnections.refreshStatus, "claimed"),
          eq(githubConnections.refreshAttemptId, input.attemptId),
          eq(githubConnections.credentialGeneration, input.expectedCredentialGeneration),
        ),
      )
      .returning({ id: githubConnections.id });
    if (updated) return { applied: true };
    return this.staleReason(input.connectionId);
  }

  /** Explains a rejected CAS without ever modifying the row. */
  private async staleReason(connectionId: string): Promise<GitHubRefreshWriteResult> {
    const [row] = await this.database
      .select({ id: githubConnections.id, status: githubConnections.status })
      .from(githubConnections)
      .where(eq(githubConnections.id, connectionId))
      .limit(1);
    if (!row) return { applied: false, reason: "not_found" };
    if (row.status !== "active") return { applied: false, reason: "not_active" };
    return { applied: false, reason: "stale" };
  }
}

function toRefreshCandidate(row: GitHubConnectionRow): GitHubRefreshCandidate {
  if (row.githubUserId === null || row.accessExpiresAt === null || row.refreshExpiresAt === null) {
    throw new Error("An active GitHub connection is missing its credential identity");
  }
  return {
    connectionId: row.id,
    accountId: row.accountId,
    githubHost: row.githubHost,
    appId: row.appId,
    githubUserId: row.githubUserId,
    credentialGeneration: row.credentialGeneration,
    accessExpiresAt: row.accessExpiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
  };
}

function toClaimedRefresh(row: GitHubConnectionRow, attemptId: string): ClaimedGitHubRefresh {
  if (row.credentialCiphertext === null || row.credentialKeyId === null) {
    throw new Error("An active GitHub connection is missing its credential material");
  }
  return {
    ...toRefreshCandidate(row),
    attemptId,
    credential: { ciphertext: row.credentialCiphertext, keyId: row.credentialKeyId },
  };
}

/**
 * The fail-closed transition for an unconfirmable refresh: reauthorization_required with the
 * authorization version bumped, every secret and flow cleared, and the refresh slot left `unknown`
 * so no caller blindly reuses the old refresh token.
 */
function reauthorizationClearingFields(now: Date, errorCode: string = GITHUB_REFRESH_OUTCOME_UNKNOWN_ERROR_CODE) {
  return {
    status: "reauthorization_required" as const,
    authorizationVersion: sql`${githubConnections.authorizationVersion} + 1`,
    credentialCiphertext: null,
    credentialKeyId: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
    oauthStateHash: null,
    oauthContext: null,
    oauthContextCiphertext: null,
    oauthContextKeyId: null,
    refreshAttemptId: null,
    refreshClaimUntil: null,
    refreshStatus: "unknown" as const,
    nextRecheckAt: null,
    lastErrorCode: boundedGitHubErrorCode(errorCode),
    updatedAt: now,
  };
}
