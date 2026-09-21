import { z } from "zod";

/**
 * E4 controlled model path: the Server brokers OpenAI-compatible chat completions for Sandbox Pi
 * executions. Off by default. This is the sole secondary Cloud switch: the model proxy is enabled
 * only when the already-resolved Cloud Runner is enabled (which the overall Cloud switch controls)
 * and OPENTAG_CLOUD_MODEL_ENABLED is true, so model requests can be stopped while Runner
 * persistence, release, and control stay available — and turning the overall switch off disables
 * the model even when the secondary switch was left on. Enabling requires the exact fixed upstream
 * origin, the platform master key (environment only — never persisted, never forwarded to a
 * Sandbox), and an explicit model allowlist. Sandboxes receive only execution-scoped, short-lived,
 * revocable tokens minted per verified delivery; the proxy binds every request to the token's
 * model, bounds bodies and streams, and never relays arbitrary URLs or upstream paths.
 */

const UPSTREAM_BASE_PATTERN = /^https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?(?:\/[a-zA-Z0-9._~/-]*)?$/;
/** Loopback HTTP is accepted only so the local acceptance harness can run a stub upstream. */
const LOOPBACK_UPSTREAM_PATTERN =
  /^http:\/\/(?:localhost|127(?:\.[0-9]{1,3}){3}|\[::1\])(?::[0-9]{1,5})?(?:\/[a-zA-Z0-9._~/-]*)?$/;
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

const CloudModelEnvironmentSchema = z
  .object({
    OPENTAG_CLOUD_MODEL_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: z.string().trim().min(1).max(1024).optional(),
    OPENTAG_CLOUD_MODEL_MASTER_KEY: z.string().min(8).max(512).optional(),
    OPENTAG_CLOUD_MODEL_ALLOWED_MODELS: z.string().trim().min(1).max(4096).optional(),
    OPENTAG_CLOUD_MODEL_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),
    OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(600_000),
    OPENTAG_CLOUD_MODEL_MAX_REQUEST_BYTES: z.coerce
      .number()
      .int()
      .min(64 * 1024)
      .max(8 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    OPENTAG_CLOUD_MODEL_MAX_RESPONSE_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .max(64 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    OPENTAG_CLOUD_MODEL_MAX_STREAMS_PER_TOKEN: z.coerce.number().int().min(1).max(16).default(4),
  })
  .strict();

export type CloudModelConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Fixed upstream origin/base path; the only URL the proxy ever calls. */
      upstreamBaseUrl: string;
      /** Platform master key; lives in process memory only. */
      masterKey: string;
      /** Source-owned model allowlist; request and token models must be members. */
      allowedModels: readonly string[];
      /**
       * Fallback permission lifetime for callers that do not pass an explicit per-turn expiry.
       * Cloud turns pass the dispatch deadline instead; the value can span the 24h runtime.
       */
      tokenTtlSeconds: number;
      requestTimeoutMs: number;
      maxRequestBytes: number;
      maxResponseBytes: number;
      maxStreamsPerToken: number;
    };

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAllowedModels(raw: string | undefined): string[] {
  if (!raw) return [];
  const models = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (models.length === 0 || models.length > 16) return [];
  const unique = new Set(models);
  if (unique.size !== models.length) return [];
  return models.every((model) => MODEL_ID_PATTERN.test(model)) ? models : [];
}

function normalizeUpstream(raw: string, environment: NodeJS.ProcessEnv): string {
  const withoutTrailingSlash = raw.replace(/\/+$/, "");
  if (UPSTREAM_BASE_PATTERN.test(withoutTrailingSlash)) return withoutTrailingSlash;
  if (LOOPBACK_UPSTREAM_PATTERN.test(withoutTrailingSlash)) {
    if (environment.OPENTAG_ENV !== "dev") {
      throw new Error("A loopback Cloud model upstream requires explicit OPENTAG_ENV=dev");
    }
    return withoutTrailingSlash;
  }
  throw new Error(
    "OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL must be an HTTPS origin/base path without credentials or query",
  );
}

export function resolveCloudModelConfig(environment: NodeJS.ProcessEnv, cloudRunnerEnabled: boolean): CloudModelConfig {
  const parsed = CloudModelEnvironmentSchema.parse({
    OPENTAG_CLOUD_MODEL_ENABLED: environment.OPENTAG_CLOUD_MODEL_ENABLED,
    OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: emptyToUndefined(environment.OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL),
    OPENTAG_CLOUD_MODEL_MASTER_KEY: emptyToUndefined(environment.OPENTAG_CLOUD_MODEL_MASTER_KEY),
    OPENTAG_CLOUD_MODEL_ALLOWED_MODELS: emptyToUndefined(environment.OPENTAG_CLOUD_MODEL_ALLOWED_MODELS),
    OPENTAG_CLOUD_MODEL_TOKEN_TTL_SECONDS: environment.OPENTAG_CLOUD_MODEL_TOKEN_TTL_SECONDS,
    OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS: environment.OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS,
    OPENTAG_CLOUD_MODEL_MAX_REQUEST_BYTES: environment.OPENTAG_CLOUD_MODEL_MAX_REQUEST_BYTES,
    OPENTAG_CLOUD_MODEL_MAX_RESPONSE_BYTES: environment.OPENTAG_CLOUD_MODEL_MAX_RESPONSE_BYTES,
    OPENTAG_CLOUD_MODEL_MAX_STREAMS_PER_TOKEN: environment.OPENTAG_CLOUD_MODEL_MAX_STREAMS_PER_TOKEN,
  });
  // The secondary switch never acts alone: a disabled Runner (overall Cloud switch off) disables
  // the model proxy even when OPENTAG_CLOUD_MODEL_ENABLED stayed true.
  if (!parsed.OPENTAG_CLOUD_MODEL_ENABLED || !cloudRunnerEnabled) return { enabled: false };
  if (!parsed.OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL) {
    throw new Error("The Cloud model proxy is enabled without OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL");
  }
  if (!parsed.OPENTAG_CLOUD_MODEL_MASTER_KEY) {
    throw new Error("The Cloud model proxy is enabled without OPENTAG_CLOUD_MODEL_MASTER_KEY");
  }
  const allowedModels = parseAllowedModels(parsed.OPENTAG_CLOUD_MODEL_ALLOWED_MODELS);
  if (allowedModels.length === 0) {
    throw new Error("The Cloud model proxy is enabled without a valid OPENTAG_CLOUD_MODEL_ALLOWED_MODELS allowlist");
  }
  return {
    enabled: true,
    upstreamBaseUrl: normalizeUpstream(parsed.OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL, environment),
    masterKey: parsed.OPENTAG_CLOUD_MODEL_MASTER_KEY,
    allowedModels,
    tokenTtlSeconds: parsed.OPENTAG_CLOUD_MODEL_TOKEN_TTL_SECONDS,
    requestTimeoutMs: parsed.OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS,
    maxRequestBytes: parsed.OPENTAG_CLOUD_MODEL_MAX_REQUEST_BYTES,
    maxResponseBytes: parsed.OPENTAG_CLOUD_MODEL_MAX_RESPONSE_BYTES,
    maxStreamsPerToken: parsed.OPENTAG_CLOUD_MODEL_MAX_STREAMS_PER_TOKEN,
  };
}
