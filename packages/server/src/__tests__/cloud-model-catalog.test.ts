import { afterEach, describe, expect, it } from "vitest";
import {
  createStaticCloudModelCatalog,
  RouterCloudModelCatalog,
  selectCloudModelExecutionProfile,
} from "../services/sandboxes/cloud-model-catalog.js";
import {
  type CloudModelUpstream,
  FIXTURE_MASTER_KEY,
  startCloudModelUpstream,
} from "./fixtures/cloud-model-upstream.js";

const MODELS_PAYLOAD = {
  object: "list",
  data: [
    {
      id: "router-model-a",
      object: "model",
      created: 0,
      owned_by: "llm-router",
      context_window: 262_144,
      max_output_tokens: 8_192,
    },
    {
      id: "router-model-b",
      object: "model",
      created: 0,
      owned_by: "llm-router",
      context_window: 64_000,
      max_output_tokens: 4_096,
    },
  ],
};

const upstreams: CloudModelUpstream[] = [];
afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
});

async function startCatalogUpstream(
  handler: Parameters<typeof startCloudModelUpstream>[0],
): Promise<CloudModelUpstream> {
  const upstream = await startCloudModelUpstream(handler);
  upstreams.push(upstream);
  return upstream;
}

function makeCatalog(
  upstream: CloudModelUpstream,
  options: { cacheTtlMs?: number; maxModels?: number; now?: () => number; timeoutMs?: number } = {},
) {
  return new RouterCloudModelCatalog({
    upstreamBaseUrl: upstream.baseUrl,
    masterKey: FIXTURE_MASTER_KEY,
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.maxModels !== undefined ? { maxModels: options.maxModels } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

describe("RouterCloudModelCatalog", () => {
  it("reads the fixed /models path with the Bearer master key and publishes only validated ids", async () => {
    const upstream = await startCatalogUpstream({ kind: "json", payload: MODELS_PAYLOAD });
    const catalog = makeCatalog(upstream);
    const snapshot = await catalog.list();
    expect(snapshot).toEqual({
      available: true,
      defaultModel: "router-model-a",
      models: ["router-model-a", "router-model-b"],
    });
    // The default is the first Router model, and membership resolves from the same list.
    await expect(catalog.defaultModel()).resolves.toBe("router-model-a");
    await expect(catalog.isModelAllowed("router-model-b")).resolves.toBe(true);
    await expect(catalog.isModelAllowed("model-z")).resolves.toBe(false);
    // Exactly the fixed path, one GET, and the platform Bearer credential.
    expect(upstream.stats.methods).toEqual(["GET"]);
    expect(upstream.stats.paths).toEqual(["/models"]);
    expect(upstream.stats.authorizations).toEqual([`Bearer ${FIXTURE_MASTER_KEY}`]);
    // Nothing but the ids crossed the boundary.
    expect(JSON.stringify(snapshot)).not.toContain("llm-router");
  });

  it("retains Router-verified capability metadata per model without changing the visible list", async () => {
    const upstream = await startCatalogUpstream({ kind: "json", payload: MODELS_PAYLOAD });
    const catalog = makeCatalog(upstream);
    await expect(catalog.capabilitiesOf("router-model-a")).resolves.toEqual({
      contextWindow: 262_144,
      maxOutputTokens: 8_192,
    });
    await expect(catalog.capabilitiesOf("router-model-b")).resolves.toEqual({
      contextWindow: 64_000,
      maxOutputTokens: 4_096,
    });
    // An unlisted model has no capabilities; the capability read shares the one bounded fetch.
    await expect(catalog.capabilitiesOf("model-z")).resolves.toBeUndefined();
    expect(upstream.stats.hits).toBe(1);
  });

  it("excludes models whose capability metadata is absent or malformed", async () => {
    const upstream = await startCatalogUpstream({
      kind: "json",
      payload: {
        object: "list",
        data: [
          { id: "router-no-caps" },
          { id: "router-bad-window", context_window: "258000", max_output_tokens: 8_192 },
          { id: "router-fractional", context_window: 258_000.5, max_output_tokens: 8_192 },
          { id: "router-oversized-output", context_window: 258_000, max_output_tokens: 65_536 },
          { id: "router-zero", context_window: 0, max_output_tokens: 8_192 },
        ],
      },
    });
    const catalog = makeCatalog(upstream);
    const snapshot = await catalog.list();
    expect(snapshot).toEqual({ available: false, defaultModel: null, models: [] });
    await expect(catalog.isModelAllowed("router-no-caps")).resolves.toBe(false);
  });

  it("reuses the fresh cache within its TTL and refreshes lazily after expiry", async () => {
    const upstream = await startCatalogUpstream({ kind: "json", payload: MODELS_PAYLOAD });
    let nowMs = 1_000_000;
    const catalog = makeCatalog(upstream, { cacheTtlMs: 60_000, now: () => nowMs });
    await catalog.list();
    await catalog.list();
    expect(upstream.stats.hits).toBe(1);

    nowMs += 59_999;
    await catalog.list();
    expect(upstream.stats.hits).toBe(1);

    nowMs += 2;
    await catalog.list();
    expect(upstream.stats.hits).toBe(2);
  });

  it("shares one in-flight fetch across concurrent readers", async () => {
    const upstream = await startCatalogUpstream({ kind: "json", payload: MODELS_PAYLOAD });
    const catalog = makeCatalog(upstream);
    const [first, second, allowed] = await Promise.all([
      catalog.list(),
      catalog.list(),
      catalog.isModelAllowed("router-model-a"),
    ]);
    expect(first).toEqual(second);
    expect(allowed).toBe(true);
    expect(upstream.stats.hits).toBe(1);
  });

  it("answers unavailable for redirects, non-200 statuses, wrong content types, and empty lists", async () => {
    for (const handler of [
      { kind: "redirect", location: "https://evil.example.com/models" },
      { kind: "error", status: 401 },
      { kind: "error", status: 500 },
      { kind: "bad-content-type" },
      { kind: "json", payload: { object: "list", data: [] } },
      { kind: "empty" },
    ] as const) {
      const upstream = await startCatalogUpstream(handler);
      const catalog = makeCatalog(upstream);
      await expect(catalog.list()).resolves.toEqual({ available: false, defaultModel: null, models: [] });
      await expect(catalog.defaultModel()).resolves.toBeUndefined();
      await expect(catalog.isModelAllowed("router-model-a")).resolves.toBe(false);
      // Redirects are never followed and failures are never cached: every read hit exactly the
      // one fixed models path (the redirect target never saw a request).
      expect(upstream.stats.hits).toBeGreaterThanOrEqual(1);
      expect(upstream.stats.paths.every((path) => path === "/models")).toBe(true);
    }
  });

  it("rejects malformed, oversized, over-count, and wire-invalid model lists", async () => {
    const upstream = await startCatalogUpstream({ kind: "json", payload: "not-json" });
    await expect(makeCatalog(upstream).list()).resolves.toMatchObject({ available: false });

    const wrongShape = await startCatalogUpstream({ kind: "json", payload: { models: ["a"] } });
    await expect(makeCatalog(wrongShape).list()).resolves.toMatchObject({ available: false });

    const invalidId = await startCatalogUpstream({
      kind: "json",
      payload: { object: "list", data: [{ id: "ok" }, { id: "x".repeat(129) }] },
    });
    await expect(makeCatalog(invalidId).list()).resolves.toMatchObject({ available: false });

    const overCount = await startCatalogUpstream({
      kind: "json",
      payload: { object: "list", data: Array.from({ length: 5 }, (_, index) => ({ id: `m-${index}` })) },
    });
    await expect(makeCatalog(overCount, { maxModels: 4 }).list()).resolves.toMatchObject({ available: false });

    const oversized = await startCatalogUpstream({ kind: "overflow", totalBytes: 512 * 1024, chunkBytes: 8 * 1024 });
    await expect(makeCatalog(oversized).list()).resolves.toMatchObject({ available: false });
  });

  it("times a stalled Router read out and never serves the expired cache after a failed refresh", async () => {
    const stalled = await startCatalogUpstream({ kind: "stall" });
    await expect(makeCatalog(stalled, { timeoutMs: 50 }).list()).resolves.toEqual({
      available: false,
      defaultModel: null,
      models: [],
    });

    // A healthy read populates the cache; once expired, a failed refresh answers unavailable
    // rather than the stale list, so a delisted model stops being issued.
    let nowMs = 0;
    let healthy = true;
    const fetchImpl: typeof fetch = (async () => {
      if (!healthy) throw new Error("router down");
      return new Response(JSON.stringify(MODELS_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const catalog = new RouterCloudModelCatalog({
      upstreamBaseUrl: "https://router.example.com/v1",
      masterKey: FIXTURE_MASTER_KEY,
      fetchImpl,
      cacheTtlMs: 1_000,
      now: () => nowMs,
    });
    await expect(catalog.list()).resolves.toMatchObject({ available: true, defaultModel: "router-model-a" });
    nowMs += 1_001;
    healthy = false;
    await expect(catalog.list()).resolves.toEqual({ available: false, defaultModel: null, models: [] });
    await expect(catalog.isModelAllowed("router-model-a")).resolves.toBe(false);
  });

  it("serves a static double for tests and treats an empty double as unavailable", async () => {
    const catalog = createStaticCloudModelCatalog(["model-a", "model-b"]);
    await expect(catalog.list()).resolves.toEqual({
      available: true,
      defaultModel: "model-a",
      models: ["model-a", "model-b"],
    });
    // The double defaults to a fully verified extended-tier profile; overrides are per model and
    // an explicit `undefined` marks a deliberately unverifiable model.
    await expect(catalog.capabilitiesOf("model-a")).resolves.toEqual({
      contextWindow: 258_000,
      maxOutputTokens: 8_192,
    });
    const overridden = createStaticCloudModelCatalog(["model-a", "model-b"], {
      "model-a": { contextWindow: 100_000, maxOutputTokens: 2_048 },
      "model-b": undefined,
    });
    await expect(overridden.capabilitiesOf("model-a")).resolves.toEqual({
      contextWindow: 100_000,
      maxOutputTokens: 2_048,
    });
    await expect(overridden.capabilitiesOf("model-b")).resolves.toBeUndefined();
    await expect(createStaticCloudModelCatalog([]).list()).resolves.toEqual({
      available: false,
      defaultModel: null,
      models: [],
    });
  });

  it("selects the two Cloud window tiers only at the verified boundaries and never fabricates a default", async () => {
    expect(selectCloudModelExecutionProfile(undefined)).toBeUndefined();
    expect(selectCloudModelExecutionProfile({ contextWindow: 63_999, maxOutputTokens: 8_192 })).toBeUndefined();
    expect(selectCloudModelExecutionProfile({ contextWindow: 0, maxOutputTokens: 8_192 })).toBeUndefined();
    expect(selectCloudModelExecutionProfile({ contextWindow: 64_000, maxOutputTokens: 8_192 })).toEqual({
      contextWindow: 64_000,
      maxTokens: 8_192,
    });
    expect(selectCloudModelExecutionProfile({ contextWindow: 256_000, maxOutputTokens: 8_192 })).toEqual({
      contextWindow: 64_000,
      maxTokens: 8_192,
    });
    expect(selectCloudModelExecutionProfile({ contextWindow: 257_999, maxOutputTokens: 8_192 })).toEqual({
      contextWindow: 64_000,
      maxTokens: 8_192,
    });
    expect(selectCloudModelExecutionProfile({ contextWindow: 258_000, maxOutputTokens: 8_192 })).toEqual({
      contextWindow: 258_000,
      maxTokens: 8_192,
    });
    // A 262,144-native model runs at the extended tier; the output budget is the verified cap.
    expect(selectCloudModelExecutionProfile({ contextWindow: 262_144, maxOutputTokens: 4_096 })).toEqual({
      contextWindow: 258_000,
      maxTokens: 4_096,
    });
    expect(selectCloudModelExecutionProfile({ contextWindow: 1_000_000, maxOutputTokens: 1 })).toEqual({
      contextWindow: 258_000,
      maxTokens: 1,
    });
  });
});
