import { createPrivateKey } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import {
  type ChannelConfig,
  type ChannelName,
  ChannelNameSchema,
  GITHUB_OAUTH_CALLBACK_PATH,
  getChannelConfig,
  SLACK_OAUTH_CALLBACK_PATH,
} from "@opentag/shared";
import { z } from "zod";
import { CloudRunnerVersionSchema, parseCloudStorageBase } from "./cloud-identities-config.js";
import { type CloudRunnerConfig, resolveCloudRunnerConfig } from "./cloud-runner-config.js";

export { parseCloudStorageBase } from "./cloud-identities-config.js";

const booleanString = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((value) => value === "true");

const OtlpEndpointSchema = z
  .string()
  .trim()
  .default("")
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Must be an HTTP(S) URL without credentials");

const DatabaseUrlSchema = z
  .string()
  .url()
  .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), "Must be a PostgreSQL URL");

const PublicUrlSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: "custom",
        message: "Must be an HTTP(S) origin without credentials, query, or fragment",
      });
      return z.NEVER;
    }
    if (url.pathname !== "/") {
      context.addIssue({ code: "custom", message: "Must be an origin without a path" });
      return z.NEVER;
    }
    return url.origin;
  });

const DownloadBaseUrlSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Must be an HTTP(S) URL" });
      return z.NEVER;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: "custom",
        message: "Must be an HTTP(S) URL without credentials, query, or fragment",
      });
      return z.NEVER;
    }
    return url.toString().replace(/\/+$/, "");
  });

/*
 * Web tools (Tavily via the existing Router). Off by default; enabling requires the fixed Router
 * origin and an explicit Account → Router tenant mapping. Tenant keys never appear in this
 * mapping: each entry names a `keyEnv` environment variable that holds the key material, so the
 * mapping itself stays reference-only and safe to log, while the plaintext keys live only in
 * deployment secrets. There is deliberately no shared default tenant.
 */
const WEB_ROUTER_KEY_ENV_PATTERN = /^OPENTAG_WEB_ROUTER_KEY_[A-Z0-9_]{1,48}$/;
const WEB_ROUTER_TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,126}$/;

const WebRouterTenantEntrySchema = z
  .object({
    accountId: z.string().uuid(),
    tenantId: z.string().regex(WEB_ROUTER_TENANT_ID_PATTERN, "Must be a bounded Router tenant slug"),
    keyEnv: z.string().regex(WEB_ROUTER_KEY_ENV_PATTERN, "Must name an OPENTAG_WEB_ROUTER_KEY_* variable"),
  })
  .strict();

const WebRouterTenantsSchema = z
  .string()
  .trim()
  .min(1)
  .max(64 * 1024)
  .optional()
  .transform((value, context) => {
    if (value === undefined) return undefined;
    const invalid = (message: string) => {
      context.addIssue({ code: "custom", message });
      return z.NEVER;
    };
    let raw: unknown;
    try {
      raw = JSON.parse(value);
    } catch {
      return invalid("Must be a JSON array of Account web tenant mappings");
    }
    const parsed = z.array(WebRouterTenantEntrySchema).max(1024).safeParse(raw);
    if (!parsed.success) return invalid("Every web tenant mapping must be {accountId, tenantId, keyEnv}");
    const accountIds = new Set<string>();
    const keyEnvs = new Set<string>();
    for (const entry of parsed.data) {
      if (accountIds.has(entry.accountId)) return invalid("Duplicate web tenant mapping for one Account");
      if (keyEnvs.has(entry.keyEnv)) return invalid("Two web tenant mappings cannot share one key variable");
      accountIds.add(entry.accountId);
      keyEnvs.add(entry.keyEnv);
    }
    return parsed.data;
  });

const EncryptionKeySchema = z
  .string()
  .min(1)
  .transform((value, context) => {
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
      context.addIssue({ code: "custom", message: "Must be a canonical base64-encoded 32-byte key" });
      return z.NEVER;
    }
    return new Uint8Array(decoded);
  });

/*
 * The v2 envelope key ring: a JSON object mapping stable key IDs to canonical base64-encoded
 * 32-byte keys. Key IDs are printable slugs; the ApplicationCipher constructor re-validates them.
 * Issues are reported without echoing any configured value, because the values are key material.
 */
const ENCRYPTION_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const EncryptionKeyRingSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .transform((value, context) => {
    if (value === undefined) return undefined;
    const invalid = (message: string) => {
      context.addIssue({ code: "custom", message });
      return z.NEVER;
    };
    let raw: unknown;
    try {
      raw = JSON.parse(value);
    } catch {
      return invalid("Must be a JSON object mapping key IDs to canonical base64-encoded 32-byte keys");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return invalid("Must be a JSON object mapping key IDs to canonical base64-encoded 32-byte keys");
    }
    const entries = Object.entries(raw);
    if (entries.length === 0) return invalid("Must name at least one key");
    const keys = new Map<string, Uint8Array>();
    for (const [keyId, encoded] of entries) {
      if (!ENCRYPTION_KEY_ID_PATTERN.test(keyId)) return invalid("Key IDs must be lowercase alphanumeric slugs");
      if (typeof encoded !== "string") return invalid("Every ring key must be a base64-encoded 32-byte key");
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.byteLength !== 32 || decoded.toString("base64") !== encoded) {
        return invalid("Every ring key must be a canonical base64-encoded 32-byte key");
      }
      keys.set(keyId, new Uint8Array(decoded));
    }
    return keys;
  });

const ServerLogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info");
export type ServerLogLevel = z.infer<typeof ServerLogLevelSchema>;

/*
 * The App private key arrives either as a base64-encoded PEM (friendly to single-line environment
 * variables) or as a PEM literal with escaped or real newlines. Validation only checks that the
 * material parses as an RSA key of at least 2048 bits; the value itself never appears in an issue
 * or error message, because it is key material.
 */
const GitHubAppPrivateKeySchema = z
  .string()
  .min(1)
  .max(16 * 1024)
  .optional()
  .transform((value, context) => {
    if (value === undefined) return undefined;
    const pem = normalizeGitHubAppPrivateKey(value);
    if (!pem) {
      context.addIssue({ code: "custom", message: "Must be a base64-encoded or literal PEM private key" });
      return z.NEVER;
    }
    try {
      const key = createPrivateKey({ key: pem, format: "pem" });
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
        context.addIssue({ code: "custom", message: "Must be an RSA private key of at least 2048 bits" });
        return z.NEVER;
      }
    } catch {
      context.addIssue({ code: "custom", message: "Must be a parseable PEM private key" });
      return z.NEVER;
    }
    return pem;
  });

function normalizeGitHubAppPrivateKey(value: string): string | undefined {
  const trimmed = value.trim();
  const candidates = [trimmed.replaceAll("\\n", "\n")];
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded) candidates.push(decoded);
  } catch {
    // Not base64; the literal candidate above is the only one.
  }
  for (const candidate of candidates) {
    if (candidate.includes("-----BEGIN") && candidate.includes("-----END")) {
      // Canonical form: trimmed body with one trailing newline, so every spelling stores alike.
      return `${candidate.trim()}\n`;
    }
  }
  return undefined;
}

/**
 * The deployment GitHub App's cross-field rules: all five material values together or none, and an
 * optional callback URL that stays on this server's origin (HTTPS there when hosted). Extracted from
 * the schema's refinement so the App rule reads as one unit.
 */
function validateGitHubAppConfiguration(
  value: {
    OPENTAG_GITHUB_APP_ID?: string | undefined;
    OPENTAG_GITHUB_APP_CLIENT_ID?: string | undefined;
    OPENTAG_GITHUB_APP_CLIENT_SECRET?: string | undefined;
    OPENTAG_GITHUB_APP_PRIVATE_KEY?: string | undefined;
    OPENTAG_GITHUB_APP_WEBHOOK_SECRET?: string | undefined;
    OPENTAG_GITHUB_OAUTH_REDIRECT_URL?: string | undefined;
    OPENTAG_PUBLIC_URL: string;
    OPENTAG_ENV: ChannelName;
  },
  context: z.RefinementCtx,
): void {
  const githubAppValues = [
    value.OPENTAG_GITHUB_APP_ID,
    value.OPENTAG_GITHUB_APP_CLIENT_ID,
    value.OPENTAG_GITHUB_APP_CLIENT_SECRET,
    value.OPENTAG_GITHUB_APP_PRIVATE_KEY,
    value.OPENTAG_GITHUB_APP_WEBHOOK_SECRET,
  ];
  const githubAppConfiguredCount = githubAppValues.filter(Boolean).length;
  if (githubAppConfiguredCount > 0 && githubAppConfiguredCount < githubAppValues.length) {
    context.addIssue({
      code: "custom",
      message:
        "OPENTAG_GITHUB_APP_ID, OPENTAG_GITHUB_APP_CLIENT_ID, OPENTAG_GITHUB_APP_CLIENT_SECRET, OPENTAG_GITHUB_APP_PRIVATE_KEY, and OPENTAG_GITHUB_APP_WEBHOOK_SECRET must be configured together",
    });
  }
  if (value.OPENTAG_GITHUB_OAUTH_REDIRECT_URL) {
    const redirectUrl = parseGitHubOAuthRedirectUrl(value.OPENTAG_GITHUB_OAUTH_REDIRECT_URL, value.OPENTAG_PUBLIC_URL);
    if (!redirectUrl) {
      context.addIssue({
        code: "custom",
        message:
          "OPENTAG_GITHUB_OAUTH_REDIRECT_URL must be this server's public origin or the exact GitHub OAuth callback URL",
      });
    } else if (isHostedEnvironment(value.OPENTAG_ENV) && !redirectUrl.startsWith("https://")) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_GITHUB_OAUTH_REDIRECT_URL must use HTTPS in hosted environments",
      });
    }
  }
}

export function isHostedEnvironment(environment: ChannelName): boolean {
  return environment !== "dev";
}

const ServerEnvironmentSchema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32),
    OPENTAG_AUTO_MIGRATE: booleanString("true"),
    OPENTAG_DATABASE_URL: DatabaseUrlSchema,
    OPENTAG_ENCRYPTION_KEY: EncryptionKeySchema,
    OPENTAG_ENCRYPTION_KEY_RING: EncryptionKeyRingSchema,
    OPENTAG_ENCRYPTION_ACTIVE_KEY_ID: z.string().trim().min(1).optional(),
    /*
     * IM credential material writes stay on the legacy v1 envelope until a deployment opts into the
     * authenticated v2 envelope; reads accept both envelopes regardless of this setting.
     */
    OPENTAG_IM_CREDENTIAL_ENCRYPTION_WRITE_VERSION: z
      .enum(["1", "2"])
      .default("1")
      .transform((value) => (value === "2" ? 2 : 1)),
    OPENTAG_ENV: ChannelNameSchema.default("dev"),
    OPENTAG_ENV_EXPLICIT: z.boolean(),
    OPENTAG_DEV_AUTH_BYPASS_ENABLED: booleanString("false"),
    OPENTAG_DEV_AUTH_EMAIL: z.string().trim().toLowerCase().email().optional(),
    OPENTAG_DEV_INTERNAL_TOOLS_ENABLED: booleanString("false"),
    /*
     * Defaults to off because turning it on opens Account creation to anyone who can reach the server. Every other
     * sign-in method the server offers requires something a deployment already granted — a Google client, a loopback
     * development bypass, a connect code — so this is the first one whose default could hand out Accounts, and that
     * has to be a decision rather than an inheritance.
     */
    OPENTAG_EMAIL_PASSWORD_AUTH_ENABLED: booleanString("false"),
    OPENTAG_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    OPENTAG_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    OPENTAG_SLACK_CLIENT_ID: z.string().min(1).optional(),
    OPENTAG_SLACK_CLIENT_SECRET: z.string().min(1).optional(),
    OPENTAG_SLACK_SIGNING_SECRET: z.string().min(1).optional(),
    OPENTAG_SLACK_REDIRECT_URL: z.string().min(1).optional(),
    /*
     * Deployment-level GitHub App. All five material values are configured together or not at all;
     * an absent group disables the integration with explicit availability metadata rather than a
     * half-configured one. The App must issue expiring user access tokens — the management plane
     * refuses the non-expiring kind instead of silently accepting a credential it cannot maintain.
     */
    OPENTAG_GITHUB_APP_ID: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/, "Must be the GitHub App's numeric ID as a decimal string")
      .optional(),
    OPENTAG_GITHUB_APP_CLIENT_ID: z.string().trim().min(1).max(255).optional(),
    OPENTAG_GITHUB_APP_CLIENT_SECRET: z.string().min(1).max(255).optional(),
    OPENTAG_GITHUB_APP_PRIVATE_KEY: GitHubAppPrivateKeySchema,
    OPENTAG_GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).max(255).optional(),
    OPENTAG_GITHUB_OAUTH_REDIRECT_URL: z.string().min(1).optional(),
    OPENTAG_HOST: z.string().min(1).default("127.0.0.1"),
    OPENTAG_JWT_SECRET: z.string().min(32),
    /*
     * Where the Server polls the channel's exact latest target for Client upgrade advertisement.
     * This is the same authority the portable installer consumes; release tooling keeps the npm
     * dist-tag at the same coordinate, so one target serves both install modes.
     */
    OPENTAG_PORTABLE_DOWNLOAD_BASE_URL: DownloadBaseUrlSchema.default("https://dl.opentag.build/releases"),
    OPENTAG_CHANNEL_TARGET_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
    OPENTAG_PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
    OPENTAG_PUBLIC_URL: PublicUrlSchema,
    OPENTAG_OTEL_ENDPOINT: OtlpEndpointSchema,
    OPENTAG_OTEL_ENVIRONMENT: z.string().trim().min(1).optional(),
    OPENTAG_OTEL_HEADERS: z.string().default(""),
    OPENTAG_OTEL_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
    OPENTAG_LOG_LEVEL: ServerLogLevelSchema,
    /*
     * Server-controlled Cloud Computer / Sandbox acceptance. Off by default; enabling requires a valid
     * storage prefix and Runner SemVer release coordinate. This is not a UI-only gate.
     */
    OPENTAG_CLOUD_IDENTITIES_ENABLED: booleanString("false"),
    OPENTAG_CLOUD_STORAGE_BASE: z.string().trim().optional(),
    OPENTAG_CLOUD_RUNNER_VERSION: z.string().trim().optional(),
    /*
     * Platform web tools: fixed Server routes forwarding to the existing Router. Off by default;
     * enabling requires the Router origin plus an explicit Account→tenant secret-reference map.
     */
    OPENTAG_WEB_ENABLED: booleanString("false"),
    OPENTAG_WEB_ROUTER_BASE_URL: z.string().trim().optional(),
    OPENTAG_WEB_ROUTER_TENANTS: WebRouterTenantsSchema,
    /*
     * Defaults to what the refresh token's lifetime was, because that is the number it replaced: how long a client
     * may be idle and still be signed in.
     */
    OPENTAG_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 30),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.OPENTAG_DEV_INTERNAL_TOOLS_ENABLED) return;
    if (!value.OPENTAG_ENV_EXPLICIT || value.OPENTAG_ENV !== "dev") {
      context.addIssue({ code: "custom", message: "Local Internal Tools requires OPENTAG_ENV=dev" });
    }
    if (!isLoopbackHostname(value.OPENTAG_HOST) || !isLoopbackHostname(new URL(value.OPENTAG_PUBLIC_URL).hostname)) {
      context.addIssue({
        code: "custom",
        message: "Local Internal Tools requires loopback OPENTAG_HOST and OPENTAG_PUBLIC_URL",
      });
    }
  })
  .superRefine((value, context) => {
    if (Boolean(value.OPENTAG_GOOGLE_CLIENT_ID) !== Boolean(value.OPENTAG_GOOGLE_CLIENT_SECRET)) {
      context.addIssue({ code: "custom", message: "Google client id and secret must be configured together" });
    }
    const slackOAuthValues = [
      value.OPENTAG_SLACK_CLIENT_ID,
      value.OPENTAG_SLACK_CLIENT_SECRET,
      value.OPENTAG_SLACK_SIGNING_SECRET,
      value.OPENTAG_SLACK_REDIRECT_URL,
    ];
    const slackOAuthConfiguredCount = slackOAuthValues.filter(Boolean).length;
    if (slackOAuthConfiguredCount > 0 && slackOAuthConfiguredCount < slackOAuthValues.length) {
      context.addIssue({
        code: "custom",
        message:
          "OPENTAG_SLACK_CLIENT_ID, OPENTAG_SLACK_CLIENT_SECRET, OPENTAG_SLACK_SIGNING_SECRET, and OPENTAG_SLACK_REDIRECT_URL must be configured together",
      });
    }
    if (value.OPENTAG_SLACK_REDIRECT_URL) {
      const redirectUrl = parseSlackRedirectUrl(value.OPENTAG_SLACK_REDIRECT_URL, value.OPENTAG_PUBLIC_URL);
      if (!redirectUrl) {
        context.addIssue({
          code: "custom",
          message:
            "OPENTAG_SLACK_REDIRECT_URL must be this server's public origin or the exact Slack OAuth callback URL",
        });
      } else if (isHostedEnvironment(value.OPENTAG_ENV) && !redirectUrl.startsWith("https://")) {
        context.addIssue({
          code: "custom",
          message: "OPENTAG_SLACK_REDIRECT_URL must use HTTPS in hosted environments",
        });
      }
    }
    validateGitHubAppConfiguration(value, context);
    if (isHostedEnvironment(value.OPENTAG_ENV) && !value.OPENTAG_PUBLIC_URL.startsWith("https://")) {
      context.addIssue({ code: "custom", message: "OPENTAG_PUBLIC_URL must use HTTPS in hosted environments" });
    }
    if (value.BETTER_AUTH_SECRET === value.OPENTAG_JWT_SECRET) {
      // Sharing one key across both would make either rotation invalidate the other's credentials at the same time,
      // which is the coupling the separate secret exists to remove.
      context.addIssue({
        code: "custom",
        message: "BETTER_AUTH_SECRET must differ from OPENTAG_JWT_SECRET",
      });
    }
    const devAuthConfigured = value.OPENTAG_DEV_AUTH_BYPASS_ENABLED || Boolean(value.OPENTAG_DEV_AUTH_EMAIL);
    if (devAuthConfigured) {
      if (!value.OPENTAG_DEV_AUTH_BYPASS_ENABLED || !value.OPENTAG_DEV_AUTH_EMAIL) {
        context.addIssue({
          code: "custom",
          message: "OPENTAG_DEV_AUTH_BYPASS_ENABLED and OPENTAG_DEV_AUTH_EMAIL must be configured together",
        });
      }
      if (!value.OPENTAG_ENV_EXPLICIT || value.OPENTAG_ENV !== "dev") {
        context.addIssue({
          code: "custom",
          message: "Development authentication bypass requires OPENTAG_ENV=dev",
        });
      }
      if (!isLoopbackHostname(value.OPENTAG_HOST) || !isLoopbackHostname(new URL(value.OPENTAG_PUBLIC_URL).hostname)) {
        context.addIssue({
          code: "custom",
          message: "Development authentication bypass requires loopback OPENTAG_HOST and OPENTAG_PUBLIC_URL",
        });
      }
    }
  })
  .superRefine((value, context) => {
    const keyRing = value.OPENTAG_ENCRYPTION_KEY_RING;
    const activeKeyId = value.OPENTAG_ENCRYPTION_ACTIVE_KEY_ID;
    if (Boolean(keyRing) !== Boolean(activeKeyId)) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_ENCRYPTION_KEY_RING and OPENTAG_ENCRYPTION_ACTIVE_KEY_ID must be configured together",
      });
      return;
    }
    if (keyRing && activeKeyId && !keyRing.has(activeKeyId)) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_ENCRYPTION_ACTIVE_KEY_ID must name a key in OPENTAG_ENCRYPTION_KEY_RING",
      });
    }
    if (value.OPENTAG_IM_CREDENTIAL_ENCRYPTION_WRITE_VERSION === 2 && !keyRing) {
      context.addIssue({
        code: "custom",
        message:
          "OPENTAG_IM_CREDENTIAL_ENCRYPTION_WRITE_VERSION=2 requires OPENTAG_ENCRYPTION_KEY_RING and OPENTAG_ENCRYPTION_ACTIVE_KEY_ID",
      });
    }
  })
  .superRefine((value, context) => {
    if (!value.OPENTAG_WEB_ENABLED) return;
    const baseUrl = value.OPENTAG_WEB_ROUTER_BASE_URL;
    if (!baseUrl) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_WEB_ROUTER_BASE_URL is required when web tools are enabled",
      });
    } else {
      let parsed: URL | undefined;
      try {
        parsed = new URL(baseUrl);
      } catch {
        parsed = undefined;
      }
      if (
        !parsed ||
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== "/"
      ) {
        context.addIssue({
          code: "custom",
          message:
            "OPENTAG_WEB_ROUTER_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment",
        });
      } else if (isHostedEnvironment(value.OPENTAG_ENV) && parsed.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "OPENTAG_WEB_ROUTER_BASE_URL must use HTTPS in hosted environments",
        });
      }
    }
    if (!value.OPENTAG_WEB_ROUTER_TENANTS || value.OPENTAG_WEB_ROUTER_TENANTS.length === 0) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_WEB_ROUTER_TENANTS must map at least one Account when web tools are enabled",
      });
    }
  })
  .superRefine((value, context) => {
    const storage = value.OPENTAG_CLOUD_STORAGE_BASE;
    const runnerVersion = value.OPENTAG_CLOUD_RUNNER_VERSION;
    if (storage !== undefined && !parseCloudStorageBase(storage)) {
      context.addIssue({
        code: "custom",
        message:
          "OPENTAG_CLOUD_STORAGE_BASE must be a gs://bucket/prefix URI without credentials, query, fragment, or dot traversal",
      });
    }
    if (runnerVersion !== undefined && !CloudRunnerVersionSchema.safeParse(runnerVersion).success) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_CLOUD_RUNNER_VERSION must be a Client/Runner SemVer release coordinate",
      });
    }
    if (!value.OPENTAG_CLOUD_IDENTITIES_ENABLED) return;
    if (!storage) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_CLOUD_STORAGE_BASE is required when Cloud identities are enabled",
      });
    }
    if (!runnerVersion) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_CLOUD_RUNNER_VERSION is required when Cloud identities are enabled",
      });
    }
  });

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."));
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The GitHub OAuth callback always lives on this server's public origin; a deployment may spell
 * the setting as the bare origin (the canonical callback path is appended) or as the exact
 * callback URL. Anything else — another origin, credentials, query, fragment — is rejected.
 */
export function parseGitHubOAuthRedirectUrl(value: string, publicOrigin: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    if (url.origin !== publicOrigin) return undefined;
    if (url.pathname === "/" || url.pathname === "") {
      return new URL(GITHUB_OAUTH_CALLBACK_PATH, publicOrigin).toString();
    }
    if (url.pathname !== GITHUB_OAUTH_CALLBACK_PATH) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function parseSlackRedirectUrl(value: string, publicOrigin: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    if (url.origin !== publicOrigin) return undefined;
    if (url.pathname === "/" || url.pathname === "") {
      return new URL(SLACK_OAUTH_CALLBACK_PATH, publicOrigin).toString();
    }
    if (url.pathname !== SLACK_OAUTH_CALLBACK_PATH) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export interface ServerConfig {
  autoMigrate: boolean;
  /** Signs every Account session and its cookies. */
  betterAuthSecret: string;
  /** Where the Server reads the channel's exact latest Client target, and how often. */
  channelTarget: { downloadBaseUrl: string; pollIntervalMs: number };
  databaseUrl: string;
  encryptionKey: Uint8Array;
  /**
   * Authenticated v2 envelope key ring for credential material, with the active write key. Absent
   * while a deployment runs the single legacy key; retired IDs stay present for reads until their
   * ciphertexts rotate away.
   */
  encryptionKeyRing?: { keys: ReadonlyMap<string, Uint8Array>; activeKeyId: string };
  /** IM credential material write envelope. Reads accept v1 and v2 regardless of this setting. */
  imCredentialEncryptionWriteVersion: 1 | 2;
  channel: ChannelConfig;
  environment: ChannelName;
  devAuth?: { email: string };
  /**
   * Whether an address and password may both create an Account and sign one in.
   *
   * One flag rather than two: a deployment that accepts passwords but refuses to issue them would have no way to give
   * anyone the first one, since nothing else in the product sets a password.
   */
  emailPasswordAuth: boolean;
  google?: { clientId: string; clientSecret: string };
  slackOAuth?: { clientId: string; clientSecret: string; signingSecret: string; redirectUrl: string };
  /**
   * The deployment-level GitHub App the management plane connects Accounts to, present only when
   * coherently configured (all values together). Secrets stay in this object; they are never
   * logged. `oauthCallbackUrl` is the resolved exact callback on this server's public origin.
   */
  githubApp?: GitHubAppConfig;
  host: string;
  /** Signs Slack OAuth state. No longer signs any Account credential; Better Auth owns those. */
  jwtSecret: string;
  migrationsDirectory: string;
  observability: {
    tracing: {
      endpoint: string;
      environment: string;
      headers: string;
      sampleRate: number;
    };
  };
  logLevel: ServerLogLevel;
  port: number;
  publicUrl: string;
  /** Lifetime of an Account session, browser and CLI alike. */
  sessionTtlSeconds: number;
  /**
   * Whether this deployment offers Internal Tools, including Account-owned setup resets.
   * Enabled on staging, or explicitly opted into on a loopback development server.
   */
  internalTools: boolean;
  /**
   * Server-controlled Cloud Computer / Sandbox acceptance. Metadata is the configured Runner
   * target, never observed execution. Off by default.
   */
  cloudIdentities: CloudIdentitiesConfig;
  /**
   * E3 Cloud Runner allocation. Off by default; enabling requires Cloud identities plus the exact
   * digest-pinned Runner image, GCP coordinates, backend origin, and Direct VPC attachment.
   */
  cloudRunner: CloudRunnerConfig;
  /**
   * Platform web tools (Tavily via the existing Router). Off by default; enabling requires the
   * Router origin and an explicit Account→tenant mapping whose key material was resolved from
   * referenced deployment-secret variables at startup. Keys live only in this object.
   */
  web: WebToolsConfig;
}

export type WebToolsConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Credential-less Router origin; the two web paths are fixed in code. */
      routerBaseUrl: string;
      /** accountId → Router tenant binding with live key material (never logged). */
      tenants: ReadonlyMap<string, { tenantId: string; routerKey: string }>;
    };

export type CloudIdentitiesConfig = { enabled: false } | { enabled: true; storageBase: string; runnerVersion: string };

export interface GitHubAppConfig {
  /** The GitHub App's numeric ID (decimal string), not its client ID. */
  appId: string;
  clientId: string;
  clientSecret: string;
  /** Normalized PEM; parse-validated RSA >= 2048 bits at config load. */
  privateKey: string;
  webhookSecret: string;
  oauthCallbackUrl: string;
}

export interface DatabaseConfig {
  databaseUrl: string;
  migrationsDirectory: string;
}

export function serverEnvironmentSummary(config: ServerConfig) {
  return {
    binName: config.channel.binName,
    channel: config.channel.channel,
    environment: config.environment,
    packageName: config.channel.packageName,
    publicUrl: config.publicUrl,
  };
}

export function parseDatabaseConfig(environment: NodeJS.ProcessEnv): DatabaseConfig {
  return {
    databaseUrl: DatabaseUrlSchema.parse(environment.OPENTAG_DATABASE_URL),
    migrationsDirectory: fileURLToPath(new URL("../drizzle", import.meta.url)),
  };
}

export function parseServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const parsed = ServerEnvironmentSchema.parse({
    BETTER_AUTH_SECRET: environment.BETTER_AUTH_SECRET,
    OPENTAG_AUTO_MIGRATE: environment.OPENTAG_AUTO_MIGRATE,
    OPENTAG_DATABASE_URL: environment.OPENTAG_DATABASE_URL,
    OPENTAG_ENCRYPTION_KEY: environment.OPENTAG_ENCRYPTION_KEY,
    OPENTAG_ENCRYPTION_KEY_RING: emptyToUndefined(environment.OPENTAG_ENCRYPTION_KEY_RING),
    OPENTAG_ENCRYPTION_ACTIVE_KEY_ID: emptyToUndefined(environment.OPENTAG_ENCRYPTION_ACTIVE_KEY_ID),
    OPENTAG_IM_CREDENTIAL_ENCRYPTION_WRITE_VERSION: environment.OPENTAG_IM_CREDENTIAL_ENCRYPTION_WRITE_VERSION,
    OPENTAG_ENV: environment.OPENTAG_ENV,
    OPENTAG_ENV_EXPLICIT: environment.OPENTAG_ENV !== undefined,
    OPENTAG_DEV_AUTH_BYPASS_ENABLED: environment.OPENTAG_DEV_AUTH_BYPASS_ENABLED,
    OPENTAG_DEV_AUTH_EMAIL: environment.OPENTAG_DEV_AUTH_EMAIL,
    OPENTAG_DEV_INTERNAL_TOOLS_ENABLED: environment.OPENTAG_DEV_INTERNAL_TOOLS_ENABLED,
    OPENTAG_EMAIL_PASSWORD_AUTH_ENABLED: environment.OPENTAG_EMAIL_PASSWORD_AUTH_ENABLED,
    OPENTAG_GOOGLE_CLIENT_ID: environment.OPENTAG_GOOGLE_CLIENT_ID,
    OPENTAG_GOOGLE_CLIENT_SECRET: environment.OPENTAG_GOOGLE_CLIENT_SECRET,
    OPENTAG_SLACK_CLIENT_ID: emptyToUndefined(environment.OPENTAG_SLACK_CLIENT_ID),
    OPENTAG_SLACK_CLIENT_SECRET: emptyToUndefined(environment.OPENTAG_SLACK_CLIENT_SECRET),
    OPENTAG_SLACK_SIGNING_SECRET: emptyToUndefined(environment.OPENTAG_SLACK_SIGNING_SECRET),
    OPENTAG_SLACK_REDIRECT_URL: emptyToUndefined(environment.OPENTAG_SLACK_REDIRECT_URL),
    OPENTAG_GITHUB_APP_ID: emptyToUndefined(environment.OPENTAG_GITHUB_APP_ID),
    OPENTAG_GITHUB_APP_CLIENT_ID: emptyToUndefined(environment.OPENTAG_GITHUB_APP_CLIENT_ID),
    OPENTAG_GITHUB_APP_CLIENT_SECRET: emptyToUndefined(environment.OPENTAG_GITHUB_APP_CLIENT_SECRET),
    OPENTAG_GITHUB_APP_PRIVATE_KEY: emptyToUndefined(environment.OPENTAG_GITHUB_APP_PRIVATE_KEY),
    OPENTAG_GITHUB_APP_WEBHOOK_SECRET: emptyToUndefined(environment.OPENTAG_GITHUB_APP_WEBHOOK_SECRET),
    OPENTAG_GITHUB_OAUTH_REDIRECT_URL: emptyToUndefined(environment.OPENTAG_GITHUB_OAUTH_REDIRECT_URL),
    OPENTAG_HOST: environment.OPENTAG_HOST,
    OPENTAG_JWT_SECRET: environment.OPENTAG_JWT_SECRET,
    OPENTAG_PORTABLE_DOWNLOAD_BASE_URL: environment.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL,
    OPENTAG_CHANNEL_TARGET_POLL_INTERVAL_MS: environment.OPENTAG_CHANNEL_TARGET_POLL_INTERVAL_MS,
    OPENTAG_PORT: environment.OPENTAG_PORT,
    OPENTAG_PUBLIC_URL: environment.OPENTAG_PUBLIC_URL,
    OPENTAG_OTEL_ENDPOINT: environment.OPENTAG_OTEL_ENDPOINT,
    OPENTAG_OTEL_ENVIRONMENT: environment.OPENTAG_OTEL_ENVIRONMENT,
    OPENTAG_OTEL_HEADERS: environment.OPENTAG_OTEL_HEADERS,
    OPENTAG_OTEL_SAMPLE_RATE: environment.OPENTAG_OTEL_SAMPLE_RATE,
    OPENTAG_LOG_LEVEL: environment.OPENTAG_LOG_LEVEL,
    OPENTAG_CLOUD_IDENTITIES_ENABLED: environment.OPENTAG_CLOUD_IDENTITIES_ENABLED,
    OPENTAG_CLOUD_STORAGE_BASE: emptyToUndefined(environment.OPENTAG_CLOUD_STORAGE_BASE),
    OPENTAG_CLOUD_RUNNER_VERSION: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_VERSION),
    OPENTAG_WEB_ENABLED: environment.OPENTAG_WEB_ENABLED,
    OPENTAG_WEB_ROUTER_BASE_URL: emptyToUndefined(environment.OPENTAG_WEB_ROUTER_BASE_URL),
    OPENTAG_WEB_ROUTER_TENANTS: emptyToUndefined(environment.OPENTAG_WEB_ROUTER_TENANTS),
    OPENTAG_SESSION_TTL_SECONDS: environment.OPENTAG_SESSION_TTL_SECONDS,
  });

  return {
    autoMigrate: parsed.OPENTAG_AUTO_MIGRATE,
    betterAuthSecret: parsed.BETTER_AUTH_SECRET,
    channelTarget: {
      downloadBaseUrl: parsed.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL,
      pollIntervalMs: parsed.OPENTAG_CHANNEL_TARGET_POLL_INTERVAL_MS,
    },
    channel: getChannelConfig(parsed.OPENTAG_ENV),
    databaseUrl: parsed.OPENTAG_DATABASE_URL,
    encryptionKey: parsed.OPENTAG_ENCRYPTION_KEY,
    ...(parsed.OPENTAG_ENCRYPTION_KEY_RING && parsed.OPENTAG_ENCRYPTION_ACTIVE_KEY_ID
      ? {
          encryptionKeyRing: {
            keys: parsed.OPENTAG_ENCRYPTION_KEY_RING,
            activeKeyId: parsed.OPENTAG_ENCRYPTION_ACTIVE_KEY_ID,
          },
        }
      : {}),
    imCredentialEncryptionWriteVersion: parsed.OPENTAG_IM_CREDENTIAL_ENCRYPTION_WRITE_VERSION,
    environment: parsed.OPENTAG_ENV,
    ...(parsed.OPENTAG_DEV_AUTH_BYPASS_ENABLED && parsed.OPENTAG_DEV_AUTH_EMAIL
      ? { devAuth: { email: parsed.OPENTAG_DEV_AUTH_EMAIL } }
      : {}),
    emailPasswordAuth: parsed.OPENTAG_EMAIL_PASSWORD_AUTH_ENABLED,
    ...(parsed.OPENTAG_GOOGLE_CLIENT_ID && parsed.OPENTAG_GOOGLE_CLIENT_SECRET
      ? { google: { clientId: parsed.OPENTAG_GOOGLE_CLIENT_ID, clientSecret: parsed.OPENTAG_GOOGLE_CLIENT_SECRET } }
      : {}),
    ...(parsed.OPENTAG_SLACK_CLIENT_ID &&
    parsed.OPENTAG_SLACK_CLIENT_SECRET &&
    parsed.OPENTAG_SLACK_SIGNING_SECRET &&
    parsed.OPENTAG_SLACK_REDIRECT_URL
      ? {
          slackOAuth: {
            clientId: parsed.OPENTAG_SLACK_CLIENT_ID,
            clientSecret: parsed.OPENTAG_SLACK_CLIENT_SECRET,
            signingSecret: parsed.OPENTAG_SLACK_SIGNING_SECRET,
            redirectUrl: parseSlackRedirectUrl(parsed.OPENTAG_SLACK_REDIRECT_URL, parsed.OPENTAG_PUBLIC_URL) as string,
          },
        }
      : {}),
    host: parsed.OPENTAG_HOST,
    jwtSecret: parsed.OPENTAG_JWT_SECRET,
    ...(parsed.OPENTAG_GITHUB_APP_ID &&
    parsed.OPENTAG_GITHUB_APP_CLIENT_ID &&
    parsed.OPENTAG_GITHUB_APP_CLIENT_SECRET &&
    parsed.OPENTAG_GITHUB_APP_PRIVATE_KEY &&
    parsed.OPENTAG_GITHUB_APP_WEBHOOK_SECRET
      ? {
          githubApp: {
            appId: parsed.OPENTAG_GITHUB_APP_ID,
            clientId: parsed.OPENTAG_GITHUB_APP_CLIENT_ID,
            clientSecret: parsed.OPENTAG_GITHUB_APP_CLIENT_SECRET,
            privateKey: parsed.OPENTAG_GITHUB_APP_PRIVATE_KEY,
            webhookSecret: parsed.OPENTAG_GITHUB_APP_WEBHOOK_SECRET,
            oauthCallbackUrl: parsed.OPENTAG_GITHUB_OAUTH_REDIRECT_URL
              ? (parseGitHubOAuthRedirectUrl(
                  parsed.OPENTAG_GITHUB_OAUTH_REDIRECT_URL,
                  parsed.OPENTAG_PUBLIC_URL,
                ) as string)
              : new URL(GITHUB_OAUTH_CALLBACK_PATH, parsed.OPENTAG_PUBLIC_URL).toString(),
          },
        }
      : {}),
    migrationsDirectory: parseDatabaseConfig(environment).migrationsDirectory,
    logLevel: parsed.OPENTAG_LOG_LEVEL,
    observability: {
      tracing: {
        endpoint: parsed.OPENTAG_OTEL_ENDPOINT,
        environment: parsed.OPENTAG_OTEL_ENVIRONMENT ?? parsed.OPENTAG_ENV,
        headers: parsed.OPENTAG_OTEL_HEADERS,
        sampleRate: parsed.OPENTAG_OTEL_SAMPLE_RATE,
      },
    },
    port: parsed.OPENTAG_PORT,
    publicUrl: parsed.OPENTAG_PUBLIC_URL,
    sessionTtlSeconds: parsed.OPENTAG_SESSION_TTL_SECONDS,
    internalTools: offersInternalTools(parsed.OPENTAG_ENV, parsed.OPENTAG_DEV_INTERNAL_TOOLS_ENABLED),
    cloudIdentities: resolveCloudIdentitiesConfig(
      parsed.OPENTAG_CLOUD_IDENTITIES_ENABLED,
      parsed.OPENTAG_CLOUD_STORAGE_BASE,
      parsed.OPENTAG_CLOUD_RUNNER_VERSION,
    ),
    cloudRunner: resolveCloudRunnerConfig(environment, parsed.OPENTAG_CLOUD_IDENTITIES_ENABLED),
    web: resolveWebToolsConfig(parsed, environment),
  };
}

function resolveWebToolsConfig(
  parsed: z.infer<typeof ServerEnvironmentSchema>,
  environment: NodeJS.ProcessEnv,
): WebToolsConfig {
  if (!parsed.OPENTAG_WEB_ENABLED) return { enabled: false };
  const routerBaseUrl = parsed.OPENTAG_WEB_ROUTER_BASE_URL;
  const mappings = parsed.OPENTAG_WEB_ROUTER_TENANTS;
  if (!routerBaseUrl || !mappings || mappings.length === 0) {
    throw new Error("Web tools are enabled without a Router origin or Account tenant mapping");
  }
  const tenants = new Map<string, { tenantId: string; routerKey: string }>();
  for (const entry of mappings) {
    const key = environment[entry.keyEnv];
    if (!key || key !== key.trim() || key.length > 1024) {
      throw new Error(`Web tenant mapping for Account ${entry.accountId} references an unset or invalid key variable`);
    }
    tenants.set(entry.accountId, { tenantId: entry.tenantId, routerKey: key });
  }
  return { enabled: true, routerBaseUrl: new URL(routerBaseUrl).origin, tenants };
}

function resolveCloudIdentitiesConfig(
  enabled: boolean,
  storageBase: string | undefined,
  runnerVersion: string | undefined,
): CloudIdentitiesConfig {
  if (!enabled) return { enabled: false };
  if (!storageBase || !runnerVersion) {
    throw new Error("Cloud identities are enabled without a storage base or Runner version");
  }
  return { enabled: true, storageBase, runnerVersion };
}

function offersInternalTools(environment: ChannelName, localPreviewEnabled: boolean): boolean {
  return environment === "staging" || (environment === "dev" && localPreviewEnabled);
}
