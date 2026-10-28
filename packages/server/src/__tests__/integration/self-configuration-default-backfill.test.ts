import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "../../db/migrate.js";
import { agentRuntimeConfigs, agents, users } from "../../db/schema/index.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";

/**
 * `0072_self_configuration_default_enabled` turns self-configuration on for every non-deleted Agent and
 * makes it the column default. It must take the same revisions an owner toggle takes, so the runtime
 * assembles a new snapshot, and it must not touch deleted Agents or Agents that are already on.
 */
const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const THROUGH_0071_IDX = 71;
const CURRENT_MIGRATION_COUNT = 73;
const EARLY = new Date("2026-08-01T00:00:00.000Z");
const ACCOUNT = "00000000-0000-4000-8000-000000000501";

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

let container: StartedPostgreSqlContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await startPostgresTestContainer();
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

async function truncatedMigrations(lastIndex: number): Promise<string> {
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as Journal;
  const folder = await mkdtemp(join(tmpdir(), `opentag-${lastIndex}-migrations-`));
  await mkdir(join(folder, "meta"));
  const entries = journal.entries.filter(({ idx }) => idx <= lastIndex);
  for (const entry of entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  return folder;
}

describe("self-configuration default backfill", () => {
  it("enables non-deleted Agents with fresh revisions and defaults new Agents to enabled", async () => {
    const throughPrevious = await truncatedMigrations(THROUGH_0071_IDX);
    const client = createDatabaseClient(databaseUrl);
    const fixtures = {
      active: { id: "00000000-0000-4000-8000-000000000601", status: "active", enabled: false },
      suspended: { id: "00000000-0000-4000-8000-000000000602", status: "suspended", enabled: false },
      deleted: { id: "00000000-0000-4000-8000-000000000603", status: "deleted", enabled: false },
      alreadyOn: { id: "00000000-0000-4000-8000-000000000604", status: "active", enabled: true },
    } as const;
    try {
      await migrateDatabase(databaseUrl, throughPrevious);
      await client.database.insert(users).values({ id: ACCOUNT, email: "self@example.com", displayName: "Self" });
      await client.database.insert(agents).values(
        Object.entries(fixtures).map(([name, fixture]) => ({
          id: fixture.id,
          createdByUserId: ACCOUNT,
          name: `agent-${name.toLowerCase()}`,
          displayName: `Agent ${name}`,
          runtimeProvider: "codex" as const,
          status: fixture.status,
          selfConfigurationEnabled: fixture.enabled,
          revision: 3,
          updatedAt: EARLY,
        })),
      );
      await client.database
        .insert(agentRuntimeConfigs)
        .values(
          Object.values(fixtures).map((fixture) => ({ agentId: fixture.id, instructions: "", updatedAt: EARLY })),
        );
      const before = new Map(
        (await client.database.select().from(agentRuntimeConfigs)).map((row) => [row.agentId, row.revision]),
      );

      await migrateDatabase(databaseUrl, migrationsFolder);

      const agentRows = new Map((await client.database.select().from(agents)).map((row) => [row.id, row]));
      const configRows = new Map(
        (await client.database.select().from(agentRuntimeConfigs)).map((row) => [row.agentId, row]),
      );
      const maxBefore = Math.max(...before.values());
      for (const flipped of [fixtures.active, fixtures.suspended]) {
        expect(agentRows.get(flipped.id)).toMatchObject({ selfConfigurationEnabled: true, revision: 4 });
        expect(agentRows.get(flipped.id)?.updatedAt.getTime()).toBeGreaterThan(EARLY.getTime());
        expect(configRows.get(flipped.id)?.revision).toBeGreaterThan(maxBefore);
        expect(configRows.get(flipped.id)?.updatedAt.getTime()).toBeGreaterThan(EARLY.getTime());
      }
      for (const untouched of [fixtures.deleted, fixtures.alreadyOn]) {
        expect(agentRows.get(untouched.id)).toMatchObject({
          selfConfigurationEnabled: untouched.enabled,
          revision: 3,
          updatedAt: EARLY,
        });
        expect(configRows.get(untouched.id)).toMatchObject({ revision: before.get(untouched.id), updatedAt: EARLY });
      }

      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const [created] = await sql<{ self_configuration_enabled: boolean }[]>`
          insert into agents (created_by_user_id, name, display_name, runtime_provider)
          values (${ACCOUNT}, 'agent-new', 'Agent new', 'codex')
          returning self_configuration_enabled
        `;
        expect(created?.self_configuration_enabled).toBe(true);
        const [journal] = await sql<
          { count: string }[]
        >`select count(*)::text as count from drizzle.__drizzle_migrations`;
        expect(Number(journal?.count)).toBe(CURRENT_MIGRATION_COUNT);
      } finally {
        await sql.end();
      }
      await verifyDatabaseMigrations(databaseUrl, migrationsFolder);
    } finally {
      await client.sql.end();
      await rm(throughPrevious, { recursive: true, force: true });
    }
  });
});
