import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../db/migrate.js";

/*
 * Migration and database-constraint contract for Agent Schedules:
 * - the `agent_schedules` table enforces the persisted rule shapes and bounds (M02 DB half);
 * - `session_messages` enforces exactly one origin — source Session XOR scheduled origin (M03);
 * - a database migrated from the pre-0052 schema keeps old ordinary messages byte-identical and
 *   admits both origins afterwards (M04).
 */

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const PRE_SCHEDULES_LAST_INDEX = 51;

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

async function withSql<T>(operation: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    return await operation(sql);
  } finally {
    await sql.end();
  }
}

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

/** A migration folder truncated after `lastIndex`, for replaying old-schema states. */
async function truncatedMigrationsFolder(lastIndex: number): Promise<string> {
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as Journal;
  const folder = await mkdtemp(join(tmpdir(), "opentag-schedules-migrations-"));
  await mkdir(join(folder, "meta"));
  const entries = journal.entries.filter((entry) => entry.idx <= lastIndex);
  for (const entry of entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

function expectDatabaseError(error: unknown, code: string, constraint?: string): void {
  const actual = error as { code?: string; constraint_name?: string };
  expect(actual.code, `Expected PostgreSQL error ${code}`).toBe(code);
  if (constraint) expect(actual.constraint_name).toBe(constraint);
}

interface Seed {
  userId: string;
  agentId: string;
  bindingId: string;
  channelSessionId: string;
  threadSessionId: string;
}

/** The minimal identity chain schedules and messages reference: user -> agent -> binding -> sessions. */
async function seedConversation(sql: Sql): Promise<Seed> {
  const userId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const channelSessionId = randomUUID();
  const threadSessionId = randomUUID();
  await sql`insert into users (id, email, display_name) values (${userId}, ${`${userId}@example.com`}, 'Owner')`;
  await sql`
    insert into agents (id, created_by_user_id, name, display_name, runtime_provider)
    values (${agentId}, ${userId}, 'assistant', 'Assistant', 'codex')
  `;
  await sql`
    insert into im_bindings (
      id, agent_id, provider, status, external_app_id, external_bot_id,
      credential_schema_version, credential_generation, encrypted_credential, activated_at
    )
    values (
      ${bindingId}, ${agentId}, 'feishu', 'active', 'cli_fixture', 'ou_fixture', 1, 1, 'test-only', now()
    )
  `;
  await sql`
    insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind)
    values (${channelSessionId}, ${bindingId}, 'oc_channel', 'dm', 'channel')
  `;
  await sql`
    insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, thread_key)
    values (${threadSessionId}, ${bindingId}, 'oc_channel', 'dm', 'thread', 'omt_thread')
  `;
  return { userId, agentId, bindingId, channelSessionId, threadSessionId };
}

const CONTENT_HASH = "a".repeat(64);

function messageRow(input: {
  id?: string;
  sourceSessionId?: string | null;
  scheduledOrigin?: postgres.JSONValue;
  targetSessionId: string;
  content?: string;
}) {
  return {
    id: input.id ?? randomUUID(),
    source_session_id: input.sourceSessionId ?? null,
    scheduled_origin: input.scheduledOrigin === undefined ? null : input.scheduledOrigin,
    target_session_id: input.targetSessionId,
    content: input.content ?? "Check the build.",
    content_hash: CONTENT_HASH,
  };
}

const VALID_ORIGIN = {
  scheduleId: randomUUID(),
  scheduledFor: "2026-09-28T01:00:00.000Z",
  timezone: "Asia/Shanghai",
  name: "Daily check",
};

function scheduleRow(input: {
  id?: string;
  agentId: string;
  targetSessionId: string;
  name?: string;
  prompt?: string;
  schedule?: postgres.JSONValue;
  timezone?: string;
  enabled?: boolean;
  nextTriggerAt?: Date | null;
  revision?: number;
}) {
  const schedule = input.schedule === undefined ? { kind: "cron", expression: "0 9 * * MON-FRI" } : input.schedule;
  return {
    id: input.id ?? randomUUID(),
    agent_id: input.agentId,
    target_session_id: input.targetSessionId,
    name: input.name ?? "Daily check",
    prompt: input.prompt ?? "Check the build.",
    schedule,
    timezone: input.timezone ?? "Asia/Shanghai",
    enabled: input.enabled ?? true,
    next_trigger_at: input.nextTriggerAt === undefined ? new Date("2026-09-29T01:00:00.000Z") : input.nextTriggerAt,
    revision: input.revision ?? 1,
  };
}

/** Insert one schedule row, sending the rule document as a typed JSON parameter. */
function insertSchedule(sql: Sql, row: ReturnType<typeof scheduleRow>) {
  const { schedule, ...rest } = row;
  return sql`insert into agent_schedules ${sql({ ...rest, schedule: sql.json(schedule) })}`;
}

describe("session_messages origin constraint (M03)", () => {
  beforeEach(async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
  });

  it("accepts exactly one origin and rejects every other combination", async () => {
    await withSql(async (sql) => {
      const seed = await seedConversation(sql);
      const insert = (row: ReturnType<typeof messageRow>) =>
        sql`insert into session_messages ${sql(row)}`.then(
          () => null,
          (error: unknown) => error,
        );

      // Ordinary and scheduled messages both persist.
      expect(
        await insert(messageRow({ sourceSessionId: seed.channelSessionId, targetSessionId: seed.threadSessionId })),
      ).toBeNull();
      expect(
        await insert(messageRow({ scheduledOrigin: VALID_ORIGIN, targetSessionId: seed.channelSessionId })),
      ).toBeNull();

      // Both origins, neither origin, and a JSON null origin are all rejected.
      for (const row of [
        messageRow({
          sourceSessionId: seed.channelSessionId,
          scheduledOrigin: VALID_ORIGIN,
          targetSessionId: seed.threadSessionId,
        }),
        messageRow({ targetSessionId: seed.threadSessionId }),
        messageRow({ scheduledOrigin: null, targetSessionId: seed.threadSessionId }),
      ]) {
        expectDatabaseError(await insert(row), "23514", "session_messages_source_shape");
      }
      // A JSON `null` literal (not SQL NULL) and non-object origins fail the shape as well.
      for (const badOrigin of [null, "scheduled", 42, [] as unknown[]]) {
        const violation = await sql`
          insert into session_messages (id, target_session_id, content, content_hash, scheduled_origin)
          values (${randomUUID()}, ${seed.threadSessionId}, 'Check the build.', ${CONTENT_HASH}, ${sql.json(badOrigin as postgres.JSONValue)})
        `.then(
          () => null,
          (cause: unknown) => cause,
        );
        expectDatabaseError(violation, "23514", "session_messages_source_shape");
      }
      // Missing and mistyped origin fields are not a valid scheduled origin.
      for (const origin of [
        { ...VALID_ORIGIN, name: undefined },
        { ...VALID_ORIGIN, timezone: undefined },
        { ...VALID_ORIGIN, scheduledFor: undefined },
        { ...VALID_ORIGIN, scheduleId: "not-a-uuid" },
        { ...VALID_ORIGIN, name: "" },
        { ...VALID_ORIGIN, extra: true },
      ]) {
        const cleaned = JSON.parse(JSON.stringify(origin));
        const violation = await sql`
          insert into session_messages (id, target_session_id, content, content_hash, scheduled_origin)
          values (${randomUUID()}, ${seed.threadSessionId}, 'Check the build.', ${CONTENT_HASH}, ${sql.json(cleaned)})
        `.then(
          () => null,
          (cause: unknown) => cause,
        );
        expectDatabaseError(violation, "23514", "session_messages_source_shape");
      }
      // The legacy foreign keys still protect both Session references.
      const badSource = await insert(
        messageRow({ sourceSessionId: randomUUID(), targetSessionId: seed.threadSessionId }),
      );
      expectDatabaseError(badSource, "23503", "session_messages_source_session_id_sessions_id_fk");
      const badTarget = await insert(
        messageRow({ sourceSessionId: seed.channelSessionId, targetSessionId: randomUUID() }),
      );
      expectDatabaseError(badTarget, "23503", "session_messages_target_session_id_sessions_id_fk");
    });
  });
});

describe("agent_schedules table contract (M02 database half)", () => {
  beforeEach(async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
  });

  it("enforces name, prompt, revision, and the disabled/next-trigger invariant", async () => {
    await withSql(async (sql) => {
      const seed = await seedConversation(sql);
      const insert = (row: ReturnType<typeof scheduleRow>) =>
        insertSchedule(sql, row).then(
          () => null,
          (error: unknown) => error,
        );
      const base = { agentId: seed.agentId, targetSessionId: seed.channelSessionId };

      expect(await insert(scheduleRow(base))).toBeNull();
      // char_length counts Unicode code points, matching the 120-code-point product bound.
      expect(await insert(scheduleRow({ ...base, name: "🚀".repeat(120) }))).toBeNull();
      expectDatabaseError(
        await insert(scheduleRow({ ...base, name: "🚀".repeat(121) })),
        "23514",
        "agent_schedules_name_bounds",
      );
      expectDatabaseError(await insert(scheduleRow({ ...base, name: "" })), "23514", "agent_schedules_name_bounds");
      // Prompt bounds are UTF-8 bytes.
      expect(await insert(scheduleRow({ ...base, prompt: `${"你".repeat(5461)}x` }))).toBeNull();
      expectDatabaseError(
        await insert(scheduleRow({ ...base, prompt: "x".repeat(16_385) })),
        "23514",
        "agent_schedules_prompt_bounds",
      );
      expectDatabaseError(await insert(scheduleRow({ ...base, prompt: "" })), "23514", "agent_schedules_prompt_bounds");
      expectDatabaseError(
        await insert(scheduleRow({ ...base, revision: 0 })),
        "23514",
        "agent_schedules_revision_positive",
      );
      expectDatabaseError(
        await insert(scheduleRow({ ...base, enabled: false })),
        "23514",
        "agent_schedules_disabled_next_null",
      );
      expect(await insert(scheduleRow({ ...base, enabled: false, nextTriggerAt: null }))).toBeNull();
      // Structural timezone shape only; semantic IANA validation belongs to the Server calculator.
      expectDatabaseError(
        await insert(scheduleRow({ ...base, timezone: "+08:00" })),
        "23514",
        "agent_schedules_timezone_shape",
      );
    });
  });

  it("enforces exactly the three persisted rule shapes", async () => {
    await withSql(async (sql) => {
      const seed = await seedConversation(sql);
      const insert = (row: ReturnType<typeof scheduleRow>) =>
        insertSchedule(sql, row).then(
          () => null,
          (error: unknown) => error,
        );
      const base = { agentId: seed.agentId, targetSessionId: seed.channelSessionId };

      expect(
        await insert(scheduleRow({ ...base, schedule: { kind: "at", at: "2026-09-29T01:00:00.000Z" } })),
      ).toBeNull();
      expect(
        await insert(
          scheduleRow({
            ...base,
            schedule: { kind: "every", intervalSeconds: 60, anchorAt: "2026-09-28T01:00:00.000Z" },
          }),
        ),
      ).toBeNull();
      expect(
        await insert(scheduleRow({ ...base, schedule: { kind: "cron", expression: "0 9 * * MON-FRI" } })),
      ).toBeNull();

      const invalid: Array<{ label: string; schedule?: postgres.JSONValue; rawJsonb?: string }> = [
        { label: "unknown kind", schedule: { kind: "daily", at: "2026-09-29T01:00:00.000Z" } },
        { label: "JSON null kind", schedule: { kind: null, at: "2026-09-29T01:00:00.000Z" } },
        { label: "at without time", schedule: { kind: "at" } },
        { label: "at with an extra key", schedule: { kind: "at", at: "2026-09-29T01:00:00.000Z", extra: true } },
        {
          label: "every below the floor",
          schedule: { kind: "every", intervalSeconds: 59, anchorAt: "2026-09-28T01:00:00.000Z" },
        },
        {
          label: "every fractional",
          schedule: { kind: "every", intervalSeconds: 60.5, anchorAt: "2026-09-28T01:00:00.000Z" },
        },
        { label: "every without an anchor", schedule: { kind: "every", intervalSeconds: 60 } },
        {
          label: "every unsafe",
          schedule: {
            kind: "every",
            intervalSeconds: Number.MAX_SAFE_INTEGER + 1,
            anchorAt: "2026-09-28T01:00:00.000Z",
          },
        },
        { label: "cron empty", schedule: { kind: "cron", expression: "" } },
        { label: "cron without expression", schedule: { kind: "cron" } },
        { label: "non-object", schedule: "not-an-object" },
        { label: "JSON null", rawJsonb: "null" },
      ];
      for (const { label, schedule, rawJsonb } of invalid) {
        const baseRow = scheduleRow({ ...base, schedule });
        const { schedule: _schedule, ...rest } = baseRow;
        const error = rawJsonb
          ? await sql`
              insert into agent_schedules (
                id, agent_id, target_session_id, name, prompt, schedule, timezone, enabled, next_trigger_at, revision
              )
              values (
                ${rest.id}, ${rest.agent_id}, ${rest.target_session_id}, ${rest.name}, ${rest.prompt},
                'null'::jsonb, ${rest.timezone}, ${rest.enabled}, ${rest.next_trigger_at}, ${rest.revision}
              )
            `.then(
              () => null,
              (cause: unknown) => cause,
            )
          : await insert(scheduleRow({ ...base, schedule }));
        expect(error, `Expected a constraint violation for ${label}`).toMatchObject({
          code: "23514",
          constraint_name: "agent_schedules_schedule_shape",
        });
      }
    });
  });

  it("keeps the ownership foreign keys restrictive and creates the documented indexes", async () => {
    await withSql(async (sql) => {
      const seed = await seedConversation(sql);
      await insertSchedule(sql, scheduleRow({ agentId: seed.agentId, targetSessionId: seed.channelSessionId }));
      // The Agent and the pinned target Session cannot be hard-deleted under a schedule.
      expectDatabaseError(
        await sql`delete from agents where id = ${seed.agentId}`.then(
          () => null,
          (error: unknown) => error,
        ),
        "23503",
      );
      expectDatabaseError(
        await sql`delete from sessions where id = ${seed.channelSessionId}`.then(
          () => null,
          (error: unknown) => error,
        ),
        "23503",
      );
      const indexes = await sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes where tablename = 'agent_schedules' order by indexname
      `;
      const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
      expect(byName.get("agent_schedules_due_idx")).toContain("WHERE");
      expect(byName.get("agent_schedules_due_idx")).toContain("next_trigger_at");
      expect(byName.get("agent_schedules_due_idx")).toContain("enabled");
      expect(byName.get("agent_schedules_agent_created_idx")).toContain("agent_id");
      expect(byName.get("agent_schedules_agent_created_idx")).toContain("created_at");
      expect(byName.has("agent_schedules_target_session_idx")).toBe(true);
    });
  });
});

describe("migration 0052 upgrade path (M04)", () => {
  it("preserves old ordinary messages and admits both origins after the upgrade", async () => {
    const truncated = await truncatedMigrationsFolder(PRE_SCHEDULES_LAST_INDEX);
    try {
      await migrateDatabase(databaseUrl, truncated);
      const legacy = await withSql(async (sql) => {
        const seed = await seedConversation(sql);
        // The pre-0052 schema: source_session_id NOT NULL, no scheduled_origin column.
        const messageId = randomUUID();
        await sql`
          insert into session_messages (id, source_session_id, target_session_id, content, content_hash)
          values (${messageId}, ${seed.channelSessionId}, ${seed.threadSessionId}, 'Legacy body', ${CONTENT_HASH})
        `;
        return { seed, messageId };
      });

      await migrateDatabase(databaseUrl, migrationsFolder);

      await withSql(async (sql) => {
        const [row] = await sql<
          {
            id: string;
            source_session_id: string | null;
            scheduled_origin: unknown;
            content: string;
            content_hash: string;
            attempt_count: number;
            last_outcome: string;
          }[]
        >`select * from session_messages where id = ${legacy.messageId}`;
        // The old row is byte-identical: source, body, hash, attempts, and outcome are untouched.
        expect(row).toMatchObject({
          id: legacy.messageId,
          source_session_id: legacy.seed.channelSessionId,
          scheduled_origin: null,
          content: "Legacy body",
          content_hash: CONTENT_HASH,
          attempt_count: 0,
          last_outcome: "unknown",
        });

        // Ordinary messages keep working against the upgraded schema...
        await sql`insert into session_messages ${sql(
          messageRow({ sourceSessionId: legacy.seed.channelSessionId, targetSessionId: legacy.seed.threadSessionId }),
        )}`;
        // ...and the scheduled origin is admitted with the mutual-exclusion guard active.
        await sql`insert into session_messages ${sql(
          messageRow({ scheduledOrigin: VALID_ORIGIN, targetSessionId: legacy.seed.channelSessionId }),
        )}`;
        const violation = await sql`insert into session_messages ${sql(
          messageRow({
            sourceSessionId: legacy.seed.channelSessionId,
            scheduledOrigin: VALID_ORIGIN,
            targetSessionId: legacy.seed.threadSessionId,
          }),
        )}`.then(
          () => null,
          (error: unknown) => error,
        );
        expectDatabaseError(violation, "23514", "session_messages_source_shape");

        const [journalRow] = await sql<{ count: string }[]>`
          select count(*)::text as count from drizzle.__drizzle_migrations
        `;
        const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as Journal;
        expect(Number(journalRow?.count)).toBe(journal.entries.length);
      });
    } finally {
      await rm(truncated, { force: true, recursive: true });
    }
  });
});
