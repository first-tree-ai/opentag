import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { parseRequest } from "../api/request-validation.js";
import { isHostedEnvironment, parseDatabaseConfig, parseServerConfig, serverEnvironmentSummary } from "../config.js";
import { createDatabaseClient } from "../db/client.js";
import {
  MIGRATION_ADVISORY_LOCK_ID,
  MigrationVerificationError,
  migrateDatabase,
  verifyDatabaseMigrations,
  withMigrationLock,
} from "../db/migrate.js";
import { createComputerAuthPreHandler } from "../plugins/computer-auth.js";
import { resolveAuthenticatedUserId } from "../plugins/user-auth.js";

vi.mock("postgres", () => ({ default: vi.fn() }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: vi.fn(() => ({ kind: "database" })) }));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: vi.fn() }));
vi.mock("drizzle-orm/migrator", () => ({ readMigrationFiles: vi.fn() }));

const required = {
  BETTER_AUTH_SECRET: "a-better-auth-secret-of-at-least-32-characters",
  OPENTAG_DATABASE_URL: "postgresql://opentag:opentag@localhost:5432/opentag",
  OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPENTAG_JWT_SECRET: "a-secret-that-is-at-least-32-characters",
  OPENTAG_PUBLIC_URL: "http://localhost:8000",
};

describe("parseServerConfig", () => {
  it("offers the Onboarding Lab on the staging environment alone, and takes no setting for it", () => {
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://staging.example.com",
      }).stagingOnboardingLab,
    ).toBe(true);

    expect(parseServerConfig(required).stagingOnboardingLab).toBe(false);
    expect(
      parseServerConfig({ ...required, OPENTAG_ENV: "prod", OPENTAG_PUBLIC_URL: "https://example.com" })
        .stagingOnboardingLab,
    ).toBe(false);

    // The Lab took one setting before the reset became reflexive. A deployment that still carries it
    // must keep starting, so the retired name is ignored rather than rejected as unknown.
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://staging.example.com",
        OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      }).stagingOnboardingLab,
    ).toBe(true);
  });

  it("applies safe local defaults", () => {
    expect(parseServerConfig(required)).toMatchObject({
      autoMigrate: true,
      environment: "dev",
      host: "127.0.0.1",
      publicUrl: "http://localhost:8000",
      port: 8000,
      observability: {
        tracing: { endpoint: "", environment: "dev", headers: "", sampleRate: 1 },
      },
      sessionTtlSeconds: 2_592_000,
    });
    expect(parseServerConfig(required).devAuth).toBeUndefined();
  });

  it("enables development sign-in only with an explicit existing-user email and loopback server", () => {
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: " ADMIN@Example.com ",
        OPENTAG_ENV: "dev",
      }),
    ).toMatchObject({ devAuth: { email: "admin@example.com" }, environment: "dev" });

    for (const invalid of [
      { OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true", OPENTAG_DEV_AUTH_EMAIL: "admin@example.com" },
      { OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true" },
      { OPENTAG_DEV_AUTH_EMAIL: "admin@example.com" },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://dev.example.com",
      },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "prod",
        OPENTAG_PUBLIC_URL: "https://localhost:8000",
      },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "dev",
        OPENTAG_HOST: "0.0.0.0",
      },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "dev",
        OPENTAG_PUBLIC_URL: "http://192.0.2.10:8000",
      },
    ]) {
      expect(() => parseServerConfig({ ...required, ...invalid })).toThrow();
    }
  });

  it("requires complete first-party Slack OAuth configuration and a callback on this origin", () => {
    const slack = {
      OPENTAG_SLACK_CLIENT_ID: "slack-client-id",
      OPENTAG_SLACK_CLIENT_SECRET: "slack-client-secret",
      OPENTAG_SLACK_SIGNING_SECRET: "slack-signing-secret",
      OPENTAG_SLACK_REDIRECT_URL: "http://localhost:8000/api/v1/im-bindings/slack/oauth/callback",
    };
    expect(parseServerConfig({ ...required, ...slack }).slackOAuth).toEqual({
      clientId: "slack-client-id",
      clientSecret: "slack-client-secret",
      signingSecret: "slack-signing-secret",
      redirectUrl: "http://localhost:8000/api/v1/im-bindings/slack/oauth/callback",
    });
    expect(
      parseServerConfig({
        ...required,
        ...slack,
        OPENTAG_SLACK_REDIRECT_URL: "http://localhost:8000",
      }).slackOAuth?.redirectUrl,
    ).toBe("http://localhost:8000/api/v1/im-bindings/slack/oauth/callback");
    expect(parseServerConfig(required).slackOAuth).toBeUndefined();
    expect(
      parseServerConfig({ ...required, OPENTAG_SLACK_CLIENT_ID: "", OPENTAG_SLACK_CLIENT_SECRET: "" }).slackOAuth,
    ).toBe(undefined);

    for (const invalid of [
      { OPENTAG_SLACK_CLIENT_ID: "slack-client-id" },
      { ...slack, OPENTAG_SLACK_REDIRECT_URL: "https://evil.example/api/v1/im-bindings/slack/oauth/callback" },
      { ...slack, OPENTAG_SLACK_REDIRECT_URL: "http://localhost:8000/api/v1/auth/google/callback" },
      {
        ...slack,
        OPENTAG_ENV: "prod",
        OPENTAG_PUBLIC_URL: "https://opentag.example.com",
        OPENTAG_SLACK_REDIRECT_URL: "http://opentag.example.com/api/v1/im-bindings/slack/oauth/callback",
      },
    ]) {
      expect(() => parseServerConfig({ ...required, ...invalid })).toThrow();
    }
  });

  it("requires complete Google configuration and HTTPS in hosted environments", () => {
    expect(isHostedEnvironment("dev")).toBe(false);
    expect(isHostedEnvironment("staging")).toBe(true);
    expect(isHostedEnvironment("prod")).toBe(true);
    expect(() => parseServerConfig({ ...required, OPENTAG_GOOGLE_CLIENT_ID: "client" })).toThrow();
    for (const environment of ["staging", "prod"] as const) {
      expect(() => parseServerConfig({ ...required, OPENTAG_ENV: environment })).toThrow();
      expect(
        parseServerConfig({
          ...required,
          OPENTAG_ENV: environment,
          OPENTAG_PUBLIC_URL: environment === "staging" ? "https://dev.example.com" : "https://opentag.example.com",
          OPENTAG_GOOGLE_CLIENT_ID: "client",
          OPENTAG_GOOGLE_CLIENT_SECRET: "secret",
        }),
      ).toMatchObject({
        environment,
        google: { clientId: "client", clientSecret: "secret" },
      });
    }
  });

  it("uses OPENTAG_ENV as the channel source without interpreting the hostname", () => {
    const config = parseServerConfig({
      ...required,
      OPENTAG_ENV: "staging",
      OPENTAG_PUBLIC_URL: "https://dev.example.com",
    });
    expect(serverEnvironmentSummary(config)).toEqual({
      binName: "opentag-staging",
      channel: "staging",
      environment: "staging",
      packageName: "open-tag-staging",
      publicUrl: "https://dev.example.com",
    });
  });

  it("rejects legacy or parallel environment values", () => {
    for (const environment of ["development", "production", "test"]) {
      expect(() => parseServerConfig({ ...required, OPENTAG_ENV: environment })).toThrow();
    }
  });

  it("rejects invalid ports, secrets, and database protocols", () => {
    expect(() => parseServerConfig({ ...required, OPENTAG_PORT: "0" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_JWT_SECRET: "short" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_DATABASE_URL: "https://example.com" })).toThrow();
  });

  it("requires a Better Auth secret that is independent of the legacy JWT secret", () => {
    expect(parseServerConfig(required).betterAuthSecret).toBe(required.BETTER_AUTH_SECRET);
    expect(parseServerConfig(required).betterAuthSecret).not.toBe(parseServerConfig(required).jwtSecret);

    const { BETTER_AUTH_SECRET: _omitted, ...withoutSecret } = required;
    expect(() => parseServerConfig(withoutSecret)).toThrow();
    expect(() => parseServerConfig({ ...required, BETTER_AUTH_SECRET: "short" })).toThrow();
    expect(() => parseServerConfig({ ...required, BETTER_AUTH_SECRET: required.OPENTAG_JWT_SECRET })).toThrow();
  });

  it("parses optional OTLP tracing configuration and validates its bounds", () => {
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_OTEL_ENDPOINT: "https://logfire-us.pydantic.dev/v1/traces",
        OPENTAG_OTEL_HEADERS: "Authorization=Bearer pylf_test",
        OPENTAG_OTEL_ENVIRONMENT: "production",
        OPENTAG_OTEL_SAMPLE_RATE: "0.25",
      }).observability.tracing,
    ).toEqual({
      endpoint: "https://logfire-us.pydantic.dev/v1/traces",
      headers: "Authorization=Bearer pylf_test",
      environment: "production",
      sampleRate: 0.25,
    });
    expect(() => parseServerConfig({ ...required, OPENTAG_OTEL_SAMPLE_RATE: "1.1" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_OTEL_ENDPOINT: "file:///tmp/traces" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_OTEL_ENDPOINT: "https://user:pass@example.com" })).toThrow();
  });

  it("allows migration commands to parse only their database dependency", () => {
    expect(parseDatabaseConfig({ OPENTAG_DATABASE_URL: required.OPENTAG_DATABASE_URL })).toMatchObject({
      databaseUrl: required.OPENTAG_DATABASE_URL,
    });
  });
});

function mockSql(handler: (query: string, values: readonly unknown[]) => unknown | Promise<unknown>) {
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => handler(strings.join(""), values)),
    { end: vi.fn(async () => undefined) },
  );
  vi.mocked(postgres).mockReturnValue(sql as never);
  return sql;
}

describe("database migration helpers", () => {
  it("creates a PostgreSQL Drizzle client with the configured pool size", async () => {
    const sql = mockSql(() => []);
    const client = createDatabaseClient("postgresql://localhost/opentag", { max: 3 });

    expect(postgres).toHaveBeenLastCalledWith("postgresql://localhost/opentag", {
      max: 3,
      onnotice: expect.any(Function),
    });
    expect(client.database).toBeDefined();
    expect(client.sql).toBe(sql);
    await client.sql.end();
  });

  it("preserves non-Zod parser failures and returns no unauthenticated identity", async () => {
    const failure = new Error("parser failed");
    expect(() =>
      parseRequest(
        {
          parse: () => {
            throw failure;
          },
        },
        {},
      ),
    ).toThrow(failure);
    await expect(resolveAuthenticatedUserId({ headers: {} } as never, {} as never)).resolves.toBeUndefined();
  });

  it("rejects missing machine credentials and verifies a non-empty bearer token", async () => {
    const verifyMachineToken = vi.fn().mockResolvedValue({ computerId: "computer" });
    const handler = createComputerAuthPreHandler({ verifyMachineToken });
    await expect(handler({ headers: {} } as never, {} as never)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
      statusCode: 401,
    });
    await expect(handler({ headers: { authorization: "Bearer " } } as never, {} as never)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
      statusCode: 401,
    });
    const request = { headers: { authorization: "Bearer machine-token" } } as {
      headers: { authorization: string };
      computerAuthContext?: unknown;
    };
    await handler(request as never, {} as never);
    expect(verifyMachineToken).toHaveBeenCalledWith("machine-token");
    expect(request.computerAuthContext).toEqual({ computerId: "computer" });
  });

  it("releases the advisory lock after a successful operation", async () => {
    const sql = mockSql(() => []);
    const result = await withMigrationLock(sql as never, async () => "migrated");

    expect(result).toBe("migrated");
    expect(sql).toHaveBeenCalledTimes(2);
    expect(sql.mock.calls[0]?.[1]).toBe(MIGRATION_ADVISORY_LOCK_ID);
    expect(sql.mock.calls[1]?.[1]).toBe(MIGRATION_ADVISORY_LOCK_ID);
  });

  it("releases the advisory lock and closes the connection after migration failure", async () => {
    const sql = mockSql(() => []);
    vi.mocked(migrate).mockRejectedValueOnce(new Error("migration failed"));

    await expect(migrateDatabase("postgresql://localhost/opentag", "/tmp/drizzle")).rejects.toThrow("migration failed");
    expect(drizzle).toHaveBeenCalledWith(sql);
    expect(migrate).toHaveBeenCalledWith({ kind: "database" }, { migrationsFolder: "/tmp/drizzle" });
    expect(sql).toHaveBeenCalledTimes(2);
    expect(sql.end).toHaveBeenCalledOnce();
  });

  it.each([
    ["empty", [{ migration_table: null }], [], "The database has not been migrated"],
    [
      "behind",
      [{ migration_table: "drizzle.__drizzle_migrations" }],
      [{ hash: "h1", created_at: "1" }],
      "The database is behind the checked-in migrations",
    ],
    [
      "diverged",
      [{ migration_table: "drizzle.__drizzle_migrations" }],
      [
        { hash: "h1", created_at: "1" },
        { hash: "h2", created_at: "2" },
        { hash: "h3", created_at: "3" },
      ],
      "The database has migrations unknown to this server build",
    ],
    [
      "hash mismatch",
      [{ migration_table: "drizzle.__drizzle_migrations" }],
      [
        { hash: "wrong", created_at: "1" },
        { hash: "h2", created_at: "2" },
      ],
      "The database migration history does not match this build",
    ],
    [
      "timestamp mismatch",
      [{ migration_table: "drizzle.__drizzle_migrations" }],
      [
        { hash: "h1", created_at: "9" },
        { hash: "h2", created_at: "2" },
      ],
      "The database migration history does not match this build",
    ],
  ])("classifies %s migration state", async (reason, relation, applied, message) => {
    vi.mocked(readMigrationFiles).mockReturnValue([
      { hash: "h1", folderMillis: 1, sql: "" },
      { hash: "h2", folderMillis: 2, sql: "" },
    ] as never);
    const sql = mockSql((query) => {
      if (query.includes("to_regclass")) return relation;
      if (query.includes("from drizzle.__drizzle_migrations")) return applied;
      return [];
    });

    const result = verifyDatabaseMigrations("postgresql://localhost/opentag", "/tmp/drizzle");
    await expect(result).rejects.toBeInstanceOf(MigrationVerificationError);
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.toMatchObject({
      reason:
        reason === "empty" ? "empty" : reason === "behind" ? "behind" : reason === "diverged" ? "diverged" : "diverged",
    });
    expect(sql.end).toHaveBeenCalledOnce();
  });

  it("accepts an exact migration ledger and wraps database failures as unreachable", async () => {
    vi.mocked(readMigrationFiles).mockReturnValue([
      { hash: "h1", folderMillis: 1, sql: "" },
      { hash: "h2", folderMillis: 2, sql: "" },
    ] as never);
    const sql = mockSql((query) => {
      if (query.includes("to_regclass")) return [{ migration_table: "drizzle.__drizzle_migrations" }];
      if (query.includes("from drizzle.__drizzle_migrations")) {
        return [
          { hash: "h1", created_at: "1" },
          { hash: "h2", created_at: "2" },
        ];
      }
      return [];
    });
    await expect(verifyDatabaseMigrations("postgresql://localhost/opentag", "/tmp/drizzle")).resolves.toBeUndefined();
    expect(sql.end).toHaveBeenCalledOnce();

    const failureSql = mockSql(() => {
      throw new Error("connection refused");
    });
    const unreachable = verifyDatabaseMigrations("postgresql://localhost/opentag", "/tmp/drizzle");
    await expect(unreachable).rejects.toMatchObject({
      name: "MigrationVerificationError",
      reason: "unreachable",
      cause: expect.objectContaining({ message: "connection refused" }),
    });
    expect(failureSql.end).toHaveBeenCalledOnce();
  });

  it("runs the migration CLI with only the database config", async () => {
    vi.resetModules();
    const migrateDatabaseMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../db/migrate.js", () => ({ migrateDatabase: migrateDatabaseMock }));
    const previousUrl = process.env.OPENTAG_DATABASE_URL;
    process.env.OPENTAG_DATABASE_URL = "postgresql://localhost/opentag";
    try {
      await import("../db/migrate-cli.js");
    } finally {
      if (previousUrl === undefined) delete process.env.OPENTAG_DATABASE_URL;
      else process.env.OPENTAG_DATABASE_URL = previousUrl;
      vi.doUnmock("../db/migrate.js");
    }
    expect(migrateDatabaseMock).toHaveBeenCalledWith(
      "postgresql://localhost/opentag",
      expect.stringContaining("/drizzle"),
    );
  });
});
