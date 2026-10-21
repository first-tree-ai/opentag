import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { githubConnections } from "../../db/schema/index.js";
import { boundedGitHubErrorCode } from "./errors.js";
import type { GitHubConnectionRow } from "./rows.js";
import { gitHubConnectionColumns, oauthConnectionScope } from "./rows.js";
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

/** Internal: the full active row state a recheck verifies, including the sealed credential. */
export interface GitHubActiveConnectionSnapshot {
  connectionId: string;
  accountId: string;
  githubHost: string;
  oauthClientId: string;
  githubUserId: string;
  authorizationVersion: bigint;
  recheckGeneration: bigint;
  credentialGeneration: bigint;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  credential: { ciphertext: string; keyId: string };
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
  private readonly oauthClientId: string;
  private readonly retryDelayMs: number;

  constructor(
    private readonly database: DatabaseClient,
    options: { oauthClientId: string; now?: () => Date; recheckIntervalMs?: number; retryDelayMs?: number },
  ) {
    this.oauthClientId = options.oauthClientId;
    this.now = options.now ?? (() => new Date());
    this.recheckIntervalMs = options.recheckIntervalMs ?? GITHUB_RECHECK_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs ?? GITHUB_RECHECK_RETRY_DELAY_MS;
  }

  async listDueForRecheck(input: { limit: number }): Promise<GitHubRecheckDueConnection[]> {
    const now = this.now();
    const rows = await this.database
      .select(gitHubConnectionColumns())
      .from(githubConnections)
      .where(
        and(
          oauthConnectionScope(this.oauthClientId),
          eq(githubConnections.status, "active"),
          lte(githubConnections.nextRecheckAt, now),
        ),
      )
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
          oauthConnectionScope(this.oauthClientId),
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
      .where(and(oauthConnectionScope(this.oauthClientId), eq(githubConnections.id, input.connectionId)))
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
      .where(
        and(
          inArray(githubConnections.id, input.connectionIds),
          oauthConnectionScope(this.oauthClientId),
          eq(githubConnections.status, "active"),
        ),
      )
      .returning({ id: githubConnections.id });
    return updated.length;
  }

  /**
   * The active identity and sealed credential a recheck worker needs after the due scan. Fencing versions travel with it so a commit can only
   * land on the exact row state the scan observed. Never logged.
   */
  async getActiveRecheckSnapshot(connectionId: string): Promise<GitHubActiveConnectionSnapshot | null> {
    const [row] = await this.database
      .select(gitHubConnectionColumns())
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.id, connectionId),
          oauthConnectionScope(this.oauthClientId),
          eq(githubConnections.status, "active"),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (
      row.oauthClientId === null ||
      row.githubUserId === null ||
      row.credentialCiphertext === null ||
      row.credentialKeyId === null ||
      row.accessExpiresAt === null ||
      row.refreshExpiresAt === null
    ) {
      throw new Error("An active GitHub connection is missing its credential identity");
    }
    return {
      connectionId: row.id,
      accountId: row.accountId,
      githubHost: row.githubHost,
      oauthClientId: row.oauthClientId,
      githubUserId: row.githubUserId,
      authorizationVersion: row.authorizationVersion,
      recheckGeneration: row.recheckGeneration,
      credentialGeneration: row.credentialGeneration,
      accessExpiresAt: row.accessExpiresAt,
      refreshExpiresAt: row.refreshExpiresAt,
      credential: { ciphertext: row.credentialCiphertext, keyId: row.credentialKeyId },
    };
  }

  /**
   * Expired flows are cleared in place; pending connections remain available for a fresh authorization.
   */
  async sweepExpiredOAuthFlows(input: { limit: number } = { limit: 100 }): Promise<{ clearedFlows: number }> {
    const now = this.now();
    const expiredFlow = sql`(${githubConnections.oauthContext} ->> 'expiresAt')::timestamptz <= ${now.toISOString()}`;
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ id: githubConnections.id, status: githubConnections.status })
        .from(githubConnections)
        .where(
          and(
            oauthConnectionScope(this.oauthClientId),
            inArray(githubConnections.status, ["pending", "active", "reauthorization_required"]),
            isNotNull(githubConnections.oauthStateHash),
            expiredFlow,
          ),
        )
        .orderBy(asc(githubConnections.id))
        .limit(githubWorkerBatchLimit(input.limit))
        .for("update", { skipLocked: true });
      const ids = candidates.map((row) => row.id);
      if (ids.length)
        await transaction
          .update(githubConnections)
          .set({
            oauthStateHash: null,
            oauthContext: null,
            oauthContextCiphertext: null,
            oauthContextKeyId: null,
            updatedAt: now,
          })
          .where(and(oauthConnectionScope(this.oauthClientId), inArray(githubConnections.id, ids)));
      return { clearedFlows: ids.length };
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
