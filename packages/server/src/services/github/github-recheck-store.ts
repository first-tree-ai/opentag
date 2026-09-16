import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { githubConnections } from "../../db/schema/index.js";
import { boundedGitHubErrorCode } from "./errors.js";
import type { GitHubConnectionRow } from "./rows.js";
import { GITHUB_RECHECK_INTERVAL_MS, GITHUB_RECHECK_RETRY_DELAY_MS, githubWorkerBatchLimit } from "./timing.js";

/** The fencing snapshot a recheck worker captures before any external GitHub call. */
export interface GitHubRecheckDueConnection {
  connectionId: string;
  accountId: string;
  githubUserId: string;
  authorizationVersion: bigint;
  recheckGeneration: bigint;
  credentialGeneration: bigint;
}

export type GitHubRecheckOutcome =
  | { kind: "healthy" }
  | { kind: "transient_failure"; errorCode: string }
  | { kind: "unauthorized"; errorCode: string };

export type GitHubRecheckCommitResult =
  | { applied: true }
  | { applied: false; reason: "not_found" | "not_active" | "stale" };

/**
 * Periodic authoritative recheck scheduling. The due scan covers every active connection whose
 * next_recheck_at has arrived — clean rows included, never only dirty ones. Results commit with an
 * authorization-version + recheck-generation CAS, so a stale "allow" can never overwrite a newer
 * invalidation, and a late commit can never resurrect a disconnected row.
 */
export class GitHubConnectionRecheckStore {
  private readonly now: () => Date;
  private readonly recheckIntervalMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly database: DatabaseClient,
    options: { now?: () => Date; recheckIntervalMs?: number; retryDelayMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.recheckIntervalMs = options.recheckIntervalMs ?? GITHUB_RECHECK_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs ?? GITHUB_RECHECK_RETRY_DELAY_MS;
  }

  async listDueForRecheck(input: { limit: number }): Promise<GitHubRecheckDueConnection[]> {
    const now = this.now();
    const rows = await this.database
      .select()
      .from(githubConnections)
      .where(and(eq(githubConnections.status, "active"), lte(githubConnections.nextRecheckAt, now)))
      .orderBy(asc(githubConnections.nextRecheckAt))
      .limit(githubWorkerBatchLimit(input.limit));
    return rows.map(toRecheckDueConnection);
  }

  async commitRecheckResult(input: {
    connectionId: string;
    expectedAuthorizationVersion: bigint;
    expectedRecheckGeneration: bigint;
    outcome: GitHubRecheckOutcome;
  }): Promise<GitHubRecheckCommitResult> {
    const now = this.now();
    const [updated] = await this.database
      .update(githubConnections)
      .set(this.outcomeFields(input, now))
      .where(
        and(
          eq(githubConnections.id, input.connectionId),
          eq(githubConnections.status, "active"),
          eq(githubConnections.authorizationVersion, input.expectedAuthorizationVersion),
          eq(githubConnections.recheckGeneration, input.expectedRecheckGeneration),
        ),
      )
      .returning({ id: githubConnections.id });
    if (updated) return { applied: true };
    const [row] = await this.database
      .select({ id: githubConnections.id, status: githubConnections.status })
      .from(githubConnections)
      .where(eq(githubConnections.id, input.connectionId))
      .limit(1);
    if (!row) return { applied: false, reason: "not_found" };
    if (row.status !== "active") return { applied: false, reason: "not_active" };
    return { applied: false, reason: "stale" };
  }

  /** Pulls the next recheck of affected active connections forward; recovery events only request rechecks. */
  async markRecheckDue(input: { connectionIds: string[]; dueAt: Date }): Promise<number> {
    if (input.connectionIds.length === 0) return 0;
    const now = this.now();
    const updated = await this.database
      .update(githubConnections)
      .set({
        recheckRequired: true,
        nextRecheckAt: sql`least(${githubConnections.nextRecheckAt}, ${input.dueAt.toISOString()})`,
        recheckGeneration: sql`${githubConnections.recheckGeneration} + 1`,
        updatedAt: now,
      })
      .where(and(inArray(githubConnections.id, input.connectionIds), eq(githubConnections.status, "active")))
      .returning({ id: githubConnections.id });
    return updated.length;
  }

  /**
   * OAuth expiry cleanup: pending rows whose only flow expired carry no secrets and are deleted so
   * the Account can reconnect; current rows keep their connection and only the dead flow slot clears.
   */
  async sweepExpiredOAuthFlows(
    input: { limit: number } = { limit: 100 },
  ): Promise<{ clearedFlows: number; deletedPending: number }> {
    const now = this.now();
    const expiredFlow = sql`(${githubConnections.oauthContext} ->> 'expiresAt')::timestamptz <= ${now.toISOString()}`;
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ id: githubConnections.id, status: githubConnections.status })
        .from(githubConnections)
        .where(
          and(
            inArray(githubConnections.status, ["pending", "active", "reauthorization_required"]),
            isNotNull(githubConnections.oauthStateHash),
            expiredFlow,
          ),
        )
        .orderBy(asc(githubConnections.id))
        .limit(githubWorkerBatchLimit(input.limit))
        .for("update", { skipLocked: true });
      const pendingIds = candidates.filter((row) => row.status === "pending").map((row) => row.id);
      const currentIds = candidates.filter((row) => row.status !== "pending").map((row) => row.id);
      if (pendingIds.length)
        await transaction.delete(githubConnections).where(inArray(githubConnections.id, pendingIds));
      if (currentIds.length)
        await transaction
          .update(githubConnections)
          .set({
            oauthStateHash: null,
            oauthContext: null,
            oauthContextCiphertext: null,
            oauthContextKeyId: null,
            updatedAt: now,
          })
          .where(inArray(githubConnections.id, currentIds));
      return { clearedFlows: currentIds.length, deletedPending: pendingIds.length };
    });
  }

  private outcomeFields(input: { expectedRecheckGeneration: bigint; outcome: GitHubRecheckOutcome }, now: Date) {
    const recheckGeneration = input.expectedRecheckGeneration + 1n;
    const outcome = input.outcome;
    if (outcome.kind === "healthy") {
      return {
        lastVerifiedAt: now,
        nextRecheckAt: new Date(now.getTime() + this.recheckIntervalMs),
        recheckRequired: false,
        recheckGeneration,
        lastErrorCode: null,
        updatedAt: now,
      };
    }
    if (outcome.kind === "transient_failure") {
      return {
        nextRecheckAt: new Date(now.getTime() + this.retryDelayMs),
        recheckRequired: true,
        recheckGeneration,
        lastErrorCode: boundedGitHubErrorCode(outcome.errorCode),
        updatedAt: now,
      };
    }
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
      refreshStatus: "idle" as const,
      nextRecheckAt: null,
      recheckGeneration,
      lastErrorCode: boundedGitHubErrorCode(outcome.errorCode),
      updatedAt: now,
    };
  }
}

function toRecheckDueConnection(row: GitHubConnectionRow): GitHubRecheckDueConnection {
  if (row.githubUserId === null) {
    throw new Error("An active GitHub connection is missing its identity");
  }
  return {
    connectionId: row.id,
    accountId: row.accountId,
    githubUserId: row.githubUserId,
    authorizationVersion: row.authorizationVersion,
    recheckGeneration: row.recheckGeneration,
    credentialGeneration: row.credentialGeneration,
  };
}
