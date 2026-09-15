import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import {
  type ChannelConfig,
  type ChannelName,
  ChannelNameSchema,
  getChannelConfig,
  SLACK_OAUTH_CALLBACK_PATH,
} from "@opentag/shared";
import { z } from "zod";

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

const OptionalEndpointUrlSchema = z
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
      context.addIssue({ code: "custom", message: "Must be an HTTP(S) URL without credentials, query, or fragment" });
      return z.NEVER;
    }
    return url.toString().replace(/\/+$/, "");
  });

const SkillStoragePrefixSchema = z
  .string()
  .trim()
  .default("skills/")
  .refine((value) => !value.startsWith("/") && !value.includes("//") && !value.includes(".."), {
    message: "Must be a relative object key prefix",
  })
  .transform((value) => (value === "" || value.endsWith("/") ? value : `${value}/`));

const ServerLogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info");
export type ServerLogLevel = z.infer<typeof ServerLogLevelSchema>;

export function isHostedEnvironment(environment: ChannelName): boolean {
  return environment !== "dev";
}

const ServerEnvironmentSchema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32),
    OPENTAG_AUTO_MIGRATE: booleanString("true"),
    OPENTAG_DATABASE_URL: DatabaseUrlSchema,
    OPENTAG_ENCRYPTION_KEY: EncryptionKeySchema,
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
     * Defaults to what the refresh token's lifetime was, because that is the number it replaced: how long a client
     * may be idle and still be signed in.
     */
    OPENTAG_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 30),
    /*
     * Object storage for skill archives (S3-compatible; Google Cloud Storage through its XML interoperability API in
     * production). Optional as a group: without a bucket the skill routes answer 503 and everything else is unaffected.
     */
    OPENTAG_SKILL_STORAGE_S3_BUCKET: z.string().trim().min(1).optional(),
    OPENTAG_SKILL_STORAGE_S3_ENDPOINT: OptionalEndpointUrlSchema.optional(),
    OPENTAG_SKILL_STORAGE_S3_REGION: z.string().trim().min(1).default("auto"),
    OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    OPENTAG_SKILL_STORAGE_S3_PREFIX: SkillStoragePrefixSchema,
    OPENTAG_SKILL_STORAGE_S3_FORCE_PATH_STYLE: booleanString("true"),
  })
  .strict()
  .superRefine((value, context) => {
    const storageValues = [
      value.OPENTAG_SKILL_STORAGE_S3_BUCKET,
      value.OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID,
      value.OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY,
    ];
    const configured = storageValues.filter(Boolean).length;
    if (configured > 0 && configured < storageValues.length) {
      context.addIssue({
        code: "custom",
        message:
          "OPENTAG_SKILL_STORAGE_S3_BUCKET, OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID, and OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY must be configured together",
      });
    }
    if (value.OPENTAG_SKILL_STORAGE_S3_ENDPOINT && !value.OPENTAG_SKILL_STORAGE_S3_BUCKET) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_SKILL_STORAGE_S3_ENDPOINT requires OPENTAG_SKILL_STORAGE_S3_BUCKET",
      });
    }
    if (
      value.OPENTAG_SKILL_STORAGE_S3_ENDPOINT &&
      isHostedEnvironment(value.OPENTAG_ENV) &&
      !value.OPENTAG_SKILL_STORAGE_S3_ENDPOINT.startsWith("https://")
    ) {
      context.addIssue({
        code: "custom",
        message: "OPENTAG_SKILL_STORAGE_S3_ENDPOINT must use HTTPS in hosted environments",
      });
    }
  })
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
  });

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."));
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

export interface SkillStorageConfig {
  bucket: string;
  /** Custom S3-compatible endpoint; absent for AWS itself. */
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Object key prefix, always empty or ending in `/`. */
  prefix: string;
  forcePathStyle: boolean;
}

export interface ServerConfig {
  autoMigrate: boolean;
  /** Signs every Account session and its cookies. */
  betterAuthSecret: string;
  /** Where the Server reads the channel's exact latest Client target, and how often. */
  channelTarget: { downloadBaseUrl: string; pollIntervalMs: number };
  databaseUrl: string;
  encryptionKey: Uint8Array;
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
  /** Object storage for skill archives; absent when the deployment does not distribute skills. */
  skillStorage?: SkillStorageConfig;
  /**
   * Whether this deployment offers Internal Tools, including Account-owned setup resets.
   * Enabled on staging, or explicitly opted into on a loopback development server.
   */
  internalTools: boolean;
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
    OPENTAG_SESSION_TTL_SECONDS: environment.OPENTAG_SESSION_TTL_SECONDS,
    OPENTAG_SKILL_STORAGE_S3_BUCKET: emptyToUndefined(environment.OPENTAG_SKILL_STORAGE_S3_BUCKET),
    OPENTAG_SKILL_STORAGE_S3_ENDPOINT: emptyToUndefined(environment.OPENTAG_SKILL_STORAGE_S3_ENDPOINT),
    OPENTAG_SKILL_STORAGE_S3_REGION: emptyToUndefined(environment.OPENTAG_SKILL_STORAGE_S3_REGION),
    OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID: emptyToUndefined(environment.OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID),
    OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY: emptyToUndefined(
      environment.OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY,
    ),
    OPENTAG_SKILL_STORAGE_S3_PREFIX: environment.OPENTAG_SKILL_STORAGE_S3_PREFIX,
    OPENTAG_SKILL_STORAGE_S3_FORCE_PATH_STYLE: environment.OPENTAG_SKILL_STORAGE_S3_FORCE_PATH_STYLE,
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
    ...skillStorageConfig(parsed),
    internalTools: offersInternalTools(parsed.OPENTAG_ENV, parsed.OPENTAG_DEV_INTERNAL_TOOLS_ENABLED),
  };
}

function skillStorageConfig(
  parsed: z.infer<typeof ServerEnvironmentSchema>,
): { skillStorage?: SkillStorageConfig } | Record<string, never> {
  if (
    !parsed.OPENTAG_SKILL_STORAGE_S3_BUCKET ||
    !parsed.OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID ||
    !parsed.OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY
  ) {
    return {};
  }
  return {
    skillStorage: {
      bucket: parsed.OPENTAG_SKILL_STORAGE_S3_BUCKET,
      ...(parsed.OPENTAG_SKILL_STORAGE_S3_ENDPOINT ? { endpoint: parsed.OPENTAG_SKILL_STORAGE_S3_ENDPOINT } : {}),
      region: parsed.OPENTAG_SKILL_STORAGE_S3_REGION,
      accessKeyId: parsed.OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: parsed.OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY,
      prefix: parsed.OPENTAG_SKILL_STORAGE_S3_PREFIX,
      forcePathStyle: parsed.OPENTAG_SKILL_STORAGE_S3_FORCE_PATH_STYLE,
    },
  };
}

function offersInternalTools(environment: ChannelName, localPreviewEnabled: boolean): boolean {
  return environment === "staging" || (environment === "dev" && localPreviewEnabled);
}
