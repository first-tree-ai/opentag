import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Distinguishes an MCP gateway bearer from every other OpenTag credential in a log or a config. */
export const MCP_GATEWAY_TOKEN_PREFIX = "otmg_";

export interface RuntimeMcpGatewayTokenRecord {
  tokenHash: string;
  executionId: string;
  expiresAt: number;
}

export interface RuntimeMcpGatewayTokenStoreOptions {
  now?: () => number;
  /** Ceiling on a token's life; the caller normally passes the execution's own remaining time. */
  maxTtlMs?: number;
  maxTokens?: number;
}

export class RuntimeMcpGatewayTokenStoreCapacityError extends Error {
  constructor() {
    super("The MCP gateway token store is full");
    this.name = "RuntimeMcpGatewayTokenStoreCapacityError";
  }
}

const DEFAULT_MAX_TOKENS = 4096;
/** Upper bound on one token's life, independent of what an execution claims. */
const DEFAULT_MAX_TTL_MS = 6 * 60 * 60 * 1_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Hash-only bounded index of MCP gateway bearers, one live token per execution.
 *
 * This is the whole reason the gateway needs no API-key table: the credential a provider CLI
 * presents is a 256-bit random value tied to one execution, and the Server keeps only its SHA-256
 * digest. Nothing here is persisted, so a token cannot outlive the process, and
 * {@link revokeExecution} is wired to the execution registry's close path so it does not outlive
 * the turn either. A token read out of a config file by a prompt-injected Agent buys no lasting
 * access, which is what makes writing it to disk acceptable at all.
 *
 * The record carries **only** the execution id. Account and Agent are deliberately absent: the
 * gateway resolves them from the live execution record, so a token can never assert an identity of
 * its own, and a stale token cannot name an Agent whose execution has since been replaced.
 */
export class RuntimeMcpGatewayTokenStore {
  readonly #now: () => number;
  readonly #maxTtlMs: number;
  readonly #maxTokens: number;
  readonly #byHash = new Map<string, RuntimeMcpGatewayTokenRecord>();
  readonly #byExecution = new Map<string, string>();

  constructor(options: RuntimeMcpGatewayTokenStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  get size(): number {
    return this.#byHash.size;
  }

  /**
   * Issue this execution's gateway bearer, replacing any token it already held.
   *
   * Replacing rather than accumulating keeps the blast radius of a leak to one token, and makes a
   * repeated request (a Client retry, a re-prepared execution) idempotent in effect: the previous
   * token stops working the moment a new one exists, so two live credentials for one execution can
   * never be in circulation.
   */
  issue(input: { executionId: string; expiresAt: number }): { token: string; expiresAt: number } {
    const now = this.#now();
    this.sweep(now);
    this.revokeExecution(input.executionId);
    if (this.#byHash.size >= this.#maxTokens) throw new RuntimeMcpGatewayTokenStoreCapacityError();
    const token = `${MCP_GATEWAY_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const expiresAt = Math.min(input.expiresAt, now + this.#maxTtlMs);
    const tokenHash = hashToken(token);
    this.#byHash.set(tokenHash, { tokenHash, executionId: input.executionId, expiresAt });
    this.#byExecution.set(input.executionId, tokenHash);
    return { token, expiresAt };
  }

  /**
   * Resolve a presented bearer to its execution, or `undefined`.
   *
   * Unlike a proxy ticket this is not single-use: one execution makes many MCP calls. Expiry is
   * checked on read and the expired record is dropped, so a lapsed token cannot linger in the map
   * waiting for a sweep.
   */
  resolve(token: string, now = this.#now()): RuntimeMcpGatewayTokenRecord | undefined {
    if (!token.startsWith(MCP_GATEWAY_TOKEN_PREFIX)) return undefined;
    const hash = hashToken(token);
    const record = this.#byHash.get(hash);
    if (!record) return undefined;
    if (record.expiresAt <= now) {
      this.#drop(hash, record.executionId);
      return undefined;
    }
    /*
     * The Map lookup already decided the match, so this cannot recover the timing the lookup leaked.
     * It is here because the comparison a reader expects to find on a credential path should be
     * present and constant-time, and because a future change to a scanning lookup would otherwise
     * silently inherit a variable-time compare.
     */
    return matchesHash(record.tokenHash, hash) ? record : undefined;
  }

  revokeExecution(executionId: string): number {
    const hash = this.#byExecution.get(executionId);
    if (!hash) return 0;
    this.#drop(hash, executionId);
    return 1;
  }

  sweep(now = this.#now()): number {
    let removed = 0;
    for (const [hash, record] of [...this.#byHash.entries()]) {
      if (record.expiresAt > now) continue;
      this.#drop(hash, record.executionId);
      removed += 1;
    }
    return removed;
  }

  #drop(hash: string, executionId: string): void {
    this.#byHash.delete(hash);
    // Only if it still points at this hash: a re-issue already moved the execution to a new token.
    if (this.#byExecution.get(executionId) === hash) this.#byExecution.delete(executionId);
  }
}

function matchesHash(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
