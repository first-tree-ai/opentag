import { describe, expect, it } from "vitest";
import { resolveCloudModelConfig } from "../cloud-model-config.js";

const MASTER_KEY = "fixture-master-key-sentinel-9f1c0d";

function enabledEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENTAG_CLOUD_MODEL_ALLOWED_MODELS: "model-a,model-b",
    OPENTAG_CLOUD_MODEL_ENABLED: "true",
    OPENTAG_CLOUD_MODEL_MASTER_KEY: MASTER_KEY,
    OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "https://models.example.com/v1/",
    ...overrides,
  };
}

describe("resolveCloudModelConfig", () => {
  it("is disabled by default with no environment and requires no staging configuration", () => {
    expect(resolveCloudModelConfig({}, true)).toEqual({ enabled: false });
    expect(resolveCloudModelConfig({}, false)).toEqual({ enabled: false });
    // Disabled wins even when a Cloud Runner is unavailable; nothing is provisioned or called.
    expect(resolveCloudModelConfig({ OPENTAG_CLOUD_MODEL_ENABLED: "false" }, false)).toEqual({ enabled: false });
  });

  it("requires the Cloud Runner and every fixed-upstream setting when enabled", () => {
    expect(() => resolveCloudModelConfig(enabledEnvironment(), false)).toThrow(/Cloud Runner/);
    expect(() =>
      resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "" }), true),
    ).toThrow(/UPSTREAM_BASE_URL/);
    expect(() => resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_MASTER_KEY: "" }), true)).toThrow(
      /MASTER_KEY/,
    );
    expect(() => resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_ALLOWED_MODELS: "" }), true)).toThrow(
      /ALLOWED_MODELS/,
    );
  });

  it("normalizes a fixed HTTPS upstream and keeps the model allowlist ordered", () => {
    const config = resolveCloudModelConfig(enabledEnvironment(), true);
    if (!config.enabled) throw new Error("expected enabled config");
    expect(config.upstreamBaseUrl).toBe("https://models.example.com/v1");
    expect(config.allowedModels).toEqual(["model-a", "model-b"]);
    expect(config.tokenTtlSeconds).toBe(1_800);
    expect(config.requestTimeoutMs).toBe(600_000);
    expect(config.maxRequestBytes).toBe(2 * 1024 * 1024);
    expect(config.maxResponseBytes).toBe(16 * 1024 * 1024);
    expect(config.maxStreamsPerToken).toBe(4);
  });

  it("gates loopback HTTP upstreams on the explicit dev environment", () => {
    expect(() =>
      resolveCloudModelConfig(
        enabledEnvironment({ OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "http://127.0.0.1:8080" }),
        true,
      ),
    ).toThrow(/loopback/);
    const config = resolveCloudModelConfig(
      enabledEnvironment({ OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "http://127.0.0.1:8080", OPENTAG_ENV: "dev" }),
      true,
    );
    if (!config.enabled) throw new Error("expected enabled config");
    expect(config.upstreamBaseUrl).toBe("http://127.0.0.1:8080");
  });

  it("rejects credentials, query strings, and non-allowlisted URL shapes", () => {
    for (const url of [
      "https://user:pass@models.example.com/v1",
      "https://models.example.com/v1?token=1",
      "ftp://models.example.com/v1",
      "https://models.example.com/v1#fragment",
    ]) {
      expect(() =>
        resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: url }), true),
      ).toThrow();
    }
  });

  it("bounds the permission TTL to the supported runtime window", () => {
    const max = resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_TOKEN_TTL_SECONDS: "86400" }), true);
    if (!max.enabled) throw new Error("expected enabled config");
    expect(max.tokenTtlSeconds).toBe(86_400);
    expect(() =>
      resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_TOKEN_TTL_SECONDS: "86401" }), true),
    ).toThrow();
    expect(() =>
      resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_TOKEN_TTL_SECONDS: "59" }), true),
    ).toThrow();
  });

  it("rejects duplicate, oversized, or malformed model allowlists", () => {
    for (const allowlist of [
      "model-a,model-a",
      "model-a,model-a,model-b",
      "model a",
      Array.from({ length: 17 }, (_, index) => `model-${index}`).join(","),
    ]) {
      expect(() =>
        resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_ALLOWED_MODELS: allowlist }), true),
      ).toThrow(/ALLOWED_MODELS/);
    }
    // Whitespace and trailing separators are normalized rather than rejected.
    const normalized = resolveCloudModelConfig(
      enabledEnvironment({ OPENTAG_CLOUD_MODEL_ALLOWED_MODELS: " model-a , model-b ," }),
      true,
    );
    if (!normalized.enabled) throw new Error("expected enabled config");
    expect(normalized.allowedModels).toEqual(["model-a", "model-b"]);
  });

  it("bounds request, response, timeout, and stream limits", () => {
    expect(() =>
      resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_MAX_REQUEST_BYTES: String(1024) }), true),
    ).toThrow();
    expect(() =>
      resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_MAX_RESPONSE_BYTES: String(512 * 1024) }), true),
    ).toThrow();
    expect(() =>
      resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS: "999" }), true),
    ).toThrow();
    expect(() =>
      resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_MAX_STREAMS_PER_TOKEN: "0" }), true),
    ).toThrow();
  });
});
