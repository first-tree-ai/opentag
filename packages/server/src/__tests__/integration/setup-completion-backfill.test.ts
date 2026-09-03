import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "../../db/migrate.js";
import { AuthService } from "../../services/auth/index.js";
import { AccountSetupService } from "../../services/setup/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

const ACCOUNT_A = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT_B = "00000000-0000-4000-8000-0000000000a2";
const ACCOUNT_GRANT_ONLY = "00000000-0000-4000-8000-0000000000a3";
const ACCOUNT_EMPTY = "00000000-0000-4000-8000-0000000000a4";
const WORKSPACE_EARLY = "00000000-0000-4000-8000-0000000000b1";
const WORKSPACE_LATE = "00000000-0000-4000-8000-0000000000b2";
const WORKSPACE_GRANT = "00000000-0000-4000-8000-0000000000b3";
const ENROLLMENT_A = "00000000-0000-4000-8000-0000000000c1";
const ENROLLMENT_B = "00000000-0000-4000-8000-0000000000c2";
const INSTALLATION_A = "00000000-0000-4000-8000-0000000000d1";
const INSTALLATION_B = "00000000-0000-4000-8000-0000000000d2";
const AGENT_DELETED = "00000000-0000-4000-8000-0000000000e1";
const AGENT_ACTIVE = "00000000-0000-4000-8000-0000000000e2";
const AGENT_LATE = "00000000-0000-4000-8000-0000000000e3";

const EARLY = new Date("2026-08-01T00:00:00.000Z");
const LATE = new Date("2026-08-20T00:00:00.000Z");

const THROUGH_0028_IDX = 28;
const THROUGH_0028_COUNT = 29;
const THROUGH_0030_COUNT = 31;
const CURRENT_MIGRATION_COUNT = 38;

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

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

async function readJournal(): Promise<Journal> {
  return JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as Journal;
}

/** The current head, read from the ledger, so a later migration does not restate this suite's subject. */

async function truncatedMigrations(lastIndex: number): Promise<string> {
  const journal = await readJournal();
  const folder = await mkdtemp(join(tmpdir(), `opentag-${lastIndex}-migrations-`));
  await mkdir(join(folder, "meta"));
  const entries = journal.entries.filter(({ idx }) => idx <= lastIndex);
  for (const entry of entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  return folder;
}

async function journalCount(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`;
  return Number(row?.count ?? 0);
}

async function insertEnrollment(
  sql: postgres.Sql,
  input: { enrollmentId: string; installationId: string; workspaceId: string; ownerId: string },
): Promise<void> {
  const now = EARLY;
  await sql`insert into computers (id, created_at) values (${input.installationId}, ${now})`;
  await sql`
    insert into workspace_computers (
      id, workspace_id, computer_id, display_name, platform, arch, client_version,
      enrolled_by_user_id, enrolled_at, updated_at
    )
    values (
      ${input.enrollmentId}, ${input.workspaceId}, ${input.installationId}, 'box', 'linux', 'x64', '0.0.1',
      ${input.ownerId}, ${now}, ${now}
    )
  `;
  await sql`
    insert into account_computers (
      id, owner_account_id, current_installation_id, display_name, platform, arch, client_version,
      created_at, updated_at
    )
    values (
      ${input.enrollmentId}, ${input.ownerId}, ${input.installationId}, 'box', 'linux', 'x64', '0.0.1',
      ${now}, ${now}
    )
  `;
}

async function populateHistoricalEvidence(sql: postgres.Sql): Promise<void> {
  await sql`
    insert into users (id, email, display_name)
    values
      (${ACCOUNT_A}, 'a@example.com', 'A'),
      (${ACCOUNT_B}, 'b@example.com', 'B'),
      (${ACCOUNT_GRANT_ONLY}, 'grant@example.com', 'Grant Only'),
      (${ACCOUNT_EMPTY}, 'empty@example.com', 'Empty')
  `;
  await sql`
    insert into workspaces (id, name, display_name, setup_completed_at)
    values
      (${WORKSPACE_EARLY}, 'early', 'Early', ${EARLY}),
      (${WORKSPACE_LATE}, 'late', 'Late', ${LATE}),
      (${WORKSPACE_GRANT}, 'grant-only', 'Grant Only', ${LATE})
  `;
  await sql`
    insert into workspace_admin_grants (workspace_id, user_id, granted_by_user_id, granted_at)
    values
      (${WORKSPACE_GRANT}, ${ACCOUNT_GRANT_ONLY}, ${ACCOUNT_GRANT_ONLY}, ${LATE}),
      (${WORKSPACE_EARLY}, ${ACCOUNT_GRANT_ONLY}, ${ACCOUNT_A}, ${LATE})
  `;
  await insertEnrollment(sql, {
    enrollmentId: ENROLLMENT_A,
    installationId: INSTALLATION_A,
    workspaceId: WORKSPACE_EARLY,
    ownerId: ACCOUNT_A,
  });
  await insertEnrollment(sql, {
    enrollmentId: ENROLLMENT_B,
    installationId: INSTALLATION_B,
    workspaceId: WORKSPACE_LATE,
    ownerId: ACCOUNT_A,
  });
  await sql`
    insert into agents (
      id, workspace_id, created_by_user_id, workspace_computer_id, computer_id,
      name, display_name, runtime_provider, status
    )
    values
      (
        ${AGENT_DELETED}, ${WORKSPACE_EARLY}, ${ACCOUNT_A}, ${ENROLLMENT_A}, ${ENROLLMENT_A},
        'deleted-assistant', 'Deleted', 'codex', 'deleted'
      ),
      (
        ${AGENT_ACTIVE}, ${WORKSPACE_LATE}, ${ACCOUNT_A}, ${ENROLLMENT_B}, ${ENROLLMENT_B},
        'active-assistant', 'Active', 'codex', 'active'
      ),
      (
        ${AGENT_LATE}, ${WORKSPACE_LATE}, ${ACCOUNT_B}, ${ENROLLMENT_B}, ${ENROLLMENT_B},
        'b-assistant', 'B', 'codex', 'active'
      )
  `;
}

async function accountSetup(sql: postgres.Sql): Promise<Record<string, string | null>> {
  const rows = await sql<{ id: string; setup_completed_at: Date | null }[]>`
    select id::text, setup_completed_at
    from users
    order by id
  `;
  return Object.fromEntries(rows.map((row) => [row.id, row.setup_completed_at?.toISOString() ?? null]));
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("message" in current && typeof current.message === "string") messages.push(current.message);
    current = "cause" in current ? current.cause : undefined;
  }
  return messages.join("\n");
}

describe("Account setup completion backfill", () => {
  it("journals 0029 and 0030 after 0028 and migrates an empty database", async () => {
    const journal = await readJournal();
    const through0030 = journal.entries.filter(({ idx }) => idx <= 30);
    expect(journal.entries).toHaveLength(CURRENT_MIGRATION_COUNT);
    expect(through0030).toHaveLength(THROUGH_0030_COUNT);
    expect(through0030.at(-3)?.tag).toBe("0028_overjoyed_speedball");
    expect(through0030.at(-2)?.tag).toBe("0029_tiresome_bedlam");
    expect(through0030.at(-1)?.tag).toBe("0030_low_ulik");

    await migrateDatabase(databaseUrl, migrationsFolder);
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      expect(await journalCount(sql)).toBe(CURRENT_MIGRATION_COUNT);
      const [column] = await sql<{ data_type: string; is_nullable: string }[]>`
        select data_type, is_nullable
        from information_schema.columns
        where table_schema = 'public' and table_name = 'users' and column_name = 'setup_completed_at'
      `;
      expect(column).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES" });
      await verifyDatabaseMigrations(databaseUrl, migrationsFolder);
    } finally {
      await sql.end();
    }
  });

  it("backfills from the earliest creator-Agent Workspace timestamp and ignores grants", async () => {
    const through0028 = await truncatedMigrations(THROUGH_0028_IDX);
    try {
      await migrateDatabase(databaseUrl, through0028);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        expect(await journalCount(sql)).toBe(THROUGH_0028_COUNT);
        await populateHistoricalEvidence(sql);
        const [missing] = await sql<{ present: number }[]>`
          select count(*)::int as present
          from information_schema.columns
          where table_schema = 'public' and table_name = 'users' and column_name = 'setup_completed_at'
        `;
        expect(missing?.present).toBe(0);
      } finally {
        await sql.end();
      }

      await migrateDatabase(databaseUrl, migrationsFolder);
      const after = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        expect(await journalCount(after)).toBe(CURRENT_MIGRATION_COUNT);
        expect(await accountSetup(after)).toEqual({
          [ACCOUNT_A]: EARLY.toISOString(),
          [ACCOUNT_B]: LATE.toISOString(),
          [ACCOUNT_GRANT_ONLY]: null,
          [ACCOUNT_EMPTY]: null,
        });
        await verifyDatabaseMigrations(databaseUrl, migrationsFolder);
      } finally {
        await after.end();
      }
    } finally {
      await rm(through0028, { recursive: true, force: true });
    }
  });

  it("is retry-safe and leaves already-populated Account rows unchanged", async () => {
    const through0028 = await truncatedMigrations(THROUGH_0028_IDX);
    try {
      await migrateDatabase(databaseUrl, through0028);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateHistoricalEvidence(sql);
      } finally {
        await sql.end();
      }
      await migrateDatabase(databaseUrl, migrationsFolder);
      await migrateDatabase(databaseUrl, migrationsFolder);
      const after = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        expect(await journalCount(after)).toBe(CURRENT_MIGRATION_COUNT);
        expect(await accountSetup(after)).toEqual({
          [ACCOUNT_A]: EARLY.toISOString(),
          [ACCOUNT_B]: LATE.toISOString(),
          [ACCOUNT_GRANT_ONLY]: null,
          [ACCOUNT_EMPTY]: null,
        });
      } finally {
        await after.end();
      }
    } finally {
      await rm(through0028, { recursive: true, force: true });
    }
  });

  it("rolls a failed 0029 back completely and succeeds on retry after the obstruction is removed", async () => {
    const through0028 = await truncatedMigrations(THROUGH_0028_IDX);
    try {
      await migrateDatabase(databaseUrl, through0028);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateHistoricalEvidence(sql);
        await sql.unsafe(`
          create function reject_setup_backfill() returns trigger language plpgsql as $$
          begin
            raise exception 'fixture rejects setup backfill';
          end
          $$
        `);
        await sql.unsafe(`
          create trigger reject_setup_backfill before update on users
          for each row execute function reject_setup_backfill()
        `);
      } finally {
        await sql.end();
      }

      const failure = await migrateDatabase(databaseUrl, migrationsFolder).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(errorChain(failure)).toContain("fixture rejects setup backfill");
      const failed = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        expect(await journalCount(failed)).toBe(THROUGH_0028_COUNT);
        const [column] = await failed<{ present: number }[]>`
          select count(*)::int as present
          from information_schema.columns
          where table_schema = 'public' and table_name = 'users' and column_name = 'setup_completed_at'
        `;
        expect(column?.present).toBe(0);
        await failed.unsafe("drop trigger reject_setup_backfill on users");
        await failed.unsafe("drop function reject_setup_backfill()");
      } finally {
        await failed.end();
      }

      await migrateDatabase(databaseUrl, migrationsFolder);
      const retried = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        expect(await journalCount(retried)).toBe(CURRENT_MIGRATION_COUNT);
        expect(await accountSetup(retried)).toMatchObject({
          [ACCOUNT_A]: EARLY.toISOString(),
          [ACCOUNT_B]: LATE.toISOString(),
        });
        await verifyDatabaseMigrations(databaseUrl, migrationsFolder);
      } finally {
        await retried.end();
      }
    } finally {
      await rm(through0028, { recursive: true, force: true });
    }
  });

  it("reads and writes Account setup through the application after the production runner", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql`
        insert into users (id, email, display_name)
        values
          (${ACCOUNT_A}, 'a@example.com', 'A'),
          (${ACCOUNT_B}, 'b@example.com', 'B'),
          (${ACCOUNT_GRANT_ONLY}, 'grant@example.com', 'Grant Only'),
          (${ACCOUNT_EMPTY}, 'empty@example.com', 'Empty')
      `;
      await sql`
        insert into computers (id, owner_account_id, current_installation_id, display_name, platform, arch, client_version)
        values (${ENROLLMENT_B}, ${ACCOUNT_B}, ${INSTALLATION_B}, 'box', 'linux', 'x64', '0.0.1')
      `;
      await sql`
        insert into agents (id, created_by_user_id, computer_id, name, display_name, runtime_provider, status)
        values (${AGENT_LATE}, ${ACCOUNT_B}, ${ENROLLMENT_B}, 'b-assistant', 'B', 'codex', 'active')
      `;
      await sql`
        update users set setup_completed_at = ${EARLY} where id = ${ACCOUNT_A}
      `;
    } finally {
      await sql.end();
    }

    const client = createDatabaseClient(databaseUrl);
    try {
      const auth = new AuthService(client.database, {
        issuePairForUser: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 1 }),
        rotate: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 1 }),
        verifyAccess: async () => ({ userId: ACCOUNT_A, expiresAt: new Date() }),
        verifyRefresh: async () => ({ userId: ACCOUNT_A }),
      } as never);
      await expect(auth.getActiveUserById(ACCOUNT_A)).resolves.toMatchObject({
        setupCompletedAt: EARLY.toISOString(),
      });
      await expect(auth.getActiveUserById(ACCOUNT_GRANT_ONLY)).resolves.toMatchObject({ setupCompletedAt: null });
      await expect(auth.getActiveUserById(ACCOUNT_EMPTY)).resolves.toMatchObject({ setupCompletedAt: null });

      const setup = new AccountSetupService(client.database, { now: () => LATE });
      await expect(setup.completeForAccount(ACCOUNT_B, AGENT_LATE)).resolves.toEqual({
        setupCompletedAt: LATE.toISOString(),
      });
      await expect(auth.getActiveUserById(ACCOUNT_B)).resolves.toMatchObject({
        setupCompletedAt: LATE.toISOString(),
      });
    } finally {
      await client.sql.end();
    }
  });
});
