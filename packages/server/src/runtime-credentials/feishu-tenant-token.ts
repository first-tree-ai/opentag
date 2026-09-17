import { z } from "zod";

export interface FeishuTenantToken {
  token: string;
  expiresAt: number;
}

export interface FeishuTenantTokenExchangeInput {
  origin: string;
  appId: string;
  appSecret: string;
  signal?: AbortSignal;
}

export type FeishuTenantTokenExchange = (input: FeishuTenantTokenExchangeInput) => Promise<FeishuTenantToken>;

const TenantTokenResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().int().positive().optional(),
});

export class FeishuTenantTokenExchangeError extends Error {
  constructor(readonly kind: "upstream" | "rejected" | "invalid") {
    super(`Feishu tenant token exchange failed: ${kind}`);
    this.name = "FeishuTenantTokenExchangeError";
  }
}

/**
 * Real tenant token exchange against the fixed brand origin. The response `expire` seconds are the
 * only lifetime authority; the platform token never leaves the Server.
 */
export async function exchangeFeishuTenantToken(
  input: FeishuTenantTokenExchangeInput & { fetchImpl?: typeof fetch; now?: () => number },
): Promise<FeishuTenantToken> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  let response: Response;
  try {
    response = await fetchImpl(`${input.origin}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
      redirect: "error",
      signal: input.signal ?? AbortSignal.timeout(10_000),
    });
  } catch (_error) {
    throw new FeishuTenantTokenExchangeError("upstream");
  }
  if (!response.ok) throw new FeishuTenantTokenExchangeError("upstream");
  let payload: z.infer<typeof TenantTokenResponseSchema>;
  try {
    payload = TenantTokenResponseSchema.parse(await response.json());
  } catch {
    throw new FeishuTenantTokenExchangeError("invalid");
  }
  if (payload.code !== 0) throw new FeishuTenantTokenExchangeError("rejected");
  if (!payload.tenant_access_token || !payload.expire) throw new FeishuTenantTokenExchangeError("invalid");
  return { token: payload.tenant_access_token, expiresAt: now() + payload.expire * 1_000 };
}

export interface FeishuTenantTokenCacheOptions {
  exchange?: FeishuTenantTokenExchange;
  now?: () => number;
  /** Re-exchange this long before the platform-reported expiry. */
  refreshSkewMs?: number;
  maxEntries?: number;
}

interface CacheEntry {
  value?: FeishuTenantToken;
  pending?: Promise<FeishuTenantToken>;
}

/**
 * Bounded Server-side cache keyed by (bindingId, credentialGeneration, brand). A generation bump
 * changes the key, so revoked material is unreachable; concurrent exchanges merge on one flight.
 */
export class FeishuTenantTokenCache {
  readonly #exchange: FeishuTenantTokenExchange;
  readonly #now: () => number;
  readonly #refreshSkewMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: FeishuTenantTokenCacheOptions = {}) {
    this.#exchange = options.exchange ?? exchangeFeishuTenantToken;
    this.#now = options.now ?? Date.now;
    this.#refreshSkewMs = options.refreshSkewMs ?? 60_000;
    this.#maxEntries = options.maxEntries ?? 256;
  }

  get size(): number {
    return this.#entries.size;
  }

  async get(input: {
    bindingId: string;
    credentialGeneration: number;
    brand: string;
    origin: string;
    appId: string;
    appSecret: string;
    signal?: AbortSignal;
  }): Promise<FeishuTenantToken> {
    const key = `${input.bindingId}:${input.credentialGeneration}:${input.brand}`;
    const existing = this.#entries.get(key);
    if (existing?.value && existing.value.expiresAt - this.#now() > this.#refreshSkewMs) return existing.value;
    if (existing?.pending) return existing.pending;
    const pending = this.#exchange({
      origin: input.origin,
      appId: input.appId,
      appSecret: input.appSecret,
      signal: input.signal,
    }).then(
      (value) => {
        this.#entries.set(key, { value });
        this.#evictOverflow();
        return value;
      },
      (error: unknown) => {
        // Failed exchanges never poison the cache; the next caller retries upstream.
        if (this.#entries.get(key)?.pending === pending) this.#entries.delete(key);
        throw error;
      },
    );
    this.#entries.set(key, { pending });
    return pending;
  }

  clear(): void {
    this.#entries.clear();
  }

  #evictOverflow(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
