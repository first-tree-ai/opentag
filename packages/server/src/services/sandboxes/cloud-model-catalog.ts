import { CLOUD_MODEL_OPTIONS_MAX_MODELS, type CloudModelOptions, RuntimeModelSchema } from "@opentag/shared";
import { z } from "zod";

/**
 * The single Server-owned authority for Cloud model choices. The deployment Router's
 * authenticated `GET {upstreamBaseUrl}/models` (OpenAI `{object:"list",data:[{id,...}]}`) is the
 * only source: it already applies tenant permissions and the priced registry, so the Server keeps
 * no static allowlist of its own. The same fixed upstream base URL and platform master key the
 * chat-completions proxy uses authorize the read; no new URL, key, or switch exists.
 *
 * The catalog is lazy and bounded: the first read after construction or cache expiry performs one
 * fetch, concurrent readers share the single in-flight fetch, and a successful list is reused for
 * a short TTL. There is no background worker and no database state. A failed refresh of an
 * expired entry — or an empty Router list — resolves to unavailable; the catalog never falls back
 * to a static model list and never forwards arbitrary upstream data (only validated model ids are
 * retained). Model ids validate against the existing runtime wire budget (128 bytes).
 */

/** The unavailable snapshot: the only terminal answer a failed or empty Router read may produce. */
const CLOUD_MODELS_UNAVAILABLE: CloudModelOptions = { available: false, defaultModel: null, models: [] };

/** Freshness window for one successful Router list read. */
const CLOUD_MODEL_CATALOG_CACHE_TTL_MS = 60_000;
/** Bounded wait for one Router list read; callers never hang on a stalled upstream. */
const CLOUD_MODEL_CATALOG_TIMEOUT_MS = 5_000;
/** A model list is tiny; anything larger is not a model list. */
const CLOUD_MODEL_CATALOG_MAX_RESPONSE_BYTES = 256 * 1024;

export interface CloudModelCatalog {
  /** The current Router model choices; `available: false` when they cannot be confirmed. */
  list(): Promise<CloudModelOptions>;
  /** True only when the current Router list offers this exact model. */
  isModelAllowed(model: string): Promise<boolean>;
  /** The deployment default — the first Router model — or undefined while unavailable. */
  defaultModel(): Promise<string | undefined>;
}

export interface RouterCloudModelCatalogOptions {
  /** Fixed Router origin/base path; the only URL the catalog ever reads (`${base}/models`). */
  upstreamBaseUrl: string;
  /** Platform Router LLM key; lives in process memory only and is never logged or relayed. */
  masterKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxModels?: number;
}

/**
 * One Router list entry. Only `id` is retained — upstream metadata never crosses the boundary —
 * and an entry whose id violates the wire budget invalidates the whole response, because a
 * Router that emits one is not the deployment's model authority.
 */
const RouterModelEntrySchema = z.object({ id: RuntimeModelSchema });

/** Read one upstream response body with a hard byte cap; undefined on overflow or read failure. */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0 || length > maxBytes) {
      await discardResponseBody(response);
      return undefined;
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) return undefined;
      chunks.push(chunk.value);
    }
  } catch {
    return undefined;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The reader is already closed/cancelled; nothing left to release.
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort release of the fixed-upstream socket.
  }
}

export class RouterCloudModelCatalog implements CloudModelCatalog {
  readonly #cacheTtlMs: number;
  readonly #fetchImpl: typeof fetch;
  readonly #masterKey: string;
  readonly #maxModels: number;
  readonly #maxResponseBytes: number;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #upstreamBaseUrl: string;
  #cached: { fetchedAtMs: number; snapshot: CloudModelOptions } | undefined;
  #inFlight: Promise<CloudModelOptions> | undefined;

  constructor(options: RouterCloudModelCatalogOptions) {
    this.#cacheTtlMs = options.cacheTtlMs ?? CLOUD_MODEL_CATALOG_CACHE_TTL_MS;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#masterKey = options.masterKey;
    this.#maxModels = options.maxModels ?? CLOUD_MODEL_OPTIONS_MAX_MODELS;
    this.#maxResponseBytes = options.maxResponseBytes ?? CLOUD_MODEL_CATALOG_MAX_RESPONSE_BYTES;
    this.#now = options.now ?? (() => Date.now());
    this.#timeoutMs = options.timeoutMs ?? CLOUD_MODEL_CATALOG_TIMEOUT_MS;
    this.#upstreamBaseUrl = options.upstreamBaseUrl;
  }

  /**
   * The current choices: the fresh cache entry when it is within its TTL, otherwise one shared
   * refresh. An expired entry whose refresh fails resolves unavailable — never the stale list and
   * never a static fallback — so a model the Router stopped offering stops being issued within
   * one TTL of the change.
   */
  list(): Promise<CloudModelOptions> {
    const cached = this.#cached;
    if (cached && this.#now() - cached.fetchedAtMs < this.#cacheTtlMs) return Promise.resolve(cached.snapshot);
    // One in-flight fetch per catalog: concurrent readers (settings page, Agent validation,
    // dispatch, and the diagnostics probe) share it instead of fanning out to the Router.
    this.#inFlight ??= this.#refresh();
    return this.#inFlight;
  }

  async isModelAllowed(model: string): Promise<boolean> {
    return (await this.list()).models.includes(model);
  }

  async defaultModel(): Promise<string | undefined> {
    return (await this.list()).defaultModel ?? undefined;
  }

  async #refresh(): Promise<CloudModelOptions> {
    try {
      const models = await this.#fetchModels();
      if (models !== undefined && models.length > 0) {
        const snapshot: CloudModelOptions = { available: true, defaultModel: models[0] as string, models };
        this.#cached = { fetchedAtMs: this.#now(), snapshot };
        return snapshot;
      }
    } finally {
      this.#inFlight = undefined;
    }
    return CLOUD_MODELS_UNAVAILABLE;
  }

  /**
   * One bounded GET against the fixed Router models path: Bearer master key, redirects refused,
   * identity encoding, hard timeout, capped response bytes, and strict shape validation. Every
   * failure is sanitized to `undefined`; the master key, upstream bodies, and upstream error
   * details never escape.
   */
  async #fetchModels(): Promise<string[] | undefined> {
    // The timeout stays armed across the body read: aborting the fetch signal fails a pending
    // body read, so a stalled upstream body is bounded by the same budget as the headers.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("cloud_model_catalog_timeout")), this.#timeoutMs);
    timer.unref?.();
    try {
      const response = await this.#fetchImpl(`${this.#upstreamBaseUrl}/models`, {
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          authorization: `Bearer ${this.#masterKey}`,
        },
        method: "GET",
        // A redirect from the fixed upstream must never steer the catalog to another origin.
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await discardResponseBody(response);
        return undefined;
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        await discardResponseBody(response);
        return undefined;
      }
      const text = await readBoundedResponseText(response, this.#maxResponseBytes);
      if (text === undefined) return undefined;
      return parseRouterModelList(text, this.#maxModels);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse the OpenAI list envelope; undefined for any malformed, oversized, or invalid payload. */
function parseRouterModelList(text: string, maxModels: number): string[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = z
    .object({ object: z.literal("list"), data: z.array(RouterModelEntrySchema).max(maxModels) })
    .safeParse(raw);
  if (!parsed.success) return undefined;
  // Defensive dedupe keeps the published list canonical; order (and therefore the default) is
  // the Router's.
  return [...new Set(parsed.data.data.map((entry) => entry.id))];
}

/**
 * A static catalog double for tests and embeddings. Production wires exactly one
 * RouterCloudModelCatalog; this helper exists so fixtures never fake the network.
 */
export function createStaticCloudModelCatalog(models: readonly string[]): CloudModelCatalog {
  const snapshot: CloudModelOptions =
    models.length === 0
      ? CLOUD_MODELS_UNAVAILABLE
      : { available: true, defaultModel: models[0] as string, models: [...models] };
  return {
    defaultModel: () => Promise.resolve(snapshot.defaultModel ?? undefined),
    isModelAllowed: (model) => Promise.resolve(snapshot.models.includes(model)),
    list: () => Promise.resolve(snapshot),
  };
}
