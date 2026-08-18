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

const ServerEnvironmentSchema = z
  .object({
    OPENTAG_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    OPENTAG_AUTO_MIGRATE: BooleanStringSchema,
    OPENTAG_DATABASE_URL: DatabaseUrlSchema,
    OPENTAG_HOST: z.string().min(1).default("127.0.0.1"),
    OPENTAG_JWT_SECRET: z.string().min(32),
    OPENTAG_PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
    OPENTAG_REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 30),
  })
  .strict();

export interface ServerConfig {
  accessTokenTtlSeconds: number;
  autoMigrate: boolean;
  databaseUrl: string;
  host: string;
  jwtSecret: string;
  migrationsDirectory: string;
  port: number;
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
    OPENTAG_HOST: environment.OPENTAG_HOST,
    OPENTAG_JWT_SECRET: environment.OPENTAG_JWT_SECRET,
    OPENTAG_PORT: environment.OPENTAG_PORT,
    OPENTAG_REFRESH_TOKEN_TTL_SECONDS: environment.OPENTAG_REFRESH_TOKEN_TTL_SECONDS,
  });

  return {
    accessTokenTtlSeconds: parsed.OPENTAG_ACCESS_TOKEN_TTL_SECONDS,
    autoMigrate: parsed.OPENTAG_AUTO_MIGRATE,
    databaseUrl: parsed.OPENTAG_DATABASE_URL,
    host: parsed.OPENTAG_HOST,
    jwtSecret: parsed.OPENTAG_JWT_SECRET,
    migrationsDirectory: parseDatabaseConfig(environment).migrationsDirectory,
    port: parsed.OPENTAG_PORT,
    refreshTokenTtlSeconds: parsed.OPENTAG_REFRESH_TOKEN_TTL_SECONDS,
  };
}
