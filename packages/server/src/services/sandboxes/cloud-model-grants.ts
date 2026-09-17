import { randomUUID } from "node:crypto";
import { RUNTIME_MAX_DURATION_MS } from "@opentag/shared";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

/**
 * Execution-scoped model call permission. A token is minted only when a Cloud delivery's durable
 * custody was persisted (the "verified" boundary), pins the exact turn/sandbox/session/model, and
 * is revoked when the turn reports, when its Runner connection is lost, or when its allocation
 * ends. Revocation also aborts in-flight upstream streams. Tokens are HS256 JWTs under a
 * dedicated audience; the platform model master key never leaves the proxy route.
 *
 * Lifetime is explicit per turn: the Server passes the dispatch deadline (+ transport allowance)
 * as `expiresAt`, bounded by the supported 24h runtime plus a small allowance. Omitting it keeps
 * the configured `ttlSeconds` for existing callers. There is no renewal and no long-lived parent
 * credential: a turn whose permission expires without a report loses model access.
 *
 * Duplicate receipts for one execution reuse the same live token instead of accumulating grants.
 * A revoked execution is never silently re-minted; the only way to obtain a fresh permission for
 * an accepted-but-unfinished turn is the explicit `supersedeRevoked` recovery rotation, which the
 * Server requests only after re-validating the exact current connection, allocation, active
 * Session/Agent chain, and unfinished custody. Rotation mints a NEW jti and leaves the old
 * revocation tombstones in place, so every old token stays invalid; an expired or conflicting
 * scope is refused, and `revokeExecution` still kills every generation for the execution.
 * Revocation state is process-local, consistent with the in-memory RunnerHub: a Server restart
 * invalidates every Runner connection, and the reconnecting Runner receives fresh grants for
 * still-pending verified deliveries only through the normal custody boundary.
 */

const MODEL_GRANT_AUDIENCE = "opentag-cloud-model";
const MODEL_GRANT_ISSUER = "opentag";
/** Longest supported runtime turn (24h); a permission never outlives it. */
const MODEL_GRANT_RUNTIME_CEILING_MS = RUNTIME_MAX_DURATION_MS;
/** Bounded allowance for dispatch/transport skew on top of the runtime ceiling. */
export const CLOUD_MODEL_GRANT_TRANSPORT_ALLOWANCE_MS = 60_000;
/** Absolute ceiling for one permission: the 24h runtime plus the transport allowance. */
export const CLOUD_MODEL_GRANT_MAX_TTL_MS = MODEL_GRANT_RUNTIME_CEILING_MS + CLOUD_MODEL_GRANT_TRANSPORT_ALLOWANCE_MS;
/** Hard bound on retained grant state; revoked entries are evicted first under pressure. */
const MAX_TRACKED_GRANTS_DEFAULT = 4_096;
const SWEEP_INTERVAL_MS_DEFAULT = 60_000;
/** Same ceiling the Runner wire schema applies to one model token. */
const MAX_TOKEN_CHARS = 4_096;
/** Small clock skew tolerated when validating a token's issued-at claim. */
const MAX_ISSUED_AT_SKEW_SECONDS = 5;

const CloudModelGrantClaimsSchema = z
  .object({
    jti: z.string().uuid(),
    executionId: z.string().min(1).max(256),
    sandboxId: z.string().uuid(),
    sessionId: z.string().uuid(),
    model: z.string().min(1).max(128),
  })
  .strict();

export type CloudModelGrantClaims = z.infer<typeof CloudModelGrantClaimsSchema>;

export interface CloudModelGrantIssue {
  claims: CloudModelGrantClaims;
  token: string;
  expiresAt: Date;
}

export interface CloudModelGrantIssueInput {
  executionId: string;
  sandboxId: string;
  sessionId: string;
  model: string;
  /**
   * Absolute expiry for this permission (for Cloud turns: dispatch deadline + transport
   * allowance). Must be in the future and at most 24h + 60s from now. Omitted keeps the
   * service's configured `ttlSeconds`.
   */
  expiresAt?: Date;
  /**
   * Explicit recovery rotation for one accepted-but-unfinished turn whose permission was revoked
   * by a lost Runner connection: mint a NEW token for the SAME execution identity while every old
   * token stays an invalid revocation tombstone. The caller must have re-validated current
   * custody immediately around this call; identical scope/model is required, and an expired
   * execution is never rotated. Never implied by omission.
   */
  supersedeRevoked?: true;
}

interface GrantState {
  claims: CloudModelGrantClaims;
  expiresAtMs: number;
  revoked: boolean;
  inFlight: Set<{ abort(): void }>;
  token: string;
}

export class CloudModelGrantService {
  readonly #allowedModels: ReadonlySet<string>;
  readonly #byExecution = new Map<string, string>();
  readonly #defaultModel: string;
  readonly #grants = new Map<string, GrantState>();
  readonly #key: Uint8Array;
  readonly #maxStreamsPerToken: number;
  readonly #maxTrackedGrants: number;
  readonly #now: () => Date;
  readonly #sweepIntervalMs: number;
  readonly #ttlSeconds: number;
  #sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    secret: string,
    options: {
      allowedModels: readonly string[];
      maxStreamsPerToken: number;
      now?: () => Date;
      ttlSeconds: number;
      /** Test/embedding override for the retained-grant bound. */
      maxTrackedGrants?: number;
      /** Recurring expiry sweep cadence; 0 disables the internal timer. */
      sweepIntervalMs?: number;
    },
  ) {
    if (options.allowedModels.length === 0) throw new Error("The Cloud model grant service requires an allowlist");
    if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 1) {
      throw new Error("The Cloud model grant service requires a positive integer ttlSeconds");
    }
    if (options.ttlSeconds > CLOUD_MODEL_GRANT_MAX_TTL_MS / 1_000) {
      throw new Error("The Cloud model grant service ttlSeconds exceeds the supported 24h runtime ceiling");
    }
    this.#allowedModels = new Set(options.allowedModels);
    this.#defaultModel = options.allowedModels[0] as string;
    this.#key = new TextEncoder().encode(secret);
    this.#maxStreamsPerToken = options.maxStreamsPerToken;
    this.#maxTrackedGrants = options.maxTrackedGrants ?? MAX_TRACKED_GRANTS_DEFAULT;
    this.#now = options.now ?? (() => new Date());
    this.#sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS_DEFAULT;
    this.#ttlSeconds = options.ttlSeconds;
  }

  /** First configured allowed model; the Server resolves an unspecified runtime model with it. */
  get defaultModel(): string {
    return this.#defaultModel;
  }

  /** Diagnostic retained-state size (live grants plus revocation tombstones awaiting expiry). */
  get trackedGrantCount(): number {
    return this.#grants.size;
  }

  isModelAllowed(model: string): boolean {
    return this.#allowedModels.has(model);
  }

  /**
   * Mint a grant for one verified delivery. The model must already be allowlisted. An identical
   * live grant for the same execution is reused (same token) and a conflicting scope/model is
   * refused. A revoked execution is never re-minted unless the caller explicitly requests
   * `supersedeRevoked` after re-validating current custody; an expired execution stays refused.
   */
  async issue(input: CloudModelGrantIssueInput): Promise<CloudModelGrantIssue | undefined> {
    if (!this.#allowedModels.has(input.model)) return undefined;
    const nowMs = this.#now().getTime();
    const existing = this.#checkExistingGrant(input, nowMs);
    if (existing.kind === "reuse") return existing.issue;
    if (existing.kind === "refuse") return undefined;
    // A "rotate" decision keeps the old revoked jti as a tombstone and mints a fresh generation;
    // the by-execution pointer moves to the new jti so revocation of the turn kills both.
    const expiresAtMs = this.#resolveExpiry(input.expiresAt, nowMs);
    if (expiresAtMs === undefined) return undefined;
    const claims = CloudModelGrantClaimsSchema.safeParse({
      executionId: input.executionId,
      jti: randomUUID(),
      model: input.model,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
    });
    if (!claims.success) return undefined;
    const issuedAt = Math.floor(nowMs / 1_000);
    const expirationSeconds = Math.floor(expiresAtMs / 1_000);
    if (expirationSeconds <= issuedAt || !this.#reserveCapacity()) return undefined;
    const token = await new SignJWT(claims.data)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(MODEL_GRANT_ISSUER)
      .setAudience(MODEL_GRANT_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expirationSeconds)
      .setJti(claims.data.jti)
      .sign(this.#key);
    this.#grants.set(claims.data.jti, {
      claims: claims.data,
      expiresAtMs,
      inFlight: new Set(),
      revoked: false,
      token,
    });
    this.#byExecution.set(claims.data.executionId, claims.data.jti);
    this.#ensureSweepTimer();
    return { claims: claims.data, expiresAt: new Date(expiresAtMs), token };
  }

  #checkExistingGrant(
    input: CloudModelGrantIssueInput,
    nowMs: number,
  ): { kind: "none" } | { kind: "reuse"; issue: CloudModelGrantIssue } | { kind: "rotate" } | { kind: "refuse" } {
    const existingJti = this.#byExecution.get(input.executionId);
    if (existingJti === undefined) return { kind: "none" };
    const existing = this.#grants.get(existingJti);
    if (!existing) {
      this.#byExecution.delete(input.executionId);
      return { kind: "none" };
    }
    const sameScope =
      existing.claims.model === input.model &&
      existing.claims.sandboxId === input.sandboxId &&
      existing.claims.sessionId === input.sessionId;
    if (existing.revoked) {
      // The execution was revoked (connection loss, stop, report, or retirement). Only an
      // explicit recovery rotation may supersede it, and only for the identical execution scope;
      // expired or conflicting generations stay refused.
      if (input.supersedeRevoked !== true || !sameScope) return { kind: "refuse" };
      if (existing.expiresAtMs <= nowMs) return { kind: "refuse" };
      return { kind: "rotate" };
    }
    if (existing.expiresAtMs <= nowMs) return { kind: "refuse" };
    if (!sameScope) return { kind: "refuse" };
    return {
      issue: { claims: existing.claims, expiresAt: new Date(existing.expiresAtMs), token: existing.token },
      kind: "reuse",
    };
  }

  /** Verify signature/audience/expiry/revocation. Returns undefined for any invalid token. */
  async verify(token: string): Promise<CloudModelGrantClaims | undefined> {
    try {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return undefined;
      const now = this.#now();
      const verified = await jwtVerify(token, this.#key, {
        algorithms: ["HS256"],
        audience: MODEL_GRANT_AUDIENCE,
        currentDate: now,
        issuer: MODEL_GRANT_ISSUER,
      });
      const { exp, iat, jti } = verified.payload;
      if (typeof exp !== "number" || typeof iat !== "number" || typeof jti !== "string") return undefined;
      const nowSeconds = Math.floor(now.getTime() / 1_000);
      // Reject tokens that claim a future issue time or an unbounded lifetime even if signed.
      if (iat > nowSeconds + MAX_ISSUED_AT_SKEW_SECONDS) return undefined;
      if (exp - iat > CLOUD_MODEL_GRANT_MAX_TTL_MS / 1_000) return undefined;
      const claims = CloudModelGrantClaimsSchema.safeParse({
        executionId: verified.payload.executionId,
        jti,
        model: verified.payload.model,
        sandboxId: verified.payload.sandboxId,
        sessionId: verified.payload.sessionId,
      });
      if (!claims.success || claims.data.jti !== jti) return undefined;
      const state = this.#grants.get(claims.data.jti);
      if (!state || state.revoked || state.expiresAtMs <= now.getTime()) return undefined;
      if (
        state.claims.executionId !== claims.data.executionId ||
        state.claims.model !== claims.data.model ||
        state.claims.sandboxId !== claims.data.sandboxId ||
        state.claims.sessionId !== claims.data.sessionId
      ) {
        return undefined;
      }
      return claims.data;
    } catch {
      return undefined;
    }
  }

  /**
   * Admit one upstream request for a verified token: bounded concurrency per token, aborted with
   * revocation and token expiry. Returns undefined when the token is revoked/expired or saturated.
   */
  beginRequest(jti: string): { release(): void; signal: AbortSignal } | undefined {
    const state = this.#grants.get(jti);
    if (!state || state.revoked || state.expiresAtMs <= this.#now().getTime()) return undefined;
    if (state.inFlight.size >= this.#maxStreamsPerToken) return undefined;
    const controller = new AbortController();
    const handle = { abort: () => controller.abort() };
    state.inFlight.add(handle);
    return {
      release: () => {
        state.inFlight.delete(handle);
      },
      signal: controller.signal,
    };
  }

  /** Revoke every grant for one execution (turn reported, connection lost, allocation ended). */
  revokeExecution(executionId: string): number {
    let revoked = 0;
    for (const state of this.#grants.values()) {
      if (state.claims.executionId !== executionId || state.revoked) continue;
      state.revoked = true;
      revoked += 1;
      for (const handle of [...state.inFlight]) handle.abort();
      state.inFlight.clear();
    }
    return revoked;
  }

  /** Drop expired entries, aborting any stream that outlived its permission. */
  sweep(): number {
    const nowMs = this.#now().getTime();
    let swept = 0;
    for (const [jti, state] of [...this.#grants.entries()]) {
      if (state.expiresAtMs > nowMs) continue;
      if (state.inFlight.size > 0) {
        for (const handle of [...state.inFlight]) handle.abort();
        state.inFlight.clear();
      }
      this.#grants.delete(jti);
      if (this.#byExecution.get(state.claims.executionId) === jti) {
        this.#byExecution.delete(state.claims.executionId);
      }
      swept += 1;
    }
    return swept;
  }

  /** Stop the recurring sweep, abort every in-flight stream, and drop all grant state. */
  close(): void {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
    for (const state of this.#grants.values()) {
      state.revoked = true;
      for (const handle of [...state.inFlight]) handle.abort();
      state.inFlight.clear();
    }
    this.#grants.clear();
    this.#byExecution.clear();
  }

  #ensureSweepTimer(): void {
    if (this.#sweepTimer || this.#sweepIntervalMs <= 0) return;
    this.#sweepTimer = setInterval(() => {
      this.sweep();
    }, this.#sweepIntervalMs);
    this.#sweepTimer.unref?.();
  }

  #resolveExpiry(expiresAt: Date | undefined, nowMs: number): number | undefined {
    if (expiresAt === undefined) return nowMs + this.#ttlSeconds * 1_000;
    if (!(expiresAt instanceof Date)) return undefined;
    const expiresAtMs = expiresAt.getTime();
    if (!Number.isFinite(expiresAtMs)) return undefined;
    if (expiresAtMs <= nowMs) return undefined;
    if (expiresAtMs > nowMs + CLOUD_MODEL_GRANT_MAX_TTL_MS) return undefined;
    return expiresAtMs;
  }

  /**
   * Keep retained state hard-bounded: sweep expired entries, then evict the soonest-expiring
   * revoked tombstones. If every retained grant is live the new permission is refused (fail
   * closed) rather than exceeding the memory bound.
   */
  #reserveCapacity(): boolean {
    if (this.#grants.size < this.#maxTrackedGrants) return true;
    this.sweep();
    if (this.#grants.size < this.#maxTrackedGrants) return true;
    const evictable = [...this.#grants.entries()]
      .filter(([, state]) => state.revoked && state.inFlight.size === 0)
      .sort((left, right) => left[1].expiresAtMs - right[1].expiresAtMs);
    while (this.#grants.size >= this.#maxTrackedGrants && evictable.length > 0) {
      const next = evictable.shift();
      if (!next) break;
      const [jti, state] = next;
      this.#grants.delete(jti);
      if (this.#byExecution.get(state.claims.executionId) === jti) {
        this.#byExecution.delete(state.claims.executionId);
      }
    }
    return this.#grants.size < this.#maxTrackedGrants;
  }
}
