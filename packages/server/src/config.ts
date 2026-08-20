import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { type ChannelConfig, type ChannelName, ChannelNameSchema, getChannelConfig } from "@opentag/shared";
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

export function isHostedEnvironment(environment: ChannelName): boolean {
  return environment !== "dev";
}

const ServerEnvironmentSchema = z
  .object({
    OPENTAG_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    OPENTAG_AUTO_MIGRATE: booleanString("true"),
    OPENTAG_DATABASE_URL: DatabaseUrlSchema,
    OPENTAG_ENCRYPTION_KEY: EncryptionKeySchema,
    OPENTAG_ENV: ChannelNameSchema.default("dev"),
    OPENTAG_ENV_EXPLICIT: z.boolean(),
    OPENTAG_DEV_AUTH_BYPASS_ENABLED: booleanString("false"),
    OPENTAG_DEV_AUTH_EMAIL: z.string().trim().toLowerCase().email().optional(),
    OPENTAG_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    OPENTAG_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    OPENTAG_HOST: z.string().min(1).default("127.0.0.1"),
    OPENTAG_JWT_SECRET: z.string().min(32),
    OPENTAG_PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
    OPENTAG_PUBLIC_URL: PublicUrlSchema,
    OPENTAG_OTEL_ENDPOINT: OtlpEndpointSchema,
    OPENTAG_OTEL_ENVIRONMENT: z.string().trim().min(1).optional(),
    OPENTAG_OTEL_HEADERS: z.string().default(""),
    OPENTAG_OTEL_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
    OPENTAG_REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 30),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.OPENTAG_GOOGLE_CLIENT_ID) !== Boolean(value.OPENTAG_GOOGLE_CLIENT_SECRET)) {
      context.addIssue({ code: "custom", message: "Google client id and secret must be configured together" });
    }
    if (isHostedEnvironment(value.OPENTAG_ENV) && !value.OPENTAG_PUBLIC_URL.startsWith("https://")) {
      context.addIssue({ code: "custom", message: "OPENTAG_PUBLIC_URL must use HTTPS in hosted environments" });
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

export interface ServerConfig {
  accessTokenTtlSeconds: number;
  autoMigrate: boolean;
  databaseUrl: string;
  encryptionKey: Uint8Array;
  channel: ChannelConfig;
  environment: ChannelName;
  devAuth?: { email: string };
  google?: { clientId: string; clientSecret: string };
  host: string;
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
  port: number;
  publicUrl: string;
  refreshTokenTtlSeconds: number;
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
    OPENTAG_ACCESS_TOKEN_TTL_SECONDS: environment.OPENTAG_ACCESS_TOKEN_TTL_SECONDS,
    OPENTAG_AUTO_MIGRATE: environment.OPENTAG_AUTO_MIGRATE,
    OPENTAG_DATABASE_URL: environment.OPENTAG_DATABASE_URL,
    OPENTAG_ENCRYPTION_KEY: environment.OPENTAG_ENCRYPTION_KEY,
    OPENTAG_ENV: environment.OPENTAG_ENV,
    OPENTAG_ENV_EXPLICIT: environment.OPENTAG_ENV !== undefined,
    OPENTAG_DEV_AUTH_BYPASS_ENABLED: environment.OPENTAG_DEV_AUTH_BYPASS_ENABLED,
    OPENTAG_DEV_AUTH_EMAIL: environment.OPENTAG_DEV_AUTH_EMAIL,
    OPENTAG_GOOGLE_CLIENT_ID: environment.OPENTAG_GOOGLE_CLIENT_ID,
    OPENTAG_GOOGLE_CLIENT_SECRET: environment.OPENTAG_GOOGLE_CLIENT_SECRET,
    OPENTAG_HOST: environment.OPENTAG_HOST,
    OPENTAG_JWT_SECRET: environment.OPENTAG_JWT_SECRET,
    OPENTAG_PORT: environment.OPENTAG_PORT,
    OPENTAG_PUBLIC_URL: environment.OPENTAG_PUBLIC_URL,
    OPENTAG_OTEL_ENDPOINT: environment.OPENTAG_OTEL_ENDPOINT,
    OPENTAG_OTEL_ENVIRONMENT: environment.OPENTAG_OTEL_ENVIRONMENT,
    OPENTAG_OTEL_HEADERS: environment.OPENTAG_OTEL_HEADERS,
    OPENTAG_OTEL_SAMPLE_RATE: environment.OPENTAG_OTEL_SAMPLE_RATE,
    OPENTAG_REFRESH_TOKEN_TTL_SECONDS: environment.OPENTAG_REFRESH_TOKEN_TTL_SECONDS,
  });

  return {
    accessTokenTtlSeconds: parsed.OPENTAG_ACCESS_TOKEN_TTL_SECONDS,
    autoMigrate: parsed.OPENTAG_AUTO_MIGRATE,
    channel: getChannelConfig(parsed.OPENTAG_ENV),
    databaseUrl: parsed.OPENTAG_DATABASE_URL,
    encryptionKey: parsed.OPENTAG_ENCRYPTION_KEY,
    environment: parsed.OPENTAG_ENV,
    ...(parsed.OPENTAG_DEV_AUTH_BYPASS_ENABLED && parsed.OPENTAG_DEV_AUTH_EMAIL
      ? { devAuth: { email: parsed.OPENTAG_DEV_AUTH_EMAIL } }
      : {}),
    ...(parsed.OPENTAG_GOOGLE_CLIENT_ID && parsed.OPENTAG_GOOGLE_CLIENT_SECRET
      ? { google: { clientId: parsed.OPENTAG_GOOGLE_CLIENT_ID, clientSecret: parsed.OPENTAG_GOOGLE_CLIENT_SECRET } }
      : {}),
    host: parsed.OPENTAG_HOST,
    jwtSecret: parsed.OPENTAG_JWT_SECRET,
    migrationsDirectory: parseDatabaseConfig(environment).migrationsDirectory,
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
    refreshTokenTtlSeconds: parsed.OPENTAG_REFRESH_TOKEN_TTL_SECONDS,
  };
}
