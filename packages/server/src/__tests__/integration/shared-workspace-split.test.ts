import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../db/migrate.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const splitScript = fileURLToPath(new URL("../../../../../scripts/split-shared-workspaces.sql", import.meta.url));

let container: StartedPostgreSqlContainer;
let created = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
}, 120_000);

afterAll(async () => container.stop());

/** A database of its own per case, so one case's legacy fixture cannot reach another's. */
async function freshDatabaseUrl(): Promise<string> {
  created += 1;
  const name = `case_${created}`;
  const admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  return url.toString();
}

/** Every message in an error's `cause` chain, because Drizzle reports the failing SQL and wraps the driver's. */
function messageChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("message" in current && typeof current.message === "string") messages.push(current.message);
    current = "cause" in current ? current.cause : undefined;
  }
  return messages.join("\n");
}

/** A migrations folder holding every entry up to and including `idx`, so a pre-0024 database can be built. */
async function migrationsThrough(idx: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `opentag-through-${idx}-`));
  await mkdir(join(folder, "meta"));
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= idx);
  for (const entry of entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  return folder;
}

/**
 * `scripts/split-shared-workspaces.sql` runs once against a deployed database, and what it touches is the
 * only copy of it. It is covered here rather than reviewed by eye: the legacy shape 0016 left behind is
 * rebuilt, the script runs, and then 0024 has to be able to create the indexes the script exists to make
 * possible. The seeded shape is the one #167 measured on staging, including the Computer carrying Agents
 * that belong to two different Accounts.
 */
describe("shared Workspace split", () => {
  it("gives every Admin their own Workspace without losing an Agent, and lets 0024 apply", async () => {
    const databaseUrl = await freshDatabaseUrl();
    await migrateDatabase(databaseUrl, await migrationsThrough(23));
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      const admins = ["alice", "bob", "carol", "dave", "erin"].map((name, index) => ({
        name,
        id: crypto.randomUUID(),
        grantedAt: new Date(Date.UTC(2026, 0, index + 1)),
      }));
      const sharedWorkspaceId = crypto.randomUUID();
      await sql`
        insert into workspaces (id, name, display_name, setup_completed_at)
        values (${sharedWorkspaceId}, 'shared', 'Shared', now())
      `;
      for (const admin of admins) {
        await sql`
          insert into users (id, email, display_name)
          values (${admin.id}, ${`${admin.name}@example.com`}, ${admin.name})
        `;
        await sql`
          insert into workspace_admin_grants (workspace_id, user_id, granted_by_user_id, granted_at)
          values (${sharedWorkspaceId}, ${admin.id}, ${admin.id}, ${admin.grantedAt})
        `;
      }

      const enrollmentByAdmin = new Map<string, string>();
      for (const admin of admins) {
        const computerId = crypto.randomUUID();
        const enrollmentId = crypto.randomUUID();
        await sql`insert into computers (id) values (${computerId})`;
        await sql`
          insert into workspace_computers (
            id, workspace_id, computer_id, display_name, platform, arch, client_version, enrolled_by_user_id
          )
          values (
            ${enrollmentId}, ${sharedWorkspaceId}, ${computerId}, ${`box-${admin.name}`},
            'linux', 'x64', '0.0.1', ${admin.id}
          )
        `;
        enrollmentByAdmin.set(admin.name, enrollmentId);
        await sql`
          insert into agents (workspace_id, created_by_user_id, workspace_computer_id, name, display_name, runtime_provider)
          values (
            ${sharedWorkspaceId}, ${admin.id}, ${enrollmentId},
            ${`agent-${admin.name}`}, ${`Agent ${admin.name}`}, 'codex'
          )
        `;
      }

      // The shared-machine shape: erin's second Agent runs on the Computer alice enrolled.
      const aliceEnrollment = enrollmentByAdmin.get("alice");
      const erin = admins.at(-1);
      if (!aliceEnrollment || !erin) throw new Error("Fixture was not seeded");
      await sql`
        insert into agents (workspace_id, created_by_user_id, workspace_computer_id, name, display_name, runtime_provider)
        values (${sharedWorkspaceId}, ${erin.id}, ${aliceEnrollment}, 'devbox-agent', 'Devbox Agent', 'codex')
      `;

      // A deleted Agent still holds the composite foreign key, so it has to travel with its enrollment.
      const bob = admins[1];
      const bobEnrollment = enrollmentByAdmin.get("bob");
      if (!bob || !bobEnrollment) throw new Error("Fixture was not seeded");
      await sql`
        insert into agents (
          workspace_id, created_by_user_id, workspace_computer_id, name, display_name, runtime_provider, status
        )
        values (
          ${sharedWorkspaceId}, ${bob.id}, ${bobEnrollment}, 'retired-agent', 'Retired Agent', 'codex', 'deleted'
        )
      `;

      // The other legacy direction: alice also holds a second, empty Workspace, which 0024 resolves itself.
      const alice = admins[0];
      if (!alice) throw new Error("Fixture was not seeded");
      const emptyWorkspaceId = crypto.randomUUID();
      await sql`insert into workspaces (id, name, display_name) values (${emptyWorkspaceId}, 'empty', 'Empty')`;
      await sql`
        insert into workspace_admin_grants (workspace_id, user_id, granted_by_user_id, granted_at)
        values (${emptyWorkspaceId}, ${alice.id}, ${alice.id}, ${new Date(Date.UTC(2026, 5, 1))})
      `;

      await sql.unsafe(await readFile(splitScript, "utf8"));
      await migrateDatabase(databaseUrl, migrationsFolder);

      const scopes = await sql<{ email: string; workspaceId: string; agents: number; setupCompleted: boolean }[]>`
        select
          u.email,
          g.workspace_id as "workspaceId",
          (select count(*)::int from agents a
            where a.workspace_id = g.workspace_id and a.status <> 'deleted') as agents,
          (w.setup_completed_at is not null) as "setupCompleted"
        from workspace_admin_grants g
        inner join users u on u.id = g.user_id
        inner join workspaces w on w.id = g.workspace_id
        where g.revoked_at is null
        order by u.email
      `;

      // One scope per Admin, each holding only their own Agents, and none of them sent back to onboarding.
      expect(scopes).toHaveLength(5);
      expect(scopes.map(({ email }) => email)).toEqual([
        "alice@example.com",
        "bob@example.com",
        "carol@example.com",
        "dave@example.com",
        "erin@example.com",
      ]);
      expect(scopes.every(({ setupCompleted }) => setupCompleted)).toBe(true);
      expect(scopes.map(({ agents }) => agents)).toEqual([1, 1, 1, 1, 2]);
      expect(new Set(scopes.map(({ workspaceId }) => workspaceId)).size).toBe(5);

      // Alice held the earliest grant, so she keeps the original Workspace and her scope does not move.
      expect(scopes[0]?.workspaceId).toBe(sharedWorkspaceId);

      const [preserved] = await sql<{ count: number }[]>`
        select count(*)::int as count from agents where status <> 'deleted'
      `;
      expect(preserved?.count).toBe(6);

      // The deleted Agent moved with bob rather than being stranded in the Workspace alice kept.
      const [retired] = await sql<{ workspaceId: string; createdByUserId: string }[]>`
        select workspace_id as "workspaceId", created_by_user_id as "createdByUserId"
        from agents where name = 'retired-agent'
      `;
      expect(retired?.createdByUserId).toBe(bob.id);
      expect(retired?.workspaceId).toBe(scopes.find(({ email }) => email === "bob@example.com")?.workspaceId);

      // Every Agent now runs on an enrollment in its own Workspace, owned by its own Account. Erin's
      // devbox Agent reached that through a second enrollment of alice's physical Computer.
      const [misplaced] = await sql<{ count: number }[]>`
        select count(*)::int as count
        from agents a
        inner join workspace_computers wc on wc.id = a.workspace_computer_id
        where a.status <> 'deleted'
          and (wc.workspace_id <> a.workspace_id or wc.enrolled_by_user_id <> a.created_by_user_id)
      `;
      expect(misplaced?.count).toBe(0);

      const sharedComputer = await sql<{ enrollments: number }[]>`
        select count(*)::int as enrollments
        from workspace_computers
        where computer_id = (select computer_id from workspace_computers where id = ${aliceEnrollment})
          and revoked_at is null
      `;
      expect(sharedComputer[0]?.enrollments).toBe(2);

      // The indexes 0024 creates are in place, so the shape cannot come back.
      const indexes = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes
        where indexname in (
          'workspace_admin_grants_active_user_unique',
          'workspace_admin_grants_active_workspace_unique'
        )
        order by indexname
      `;
      expect(indexes.map(({ indexname }) => indexname)).toEqual([
        "workspace_admin_grants_active_user_unique",
        "workspace_admin_grants_active_workspace_unique",
      ]);
    } finally {
      await sql.end();
    }
  }, 180_000);

  /**
   * The deployment runs migrations at boot under OPENTAG_AUTO_MIGRATE, so rolling this out before the
   * split above has run is a real possibility. What has to hold then is that 0024 refuses whole: it
   * names the contested Workspace, leaves the data exactly as it found it, records nothing in the
   * migration journal, and applies cleanly once the split has been run. The deployment fails closed and
   * recovers by rolling forward, without a restore.
   */
  it("refuses a shared Workspace whole, and applies once the split has run", async () => {
    const databaseUrl = await freshDatabaseUrl();
    await migrateDatabase(databaseUrl, await migrationsThrough(23));
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
      const sharedWorkspaceId = crypto.randomUUID();
      const emptyWorkspaceId = crypto.randomUUID();
      await sql`insert into workspaces (id, name, display_name) values (${sharedWorkspaceId}, 'shared', 'Shared')`;
      await sql`insert into workspaces (id, name, display_name) values (${emptyWorkspaceId}, 'empty', 'Empty')`;
      for (const [index, id] of [first, second].entries()) {
        await sql`
          insert into users (id, email, display_name)
          values (${id}, ${`admin-${index}@example.com`}, ${`Admin ${index}`})
        `;
        await sql`
          insert into workspace_admin_grants (workspace_id, user_id, granted_by_user_id, granted_at)
          values (${sharedWorkspaceId}, ${id}, ${id}, ${new Date(Date.UTC(2026, 0, index + 1))})
        `;
      }
      // The same Account also holds the redundant empty Workspace that 0024 resolves on its own, so the
      // rollback below has something to undo if the migration were not atomic.
      await sql`
        insert into workspace_admin_grants (workspace_id, user_id, granted_by_user_id, granted_at)
        values (${emptyWorkspaceId}, ${first}, ${first}, ${new Date(Date.UTC(2026, 5, 1))})
      `;

      const failure = await migrateDatabase(databaseUrl, migrationsFolder).then(
        () => undefined,
        (error: unknown) => error,
      );
      /**
       * Asserted on the formatted id and admin count, which the guard can only produce by evaluating the
       * data. Drizzle's wrapper puts the failing SQL in its own message and the raised one in `cause`, so
       * matching the exception text alone would pass against the echoed source of the guard itself.
       */
      expect(messageChain(failure)).toContain(`${sharedWorkspaceId} (2 admins)`);

      // Nothing was half-applied: the redundant grant the first statement would have revoked is still
      // active, neither index exists, and the journal did not record 0024.
      const [stillActive] = await sql<{ count: number }[]>`
        select count(*)::int as count from workspace_admin_grants where revoked_at is null
      `;
      expect(stillActive?.count).toBe(3);
      const indexes = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes where indexname like 'workspace_admin_grants_active_%unique'
      `;
      expect(indexes.map(({ indexname }) => indexname)).toEqual([
        "workspace_admin_grants_active_workspace_user_unique",
      ]);
      const [applied] = await sql<{ count: number }[]>`
        select count(*)::int as count from drizzle.__drizzle_migrations
      `;
      expect(applied?.count).toBe(24);

      // Roll forward: run the split the migration asked for, and the same deploy succeeds.
      await sql.unsafe(await readFile(splitScript, "utf8"));
      await migrateDatabase(databaseUrl, migrationsFolder);
      const [afterwards] = await sql<{ count: number }[]>`
        select count(*)::int as count from drizzle.__drizzle_migrations
      `;
      expect(afterwards?.count).toBe(25);
    } finally {
      await sql.end();
    }
  }, 180_000);
});
