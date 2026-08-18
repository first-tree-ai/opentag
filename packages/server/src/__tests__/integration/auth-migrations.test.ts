import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  MigrationVerificationError,
  migrateDatabase,
  verifyDatabaseMigrations,
  withMigrationLock,
} from "../../db/migrate.js";
import { authSessions, connectCodes, memberships, users } from "../../db/schema/index.js";
import { AccessTokenService, AuthService, AuthServiceError, hashSecret } from "../../services/auth/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const jwtSecret = "integration-test-secret-at-least-32-characters";
let container: StartedPostgreSqlContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  databaseUrl = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await container.stop();
});

beforeEach(async () => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("drop schema if exists public cascade");
    await sql.unsafe("drop schema if exists drizzle cascade");
    await sql.unsafe("create schema public");
  } finally {
    await sql.end();
  }
});

async function createAuthFixture(now = new Date("2026-08-18T00:00:00.000Z")) {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(
    client.database,
    {
      displayName: "Admin",
      email: "admin@example.com",
      tenantDisplayName: "Example",
      tenantSlug: "example",
    },
    now,
  );
  const auth = new AuthService(client.database, new AccessTokenService(jwtSecret, 900), {
    now: () => now,
    refreshTokenTtlSeconds: 3600,
  });
  return { auth, bootstrap, ...client };
}

describe("database migrations", () => {
  it("migrates an empty database and reruns idempotently", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    await migrateDatabase(databaseUrl, migrationsFolder);

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const [row] = await sql<{ table_count: number }[]>`
        select count(*)::int as table_count
        from information_schema.tables
        where table_schema = 'public' and table_name in ('users', 'tenants', 'memberships', 'connect_codes', 'auth_sessions')
      `;
      expect(row?.table_count).toBe(5);
    } finally {
      await sql.end();
    }
  });

  it("serializes two migrators on one session-held advisory lock", async () => {
    const firstSql = postgres(databaseUrl, { max: 1 });
    const secondSql = postgres(databaseUrl, { max: 1 });
    let releaseFirst: (() => void) | undefined;
    let signalFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    try {
      const first = withMigrationLock(firstSql, async () => {
        order.push("first-enter");
        signalFirstEntered?.();
        await firstRelease;
        order.push("first-exit");
      });
      await firstEntered;
      const second = withMigrationLock(secondSql, async () => {
        order.push("second-enter");
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual(["first-enter"]);
      releaseFirst?.();
      await Promise.all([first, second]);
      expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    } finally {
      await Promise.all([firstSql.end(), secondSql.end()]);
    }
  });

  it("releases the migration lock after a failed migration", async () => {
    await expect(migrateDatabase(databaseUrl, `${migrationsFolder}/missing`)).rejects.toThrow();
    await expect(migrateDatabase(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
  });

  it("allows concurrent migrators to complete without racing migration state", async () => {
    await expect(
      Promise.all([migrateDatabase(databaseUrl, migrationsFolder), migrateDatabase(databaseUrl, migrationsFolder)]),
    ).resolves.toEqual([undefined, undefined]);
  });

  it("verifies an exactly current migration history in manual mode", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
  });

  it("rejects an empty database in manual mode", async () => {
    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).rejects.toMatchObject({
      reason: "empty",
    });
  });

  it("rejects a database behind the checked-in migration history", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql`delete from drizzle.__drizzle_migrations`;
    } finally {
      await sql.end();
    }

    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).rejects.toMatchObject({
      reason: "behind",
    });
  });

  it("classifies an unreachable database in manual mode", async () => {
    const error = await verifyDatabaseMigrations(
      "postgresql://opentag:opentag@127.0.0.1:1/opentag?connect_timeout=1",
      migrationsFolder,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationVerificationError);
    expect(error).toMatchObject({ reason: "unreachable" });
  });
});

describe("authentication persistence", () => {
  it("allows only one concurrent initial bootstrap", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    const first = createDatabaseClient(databaseUrl);
    const second = createDatabaseClient(databaseUrl);
    const input = {
      displayName: "Admin",
      email: "admin@example.com",
      tenantDisplayName: "Example",
      tenantSlug: "example",
    };

    try {
      const outcomes = await Promise.allSettled([
        bootstrapInitialAdmin(first.database, input),
        bootstrapInitialAdmin(second.database, input),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const storedUsers = await first.database.select().from(users);
      expect(storedUsers).toHaveLength(1);
    } finally {
      await Promise.all([first.sql.end(), second.sql.end()]);
    }
  });

  it("validates and normalizes bootstrap input at the service boundary", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    const client = createDatabaseClient(databaseUrl);
    try {
      await expect(
        bootstrapInitialAdmin(client.database, {
          connectCodeTtlSeconds: 0,
          displayName: "   ",
          email: "not-an-email",
          tenantDisplayName: "   ",
          tenantSlug: "Not Valid",
        }),
      ).rejects.toThrow();
      expect(await client.database.select().from(users)).toHaveLength(0);

      const result = await bootstrapInitialAdmin(client.database, {
        displayName: "  Admin  ",
        email: "  ADMIN@EXAMPLE.COM  ",
        tenantDisplayName: "  Example  ",
        tenantSlug: "  EXAMPLE  ",
      });
      const [storedUser] = await client.database.select().from(users).where(eq(users.id, result.userId));
      expect(storedUser).toMatchObject({ displayName: "Admin", email: "admin@example.com" });
    } finally {
      await client.sql.end();
    }
  });

  it("stores only hashes and consumes a connect code once", async () => {
    const fixture = await createAuthFixture();
    try {
      const tokens = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      const [storedCode] = await fixture.database.select().from(connectCodes);
      const [storedSession] = await fixture.database.select().from(authSessions);
      expect(storedCode?.codeHash).toBe(hashSecret(fixture.bootstrap.connectCode));
      expect(storedCode?.codeHash).not.toBe(fixture.bootstrap.connectCode);
      expect(storedSession?.refreshTokenHash).toBe(hashSecret(tokens.refreshToken));
      expect(storedSession?.refreshTokenHash).not.toBe(tokens.refreshToken);
      const claims = decodeJwt(tokens.accessToken);
      expect(claims).not.toHaveProperty("tenantId");
      expect(claims).not.toHaveProperty("role");

      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toMatchObject({
        code: "AUTH_CODE_CONSUMED",
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("rejects expired codes and suspended users", async () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    const fixture = await createAuthFixture(now);
    try {
      await fixture.database
        .update(connectCodes)
        .set({ expiresAt: new Date("2026-08-17T23:59:59.000Z") })
        .where(eq(connectCodes.codeHash, hashSecret(fixture.bootstrap.connectCode)));
      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toMatchObject({
        code: "AUTH_CODE_EXPIRED",
      });

      await fixture.database
        .update(connectCodes)
        .set({ expiresAt: new Date("2026-08-18T00:15:00.000Z") })
        .where(eq(connectCodes.codeHash, hashSecret(fixture.bootstrap.connectCode)));
      await fixture.database.update(users).set({ suspendedAt: now }).where(eq(users.id, fixture.bootstrap.userId));
      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toMatchObject({
        code: "AUTH_USER_SUSPENDED",
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("rotates refresh tokens and honors explicit revocation", async () => {
    const fixture = await createAuthFixture();
    try {
      const initial = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      const initialIdentity = await fixture.auth.getAuthenticatedUser(initial.accessToken);
      const rotated = await fixture.auth.refresh(initial.refreshToken);
      await expect(fixture.auth.refresh(initial.refreshToken)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });

      await expect(fixture.auth.getAuthenticatedUser(initial.accessToken)).resolves.toMatchObject({
        sessionId: initialIdentity.sessionId,
      });

      const authenticated = await fixture.auth.getAuthenticatedUser(rotated.accessToken);
      expect(authenticated.sessionId).toBe(initialIdentity.sessionId);
      await fixture.auth.revokeSession(authenticated.sessionId);
      await expect(fixture.auth.refresh(rotated.refreshToken)).rejects.toMatchObject({ code: "AUTH_SESSION_REVOKED" });
      await expect(fixture.auth.getAuthenticatedUser(rotated.accessToken)).rejects.toMatchObject({
        code: "AUTH_SESSION_REVOKED",
      });
      await expect(fixture.auth.getAuthenticatedUser(initial.accessToken)).rejects.toMatchObject({
        code: "AUTH_SESSION_REVOKED",
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("resolves membership changes live on every protected request", async () => {
    const fixture = await createAuthFixture();
    try {
      const tokens = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      await expect(fixture.auth.getAuthenticatedUser(tokens.accessToken)).resolves.toMatchObject({
        me: { memberships: [{ tenantId: fixture.bootstrap.tenantId, role: "admin" }] },
      });

      await fixture.database
        .update(memberships)
        .set({ leftAt: new Date("2026-08-18T00:01:00.000Z") })
        .where(eq(memberships.userId, fixture.bootstrap.userId));
      const error = await fixture.auth.getAuthenticatedUser(tokens.accessToken).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthServiceError);
      expect(error).toMatchObject({ code: "AUTH_MEMBERSHIP_REQUIRED" });
    } finally {
      await fixture.sql.end();
    }
  });
});
