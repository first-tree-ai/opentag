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
    expect(resolveCloudModelConfig({ OPENTAG_CLOUD_MODEL_ENABLED: "false" }, false)).toEqual({
      enabled: false,
    });
  });

  it("stays disabled while the Runner is off and requires every fixed-upstream setting when enabled", () => {
    // The overall Cloud switch dominates: with the Runner off the model proxy is disabled even
    // when the secondary switch and every model coordinate are set and valid.
    expect(resolveCloudModelConfig(enabledEnvironment(), false)).toEqual({ enabled: false });
    expect(() =>
      resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "" }), true),
    ).toThrow(/UPSTREAM_BASE_URL/);
    expect(() => resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_MASTER_KEY: "" }), true)).toThrow(
      /MASTER_KEY/,
    );
    // The retired allowlist variable is ignored: it is neither required nor restrictive.
    expect(resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_ALLOWED_MODELS: "" }), true)).toMatchObject(
      { enabled: true },
    );
  });

  it("validates an opted-in configuration even while the Runner is off", () => {
    // A staged configuration error surfaces at this startup, not on the later deploy that enables
    // Cloud; only after validation does the disabled Runner resolve the proxy to disabled.
    expect(() => resolveCloudModelConfig({ OPENTAG_CLOUD_MODEL_ENABLED: "true" }, false)).toThrow(/UPSTREAM_BASE_URL/);
    expect(() => resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_MASTER_KEY: "" }), false)).toThrow(
      /MASTER_KEY/,
    );
    // A malformed retired allowlist value no longer fails the boot: the Router is the authority.
    expect(
      resolveCloudModelConfig(enabledEnvironment({ OPENTAG_CLOUD_MODEL_ALLOWED_MODELS: "model-a,model-a" }), false),
    ).toEqual({ enabled: false });
    expect(() =>
      resolveCloudModelConfig(
        enabledEnvironment({ OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "ftp://models.example.com/v1" }),
        false,
      ),
    ).toThrow();
    // A complete, valid configuration resolves disabled while the Runner is off, and both
    // switches off keeps the model group fully optional.
    expect(resolveCloudModelConfig(enabledEnvironment(), false)).toEqual({ enabled: false });
    expect(resolveCloudModelConfig({ OPENTAG_CLOUD_MODEL_ENABLED: "false" }, false)).toEqual({ enabled: false });
  });

  it("normalizes a fixed HTTPS upstream and sources models from the Router, not the environment", () => {
    const config = resolveCloudModelConfig(enabledEnvironment(), true);
    if (!config.enabled) throw new Error("expected enabled config");
    expect(config.upstreamBaseUrl).toBe("https://models.example.com/v1");
    // No Server-side allowlist: the Router catalog is the only model authority.
    expect(config).not.toHaveProperty("allowedModels");
    expect(config.tokenTtlSeconds).toBe(1_800);
    expect(config.requestTimeoutMs).toBe(600_000);
    expect(config.maxRequestBytes).toBe(2 * 1024 * 1024);
    expect(config.maxResponseBytes).toBe(16 * 1024 * 1024);
    expect(config.maxStreamsPerToken).toBe(4);
    // The deployment still boots with the retired variable absent entirely.
    const withoutLegacy = resolveCloudModelConfig(
      {
        OPENTAG_CLOUD_MODEL_ENABLED: "true",
        OPENTAG_CLOUD_MODEL_MASTER_KEY: MASTER_KEY,
        OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "https://models.example.com/v1/",
      },
      true,
    );
    if (!withoutLegacy.enabled) throw new Error("expected enabled config");
    expect(withoutLegacy.upstreamBaseUrl).toBe("https://models.example.com/v1");
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
    // Built via the URL API so no literal credential-bearing URL appears in source; rejection coverage is unchanged.
    const credentialsUrl = new URL("https://models.example.com/v1");
    credentialsUrl.username = "user";
    credentialsUrl.password = "pass";
    for (const url of [
      credentialsUrl.href,
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
