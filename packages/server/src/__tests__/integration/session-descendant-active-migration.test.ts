/**
 * `0069_session_descendant_active` derives the closure's activity flag from the Sessions it describes.
 *
 * A backfill that ran in the wrong order, or that silently skipped rows an earlier binary ended, would ship
 * partial indexes whose contents disagree with `sessions.ended_at` — and a page served from them would show
 * an ended internal Session. This suite applies the migration history up to the release before the change,
 * writes the historical shapes, then applies the new migration and inspects the result.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import { sessionDescendants, sessions } from "../../db/schema/index.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACTIVE_SESSION_ID = "00000000-0000-4000-8000-0000000000b1";
const ENDED_SESSION_ID = "00000000-0000-4000-8000-0000000000b2";
const ENDED_GRANDCHILD_ID = "00000000-0000-4000-8000-0000000000b3";
const ROOT_SESSION_ID = "00000000-0000-4000-8000-0000000000b0";
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000a1";
const COMPUTER_ID = "00000000-0000-4000-8000-0000000000c1";
const AGENT_ID = "00000000-0000-4000-8000-0000000000d1";
const BINDING_ID = "00000000-0000-4000-8000-0000000000e1";
const MESSAGE_ID = "00000000-0000-4000-8000-0000000000f1";
const NOW = new Date("2026-08-24T00:00:00.000Z");
/** The journal index of the last migration before `0069_session_descendant_active`. */
const PREVIOUS_HEAD_IDX = 68;

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

function readJournal(): Promise<Journal> {
  return readFile(join(migrationsFolder, "meta/_journal.json"), "utf8").then((raw) => JSON.parse(raw) as Journal);
}

/** A migrations folder holding the history up to `lastIndex`, so the new migration is the only pending one. */
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

async function insertHistoricalSessions(): Promise<void> {
  const client = createDatabaseClient(databaseUrl);
  try {
    const database = client.database;
    await database.execute(
      `insert into users (id, email, display_name) values ('${ACCOUNT_ID}', 'a@example.com', 'A')`,
    );
    await database.execute(`
      insert into computers (id, owner_account_id, current_installation_id, display_name, platform, arch, client_version, created_at, updated_at)
      values ('${COMPUTER_ID}', '${ACCOUNT_ID}', '00000000-0000-4000-8000-0000000000c2', 'box', 'linux', 'x64', '1',
        '${NOW.toISOString()}', '${NOW.toISOString()}')
    `);
    await database.execute(`
      insert into agents (id, created_by_user_id, computer_id, name, display_name, runtime_provider, created_at, updated_at)
      values ('${AGENT_ID}', '${ACCOUNT_ID}', '${COMPUTER_ID}', 'assistant', 'Assistant', 'codex',
        '${NOW.toISOString()}', '${NOW.toISOString()}')
    `);
    await database.execute(`
      insert into im_bindings (
        id, agent_id, provider, status, external_app_id, external_bot_id, credential_schema_version,
        credential_generation, encrypted_credential, activated_at, created_at, updated_at
      )
      values ('${BINDING_ID}', '${AGENT_ID}', 'feishu', 'active', 'app', 'bot', 1, 1, 'sealed',
        '${NOW.toISOString()}', '${NOW.toISOString()}', '${NOW.toISOString()}')
    `);
    // `ended_at` is the only fact the flag must mirror: one live Session, one ended Session, and one ended
    // grandchild whose ancestor chain must be marked through its own row.
    await database.execute(`
      insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, created_by_session_id, ended_at, created_at)
      values
        ('${ROOT_SESSION_ID}', '${BINDING_ID}', 'C1', 'dm', 'channel', null, null, '${NOW.toISOString()}'),
        ('${ACTIVE_SESSION_ID}', '${BINDING_ID}', 'C1', 'dm', 'internal', '${ROOT_SESSION_ID}', null, '${NOW.toISOString()}'),
        ('${ENDED_SESSION_ID}', '${BINDING_ID}', 'C2', 'dm', 'internal', '${ROOT_SESSION_ID}', '${NOW.toISOString()}', '${NOW.toISOString()}'),
        ('${ENDED_GRANDCHILD_ID}', '${BINDING_ID}', 'C3', 'dm', 'internal', '${ENDED_SESSION_ID}', '${NOW.toISOString()}', '${NOW.toISOString()}')
    `);
    // Raw SQL, not the generated insert: the generated statement names `descendant_active` even when no
    // value is given, and this row set must be exactly what the previous release could write.
    const rows: Array<[string, string, number, string]> = [
      [ROOT_SESSION_ID, ACTIVE_SESSION_ID, 1, "active"],
      [ROOT_SESSION_ID, ENDED_SESSION_ID, 1, "ended"],
      [ROOT_SESSION_ID, ENDED_GRANDCHILD_ID, 2, "ended grandchild"],
      [ENDED_SESSION_ID, ENDED_GRANDCHILD_ID, 1, "ended grandchild"],
    ];
    for (const [ancestor, descendant, depth, preview] of rows) {
      await database.execute(sql`
        insert into session_descendants (
          ancestor_session_id, descendant_session_id, depth, last_message_created_at,
          last_message_id, last_delivery_outcome, task_preview
        )
        values (
          ${ancestor}::uuid, ${descendant}::uuid, ${depth}, ${NOW.toISOString()}::timestamptz,
          ${MESSAGE_ID}::uuid, 'accepted', ${preview}
        )
      `);
    }
  } finally {
    await client.sql.end();
  }
}

describe("0069_session_descendant_active", () => {
  it("derives the activity flag from sessions.ended_at and indexes only active rows", async () => {
    const truncated = await truncatedMigrations(PREVIOUS_HEAD_IDX);
    try {
      await migrateDatabase(databaseUrl, truncated);
    } finally {
      await rm(truncated, { recursive: true, force: true });
    }
    await insertHistoricalSessions();
    await migrateDatabase(databaseUrl, migrationsFolder);

    const client = createDatabaseClient(databaseUrl);
    try {
      const rows = await client.database.select().from(sessionDescendants);
      const flags = new Map(rows.map((row) => [`${row.ancestorSessionId}/${row.descendantSessionId}`, row]));
      expect(flags.size).toBe(4);
      expect(flags.get(`${ROOT_SESSION_ID}/${ACTIVE_SESSION_ID}`)?.descendantActive).toBe(true);
      expect(flags.get(`${ROOT_SESSION_ID}/${ENDED_SESSION_ID}`)?.descendantActive).toBe(false);
      expect(flags.get(`${ROOT_SESSION_ID}/${ENDED_GRANDCHILD_ID}`)?.descendantActive).toBe(false);
      expect(flags.get(`${ENDED_SESSION_ID}/${ENDED_GRANDCHILD_ID}`)?.descendantActive).toBe(false);

      const [divergence] = await client.sql<{ divergent: number }[]>`
        select count(*)::int as divergent
        from session_descendants link
        inner join sessions child on child.id = link.descendant_session_id
        where link.descendant_active is distinct from (child.ended_at is null)
      `;
      expect(divergence?.divergent).toBe(0);

      const indexes = await client.sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'session_descendants'
        order by indexname
      `;
      const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));
      expect([...byName.keys()].sort()).toEqual([
        "session_descendants_ancestor_activity_active_idx",
        "session_descendants_ancestor_depth_activity_active_idx",
        "session_descendants_ancestor_session_id_descendant_session_id_p",
        // PostgreSQL truncates this generated constraint name to 63 bytes.
        "session_descendants_descendant_ancestor_idx",
        "session_descendants_last_message_idx",
      ]);
      expect(byName.get("session_descendants_ancestor_activity_active_idx")).toContain("WHERE descendant_active");
      expect(byName.get("session_descendants_ancestor_depth_activity_active_idx")).toContain("WHERE descendant_active");

      // The partial index must answer the page's ordering without touching ended descendants.
      await client.sql`set enable_seqscan = off`;
      const plan = await client.sql`
        explain (format json)
        select descendant_session_id
        from session_descendants
        where ancestor_session_id = ${ROOT_SESSION_ID}::uuid and descendant_active
        order by last_message_created_at desc, last_message_id desc, descendant_session_id desc
        limit 2
      `;
      expect(JSON.stringify(plan)).toContain("session_descendants_ancestor_activity_active_idx");
      const ended = await client.database.select().from(sessions);
      expect(ended.filter((row) => row.endedAt !== null)).toHaveLength(2);
    } finally {
      await client.sql.end();
    }
  }, 120_000);
});
