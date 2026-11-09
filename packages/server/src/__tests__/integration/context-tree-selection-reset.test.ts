import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import { AgentService } from "../../services/agents/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());

it("clears selections once, advances affected revisions, and preserves other configuration", async () => {
  const { database, sql } = createDatabaseClient(testDatabase.databaseUrl);
  try {
    const { userId } = await bootstrapInitialAdmin(database, { displayName: "Admin", email: "admin@example.com" });
    const service = new AgentService(database);
    const selected = await service.createForAccount(userId, {
      name: "selected",
      displayName: "Selected",
      runtimeProvider: "codex",
    });
    const empty = await service.createForAccount(userId, {
      name: "empty",
      displayName: "Empty",
      runtimeProvider: "codex",
    });
    await sql`update agent_runtime_configs set context_trees = '[{"alias":"memory","repository":"acme/memory"}]'::jsonb,
      instructions = 'Keep this instruction' where agent_id = ${selected.id}`;
    const before = await sql`select * from agent_runtime_configs order by agent_id`;
    await sql.unsafe(await readFile(join(migrationsFolder, "0067_reset_context_tree_selections.sql"), "utf8"));
    const after = await sql`select * from agent_runtime_configs order by agent_id`;
    for (const original of before) {
      const updated = after.find((row) => row.agent_id === original.agent_id);
      if (original.agent_id === selected.id) {
        expect(updated).toEqual({
          ...original,
          context_trees: [],
          revision: expect.any(String),
          updated_at: expect.any(String),
        });
        expect(Number(updated?.revision)).toBeGreaterThan(Number(original.revision));
      } else {
        expect(updated).toEqual(original);
      }
    }
    const selectedConfig = await service.getConfigById(userId, selected.id);
    expect(selectedConfig.revision).toBe(selected.revision + 1);
    expect((await service.getConfigById(userId, empty.id)).revision).toBe(empty.revision);

    const reconnected = await service.updateContextTreeSelection(
      userId,
      selected.id,
      {
        ...selectedConfig,
        runtimeConfigRevision: selectedConfig.runtimeConfig.revision,
      },
      [{ kind: "git", repository: "acme/memory", path: ".", ref: "main" }],
    );
    await migrateDatabase(testDatabase.databaseUrl, migrationsFolder);
    expect(await service.getConfigById(userId, selected.id)).toEqual(reconnected);
  } finally {
    await sql.end();
  }
});

it("changes a nonempty selection while the Agent keeps running", async () => {
  const { database, sql } = createDatabaseClient(testDatabase.databaseUrl);
  try {
    const [existing] = await sql<{ id: string }[]>`select id from users order by created_at limit 1`;
    const userId =
      existing?.id ??
      (await bootstrapInitialAdmin(database, { displayName: "Admin", email: "admin@example.com" })).userId;
    const service = new AgentService(database);
    const agent = await service.createForAccount(userId, {
      name: "running",
      displayName: "Running",
      runtimeProvider: "codex",
    });
    const first = { kind: "git" as const, repository: "acme/memory", path: ".", ref: "main" };
    const second = { kind: "git" as const, repository: "acme/notes", path: "docs", ref: "main" };
    const save = async (connections: (typeof first)[]) => {
      const current = await service.getConfigById(userId, agent.id);
      expect(current.status).toBe("active");
      return service.updateContextTreeSelection(
        userId,
        agent.id,
        { ...current, runtimeConfigRevision: current.runtimeConfig.revision },
        connections,
      );
    };
    expect((await save([first])).runtimeConfig.contextTrees).toEqual([first]);
    const added = await save([first, second]);
    expect(added.status).toBe("active");
    expect(added.runtimeConfig.contextTrees).toEqual([first, second]);
    expect((await save([second])).runtimeConfig.contextTrees).toEqual([second]);
  } finally {
    await sql.end();
  }
});
