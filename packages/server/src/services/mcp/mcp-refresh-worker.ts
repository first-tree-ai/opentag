import { and, asc, eq, isNull, lte, ne, or } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, mcpServerAuthorizations } from "../../db/schema/index.js";
import type { McpAuthorizationService } from "./mcp-authorization-service.js";
import type { McpOAuthFlowService } from "./mcp-oauth-flow-service.js";
import type { McpServerService } from "./mcp-server-service.js";

export const MCP_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const MCP_REFRESH_BATCH_SIZE = 100;
/**
 * Stays one slot below `MCP_DEFAULT_MAX_CONCURRENT_PER_ACCOUNT` (4) so interactive OAuth flows and
 * manual probes still have a free per-Account outbound slot while a refresh pass is running.
 */
export const MCP_REFRESH_CONCURRENCY = 3;
/** Missing `expires_in` is treated as this lifetime, matching the general default. */
const DEFAULT_EXPIRES_IN_SECONDS = 300;
const MAX_LEAD_MS = 5 * 60 * 1000;

/** When a token must be refreshed: at expiry, minus `min(5 minutes, half its lifetime)`. */
export function refreshLeadMs(expiresInSeconds: number | undefined): number {
  const lifetimeMs = (expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;
  return Math.min(MAX_LEAD_MS, lifetimeMs * 0.5);
}

export function refreshAtFrom(expiresAt: Date, expiresInSeconds?: number): Date {
  return new Date(expiresAt.getTime() - refreshLeadMs(expiresInSeconds));
}

export interface McpRefreshWorkerOptions {
  /** Runs the probes this pass schedules; see `#runPendingProbes`. */
  authorization: McpAuthorizationService;
  database: DatabaseClient;
  flows: McpOAuthFlowService;
  /** Test seam for the pass's clock; the scan compares against it rather than the wall clock. */
  now?: () => Date;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  batchSize?: number;
  /** Maximum number of probes or token refreshes to run concurrently within one pass. */
  concurrency?: number;
  servers: McpServerService;
}

export class McpRefreshWorker {
  readonly #authorization: McpAuthorizationService;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #database: DatabaseClient;
  readonly #flows: McpOAuthFlowService;
  readonly #intervalMs: number;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  #inflight: Promise<number> | undefined;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: McpRefreshWorkerOptions) {
    this.#authorization = options.authorization;
    this.#batchSize = options.batchSize ?? MCP_REFRESH_BATCH_SIZE;
    this.#concurrency = Math.max(1, Math.trunc(options.concurrency ?? MCP_REFRESH_CONCURRENCY));
    this.#database = options.database;
    this.#flows = options.flows;
    this.#intervalMs = options.intervalMs ?? MCP_REFRESH_INTERVAL_MS;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.runOnce().catch(this.#onError);
    }, this.#intervalMs);
    // A monitoring timer must not hold the process open on its own.
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#inflight;
  }

  runOnce(): Promise<number> {
    if (this.#inflight || this.#stopped) return Promise.resolve(0);
    const task = this.#run().finally(() => {
      if (this.#inflight === task) this.#inflight = undefined;
    });
    this.#inflight = task;
    return task;
  }

  async #run(): Promise<number> {
    const now = this.#now();
    await this.#runPendingProbes();
    if (this.#stopped) return 0;
    const due = await this.#database
      .select({ id: mcpServerAuthorizations.id })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      .where(
        and(
          isNull(mcpServerAuthorizations.credentialSourceId),
          eq(mcpServerAuthorizations.kind, "oauth"),
          eq(mcpServerAuthorizations.status, "active"),
          ne(agents.status, "deleted"),
          or(
            isNull(mcpServerAuthorizations.refreshClaimId),
            lte(mcpServerAuthorizations.refreshClaimedAt, new Date(now.getTime() - 2 * 60 * 1000)),
          ),
          // `access_token_expires_at` is stored as the raw expiry; the lead is applied here so a
          // lifetime change takes effect without rewriting rows.
          lte(mcpServerAuthorizations.accessTokenExpiresAt, new Date(now.getTime() + MAX_LEAD_MS)),
        ),
      )
      .orderBy(asc(mcpServerAuthorizations.accessTokenExpiresAt))
      .limit(this.#batchSize);
    let refreshed = 0;
    await this.#runWithConcurrency(due, async (row) => {
      refreshed += 1;
      try {
        await this.#flows.refreshAuthorization(row.id);
      } catch (error) {
        this.#onError(error);
      }
    });
    return refreshed;
  }

  async #runPendingProbes(): Promise<void> {
    const pending = await this.#database
      .select({
        agentId: mcpServerAuthorizations.agentId,
        accountId: agents.createdByUserId,
        id: mcpServerAuthorizations.id,
        mcpServerId: mcpServerAuthorizations.mcpServerId,
      })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      .where(
        and(
          eq(mcpServerAuthorizations.probeState, "pending"),
          /*
           * Only rows `probe()` will accept.
           *
           * It throws `AUTHORIZATION_REQUIRED` for any row that is not `active`, before writing
           * anything — so a revoked, expired, or errored row that is still marked pending would be
           * selected, throw, keep its `probeState` and its `updatedAt`, and be selected again next pass,
           * forever. Those are not edge cases: `revoke` writes `probeState: "pending"` itself, and
           * `start` marks the row pending at the beginning of every flow.
           *
           * The sharper half is starvation. The scan is oldest-first with a batch bound, and a row that
           * throws never has its `updatedAt` touched, so stuck rows sort to the head permanently. Once
           * a deployment accumulates a batch of them the pass runs nothing else — the symptom this pass
           * exists to remove, reached from the other side.
           */
          eq(mcpServerAuthorizations.status, "active"),
          ne(agents.status, "deleted"),
        ),
      )
      .orderBy(asc(mcpServerAuthorizations.updatedAt))
      .limit(this.#batchSize);
    await this.#runWithConcurrency(pending, async (row) => {
      try {
        await this.#authorization.probe(row.accountId, row.agentId, row.mcpServerId, {
          rethrowConcurrencyLimit: true,
        });
      } catch (error) {
        // Rotate only failures whose probe did not persist its own outcome.
        this.#onError(error);
        if (this.#stopped) return;
        await this.#database
          .update(mcpServerAuthorizations)
          .set({ updatedAt: this.#now() })
          .where(eq(mcpServerAuthorizations.id, row.id));
      }
    });
  }

  async #runWithConcurrency<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
    if (items.length === 0 || this.#stopped) return;
    let nextIndex = 0;
    let aborted = false;
    const workerCount = Math.min(this.#concurrency, items.length);
    const outcomes = await Promise.allSettled(
      Array.from({ length: workerCount }, async () => {
        while (!this.#stopped && !aborted) {
          const index = nextIndex;
          nextIndex += 1;
          const item = items[index];
          if (item === undefined) return;
          try {
            await worker(item);
          } catch (error) {
            aborted = true;
            throw error;
          }
        }
      }),
    );
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (rejected) throw rejected.reason;
  }
}
