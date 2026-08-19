import { fileURLToPath } from "node:url";
import { z } from "zod";

const BooleanStringSchema = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

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

const ServerEnvironmentSchema = z
  .object({
    OPENTAG_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    OPENTAG_AUTO_MIGRATE: BooleanStringSchema,
    OPENTAG_DATABASE_URL: DatabaseUrlSchema,
    OPENTAG_ENCRYPTION_KEY: EncryptionKeySchema,
    OPENTAG_ENV: z.enum(["development", "production", "test"]).default("development"),
    OPENTAG_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    OPENTAG_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    OPENTAG_HOST: z.string().min(1).default("127.0.0.1"),
    OPENTAG_JWT_SECRET: z.string().min(32),
    OPENTAG_PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
    OPENTAG_PUBLIC_URL: PublicUrlSchema,
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
    if (value.OPENTAG_ENV === "production" && !value.OPENTAG_PUBLIC_URL.startsWith("https://")) {
      context.addIssue({ code: "custom", message: "OPENTAG_PUBLIC_URL must use HTTPS in production" });
    }
  });

export interface ServerConfig {
  accessTokenTtlSeconds: number;
  autoMigrate: boolean;
  databaseUrl: string;
  encryptionKey: Uint8Array;
  environment: "development" | "production" | "test";
  google?: { clientId: string; clientSecret: string };
  host: string;
  jwtSecret: string;
  migrationsDirectory: string;
  port: number;
  publicUrl: string;
  refreshTokenTtlSeconds: number;
}

export interface DatabaseConfig {
  databaseUrl: string;
  migrationsDirectory: string;
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
    OPENTAG_GOOGLE_CLIENT_ID: environment.OPENTAG_GOOGLE_CLIENT_ID,
    OPENTAG_GOOGLE_CLIENT_SECRET: environment.OPENTAG_GOOGLE_CLIENT_SECRET,
    OPENTAG_HOST: environment.OPENTAG_HOST,
    OPENTAG_JWT_SECRET: environment.OPENTAG_JWT_SECRET,
    OPENTAG_PORT: environment.OPENTAG_PORT,
    OPENTAG_PUBLIC_URL: environment.OPENTAG_PUBLIC_URL,
    OPENTAG_REFRESH_TOKEN_TTL_SECONDS: environment.OPENTAG_REFRESH_TOKEN_TTL_SECONDS,
  });

  return {
    accessTokenTtlSeconds: parsed.OPENTAG_ACCESS_TOKEN_TTL_SECONDS,
    autoMigrate: parsed.OPENTAG_AUTO_MIGRATE,
    databaseUrl: parsed.OPENTAG_DATABASE_URL,
    encryptionKey: parsed.OPENTAG_ENCRYPTION_KEY,
    environment: parsed.OPENTAG_ENV,
    ...(parsed.OPENTAG_GOOGLE_CLIENT_ID && parsed.OPENTAG_GOOGLE_CLIENT_SECRET
      ? { google: { clientId: parsed.OPENTAG_GOOGLE_CLIENT_ID, clientSecret: parsed.OPENTAG_GOOGLE_CLIENT_SECRET } }
      : {}),
    host: parsed.OPENTAG_HOST,
    jwtSecret: parsed.OPENTAG_JWT_SECRET,
    migrationsDirectory: parseDatabaseConfig(environment).migrationsDirectory,
    port: parsed.OPENTAG_PORT,
    publicUrl: parsed.OPENTAG_PUBLIC_URL,
    refreshTokenTtlSeconds: parsed.OPENTAG_REFRESH_TOKEN_TTL_SECONDS,
  };
}
