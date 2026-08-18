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
import { connectCodes, memberships, teams, users } from "../../db/schema/index.js";
import {
  AuthService,
  AuthServiceError,
  type AuthTokenProvider,
  AuthTokenService,
  hashSecret,
} from "../../services/auth/index.js";

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

async function createAuthFixture(now = new Date("2026-08-18T00:00:00.000Z"), authTokens?: AuthTokenProvider) {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(
    client.database,
    {
      displayName: "Admin",
      email: "admin@example.com",
      teamDisplayName: "Example",
      teamName: "example",
    },
    now,
  );
  const auth = new AuthService(
    client.database,
    authTokens ?? new AuthTokenService(jwtSecret, 900, 3600, { now: () => now }),
    {
      now: () => now,
    },
  );
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
        where table_schema = 'public' and table_name in ('users', 'teams', 'memberships', 'connect_codes')
      `;
      expect(row?.table_count).toBe(4);
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
      teamDisplayName: "Example",
      teamName: "example",
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
          teamDisplayName: "   ",
          teamName: "Not Valid",
        }),
      ).rejects.toThrow();
      expect(await client.database.select().from(users)).toHaveLength(0);

      const result = await bootstrapInitialAdmin(client.database, {
        displayName: "  Admin  ",
        email: "  ADMIN@EXAMPLE.COM  ",
        teamDisplayName: "  Example  ",
        teamName: "  EXAMPLE  ",
      });
      const [storedUser] = await client.database.select().from(users).where(eq(users.id, result.userId));
      const [storedTeam] = await client.database.select().from(teams).where(eq(teams.id, result.teamId));
      expect(storedUser).toMatchObject({ displayName: "Admin", email: "admin@example.com" });
      expect(storedTeam).toMatchObject({ displayName: "Example", name: "example" });
    } finally {
      await client.sql.end();
    }
  });

  it("stores only the connect-code hash and issues authority-free JWTs", async () => {
    const fixture = await createAuthFixture();
    try {
      const tokens = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      const [storedCode] = await fixture.database.select().from(connectCodes);
      expect(storedCode?.codeHash).toBe(hashSecret(fixture.bootstrap.connectCode));
      expect(storedCode?.codeHash).not.toBe(fixture.bootstrap.connectCode);
      for (const token of [tokens.accessToken, tokens.refreshToken]) {
        const claims = decodeJwt(token);
        expect(claims.sub).toBe(fixture.bootstrap.userId);
        expect(claims).toHaveProperty("jti");
        expect(claims).not.toHaveProperty("email");
        expect(claims).not.toHaveProperty("teamId");
        expect(claims).not.toHaveProperty("role");
        expect(claims).not.toHaveProperty("sid");
      }

      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toMatchObject({
        code: "AUTH_CODE_CONSUMED",
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("does not consume a connect code when token issuance fails", async () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    const delegate = new AuthTokenService(jwtSecret, 900, 3600, { now: () => now });
    let shouldFail = true;
    const authTokens: AuthTokenProvider = {
      issuePairForUser: async (userId) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Injected token signing failure");
        }
        return delegate.issuePairForUser(userId);
      },
      verifyAccess: (token) => delegate.verifyAccess(token),
      verifyRefresh: (token) => delegate.verifyRefresh(token),
    };
    const fixture = await createAuthFixture(now, authTokens);

    try {
      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toThrow(
        "Injected token signing failure",
      );
      const [afterFailure] = await fixture.database.select().from(connectCodes);
      expect(afterFailure?.consumedAt).toBeNull();

      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).resolves.toMatchObject({
        tokenType: "Bearer",
      });
      const [afterRetry] = await fixture.database.select().from(connectCodes);
      expect(afterRetry?.consumedAt).not.toBeNull();
    } finally {
      await fixture.sql.end();
    }
  });

  it("issues tokens through the provider-neutral post-identity boundary", async () => {
    const fixture = await createAuthFixture();
    try {
      const tokens = await fixture.auth.issueTokensForUser(fixture.bootstrap.userId);
      await expect(fixture.auth.getAuthenticatedUser(tokens.accessToken)).resolves.toMatchObject({
        me: { user: { id: fixture.bootstrap.userId } },
      });

      const [storedCode] = await fixture.database.select().from(connectCodes);
      expect(storedCode?.consumedAt).toBeNull();
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

  it("uses stateless sliding refresh JWTs while preserving live account checks", async () => {
    const fixture = await createAuthFixture();
    try {
      const initial = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      const rotated = await fixture.auth.refresh(initial.refreshToken);
      expect(rotated.accessToken).not.toBe(initial.accessToken);
      expect(rotated.refreshToken).not.toBe(initial.refreshToken);
      await expect(fixture.auth.refresh(initial.refreshToken)).resolves.toMatchObject({ tokenType: "Bearer" });
      await expect(fixture.auth.getAuthenticatedUser(initial.accessToken)).resolves.toMatchObject({
        me: { user: { id: fixture.bootstrap.userId } },
      });

      await fixture.database
        .update(users)
        .set({ suspendedAt: new Date() })
        .where(eq(users.id, fixture.bootstrap.userId));
      await expect(fixture.auth.refresh(rotated.refreshToken)).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
      await expect(fixture.auth.getAuthenticatedUser(rotated.accessToken)).rejects.toMatchObject({
        code: "AUTH_USER_SUSPENDED",
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
        me: { memberships: [{ teamId: fixture.bootstrap.teamId, role: "admin" }] },
      });

      await fixture.database
        .update(memberships)
        .set({ leftAt: new Date("2026-08-18T00:01:00.000Z") })
        .where(eq(memberships.userId, fixture.bootstrap.userId));
      const error = await fixture.auth.getAuthenticatedUser(tokens.accessToken).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthServiceError);
      expect(error).toMatchObject({ code: "AUTH_MEMBERSHIP_REQUIRED" });
      await expect(fixture.auth.refresh(tokens.refreshToken)).rejects.toMatchObject({
        code: "AUTH_MEMBERSHIP_REQUIRED",
      });
    } finally {
      await fixture.sql.end();
    }
  });
});
