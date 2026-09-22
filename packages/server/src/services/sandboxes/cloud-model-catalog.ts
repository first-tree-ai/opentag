import {
  CLOUD_MODEL_CONTEXT_WINDOW_EXTENDED,
  CLOUD_MODEL_CONTEXT_WINDOW_STANDARD,
  CLOUD_MODEL_OPTIONS_MAX_MODELS,
  CLOUD_MODEL_OUTPUT_TOKEN_LIMIT,
  type CloudModelOptions,
  RuntimeModelSchema,
} from "@opentag/shared";
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

export interface CloudModelCapabilities {
  /** Router-verified native context window in tokens (a positive integer, never estimated). */
  readonly contextWindow: number;
  /** Router-verified native output ceiling in tokens (a positive integer, at most the platform limit). */
  readonly maxOutputTokens: number;
}

/**
 * The Server-selected execution profile for one issued grant: exactly one of the two Cloud
 * context tiers plus the issued output budget. The wire schema admits only these values, so the
 * Runner and the proxy never re-derive them.
 */
export interface CloudModelExecutionProfile {
  readonly contextWindow: typeof CLOUD_MODEL_CONTEXT_WINDOW_STANDARD | typeof CLOUD_MODEL_CONTEXT_WINDOW_EXTENDED;
  readonly maxTokens: number;
}

/**
 * The one place the Server maps Router-verified native capabilities to the issued Cloud execution
 * profile: a native window of at least 258,000 tokens runs at the 258,000 tier, at least 64,000 at
 * the 64,000 tier, and anything smaller — or a model whose capabilities are unknown — is not a
 * valid Cloud choice (no default is ever fabricated). The issued output budget is
 * `min(CLOUD_MODEL_OUTPUT_TOKEN_LIMIT, verified native output ceiling)`.
 */
export function selectCloudModelExecutionProfile(
  capabilities: CloudModelCapabilities | undefined,
): CloudModelExecutionProfile | undefined {
  if (!capabilities) return undefined;
  const contextWindow =
    capabilities.contextWindow >= CLOUD_MODEL_CONTEXT_WINDOW_EXTENDED
      ? CLOUD_MODEL_CONTEXT_WINDOW_EXTENDED
      : capabilities.contextWindow >= CLOUD_MODEL_CONTEXT_WINDOW_STANDARD
        ? CLOUD_MODEL_CONTEXT_WINDOW_STANDARD
        : undefined;
  if (contextWindow === undefined) return undefined;
  return { contextWindow, maxTokens: Math.min(CLOUD_MODEL_OUTPUT_TOKEN_LIMIT, capabilities.maxOutputTokens) };
}

export interface CloudModelCatalog {
  /** The current Router model choices; `available: false` when they cannot be confirmed. */
  list(): Promise<CloudModelOptions>;
  /** True only when the current Router list offers this exact model. */
  isModelAllowed(model: string): Promise<boolean>;
  /** The deployment default — the first Router model — or undefined while unavailable. */
  defaultModel(): Promise<string | undefined>;
  /**
   * The Router-verified capabilities of one listed model; undefined when the model is not listed
   * or the Router did not publish verified capability metadata for it. Unknown capabilities are
   * never a valid Cloud choice downstream — no caller may guess a window or output budget.
   */
  capabilitiesOf(model: string): Promise<CloudModelCapabilities | undefined>;
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
 * One Router list entry. Only `id` is retained for the published list — upstream metadata never
 * crosses that boundary — and an entry whose id violates the wire budget invalidates the whole
 * response, because a Router that emits one is not the deployment's model authority. The
 * capability metadata is validated separately per entry: a malformed or absent
 * `context_window`/`max_output_tokens` pair excludes that entry from Cloud choices, while preserving the other verified models.
 */
const RouterModelEntrySchema = z.object({
  id: RuntimeModelSchema,
  context_window: z.unknown().optional(),
  max_output_tokens: z.unknown().optional(),
});

/** One entry's verified capability metadata, or undefined when it is absent or malformed. */
function parseEntryCapabilities(entry: {
  context_window?: unknown;
  max_output_tokens?: unknown;
}): CloudModelCapabilities | undefined {
  const { context_window: contextWindow, max_output_tokens: maxOutputTokens } = entry;
  if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) < 1) return undefined;
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    (maxOutputTokens as number) < 1 ||
    (maxOutputTokens as number) > CLOUD_MODEL_OUTPUT_TOKEN_LIMIT
  ) {
    return undefined;
  }
  return { contextWindow: contextWindow as number, maxOutputTokens: maxOutputTokens as number };
}

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
  #cached: { fetchedAtMs: number; snapshot: RouterCatalogSnapshot } | undefined;
  #inFlight: Promise<RouterCatalogSnapshot> | undefined;

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
  async list(): Promise<CloudModelOptions> {
    return (await this.#snapshot()).options;
  }

  async isModelAllowed(model: string): Promise<boolean> {
    return (await this.list()).models.includes(model);
  }

  async defaultModel(): Promise<string | undefined> {
    return (await this.list()).defaultModel ?? undefined;
  }

  async capabilitiesOf(model: string): Promise<CloudModelCapabilities | undefined> {
    return (await this.#snapshot()).capabilities.get(model);
  }

  /** The shared bounded read: the fresh cache entry or the single in-flight refresh. */
  #snapshot(): Promise<RouterCatalogSnapshot> {
    const cached = this.#cached;
    if (cached && this.#now() - cached.fetchedAtMs < this.#cacheTtlMs) return Promise.resolve(cached.snapshot);
    // One in-flight fetch per catalog: concurrent readers (settings page, Agent validation,
    // dispatch, and the diagnostics probe) share it instead of fanning out to the Router.
    this.#inFlight ??= this.#refresh();
    return this.#inFlight;
  }

  async #refresh(): Promise<RouterCatalogSnapshot> {
    try {
      const snapshot = await this.#fetchModels();
      if (snapshot !== undefined && snapshot.options.models.length > 0) {
        this.#cached = { fetchedAtMs: this.#now(), snapshot };
        return snapshot;
      }
    } finally {
      this.#inFlight = undefined;
    }
    return CATALOG_UNAVAILABLE_ENTRY;
  }

  /**
   * One bounded GET against the fixed Router models path: Bearer master key, redirects refused,
   * identity encoding, hard timeout, capped response bytes, and strict shape validation. Every
   * failure is sanitized to `undefined`; the master key, upstream bodies, and upstream error
   * details never escape.
   */
  async #fetchModels(): Promise<RouterCatalogSnapshot | undefined> {
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

/** One validated Router read: the published id list plus the per-model verified capabilities. */
interface RouterCatalogSnapshot {
  readonly options: CloudModelOptions;
  readonly capabilities: ReadonlyMap<string, CloudModelCapabilities>;
}

const CATALOG_UNAVAILABLE_ENTRY: RouterCatalogSnapshot = {
  options: CLOUD_MODELS_UNAVAILABLE,
  capabilities: new Map(),
};

/** Parse the OpenAI list envelope; undefined for any malformed, oversized, or invalid payload. */
function parseRouterModelList(text: string, maxModels: number): RouterCatalogSnapshot | undefined {
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
  // the Router's. The first occurrence of a duplicated id wins, exactly like the published list.
  const models: string[] = [];
  const seen = new Set<string>();
  const capabilities = new Map<string, CloudModelCapabilities>();
  for (const entry of parsed.data.data) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const verified = parseEntryCapabilities(entry);
    if (!verified || !selectCloudModelExecutionProfile(verified)) continue;
    models.push(entry.id);
    capabilities.set(entry.id, verified);
  }
  return {
    options: { available: true, defaultModel: models[0] ?? null, models },
    capabilities,
  };
}

/**
 * A static catalog double for tests and embeddings. Production wires exactly one
 * RouterCloudModelCatalog; this helper exists so fixtures never fake the network. Every listed
 * model carries the fully-verified reference capabilities (258,000-token window, 8,192-token
 * output ceiling) unless the caller deliberately overrides them per model or marks a model's
 * capabilities unknown (`undefined`) to exercise the refusal path.
 */
export function createStaticCloudModelCatalog(
  models: readonly string[],
  capabilities?: CloudModelCapabilities | Record<string, CloudModelCapabilities | undefined>,
): CloudModelCatalog {
  const snapshot: CloudModelOptions =
    models.length === 0
      ? CLOUD_MODELS_UNAVAILABLE
      : { available: true, defaultModel: models[0] as string, models: [...models] };
  const verified = new Map<string, CloudModelCapabilities>();
  // The override is either one capability pair applied to every listed model or a per-model
  // record (`undefined` marks a deliberately unverified model).
  const sharedOverride =
    capabilities !== undefined && typeof (capabilities as CloudModelCapabilities).contextWindow === "number"
      ? (capabilities as CloudModelCapabilities)
      : undefined;
  for (const model of models) {
    const entry =
      capabilities === undefined
        ? STATIC_REFERENCE_CAPABILITIES
        : (sharedOverride ?? (capabilities as Record<string, CloudModelCapabilities | undefined>)[model]);
    if (entry) verified.set(model, entry);
  }
  return {
    capabilitiesOf: (model) => Promise.resolve(verified.get(model)),
    defaultModel: () => Promise.resolve(snapshot.defaultModel ?? undefined),
    isModelAllowed: (model) => Promise.resolve(snapshot.models.includes(model)),
    list: () => Promise.resolve(snapshot),
  };
}

/** The double's default: a fully verified model at the extended window and the platform ceiling. */
const STATIC_REFERENCE_CAPABILITIES: CloudModelCapabilities = {
  contextWindow: CLOUD_MODEL_CONTEXT_WINDOW_EXTENDED,
  maxOutputTokens: CLOUD_MODEL_OUTPUT_TOKEN_LIMIT,
};
