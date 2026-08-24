import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ConnectCodeService,
  hashSecret,
} from "../../services/auth/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const jwtSecret = "im-binding-test-secret-at-least-32-characters";
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
  it("orders the Team setup repair before the Slack pending receive-mode migration", async () => {
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.slice(-3).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 10, tag: "0010_optimal_jazinda" },
      { idx: 11, tag: "0011_staging_team_setup_repair" },
      { idx: 12, tag: "0012_supreme_maddog" },
    ]);
  });

  it("migrates an empty database and reruns idempotently", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    await migrateDatabase(databaseUrl, migrationsFolder);

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const [row] = await sql<{ table_count: number }[]>`
        select count(*)::int as table_count
        from information_schema.tables
        where table_schema = 'public' and table_name in (
          'users', 'teams', 'memberships', 'connect_codes', 'computers', 'agents',
          'auth_identities', 'invitations', 'invitation_redemptions'
        )
      `;
      expect(row?.table_count).toBe(9);
    } finally {
      await sql.end();
    }
  });

  it("maps legacy left_at rows to the single membership status truth", async () => {
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const applyFile = async (name: string) => {
      const source = await readFile(`${migrationsFolder}/${name}`, "utf8");
      for (const statement of source
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean)) {
        await sql.unsafe(statement);
      }
    };
    try {
      await applyFile("0000_strong_thunderbolt_ross.sql");
      await applyFile("0001_living_franklin_richards.sql");
      await applyFile("0002_sticky_crystal.sql");
      const [user] = await sql<{ id: string }[]>`
        insert into users (email, display_name) values ('left@example.com', 'Left User') returning id
      `;
      const [team] = await sql<{ id: string }[]>`
        insert into teams (name, display_name) values ('legacy', 'Legacy') returning id
      `;
      if (!user || !team) throw new Error("Legacy fixtures were not created");
      await sql`
        insert into memberships (team_id, user_id, role, left_at)
        values (${team.id}, ${user.id}, 'admin', now())
      `;
      await applyFile("0003_noisy_husk.sql");
      const [membership] = await sql<{ status: string }[]>`select status from memberships`;
      expect(membership?.status).toBe("left");
      const columns = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'memberships'
      `;
      expect(columns.map(({ column_name }) => column_name)).not.toContain("left_at");
      const emailIndex = await sql<{ count: number }[]>`
        select count(*)::int as count from pg_indexes where indexname = 'users_email_unique'
      `;
      expect(emailIndex[0]?.count).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("upgrades deployed 0005 and 0006 Drizzle histories through each forward migration exactly once", async () => {
    const legacyFolder = await mkdtemp(join(tmpdir(), "opentag-0005-migrations-"));
    const legacyMeta = join(legacyFolder, "meta");
    await mkdir(legacyMeta);
    const through0006Folder = await mkdtemp(join(tmpdir(), "opentag-0006-migrations-"));
    const through0006Meta = join(through0006Folder, "meta");
    await mkdir(through0006Meta);
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    for (const entry of journal.entries.filter(({ idx }) => idx <= 5)) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
    }
    await writeFile(
      join(legacyMeta, "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 5) }, null, 2),
    );
    for (const entry of journal.entries.filter(({ idx }) => idx <= 6)) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(through0006Folder, `${entry.tag}.sql`));
    }
    await writeFile(
      join(through0006Meta, "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 6) }, null, 2),
    );

    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const [before] = await sql<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `;
        expect(before?.count).toBe(6);
        expect(await sql`select to_regclass('public.integrations') as table_name`).toEqual([
          { table_name: "integrations" },
        ]);

        await migrateDatabase(databaseUrl, through0006Folder);
        const [after] = await sql<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `;
        expect(after?.count).toBe(7);
        const [objects] = await sql<
          { im_bindings: string | null; integrations: string | null; new_enum: boolean; old_enum: boolean }[]
        >`
          select
            to_regclass('public.im_bindings')::text as im_bindings,
            to_regclass('public.integrations')::text as integrations,
            exists(select 1 from pg_type where typname = 'im_binding_status') as new_enum,
            exists(select 1 from pg_type where typname = 'integration_status') as old_enum
        `;
        expect(objects).toEqual({ im_bindings: "im_bindings", integrations: null, new_enum: true, old_enum: false });
        const columns = await sql<{ table_name: string; column_name: string; column_default: string | null }[]>`
          select table_name, column_name, column_default
          from information_schema.columns
          where (table_name in ('sessions', 'im_messages') and column_name in ('integration_id', 'im_binding_id'))
             or (table_name = 'agents' and column_name = 'receive_mode')
          order by table_name, column_name
        `;
        expect(columns).toEqual([
          { table_name: "agents", column_name: "receive_mode", column_default: "'mention_only'::agent_receive_mode" },
          { table_name: "im_messages", column_name: "im_binding_id", column_default: null },
          { table_name: "sessions", column_name: "im_binding_id", column_default: null },
        ]);
        const constraints = await sql<{ conname: string }[]>`
          select conname from pg_constraint
          where conname in (
            'agents_manager_membership_fk',
            'agents_manager_computer_owner_fk',
            'im_bindings_agent_id_agents_id_fk',
            'sessions_im_binding_id_im_bindings_id_fk'
          )
          order by conname
        `;
        expect(constraints.map(({ conname }) => conname)).toEqual([
          "agents_manager_computer_owner_fk",
          "agents_manager_membership_fk",
          "im_bindings_agent_id_agents_id_fk",
          "sessions_im_binding_id_im_bindings_id_fk",
        ]);
        const indexes = await sql<{ indexname: string }[]>`
          select indexname from pg_indexes
          where indexname in ('im_bindings_agent_current_unique', 'sessions_im_binding_scope_idx')
          order by indexname
        `;
        expect(indexes.map(({ indexname }) => indexname)).toEqual([
          "im_bindings_agent_current_unique",
          "sessions_im_binding_scope_idx",
        ]);

        const userId = crypto.randomUUID();
        const teamId = crypto.randomUUID();
        const controlTeamId = crypto.randomUUID();
        const computerId = crypto.randomUUID();
        const activeAgentId = "6eb89d85-0f12-4962-8465-518071f1d3e9";
        const deletedAgentId = crypto.randomUUID();
        await sql`insert into users (id, email, display_name) values (${userId}, 'migration@example.com', 'Migration')`;
        await sql`insert into teams (id, name, display_name) values (${teamId}, 'migration', 'Migration')`;
        await sql`
          insert into teams (id, name, display_name)
          values (${controlTeamId}, 'migration-control', 'Migration Control')
        `;
        await sql`insert into memberships (team_id, user_id, role) values (${teamId}, ${userId}, 'admin')`;
        await sql`
          insert into computers (id, owner_user_id, display_name, platform, arch, client_version)
          values (${computerId}, ${userId}, 'Migration Computer', 'linux', 'x64', '0.0.1')
        `;
        await sql`
          insert into agents (id, team_id, manager_user_id, computer_id, name, display_name, runtime_provider)
          values (${activeAgentId}, ${teamId}, ${userId}, ${computerId}, 'active-agent', 'Active Agent', 'codex')
        `;
        await sql`
          insert into agents (
            id, team_id, manager_user_id, computer_id, name, display_name, runtime_provider, deleted_at
          )
          values (
            ${deletedAgentId}, ${teamId}, ${userId}, ${computerId}, 'deleted-agent', 'Deleted Agent', 'codex', now()
          )
        `;

        await migrateDatabase(databaseUrl, migrationsFolder);
        const [lifecycle] = await sql<
          {
            count: number;
            creation_intents_null: boolean;
            deleted_at_exists: boolean;
            setup_completed_at_exists: boolean;
            status_default: string | null;
            statuses: string[];
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as count,
            not exists(
              select 1 from agents
              where creation_intent_id is not null or creation_intent_fingerprint is not null
            ) as creation_intents_null,
            exists(
              select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'deleted_at'
            ) as deleted_at_exists,
            exists(
              select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'teams' and column_name = 'setup_completed_at'
            ) as setup_completed_at_exists,
            (
              select column_default from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'status'
            ) as status_default,
            array(select status::text from agents order by name) as statuses
        `;
        expect(lifecycle).toEqual({
          count: 13,
          creation_intents_null: true,
          deleted_at_exists: false,
          setup_completed_at_exists: true,
          status_default: "'active'::agent_status",
          statuses: ["active", "deleted"],
        });
        const repairedTeams = await sql<{ completed: boolean; name: string }[]>`
          select name, setup_completed_at is not null as completed
          from teams
          order by name
        `;
        expect(repairedTeams).toEqual([
          { completed: true, name: "migration" },
          { completed: false, name: "migration-control" },
        ]);
        const [agentStatusEnum] = await sql<{ values: string[] }[]>`
          select array_agg(enumlabel order by enumsortorder)::text[] as values
          from pg_enum join pg_type on pg_type.oid = pg_enum.enumtypid
          where pg_type.typname = 'agent_status'
        `;
        expect(agentStatusEnum?.values).toEqual(["active", "suspended", "deleted"]);
        const [agentNameIndex] = await sql<{ indexdef: string }[]>`
          select indexdef from pg_indexes where indexname = 'agents_team_name_active_unique'
        `;
        expect(agentNameIndex?.indexdef).toContain("status <> 'deleted'::agent_status");
        const [creationIntentIndex] = await sql<{ indexdef: string }[]>`
          select indexdef from pg_indexes where indexname = 'agents_creation_intent_unique'
        `;
        expect(creationIntentIndex?.indexdef).toContain("UNIQUE INDEX");

        await migrateDatabase(databaseUrl, migrationsFolder);
        const [rerun] = await sql<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `;
        expect(rerun?.count).toBe(13);
      } finally {
        await sql.end();
      }
    } finally {
      await rm(legacyFolder, { recursive: true, force: true });
      await rm(through0006Folder, { recursive: true, force: true });
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

  it("issues user-scoped connect codes with the shared 15-minute, single-use invariants", async () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    const fixture = await createAuthFixture(now);
    try {
      const issuer = new ConnectCodeService(fixture.database, { now: () => now });
      const issued = await issuer.issueForUser(fixture.bootstrap.userId);
      expect(issued).toMatchObject({
        expiresAt: new Date("2026-08-18T00:15:00.000Z"),
        expiresIn: 900,
        issuedAt: now,
      });
      const [stored] = await fixture.database
        .select()
        .from(connectCodes)
        .where(eq(connectCodes.codeHash, hashSecret(issued.code)));
      expect(stored).toMatchObject({
        codeHash: hashSecret(issued.code),
        userId: fixture.bootstrap.userId,
        issuerUserId: fixture.bootstrap.userId,
        consumedAt: null,
      });
      expect(stored?.codeHash).not.toBe(issued.code);

      await expect(fixture.auth.exchangeConnectCode(issued.code)).resolves.toMatchObject({ tokenType: "Bearer" });
      await expect(fixture.auth.exchangeConnectCode(issued.code)).rejects.toMatchObject({ code: "AUTH_CODE_CONSUMED" });
    } finally {
      await fixture.sql.end();
    }
  });

  it("issues Web onboarding connect codes only to a live Team Admin", async () => {
    const fixture = await createAuthFixture();
    try {
      const [member] = await fixture.database
        .insert(users)
        .values({ email: "computer-member@example.com", displayName: "Computer Member" })
        .returning();
      if (!member) throw new Error("Member fixture was not created");
      await fixture.database.insert(memberships).values({
        teamId: fixture.bootstrap.teamId,
        userId: member.id,
        role: "member",
        status: "active",
      });
      const issuer = new ConnectCodeService(fixture.database);
      await expect(issuer.issueForTeamAdmin(member.id, fixture.bootstrap.teamId)).rejects.toMatchObject({
        code: "MEMBERSHIP_FORBIDDEN",
      });
      await expect(issuer.issueForTeamAdmin(fixture.bootstrap.userId, fixture.bootstrap.teamId)).resolves.toMatchObject(
        {
          expiresIn: 900,
        },
      );
      expect(
        (await fixture.database.select().from(connectCodes)).filter((row) => row.userId === member.id),
      ).toHaveLength(0);
    } finally {
      await fixture.sql.end();
    }
  });

  it("refuses to mint a connect code after the user loses every active membership", async () => {
    const fixture = await createAuthFixture();
    try {
      await fixture.database
        .update(memberships)
        .set({ status: "left", updatedAt: new Date() })
        .where(eq(memberships.userId, fixture.bootstrap.userId));
      const before = await fixture.database.select().from(connectCodes);
      await expect(
        new ConnectCodeService(fixture.database).issueForUser(fixture.bootstrap.userId),
      ).rejects.toMatchObject({
        code: "AUTH_MEMBERSHIP_REQUIRED",
      });
      expect(await fixture.database.select().from(connectCodes)).toHaveLength(before.length);
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

  it("does not consume a connect code when a bound home expects another user", async () => {
    const fixture = await createAuthFixture();
    try {
      await expect(
        fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode, crypto.randomUUID()),
      ).rejects.toMatchObject({
        code: "AUTH_USER_MISMATCH",
        statusCode: 409,
      });
      const [afterMismatch] = await fixture.database.select().from(connectCodes);
      expect(afterMismatch?.consumedAt).toBeNull();
      await expect(
        fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode, fixture.bootstrap.userId),
      ).resolves.toMatchObject({ tokenType: "Bearer" });
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
        .set({ status: "left", updatedAt: new Date("2026-08-18T00:01:00.000Z") })
        .where(eq(memberships.userId, fixture.bootstrap.userId));
      // Losing every membership drops Team authority but keeps the session, so the user can create a new Team.
      await expect(fixture.auth.getAuthenticatedUser(tokens.accessToken)).resolves.toMatchObject({
        me: { user: { id: fixture.bootstrap.userId }, memberships: [] },
      });
      await expect(fixture.auth.refresh(tokens.refreshToken)).resolves.toMatchObject({ tokenType: "Bearer" });

      await fixture.database
        .update(users)
        .set({ suspendedAt: new Date("2026-08-18T00:02:00.000Z") })
        .where(eq(users.id, fixture.bootstrap.userId));
      const error = await fixture.auth.getAuthenticatedUser(tokens.accessToken).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthServiceError);
      expect(error).toMatchObject({ code: "AUTH_USER_SUSPENDED" });
    } finally {
      await fixture.sql.end();
    }
  });
});
