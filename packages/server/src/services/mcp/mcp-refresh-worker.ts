import { and, asc, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, mcpServerAuthorizations } from "../../db/schema/index.js";
import type { McpAuthorizationService } from "./mcp-authorization-service.js";
import type { McpOAuthFlowService } from "./mcp-oauth-flow-service.js";
import type { McpServerService } from "./mcp-server-service.js";

/**
 * The background refresh pass.
 *
 * Two properties matter and both are enforced in the scan rather than hoped for:
 *
 * - **Deleted Agents are excluded.** An Agent's deletion is a status change, so nothing cascades;
 *   without the join a deleted Agent's credential would keep being renewed forever, spending a
 *   refresh token on behalf of something that no longer exists.
 * - **`refresh_at` carries a lead.** A token refreshed exactly at expiry races the request that uses
 *   it, so the deadline is pulled forward by `min(5 minutes, half the lifetime)`.
 */

export const MCP_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const MCP_REFRESH_BATCH_SIZE = 100;
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
  servers: McpServerService;
}

export class McpRefreshWorker {
  readonly #authorization: McpAuthorizationService;
  readonly #batchSize: number;
  readonly #database: DatabaseClient;
  readonly #flows: McpOAuthFlowService;
  readonly #intervalMs: number;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  #running = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: McpRefreshWorkerOptions) {
    this.#authorization = options.authorization;
    this.#batchSize = options.batchSize ?? MCP_REFRESH_BATCH_SIZE;
    this.#database = options.database;
    this.#flows = options.flows;
    this.#intervalMs = options.intervalMs ?? MCP_REFRESH_INTERVAL_MS;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.runOnce().catch(this.#onError);
    }, this.#intervalMs);
    // A monitoring timer must not hold the process open on its own.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One pass: expire the credentials that cannot be renewed, run the probes that were scheduled, then
   * refresh the tokens that can be. The statements are separate so a failure in one cannot leave
   * another's work half-reported.
   *
   * The return value counts refreshed tokens, which is what its callers and the tests have always
   * meant by a pass; pending probes are reported to `onError` and do not change it.
   */
  async runOnce(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      const now = this.#now();
      await this.#expireUnrenewable(now);
      await this.#runPendingProbes();
      const due = await this.#database
        .select({ id: mcpServerAuthorizations.id })
        .from(mcpServerAuthorizations)
        .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
        .where(
          and(
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
      for (const row of due) {
        try {
          await this.#flows.refreshAuthorization(row.id);
        } catch (error) {
          this.#onError(error);
        }
      }
      return due.length;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Run the probes that were scheduled by a state change.
   *
   * Several paths mark a row `pending` — a callback storing a credential, a definition edit, a binding
   * override — and the comment on `markProbesPending` promised "a background pass re-probes them". No
   * such pass existed: the only probes were the two explicit routes, so a shared edit left every mount
   * showing stale tools until somebody clicked Re-probe, and a freshly authorized row stayed `pending`
   * forever, which is also why `mcp authorize` could never finish its wait.
   *
   * Bounded per pass, oldest first, and a deleted Agent is excluded for the same reason the refresh
   * scan excludes one: nothing should reach out on behalf of an Agent that no longer exists.
   */
  async #runPendingProbes(): Promise<void> {
    const pending = await this.#database
      .select({
        agentId: mcpServerAuthorizations.agentId,
        accountId: agents.createdByUserId,
        mcpServerId: mcpServerAuthorizations.mcpServerId,
      })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      .where(and(eq(mcpServerAuthorizations.probeState, "pending"), ne(agents.status, "deleted")))
      .orderBy(asc(mcpServerAuthorizations.updatedAt))
      .limit(this.#batchSize);
    for (const row of pending) {
      try {
        await this.#authorization.probe(row.accountId, row.agentId, row.mcpServerId);
      } catch (error) {
        /*
         * Reported and stepped over. A probe that fails records its own failure on the row, so the
         * next pass sees `failed` rather than `pending` and does not retry it in a loop; anything
         * thrown here is infrastructure, and one bad row must not stop the rest of the batch.
         */
        this.#onError(error);
      }
    }
  }

  /** An OAuth row past its expiry with no refresh token lapses; there is nothing to spend. */
  async #expireUnrenewable(now: Date): Promise<void> {
    const rows = await this.#database
      .select({ id: mcpServerAuthorizations.id, ciphertext: mcpServerAuthorizations.ciphertext })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      .where(
        and(
          eq(mcpServerAuthorizations.kind, "oauth"),
          eq(mcpServerAuthorizations.status, "active"),
          ne(agents.status, "deleted"),
          isNull(mcpServerAuthorizations.refreshClaimId),
          lte(mcpServerAuthorizations.accessTokenExpiresAt, now),
        ),
      )
      .limit(this.#batchSize);
    const ids = rows.filter((row) => row.ciphertext === null).map((row) => row.id);
    if (ids.length === 0) return;
    await this.#database
      .update(mcpServerAuthorizations)
      .set({ status: "expired", updatedAt: now })
      .where(inArray(mcpServerAuthorizations.id, ids));
  }
}
