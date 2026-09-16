import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  RUNTIME_CREDENTIAL_CAPABILITY_REFRESH_AFTER_MS,
  RUNTIME_CREDENTIAL_CAPABILITY_TTL_MS,
  type RuntimeCredentialProvider,
} from "@opentag/shared";
import { capabilitySlotKey, type RuntimeExecutionPurpose } from "./types.js";

export interface RuntimeCapabilityRecord {
  grantId: string;
  tokenHash: string;
  executionId: string;
  provider: RuntimeCredentialProvider;
  bindingId: string;
  purpose: RuntimeExecutionPurpose;
  scopeHash: string;
  authorizationRevision: string;
  credentialGeneration: string;
  issuedAt: number;
  expiresAt: number;
  refreshAfter: number;
  /** True once a newer grant exists for the same execution/provider/binding; still honored until expiry. */
  superseded: boolean;
}

export interface RuntimeCapabilityIssueInput {
  executionId: string;
  provider: RuntimeCredentialProvider;
  bindingId: string;
  purpose: RuntimeExecutionPurpose;
  scopeHash: string;
  authorizationRevision: string;
  credentialGeneration: string;
}

export interface RuntimeCapabilityStoreOptions {
  now?: () => number;
  ttlMs?: number;
  refreshAfterMs?: number;
  /** Bounded owner memory: total live capability records across all executions. */
  maxRecords?: number;
}

export class RuntimeCapabilityStoreCapacityError extends Error {
  constructor() {
    super("The runtime capability store is full");
    this.name = "RuntimeCapabilityStoreCapacityError";
  }
}

const DEFAULT_MAX_RECORDS = 4096;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Hash-only bounded in-memory capability index. 256-bit random opaque tokens; the Server retains
 * only their SHA-256 digests. At most the current and the previous grant survive per
 * (execution, provider, binding) so in-flight requests finish while renewal rotates.
 */
export class RuntimeCapabilityStore {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #refreshAfterMs: number;
  readonly #maxRecords: number;
  readonly #byHash = new Map<string, RuntimeCapabilityRecord>();
  readonly #byKey = new Map<string, { current: string; previous?: string }>();

  constructor(options: RuntimeCapabilityStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? RUNTIME_CREDENTIAL_CAPABILITY_TTL_MS;
    this.#refreshAfterMs = options.refreshAfterMs ?? RUNTIME_CREDENTIAL_CAPABILITY_REFRESH_AFTER_MS;
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (this.#ttlMs < 1 || this.#refreshAfterMs < 1 || this.#refreshAfterMs >= this.#ttlMs) {
      throw new Error("Capability TTL must exceed the refresh interval");
    }
  }

  get size(): number {
    return this.#byHash.size;
  }

  issue(input: RuntimeCapabilityIssueInput): { token: string; record: RuntimeCapabilityRecord } {
    this.sweep(this.#now());
    if (this.#byHash.size >= this.#maxRecords) throw new RuntimeCapabilityStoreCapacityError();
    const now = this.#now();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const record: RuntimeCapabilityRecord = {
      grantId: randomUUID(),
      tokenHash,
      executionId: input.executionId,
      provider: input.provider,
      bindingId: input.bindingId,
      purpose: input.purpose,
      scopeHash: input.scopeHash,
      authorizationRevision: input.authorizationRevision,
      credentialGeneration: input.credentialGeneration,
      issuedAt: now,
      expiresAt: now + this.#ttlMs,
      refreshAfter: now + this.#refreshAfterMs,
      superseded: false,
    };
    const key = capabilitySlotKey(input.executionId, input.provider, input.bindingId);
    const slot = this.#byKey.get(key);
    if (slot) {
      if (slot.previous) this.#byHash.delete(slot.previous);
      const current = this.#byHash.get(slot.current);
      if (current) current.superseded = true;
      this.#byKey.set(key, { current: tokenHash, previous: slot.current });
    } else {
      this.#byKey.set(key, { current: tokenHash });
    }
    this.#byHash.set(tokenHash, record);
    return { token, record };
  }

  /** Any unexpired grant — current or previous — remains usable; a copied hash grants nothing more. */
  lookup(token: string, now = this.#now()): RuntimeCapabilityRecord | undefined {
    const record = this.#byHash.get(hashToken(token));
    if (!record || record.expiresAt <= now) return undefined;
    return record;
  }

  /**
   * True when at least one unexpired capability (current or previous, so a healthy renewal may
   * have replaced the original grant) still matches the exact execution/provider/binding/scope/
   * revision being served. Long-lived streams call this on every revalidation: revocation and a
   * missing renewal both stop within the revalidation bound without being tied to a grant id.
   */
  hasLiveMatching(input: {
    executionId: string;
    provider: RuntimeCredentialProvider;
    bindingId: string;
    scopeHash: string;
    authorizationRevision: string;
    now?: number;
  }): boolean {
    const slot = this.#byKey.get(capabilitySlotKey(input.executionId, input.provider, input.bindingId));
    if (!slot) return false;
    const now = input.now ?? this.#now();
    for (const hash of [slot.current, slot.previous]) {
      if (!hash) continue;
      const record = this.#byHash.get(hash);
      if (
        record &&
        record.expiresAt > now &&
        record.scopeHash === input.scopeHash &&
        record.authorizationRevision === input.authorizationRevision
      ) {
        return true;
      }
    }
    return false;
  }

  lookupGrant(executionId: string, grantId: string, now = this.#now()): RuntimeCapabilityRecord | undefined {
    const prefix = `${executionId}:`;
    for (const [key, slot] of this.#byKey) {
      if (!key.startsWith(prefix)) continue;
      for (const hash of [slot.current, slot.previous]) {
        if (!hash) continue;
        const record = this.#byHash.get(hash);
        if (record?.grantId === grantId) {
          return record.expiresAt <= now ? undefined : record;
        }
      }
    }
    return undefined;
  }

  revokeExecution(executionId: string): number {
    let removed = 0;
    for (const [key, slot] of [...this.#byKey.entries()]) {
      if (!key.startsWith(`${executionId}:`)) continue;
      for (const hash of [slot.current, slot.previous]) {
        if (hash && this.#byHash.delete(hash)) removed += 1;
      }
      this.#byKey.delete(key);
    }
    return removed;
  }

  sweep(now = this.#now()): number {
    let removed = 0;
    for (const [hash, record] of [...this.#byHash.entries()]) {
      if (record.expiresAt > now) continue;
      this.#byHash.delete(hash);
      removed += 1;
      const key = capabilitySlotKey(record.executionId, record.provider, record.bindingId);
      const slot = this.#byKey.get(key);
      if (!slot) continue;
      if (slot.current === hash) {
        if (slot.previous) {
          this.#byKey.set(key, { current: slot.previous });
        } else {
          this.#byKey.delete(key);
        }
      } else if (slot.previous === hash) {
        this.#byKey.set(key, { current: slot.current });
      }
    }
    return removed;
  }
}
