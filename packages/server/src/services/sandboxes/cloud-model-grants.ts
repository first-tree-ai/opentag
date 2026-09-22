import { randomUUID } from "node:crypto";
import { CLOUD_MODEL_OUTPUT_TOKEN_LIMIT, RUNTIME_MAX_DURATION_MS } from "@opentag/shared";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import {
  type CloudModelCatalog,
  type CloudModelExecutionProfile,
  selectCloudModelExecutionProfile,
} from "./cloud-model-catalog.js";

/**
 * Execution-scoped model call permission. The delivery owner may prepare a token before custody
 * commits, but sends it to the Runner only after durable custody and authorization checks (the
 * "verified" boundary). This service controls signing and revocation, not custody. A mint that
 * loses a revocation, close or expiry race is never returned. A token pins the exact
 * turn/sandbox/session/model, and is revoked when
 * the turn reports, when its Runner connection is lost, or when its allocation ends. Revocation
 * also aborts in-flight upstream streams. Tokens are HS256 JWTs under a dedicated audience; the
 * platform model master key never leaves the proxy route.
 *
 * Model admission is the Server-owned CloudModelCatalog (the deployment Router's live model
 * list), never a static allowlist: the catalog read is awaited INSIDE the reservation lifecycle
 * (see #mint), so the reservation still lands synchronously and a revocation, close, or expiry
 * that races the read marks the tombstone and wins before any token exists. A stale Router list
 * never authorizes a new grant: once the catalog's bounded cache expires, a failed refresh
 * refuses issuance.
 *
 * Issuance keeps the capacity bound and the per-execution idempotence across concurrent issue()
 * calls without any lock table: the reservation — which counts against the retained-grant bound
 * and is keyed by execution — is inserted synchronously before the asynchronous JWT signing
 * starts. A concurrent mint for a different execution therefore fails closed against the bound,
 * while a concurrent duplicate for the same execution awaits the one in-flight mint and reuses
 * its token. A failed mint releases the reservation unless the execution was revoked meanwhile,
 * so capacity and retry-ability survive signing errors without unbounded state.
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

/**
 * The immutable execution scope reserved synchronously at issue() time; the Router-verified
 * capability profile is resolved inside the reservation (see #mint) and completes the claims.
 */
const grantScopeShape = {
  jti: z.string().uuid(),
  executionId: z.string().min(1).max(256),
  sandboxId: z.string().uuid(),
  sessionId: z.string().uuid(),
  model: z.string().min(1).max(128),
} as const;

const CloudModelGrantScopeSchema = z.object(grantScopeShape).strict();

type CloudModelGrantScope = z.infer<typeof CloudModelGrantScopeSchema>;

const CloudModelGrantClaimsSchema = z
  .object({
    ...grantScopeShape,
    /** The issued output budget the model proxy enforces for this exact permission. */
    maxTokens: z.number().int().min(1).max(CLOUD_MODEL_OUTPUT_TOKEN_LIMIT),
  })
  .strict();

export type CloudModelGrantClaims = z.infer<typeof CloudModelGrantClaimsSchema>;

export interface CloudModelGrantIssue {
  claims: CloudModelGrantClaims;
  token: string;
  expiresAt: Date;
  /**
   * The working context window selected once here from the Router-verified native window
   * (exactly one of the two Cloud tiers); the Runner writes it to Pi verbatim.
   */
  contextWindow: CloudModelExecutionProfile["contextWindow"];
  /** The issued output budget: `min(platform ceiling, Router-verified native output limit)`. */
  maxTokens: number;
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
  /** The immutable scope reserved synchronously at issue() time (revocation matches on it). */
  scope: CloudModelGrantScope;
  /** The finalized claims; present once the mint resolved the capability profile. */
  claims: CloudModelGrantClaims | undefined;
  /** The Server-selected execution profile for this grant; present once the mint resolved it. */
  profile: CloudModelExecutionProfile | undefined;
  expiresAtMs: number;
  revoked: boolean;
  inFlight: Set<{ abort(): void }>;
  /** Disclosed token; empty while the mint is in flight or after it lost a revocation race. */
  token: string;
  /** In-flight mint for this reservation; undefined once the reservation has settled. */
  signing: Promise<string | undefined> | undefined;
}

export class CloudModelGrantService {
  readonly #byExecution = new Map<string, string>();
  readonly #catalog: CloudModelCatalog;
  readonly #grants = new Map<string, GrantState>();
  readonly #key: Uint8Array;
  readonly #maxStreamsPerToken: number;
  readonly #maxTrackedGrants: number;
  readonly #now: () => Date;
  readonly #sweepIntervalMs: number;
  readonly #ttlSeconds: number;
  #closed = false;
  #sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    secret: string,
    options: {
      /** The Server-owned Router model catalog; the sole admission authority for minted models. */
      catalog: CloudModelCatalog;
      maxStreamsPerToken: number;
      now?: () => Date;
      ttlSeconds: number;
      /** Test/embedding override for the retained-grant bound. */
      maxTrackedGrants?: number;
      /** Recurring expiry sweep cadence; 0 disables the internal timer. */
      sweepIntervalMs?: number;
    },
  ) {
    if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 1) {
      throw new Error("The Cloud model grant service requires a positive integer ttlSeconds");
    }
    if (options.ttlSeconds > CLOUD_MODEL_GRANT_MAX_TTL_MS / 1_000) {
      throw new Error("The Cloud model grant service ttlSeconds exceeds the supported 24h runtime ceiling");
    }
    this.#catalog = options.catalog;
    this.#key = new TextEncoder().encode(secret);
    this.#maxStreamsPerToken = options.maxStreamsPerToken;
    this.#maxTrackedGrants = options.maxTrackedGrants ?? MAX_TRACKED_GRANTS_DEFAULT;
    this.#now = options.now ?? (() => new Date());
    this.#sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS_DEFAULT;
    this.#ttlSeconds = options.ttlSeconds;
  }

  /** The deployment default (the first Router model); undefined while the catalog is unavailable. */
  defaultModel(): Promise<string | undefined> {
    return this.#catalog.defaultModel();
  }

  /** Diagnostic retained-state size (live grants, in-flight reservations, and revocation tombstones). */
  get trackedGrantCount(): number {
    return this.#grants.size;
  }

  /** True only when the current Router model list offers this exact model. */
  isModelAllowed(model: string): Promise<boolean> {
    return this.#catalog.isModelAllowed(model);
  }

  /**
   * Mint a grant for one verified delivery. The model must be offered by the current Router
   * catalog. An identical
   * live grant for the same execution is reused (same token) and a conflicting scope/model is
   * refused. A revoked execution is never re-minted unless the caller explicitly requests
   * `supersedeRevoked` after re-validating current custody; an expired execution stays refused.
   * Concurrent calls are serialized through the reservation itself: the slot is reserved
   * synchronously before the asynchronous signing, a duplicate for the same execution awaits the
   * in-flight mint and reuses its token, and the retained-grant bound accounts for in-flight
   * reservations, so concurrent mints for distinct executions fail closed.
   */
  async issue(input: CloudModelGrantIssueInput): Promise<CloudModelGrantIssue | undefined> {
    if (this.#closed) return undefined;
    const nowMs = this.#now().getTime();
    const existing = this.#checkExistingGrant(input, nowMs);
    if (existing.kind === "refuse") return undefined;
    if (existing.kind === "reuse") return this.#disclose(existing.state);
    // A "rotate" decision keeps the old revoked jti as a tombstone and mints a fresh generation;
    // the by-execution pointer moves to the new jti so revocation of the turn kills both.
    const expiresAtMs = this.#resolveExpiry(input.expiresAt, nowMs);
    if (expiresAtMs === undefined) return undefined;
    const scope = CloudModelGrantScopeSchema.safeParse({
      executionId: input.executionId,
      jti: randomUUID(),
      model: input.model,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
    });
    if (!scope.success) return undefined;
    const issuedAt = Math.floor(nowMs / 1_000);
    const expirationSeconds = Math.floor(expiresAtMs / 1_000);
    if (expirationSeconds <= issuedAt || !this.#reserveCapacity()) return undefined;
    // Reserve the slot synchronously, BEFORE the asynchronous signing starts: the capacity bound
    // and the per-execution idempotence therefore hold across concurrent issue() calls.
    const reservation: GrantState = {
      scope: scope.data,
      claims: undefined,
      profile: undefined,
      expiresAtMs,
      inFlight: new Set(),
      revoked: false,
      signing: undefined,
      token: "",
    };
    this.#grants.set(scope.data.jti, reservation);
    this.#byExecution.set(scope.data.executionId, scope.data.jti);
    this.#ensureSweepTimer();
    reservation.signing = this.#mint(reservation, issuedAt, expirationSeconds);
    return this.#disclose(reservation);
  }

  /**
   * Disclose one grant to its caller: await any in-flight mint, then re-validate that the
   * reservation is still tracked, unrevoked, and unexpired. A revocation, close, sweep, or
   * eviction that raced the mint wins, and the token is never disclosed.
   */
  async #disclose(state: GrantState): Promise<CloudModelGrantIssue | undefined> {
    if (state.signing !== undefined) {
      const settled = await state.signing;
      if (settled === undefined) return undefined;
    }
    if (this.#grants.get(state.scope.jti) !== state) return undefined;
    if (state.revoked || state.token.length === 0) return undefined;
    if (state.expiresAtMs <= this.#now().getTime()) return undefined;
    const claims = state.claims;
    const profile = state.profile;
    if (!claims || !profile) return undefined;
    return {
      claims,
      expiresAt: new Date(state.expiresAtMs),
      token: state.token,
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
    };
  }

  /**
   * Admit the model and sign one reserved grant, settling the reservation. The Router catalog
   * read and the signing are the only awaits between the capacity reservation and disclosure, so
   * anything that raced them is honoured here: a swept or evicted reservation discloses nothing,
   * and a revocation or close that landed mid-read or mid-mint keeps the reservation as a revoked
   * tombstone whose token is never disclosed. A denied/unavailable model, a model without valid
   * Router-verified capabilities, or a failed mint removes the reservation — releasing capacity
   * and keeping the execution reusable — unless it was revoked meanwhile, in which case the
   * tombstone stays so the turn is never silently re-minted.
   */
  async #mint(state: GrantState, issuedAt: number, expirationSeconds: number): Promise<string | undefined> {
    let token: string | undefined;
    try {
      // Model admission happens while the reservation already exists: a revocation racing this
      // await marks the tombstone below instead of being lost. Admission requires Router-verified
      // capabilities that select a real Cloud execution profile; a listed model without them (or
      // with a native window below the smallest tier) is not a valid Cloud choice and never gets
      // a fabricated default.
      const profile = selectCloudModelExecutionProfile(await this.#catalog.capabilitiesOf(state.scope.model));
      const claims = profile
        ? CloudModelGrantClaimsSchema.safeParse({ ...state.scope, maxTokens: profile.maxTokens })
        : undefined;
      if (profile && claims?.success) {
        token = await new SignJWT(claims.data)
          .setProtectedHeader({ alg: "HS256", typ: "JWT" })
          .setIssuer(MODEL_GRANT_ISSUER)
          .setAudience(MODEL_GRANT_AUDIENCE)
          .setIssuedAt(issuedAt)
          .setExpirationTime(expirationSeconds)
          .setJti(claims.data.jti)
          .sign(this.#key);
        if (token !== undefined) {
          state.claims = claims.data;
          state.profile = profile;
        }
      }
    } catch {
      token = undefined;
    }
    state.signing = undefined;
    // A swept or evicted reservation discloses nothing.
    if (this.#grants.get(state.scope.jti) !== state) return undefined;
    if (token === undefined) {
      if (state.revoked) return undefined;
      this.#grants.delete(state.scope.jti);
      if (this.#byExecution.get(state.scope.executionId) === state.scope.jti) {
        this.#byExecution.delete(state.scope.executionId);
      }
      return undefined;
    }
    // Revoked or closed while signing: the tombstone stays and the token is never disclosed.
    if (state.revoked) return undefined;
    state.token = token;
    return token;
  }

  #checkExistingGrant(
    input: CloudModelGrantIssueInput,
    nowMs: number,
  ): { kind: "none" } | { kind: "reuse"; state: GrantState } | { kind: "rotate" } | { kind: "refuse" } {
    const existingJti = this.#byExecution.get(input.executionId);
    if (existingJti === undefined) return { kind: "none" };
    const existing = this.#grants.get(existingJti);
    if (!existing) {
      this.#byExecution.delete(input.executionId);
      return { kind: "none" };
    }
    const sameScope =
      existing.scope.model === input.model &&
      existing.scope.sandboxId === input.sandboxId &&
      existing.scope.sessionId === input.sessionId;
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
    return { kind: "reuse", state: existing };
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
        maxTokens: verified.payload.maxTokens,
      });
      if (!claims.success || claims.data.jti !== jti) return undefined;
      const state = this.#grants.get(claims.data.jti);
      // A grant whose token was never disclosed (mint in flight or lost to a race) never verifies.
      if (!state || state.revoked || state.token.length === 0 || state.expiresAtMs <= now.getTime()) return undefined;
      if (
        !state.claims ||
        state.claims.executionId !== claims.data.executionId ||
        state.claims.model !== claims.data.model ||
        state.claims.sandboxId !== claims.data.sandboxId ||
        state.claims.sessionId !== claims.data.sessionId ||
        state.claims.maxTokens !== claims.data.maxTokens
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
      if (state.scope.executionId !== executionId || state.revoked) continue;
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
      if (this.#byExecution.get(state.scope.executionId) === jti) {
        this.#byExecution.delete(state.scope.executionId);
      }
      swept += 1;
    }
    return swept;
  }

  /** Stop issuance and the recurring sweep, abort every in-flight stream, and drop all state. */
  close(): void {
    this.#closed = true;
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
      if (this.#byExecution.get(state.scope.executionId) === jti) {
        this.#byExecution.delete(state.scope.executionId);
      }
    }
    return this.#grants.size < this.#maxTrackedGrants;
  }
}
