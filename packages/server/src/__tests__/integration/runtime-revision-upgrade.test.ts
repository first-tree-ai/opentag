import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "../../db/migrate.js";
import { AgentService } from "../../services/agents/index.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const migrationTag = "0066_self_configuration_runtime_revision";
let container: Awaited<ReturnType<typeof startPostgresTestContainer>>;
let client: ReturnType<typeof createDatabaseClient>;
let legacyFolder: string;

beforeAll(async () => {
  container = await startPostgresTestContainer();
  legacyFolder = await mkdtemp(join(tmpdir(), "opentag-runtime-revision-upgrade-"));
  await mkdir(join(legacyFolder, "meta"));
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === migrationTag);
  if (index < 0) throw new Error("Runtime revision repair migration is missing");
  const entries = journal.entries.slice(0, index);
  for (const entry of entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
  }
  await writeFile(join(legacyFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  await migrateDatabase(container.getConnectionUri(), legacyFolder);
  client = createDatabaseClient(container.getConnectionUri());
}, 120_000);

afterAll(async () => {
  await client?.sql.end();
  await container?.stop();
  if (legacyFolder) await rm(legacyFolder, { recursive: true, force: true });
});

describe("Runtime revision repair upgrade against PostgreSQL", () => {
  it("repairs existing opt-in states atomically and only once through the migration ledger", async () => {
    const { sql, database } = client;
    const account = await bootstrapInitialAdmin(database, { displayName: "Admin", email: "upgrade@example.invalid" });
    const service = new AgentService(database);
    for (const name of ["enabled", "disabled", "unchanged"]) {
      const agent = await service.createForAccount(account.userId, {
        name,
        displayName: name,
        runtimeProvider: "codex",
      });
      if (name !== "unchanged") {
        await sql`update agents set self_configuration_enabled = ${name === "enabled"}, revision = revision + 1 where id = ${agent.id}`;
      }
    }
    const previousConfigs = await sql`select * from agent_runtime_configs order by agent_id`;
    const previousAgents = await sql`select * from agents order by id`;
    const migration = await readFile(join(migrationsFolder, `${migrationTag}.sql`), "utf8");
    await expect(
      sql.begin(async (transaction) => {
        await transaction.unsafe(migration);
        throw new Error("interrupted runtime revision migration");
      }),
    ).rejects.toThrow("interrupted runtime revision migration");
    expect(await sql`select * from agent_runtime_configs order by agent_id`).toEqual(previousConfigs);

    await migrateDatabase(container.getConnectionUri(), migrationsFolder);
    const repairedConfigs = await sql`select * from agent_runtime_configs order by agent_id`;
    expect(repairedConfigs).toHaveLength(previousConfigs.length);
    for (const [index, repaired] of repairedConfigs.entries()) {
      const previous = previousConfigs[index];
      expect(Number(repaired.revision)).toBeGreaterThan(Number(previous?.revision));
      expect({ ...repaired, revision: previous?.revision }).toEqual(previous);
    }
    expect(await sql`select * from agents order by id`).toEqual(previousAgents);
    await verifyDatabaseMigrations(container.getConnectionUri(), migrationsFolder);
    await migrateDatabase(container.getConnectionUri(), migrationsFolder);
    expect(await sql`select * from agent_runtime_configs order by agent_id`).toEqual(repairedConfigs);
    const agent = await service.getConfigById(account.userId, previousAgents[0]?.id);
    const next = await service.updateById(account.userId, agent.id, {
      expectedRevision: agent.revision,
      selfConfigurationEnabled: !agent.selfConfigurationEnabled,
    });
    expect(next.runtimeConfig.revision).toBeGreaterThan(agent.runtimeConfig.revision);
  });
});
