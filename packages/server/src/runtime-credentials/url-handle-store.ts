import { randomBytes } from "node:crypto";
import type { RuntimeCredentialProvider } from "@opentag/shared";

export const RUNTIME_URL_HANDLE_PATH_PREFIX = "/__opentag__/handles/";
export const RUNTIME_URL_HANDLE_TTL_MS = 15 * 60 * 1_000;

export interface RuntimeUrlHandle {
  handleId: string;
  executionId: string;
  provider: RuntimeCredentialProvider;
  kind: "upload" | "download";
  /** Real upstream URL, retained only in bounded Server memory. */
  url: string;
  expiresAt: number;
}

export interface RuntimeUrlHandleStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxHandles?: number;
}

export class RuntimeUrlHandleStoreCapacityError extends Error {
  constructor() {
    super("The runtime URL handle store is full");
    this.name = "RuntimeUrlHandleStoreCapacityError";
  }
}

export function runtimeUrlHandlePath(handleId: string): string {
  return `${RUNTIME_URL_HANDLE_PATH_PREFIX}${handleId}`;
}

export function rewriteUrlToHandle(origin: string, handleId: string): string {
  return `${origin}${runtimeUrlHandlePath(handleId)}`;
}

/**
 * Server-held upload/download handles. Native signed or token-authorized URLs never cross to the
 * caller; responses carry execution-scoped handle URLs on the provider's fixed origin, and every
 * use re-resolves the execution/provider/kind binding and re-runs authorization upstream.
 */
export class RuntimeUrlHandleStore {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxHandles: number;
  readonly #handles = new Map<string, RuntimeUrlHandle>();

  constructor(options: RuntimeUrlHandleStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? RUNTIME_URL_HANDLE_TTL_MS;
    this.#maxHandles = options.maxHandles ?? 4096;
  }

  get size(): number {
    return this.#handles.size;
  }

  create(input: {
    executionId: string;
    provider: RuntimeCredentialProvider;
    kind: "upload" | "download";
    url: string;
  }): string {
    this.sweep(this.#now());
    if (this.#handles.size >= this.#maxHandles) throw new RuntimeUrlHandleStoreCapacityError();
    const handleId = randomBytes(24).toString("base64url");
    this.#handles.set(handleId, {
      handleId,
      executionId: input.executionId,
      provider: input.provider,
      kind: input.kind,
      url: input.url,
      expiresAt: this.#now() + this.#ttlMs,
    });
    return handleId;
  }

  resolve(
    handleId: string,
    expected: { executionId: string; provider: RuntimeCredentialProvider; kind: "upload" | "download" },
    now = this.#now(),
  ): RuntimeUrlHandle | undefined {
    const handle = this.#handles.get(handleId);
    if (!handle || handle.expiresAt <= now) return undefined;
    if (
      handle.executionId !== expected.executionId ||
      handle.provider !== expected.provider ||
      handle.kind !== expected.kind
    ) {
      return undefined;
    }
    return handle;
  }

  revokeExecution(executionId: string): number {
    let removed = 0;
    for (const [handleId, handle] of [...this.#handles.entries()]) {
      if (handle.executionId !== executionId) continue;
      this.#handles.delete(handleId);
      removed += 1;
    }
    return removed;
  }

  sweep(now = this.#now()): number {
    let removed = 0;
    for (const [handleId, handle] of [...this.#handles.entries()]) {
      if (handle.expiresAt > now) continue;
      this.#handles.delete(handleId);
      removed += 1;
    }
    return removed;
  }
}
