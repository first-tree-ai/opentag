import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PROTOCOL_V2 } from "@opentag/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "../../db/migrate.js";
import {
  accountComputers,
  agents,
  computerConnectCodes,
  computerCredentials,
  sessionCliProofs,
  sessionPlacements,
  workspaceComputerCredentials,
  workspaceComputers,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { SessionCliProofService, SessionService } from "../../services/sessions/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const CREATOR_ID = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000003";
const INSTALLATION_ID = "00000000-0000-4000-8000-000000000004";
const ACTIVE_ENROLLMENT_ID = "00000000-0000-4000-8000-000000000005";
const REVOKED_ENROLLMENT_ID = "00000000-0000-4000-8000-000000000006";
const ACTIVE_CREDENTIAL_ID = "00000000-0000-4000-8000-000000000007";
const REVOKED_CREDENTIAL_ID = "00000000-0000-4000-8000-000000000008";
const UNCONSUMED_CODE_ID = "00000000-0000-4000-8000-000000000009";
const CONSUMED_CODE_ID = "00000000-0000-4000-8000-00000000000a";
const AGENT_ID = "00000000-0000-4000-8000-00000000000b";
const BINDING_ID = "00000000-0000-4000-8000-00000000000c";
const ACTIVE_SESSION_ID = "00000000-0000-4000-8000-00000000000d";
const ENDED_SESSION_ID = "00000000-0000-4000-8000-00000000000e";
const SLACK_ACTIVE_ID = "00000000-0000-4000-8000-00000000000f";
const SLACK_DISABLED_ID = "00000000-0000-4000-8000-000000000010";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000011";
const PENDING_DELIVERY_ID = "00000000-0000-4000-8000-000000000012";
const ACCEPTED_DELIVERY_ID = "00000000-0000-4000-8000-000000000013";
const CURRENT_INSTANCE_ID = "00000000-0000-4000-8000-000000000014";
const STALE_INSTANCE_ID = "00000000-0000-4000-8000-000000000015";

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

function postgresError(error: unknown): { code?: string; constraint_name?: string } {
  if (typeof error !== "object" || error === null) return {};
  return error as { code?: string; constraint_name?: string };
}

const HAZARD_CONSTRAINTS = [
  "computer_connect_codes_workspace_enrollment_fk",
  "agents_workspace_enrollment_fk",
] as const;
const HAZARD_INDEXES = [
  "slack_installations_workspace_current_unique",
  "session_placements_workspace_computer_id_idx",
] as const;

async function expansionSchema(sql: postgres.Sql) {
  const [row] = await sql<
    {
      migrations: number;
      account_computers: string | null;
      computer_credentials: string | null;
      agents_computer_id: boolean;
      placements_computer_id: boolean;
      proofs_computer_id: boolean;
      slack_agent_id: boolean;
      connect_mode: boolean;
      hazards: string[];
      hazard_indexes: string[];
    }[]
  >`
    select
      (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
      to_regclass('public.account_computers')::text as account_computers,
      to_regclass('public.computer_credentials')::text as computer_credentials,
      exists(
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'agents' and column_name = 'computer_id'
      ) as agents_computer_id,
      exists(
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'session_placements' and column_name = 'computer_id'
      ) as placements_computer_id,
      exists(
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'session_cli_proofs' and column_name = 'computer_id'
      ) as proofs_computer_id,
      exists(
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'slack_installations' and column_name = 'agent_id'
      ) as slack_agent_id,
      exists(
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'computer_connect_codes' and column_name = 'mode'
      ) as connect_mode,
      array(
        select conname::text from pg_constraint
        where conname in ('computer_connect_codes_workspace_enrollment_fk', 'agents_workspace_enrollment_fk')
        order by conname
      ) as hazards,
      array(
        select indexname::text from pg_indexes
        where indexname in (
          'slack_installations_workspace_current_unique',
          'session_placements_workspace_computer_id_idx'
        )
        order by indexname
      ) as hazard_indexes
  `;
  return row;
}

async function populateLegacyOwnership(sql: postgres.Sql): Promise<void> {
  const now = new Date("2026-08-20T00:00:00.000Z");
  const later = new Date("2026-08-21T00:00:00.000Z");
  await sql`
    insert into users (id, email, display_name)
    values
      (${OWNER_ID}, 'owner@example.com', 'Owner'),
      (${CREATOR_ID}, 'creator@example.com', 'Creator')
  `;
  await sql`
    insert into workspaces (id, name, display_name)
    values (${WORKSPACE_ID}, 'legacy', 'Legacy')
  `;
  await sql`
    insert into workspace_admin_grants (workspace_id, user_id, granted_by_user_id, granted_at)
    values
      (${WORKSPACE_ID}, ${OWNER_ID}, ${OWNER_ID}, ${now}),
      (${WORKSPACE_ID}, ${CREATOR_ID}, ${OWNER_ID}, ${now})
  `;
  await sql`insert into computers (id, created_at) values (${INSTALLATION_ID}, ${now})`;
  await sql`
    insert into workspace_computers (
      id, workspace_id, computer_id, display_name, platform, arch, client_version,
      enrolled_by_user_id, enrolled_at, current_instance_id, connected_at, last_seen_at, updated_at
    )
    values (
      ${ACTIVE_ENROLLMENT_ID}, ${WORKSPACE_ID}, ${INSTALLATION_ID}, 'active-box', 'linux', 'x64', '0.0.1',
      ${OWNER_ID}, ${now}, ${CURRENT_INSTANCE_ID}, ${now}, ${now}, ${now}
    )
  `;
  await sql`
    insert into workspace_computers (
      id, workspace_id, computer_id, display_name, platform, arch, client_version,
      enrolled_by_user_id, enrolled_at, revoked_by_user_id, revoked_at, updated_at
    )
    values (
      ${REVOKED_ENROLLMENT_ID}, ${WORKSPACE_ID}, ${INSTALLATION_ID}, 'revoked-box', 'linux', 'x64', '0.0.1',
      ${OWNER_ID}, ${now}, ${OWNER_ID}, ${later}, ${later}
    )
  `;
  await sql`
    insert into workspace_computer_credentials (
      id, workspace_computer_id, secret_hash, issued_by_user_id, issued_at
    )
    values (
      ${ACTIVE_CREDENTIAL_ID}, ${ACTIVE_ENROLLMENT_ID}, ${"a".repeat(64)}, ${OWNER_ID}, ${now}
    )
  `;
  await sql`
    insert into workspace_computer_credentials (
      id, workspace_computer_id, secret_hash, issued_by_user_id, issued_at, revoked_by_user_id, revoked_at
    )
    values (
      ${REVOKED_CREDENTIAL_ID}, ${ACTIVE_ENROLLMENT_ID}, ${"b".repeat(64)}, ${OWNER_ID}, ${now}, ${OWNER_ID}, ${later}
    )
  `;
  await sql`
    insert into computer_connect_codes (
      id, workspace_id, token_hash, issued_by_user_id, created_at, expires_at
    )
    values (
      ${UNCONSUMED_CODE_ID}, ${WORKSPACE_ID}, ${"c".repeat(64)}, ${OWNER_ID}, ${now}, ${later}
    )
  `;
  await sql`
    insert into computer_connect_codes (
      id, workspace_id, token_hash, issued_by_user_id, created_at, expires_at,
      consumed_workspace_computer_id, consumed_at
    )
    values (
      ${CONSUMED_CODE_ID}, ${WORKSPACE_ID}, ${"d".repeat(64)}, ${OWNER_ID}, ${now}, ${later},
      ${ACTIVE_ENROLLMENT_ID}, ${now}
    )
  `;
  await sql`
    insert into agents (
      id, workspace_id, created_by_user_id, workspace_computer_id, name, display_name, runtime_provider
    )
    values (
      ${AGENT_ID}, ${WORKSPACE_ID}, ${CREATOR_ID}, ${ACTIVE_ENROLLMENT_ID},
      'mismatched', 'Mismatched', 'codex'
    )
  `;
  await sql`
    insert into im_bindings (
      id, agent_id, provider, status, external_app_id, external_bot_id,
      credential_schema_version, credential_generation, encrypted_credential, activated_at
    )
    values (
      ${BINDING_ID}, ${AGENT_ID}, 'feishu', 'active', 'cli_legacy', 'ou_legacy',
      1, 1, 'encrypted', ${now}
    )
  `;
  await sql`
    insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, created_at)
    values
      (${ACTIVE_SESSION_ID}, ${BINDING_ID}, 'C-active', 'channel', 'channel', ${now}),
      (${ENDED_SESSION_ID}, ${BINDING_ID}, 'C-ended', 'channel', 'channel', ${now})
  `;
  await sql`update sessions set ended_at = ${later} where id = ${ENDED_SESSION_ID}`;
  await sql`
    insert into session_placements (session_id, workspace_computer_id, generation, updated_at)
    values
      (${ACTIVE_SESSION_ID}, ${ACTIVE_ENROLLMENT_ID}, 2, ${later}),
      (${ENDED_SESSION_ID}, ${REVOKED_ENROLLMENT_ID}, 1, ${now})
  `;
  await sql`
    insert into session_cli_proofs (
      session_id, proof_id, token_hash, workspace_computer_id, placement_generation,
      connection_instance_id, created_at, updated_at
    )
    values (
      ${ACTIVE_SESSION_ID}, ${crypto.randomUUID()}, ${"e".repeat(64)}, ${ACTIVE_ENROLLMENT_ID}, 1,
      ${STALE_INSTANCE_ID}, ${now}, ${now}
    )
  `;
  await sql`
    insert into slack_installations (
      id, workspace_id, status, external_app_id, external_team_id, external_bot_id,
      credential_schema_version, credential_generation, encrypted_credential, activated_at, created_at, updated_at
    )
    values (
      ${SLACK_ACTIVE_ID}, ${WORKSPACE_ID}, 'active', 'A_LEGACY', 'T_LEGACY', 'U_BOT',
      1, 1, 'encrypted-slack', ${now}, ${now}, ${now}
    )
  `;
  await sql`
    insert into slack_installations (
      id, workspace_id, status, external_app_id, external_team_id, external_bot_id,
      credential_generation, encrypted_credential, replacement_slack_installation_id,
      disabled_at, created_at, updated_at
    )
    values (
      ${SLACK_DISABLED_ID}, ${WORKSPACE_ID}, 'disabled', 'A_OLD', 'T_OLD', 'U_OLD',
      1, null, ${SLACK_ACTIVE_ID}, ${later}, ${now}, ${later}
    )
  `;
  await sql`
    insert into im_messages (
      id, im_binding_id, channel_id, external_message_id, provider_revision_key, operation, direction,
      author_kind, author_external_id, content, provider_context, occurred_at, received_at
    )
    values (
      ${MESSAGE_ID}, ${BINDING_ID}, 'C-active', 'om_legacy', '1', 'created', 'inbound',
      'human', 'ou_human',
      '{"version":1,"fallbackText":"hi","blocks":[],"truncated":false}'::jsonb,
      '{"provider":"feishu","chatType":"p2p"}'::jsonb,
      ${now}, ${now}
    )
  `;
  await sql`
    insert into im_message_deliveries (
      id, message_id, session_id, attention, state, placement_generation, attempt_count,
      next_attempt_at, expires_at
    )
    values (
      ${PENDING_DELIVERY_ID}, ${MESSAGE_ID}, ${ACTIVE_SESSION_ID}, 'direct', 'pending', 2, 0,
      ${now}, ${later}
    )
  `;
  await sql`
    insert into im_message_deliveries (
      id, message_id, session_id, attention, state, placement_generation, attempt_count,
      next_attempt_at, expires_at, accepted_at, turn_id, input_hash, report_owner_instance_id
    )
    values (
      ${ACCEPTED_DELIVERY_ID}, ${MESSAGE_ID}, ${ENDED_SESSION_ID}, 'direct', 'accepted', 1, 1,
      ${now}, ${later}, ${now}, 'turn-legacy', ${"a".repeat(64)}, ${CURRENT_INSTANCE_ID}
    )
  `;
}

describe("account-owned computer expansion migrations", () => {
  it("orders the expansion schema immediately after credential retirement", async () => {
    const journal = await readJournal();
    expect(journal.entries.slice(25, 27).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 25, tag: "0025_retire_legacy_credentials" },
      { idx: 26, tag: "0026_wakeful_wildside" },
    ]);
  });

  it("migrates an empty database to 0026 and reruns idempotently", async () => {
    const journal = await readJournal();
    await migrateDatabase(databaseUrl, migrationsFolder);
    await migrateDatabase(databaseUrl, migrationsFolder);
    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();

    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      const schema = await expansionSchema(sql);
      expect(schema).toMatchObject({
        migrations: journal.entries.length,
        account_computers: "account_computers",
        computer_credentials: "computer_credentials",
        agents_computer_id: true,
        placements_computer_id: true,
        proofs_computer_id: true,
        slack_agent_id: true,
        connect_mode: true,
        hazards: [...HAZARD_CONSTRAINTS].sort(),
        hazard_indexes: [...HAZARD_INDEXES].sort(),
      });
      const [counts] = await sql<{ account_computers: number; computer_credentials: number }[]>`
        select
          (select count(*)::int from account_computers) as account_computers,
          (select count(*)::int from computer_credentials) as computer_credentials
      `;
      expect(counts).toEqual({ account_computers: 0, computer_credentials: 0 });
    } finally {
      await sql.end();
    }
  });

  it("upgrades populated 0025 data to 0026 without backfilling target projections", async () => {
    const journal = await readJournal();
    const legacyFolder = await truncatedMigrations(25);
    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateLegacyOwnership(sql);
        const [before] = await sql<
          {
            migrations: number;
            workspace_computers: number;
            credentials: number;
            codes: number;
            agents: number;
            placements: number;
            proofs: number;
            slack: number;
            deliveries: number;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (select count(*)::int from workspace_computers) as workspace_computers,
            (select count(*)::int from workspace_computer_credentials) as credentials,
            (select count(*)::int from computer_connect_codes) as codes,
            (select count(*)::int from agents) as agents,
            (select count(*)::int from session_placements) as placements,
            (select count(*)::int from session_cli_proofs) as proofs,
            (select count(*)::int from slack_installations) as slack,
            (select count(*)::int from im_message_deliveries) as deliveries
        `;
        expect(before).toEqual({
          migrations: 26,
          workspace_computers: 2,
          credentials: 2,
          codes: 2,
          agents: 1,
          placements: 2,
          proofs: 1,
          slack: 2,
          deliveries: 2,
        });

        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();

        const [after] = await sql<
          {
            migrations: number;
            workspace_computers: number;
            credentials: number;
            codes: number;
            agents: number;
            placements: number;
            proofs: number;
            slack: number;
            deliveries: number;
            account_computers: number;
            computer_credentials: number;
            agents_computer_id: number;
            placement_computer_id: number;
            proof_computer_id: number;
            slack_agent_id: number;
            code_projections: number;
            owner_mismatch: number;
            active_credentials: number;
            revoked_credentials: number;
            unconsumed_codes: number;
            consumed_codes: number;
            ended_sessions: number;
            pending_deliveries: number;
            accepted_unreported: number;
            replaced_slack: number;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (select count(*)::int from workspace_computers) as workspace_computers,
            (select count(*)::int from workspace_computer_credentials) as credentials,
            (select count(*)::int from computer_connect_codes) as codes,
            (select count(*)::int from agents) as agents,
            (select count(*)::int from session_placements) as placements,
            (select count(*)::int from session_cli_proofs) as proofs,
            (select count(*)::int from slack_installations) as slack,
            (select count(*)::int from im_message_deliveries) as deliveries,
            (select count(*)::int from account_computers) as account_computers,
            (select count(*)::int from computer_credentials) as computer_credentials,
            (select count(*)::int from agents where computer_id is not null) as agents_computer_id,
            (select count(*)::int from session_placements where computer_id is not null) as placement_computer_id,
            (select count(*)::int from session_cli_proofs where computer_id is not null) as proof_computer_id,
            (select count(*)::int from slack_installations where agent_id is not null) as slack_agent_id,
            (
              select count(*)::int from computer_connect_codes
              where issued_by_account_id is not null or mode is not null
                or target_computer_id is not null or consumed_computer_id is not null
            ) as code_projections,
            (
              select count(*)::int from agents
              inner join workspace_computers on workspace_computers.id = agents.workspace_computer_id
              where agents.created_by_user_id <> workspace_computers.enrolled_by_user_id
            ) as owner_mismatch,
            (select count(*)::int from workspace_computer_credentials where revoked_at is null) as active_credentials,
            (select count(*)::int from workspace_computer_credentials where revoked_at is not null) as revoked_credentials,
            (select count(*)::int from computer_connect_codes where consumed_at is null and revoked_at is null) as unconsumed_codes,
            (select count(*)::int from computer_connect_codes where consumed_at is not null) as consumed_codes,
            (select count(*)::int from sessions where ended_at is not null) as ended_sessions,
            (select count(*)::int from im_message_deliveries where state = 'pending') as pending_deliveries,
            (
              select count(*)::int from im_message_deliveries
              where state = 'accepted' and reported_at is null
            ) as accepted_unreported,
            (
              select count(*)::int from slack_installations
              where status = 'disabled' and replacement_slack_installation_id = ${SLACK_ACTIVE_ID}
            ) as replaced_slack
        `;
        expect(after).toEqual({
          migrations: journal.entries.length,
          workspace_computers: 2,
          credentials: 2,
          codes: 2,
          agents: 1,
          placements: 2,
          proofs: 1,
          slack: 2,
          deliveries: 2,
          account_computers: 0,
          computer_credentials: 0,
          agents_computer_id: 0,
          placement_computer_id: 0,
          proof_computer_id: 0,
          slack_agent_id: 0,
          code_projections: 0,
          owner_mismatch: 1,
          active_credentials: 1,
          revoked_credentials: 1,
          unconsumed_codes: 1,
          consumed_codes: 1,
          ended_sessions: 1,
          pending_deliveries: 1,
          accepted_unreported: 1,
          replaced_slack: 1,
        });
        const schema = await expansionSchema(sql);
        expect(schema?.hazards).toEqual([...HAZARD_CONSTRAINTS].sort());
        expect(schema?.hazard_indexes).toEqual([...HAZARD_INDEXES].sort());
        const [stable] = await sql<{ enrollment_id: string; credential_hash: string; agent_creator: string }[]>`
          select
            ${ACTIVE_ENROLLMENT_ID}::text as enrollment_id,
            (select secret_hash from workspace_computer_credentials where id = ${ACTIVE_CREDENTIAL_ID}) as credential_hash,
            (select created_by_user_id::text from agents where id = ${AGENT_ID}) as agent_creator
        `;
        expect(stable).toEqual({
          enrollment_id: ACTIVE_ENROLLMENT_ID,
          credential_hash: "a".repeat(64),
          agent_creator: CREATOR_ID,
        });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(legacyFolder, { force: true, recursive: true });
    }
  });

  it("upgrades representative 0024 Slack-install history through 0026 without filling agent_id", async () => {
    const journal = await readJournal();
    const legacyFolder = await truncatedMigrations(24);
    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const userId = crypto.randomUUID();
        const workspaceId = crypto.randomUUID();
        await sql`insert into users (id, email, display_name) values (${userId}, 'hist@example.com', 'Hist')`;
        await sql`insert into workspaces (id, name, display_name) values (${workspaceId}, 'hist', 'Hist')`;
        await sql`
          insert into slack_installations (
            workspace_id, status, external_app_id, external_team_id, external_bot_id,
            credential_schema_version, credential_generation, encrypted_credential, activated_at
          )
          values (
            ${workspaceId}, 'active', 'A_HIST', 'T_HIST', 'U_HIST', 1, 1, 'encrypted', now()
          )
        `;
        const [before] = await sql<{ migrations: number; slack: number }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (select count(*)::int from slack_installations) as slack
        `;
        expect(before).toEqual({ migrations: 25, slack: 1 });

        await migrateDatabase(databaseUrl, migrationsFolder);
        const [after] = await sql<{ migrations: number; slack: number; filled: number; installation: string }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (select count(*)::int from slack_installations) as slack,
            (select count(*)::int from slack_installations where agent_id is not null) as filled,
            (select external_app_id from slack_installations limit 1) as installation
        `;
        expect(after).toEqual({
          migrations: journal.entries.length,
          slack: 1,
          filled: 0,
          installation: "A_HIST",
        });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(legacyFolder, { force: true, recursive: true });
    }
  });

  it("rolls back a failed 0026 transaction and retries the checked-in migration", async () => {
    const journal = await readJournal();
    const through0025 = await truncatedMigrations(25);
    try {
      await migrateDatabase(databaseUrl, through0025);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await sql`insert into users (id, email, display_name) values (${OWNER_ID}, 'retry@example.com', 'Retry')`;
        await sql.unsafe("create table computer_credentials (id integer primary key)");
        await sql.unsafe("insert into computer_credentials (id) values (1)");

        await expect(migrateDatabase(databaseUrl, migrationsFolder)).rejects.toThrow(/computer_credentials/);
        const [failed] = await sql<
          {
            migrations: number;
            account_computers: string | null;
            mode_enum: boolean;
            agents_computer_id: boolean;
            dummy_type: string | null;
            dummy_rows: number;
            users: number;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            to_regclass('public.account_computers')::text as account_computers,
            exists(select 1 from pg_type where typname = 'computer_connect_code_mode') as mode_enum,
            exists(
              select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'computer_id'
            ) as agents_computer_id,
            (
              select data_type from information_schema.columns
              where table_schema = 'public' and table_name = 'computer_credentials' and column_name = 'id'
            ) as dummy_type,
            (select count(*)::int from computer_credentials) as dummy_rows,
            (select count(*)::int from users) as users
        `;
        expect(failed).toEqual({
          migrations: 26,
          account_computers: null,
          mode_enum: false,
          agents_computer_id: false,
          dummy_type: "integer",
          dummy_rows: 1,
          users: 1,
        });

        await sql.unsafe("drop table computer_credentials");
        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
        const [retried] = await sql<
          {
            migrations: number;
            account_computers: string | null;
            mode_enum: boolean;
            credential_id_type: string | null;
            users: number;
            account_rows: number;
            credential_rows: number;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            to_regclass('public.account_computers')::text as account_computers,
            exists(select 1 from pg_type where typname = 'computer_connect_code_mode') as mode_enum,
            (
              select data_type from information_schema.columns
              where table_schema = 'public' and table_name = 'computer_credentials' and column_name = 'id'
            ) as credential_id_type,
            (select count(*)::int from users) as users,
            (select count(*)::int from account_computers) as account_rows,
            (select count(*)::int from computer_credentials) as credential_rows
        `;
        expect(retried).toEqual({
          migrations: journal.entries.length,
          account_computers: "account_computers",
          mode_enum: true,
          credential_id_type: "uuid",
          users: 1,
          account_rows: 0,
          credential_rows: 0,
        });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0025, { force: true, recursive: true });
    }
  });

  it("preserves legacy enrollment hazards and fail-closes new projection constraints", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    const client = createDatabaseClient(databaseUrl);
    try {
      const bootstrap = await bootstrapInitialAdmin(client.database, {
        displayName: "Admin",
        email: "admin@example.com",
        workspaceDisplayName: "Example",
        workspaceName: "example",
      });
      const sql = client.sql;
      const [hazards] = await sql<{ constraints: string[]; indexes: string[] }[]>`
        select
          array(
            select conname::text from pg_constraint
            where conname in ('computer_connect_codes_workspace_enrollment_fk', 'agents_workspace_enrollment_fk')
            order by conname
          ) as constraints,
          array(
            select indexname::text from pg_indexes
            where indexname in (
              'slack_installations_workspace_current_unique',
              'session_placements_workspace_computer_id_idx'
            )
            order by indexname
          ) as indexes
      `;
      expect(hazards).toEqual({
        constraints: [...HAZARD_CONSTRAINTS].sort(),
        indexes: [...HAZARD_INDEXES].sort(),
      });

      const computerId = crypto.randomUUID();
      await sql`insert into computers (id) values (${computerId})`;
      const [enrollment] = await sql<{ id: string }[]>`
        insert into workspace_computers (
          workspace_id, computer_id, display_name, platform, arch, client_version, enrolled_by_user_id
        )
        values (${bootstrap.workspaceId}, ${computerId}, 'box', 'linux', 'x64', '0.0.1', ${bootstrap.userId})
        returning id::text
      `;
      if (!enrollment) throw new Error("Enrollment fixture was not created");
      await sql`
        insert into account_computers (
          id, owner_account_id, current_installation_id, display_name, platform, arch, client_version
        )
        values (${enrollment.id}, ${bootstrap.userId}, ${computerId}, 'box', 'linux', 'x64', '0.0.1')
      `;

      const orphan = await sql`
        insert into agents (workspace_id, created_by_user_id, workspace_computer_id, computer_id, name, display_name, runtime_provider)
        values (
          ${bootstrap.workspaceId}, ${bootstrap.userId}, ${enrollment.id}, ${crypto.randomUUID()},
          'orphan', 'Orphan', 'codex'
        )
      `.catch((error: unknown) => error);
      expect(postgresError(orphan)).toMatchObject({
        code: "23503",
        constraint_name: "agents_computer_id_account_computers_id_fk",
      });

      await sql`
        insert into computer_credentials (computer_id, secret_hash, issued_by_user_id)
        values (${enrollment.id}, ${"f".repeat(64)}, ${bootstrap.userId})
      `;
      const duplicateActive = await sql`
        insert into computer_credentials (computer_id, secret_hash, issued_by_user_id)
        values (${enrollment.id}, ${"0".repeat(64)}, ${bootstrap.userId})
      `.catch((error: unknown) => error);
      expect(postgresError(duplicateActive)).toMatchObject({
        code: "23505",
        constraint_name: "computer_credentials_active_computer_unique",
      });

      const revocationPair = await sql`
        insert into computer_credentials (computer_id, secret_hash, issued_by_user_id, revoked_at)
        values (${enrollment.id}, ${"1".repeat(64)}, ${bootstrap.userId}, now())
      `.catch((error: unknown) => error);
      expect(postgresError(revocationPair)).toMatchObject({
        code: "23514",
        constraint_name: "computer_credentials_revocation_pair",
      });

      const otherWorkspace = crypto.randomUUID();
      await sql`insert into workspaces (id, name, display_name) values (${otherWorkspace}, 'other', 'Other')`;
      const crossCode = await sql`
        insert into computer_connect_codes (
          workspace_id, token_hash, issued_by_user_id, expires_at, consumed_workspace_computer_id, consumed_at
        )
        values (
          ${otherWorkspace}, ${"2".repeat(64)}, ${bootstrap.userId}, now() + interval '15 minutes',
          ${enrollment.id}, now()
        )
      `.catch((error: unknown) => error);
      expect(postgresError(crossCode)).toMatchObject({
        code: "23503",
        constraint_name: "computer_connect_codes_workspace_enrollment_fk",
      });

      await sql`
        insert into slack_installations (
          workspace_id, status, external_app_id, external_team_id, external_bot_id,
          credential_schema_version, credential_generation, encrypted_credential, activated_at
        )
        values (
          ${bootstrap.workspaceId}, 'active', 'A1', 'T1', 'U1', 1, 1, 'secret', now()
        )
      `;
      const duplicateSlack = await sql`
        insert into slack_installations (
          workspace_id, status, external_app_id, external_team_id, external_bot_id,
          credential_schema_version, credential_generation, encrypted_credential, activated_at
        )
        values (
          ${bootstrap.workspaceId}, 'active', 'A2', 'T2', 'U2', 1, 1, 'secret-2', now()
        )
      `.catch((error: unknown) => error);
      expect(postgresError(duplicateSlack)).toMatchObject({
        code: "23505",
        constraint_name: "slack_installations_workspace_current_unique",
      });

      const [otherEnrollment] = await sql<{ id: string }[]>`
        insert into workspace_computers (
          workspace_id, computer_id, display_name, platform, arch, client_version, enrolled_by_user_id
        )
        values (${otherWorkspace}, ${computerId}, 'other-box', 'linux', 'x64', '0.0.1', ${bootstrap.userId})
        returning id::text
      `;
      if (!otherEnrollment) throw new Error("Cross-workspace enrollment fixture was not created");
      const crossAgent = await sql`
        insert into agents (workspace_id, created_by_user_id, workspace_computer_id, name, display_name, runtime_provider)
        values (
          ${bootstrap.workspaceId}, ${bootstrap.userId}, ${otherEnrollment.id},
          'cross', 'Cross', 'codex'
        )
      `.catch((error: unknown) => error);
      expect(postgresError(crossAgent)).toMatchObject({
        code: "23503",
        constraint_name: "agents_workspace_enrollment_fk",
      });
    } finally {
      await client.sql.end();
    }
  });

  it("accepts representative reads and dual-writes after the real migration runner", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
    const client = createDatabaseClient(databaseUrl);
    try {
      const bootstrap = await bootstrapInitialAdmin(client.database, {
        displayName: "Admin",
        email: "admin@example.com",
        workspaceDisplayName: "Example",
        workspaceName: "example",
      });
      const machineAuth = new MachineAuthService(client.database);
      const computers = new ComputerService(client.database, {
        getActiveUserById: async () => {
          throw new Error("unused");
        },
      });
      const issued = await machineAuth.issueForWorkspaceAdmin(bootstrap.userId, bootstrap.workspaceId);
      const enrollment = await machineAuth.exchangeConnectCode({
        code: issued.code,
        computerId: crypto.randomUUID(),
        displayName: "workstation",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
      });
      const instanceId = crypto.randomUUID();
      await computers.register(enrollment, {
        type: "computer:register",
        requestId: crypto.randomUUID(),
        computerId: enrollment.computerId,
        instanceId,
        displayName: "workstation",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
        capabilities: { imCredentialGrant: 0 as const },
        protocolVersion: RUNTIME_PROTOCOL_V2,
        supportedCapabilities: { imCredentialGrant: { min: 1, max: 1 } },
        requiredServerCapabilities: [],
      });

      const [legacy] = await client.database
        .select()
        .from(workspaceComputers)
        .where(eq(workspaceComputers.id, enrollment.workspaceComputerId));
      const [target] = await client.database
        .select()
        .from(accountComputers)
        .where(eq(accountComputers.id, enrollment.workspaceComputerId));
      expect(target).toMatchObject({
        id: enrollment.workspaceComputerId,
        ownerAccountId: bootstrap.userId,
        currentInstallationId: enrollment.computerId,
        currentInstanceId: instanceId,
        displayName: legacy?.displayName,
      });
      const [legacyCredential] = await client.database
        .select()
        .from(workspaceComputerCredentials)
        .where(eq(workspaceComputerCredentials.id, enrollment.credentialId));
      const [targetCredential] = await client.database
        .select()
        .from(computerCredentials)
        .where(eq(computerCredentials.id, enrollment.credentialId));
      expect(targetCredential).toMatchObject({
        id: enrollment.credentialId,
        computerId: enrollment.workspaceComputerId,
        secretHash: legacyCredential?.secretHash,
        issuedByUserId: bootstrap.userId,
        revokedAt: null,
      });
      const codes = await client.database.select().from(computerConnectCodes);
      expect(codes).toHaveLength(1);
      expect(codes[0]).toMatchObject({
        issuedByAccountId: bootstrap.userId,
        mode: "create",
        consumedComputerId: enrollment.workspaceComputerId,
        consumedWorkspaceComputerId: enrollment.workspaceComputerId,
      });

      const agent = await new AgentService(client.database).createForWorkspace(
        bootstrap.userId,
        bootstrap.workspaceId,
        {
          name: "assistant",
          displayName: "Assistant",
          runtimeProvider: "codex",
          computerId: enrollment.computerId,
        },
      );
      const [agentRow] = await client.database.select().from(agents).where(eq(agents.id, agent.id));
      expect(agentRow).toMatchObject({
        createdByUserId: bootstrap.userId,
        workspaceComputerId: enrollment.workspaceComputerId,
        computerId: enrollment.workspaceComputerId,
      });

      const [binding] = await client.sql<{ id: string }[]>`
        insert into im_bindings (
          agent_id, provider, status, external_app_id, external_bot_id,
          credential_schema_version, credential_generation, encrypted_credential, activated_at
        )
        values (
          ${agent.id}, 'feishu', 'active', 'cli_boot', 'ou_boot', 1, 1, 'encrypted', now()
        )
        returning id::text
      `;
      if (!binding) throw new Error("IM binding was not created");
      const sessions = new SessionService(client.database);
      const chat = await sessions.ensureChatSession(
        { imBindingId: binding.id, channelId: "C-boot", conversationKind: "channel" },
        "channel",
      );
      expect(chat.placement.workspaceComputerId).toBe(enrollment.workspaceComputerId);
      const [placement] = await client.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, chat.session.id));
      expect(placement).toMatchObject({
        workspaceComputerId: enrollment.workspaceComputerId,
        computerId: enrollment.workspaceComputerId,
        generation: 1,
      });

      const proofs = new SessionCliProofService(
        client.database,
        {
          currentInstanceId: (workspaceComputerId: string) =>
            workspaceComputerId === enrollment.workspaceComputerId ? instanceId : undefined,
          supportsCapability: (workspaceComputerId: string, connectionInstanceId: string) =>
            workspaceComputerId === enrollment.workspaceComputerId && connectionInstanceId === instanceId,
        },
        new Uint8Array(32).fill(3),
      );
      const minted = await proofs.mint({
        sessionId: chat.session.id,
        workspaceComputerId: enrollment.workspaceComputerId,
        placementGeneration: 1,
        connectionInstanceId: instanceId,
      });
      const [proof] = await client.database
        .select()
        .from(sessionCliProofs)
        .where(eq(sessionCliProofs.sessionId, chat.session.id));
      expect(proof).toMatchObject({
        proofId: minted.proofId,
        workspaceComputerId: enrollment.workspaceComputerId,
        computerId: enrollment.workspaceComputerId,
      });

      const moved = await sessions.movePlacement(chat.session.id, enrollment.workspaceComputerId);
      expect(moved).toMatchObject({
        workspaceComputerId: enrollment.workspaceComputerId,
        generation: 2,
      });
      const [movedRow] = await client.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, chat.session.id));
      expect(movedRow?.computerId).toBe(enrollment.workspaceComputerId);

      const [message] = await client.sql<{ id: string }[]>`
        insert into im_messages (
          im_binding_id, channel_id, external_message_id, provider_revision_key, operation, direction,
          author_kind, author_external_id, content, provider_context, occurred_at
        )
        values (
          ${binding.id}, 'C-boot', 'om_boot', '1', 'created', 'inbound',
          'human', 'ou_boot',
          '{"version":1,"fallbackText":"custody","blocks":[],"truncated":false}'::jsonb,
          '{"provider":"feishu","chatType":"p2p"}'::jsonb,
          now()
        )
        returning id::text
      `;
      if (!message) throw new Error("Custody message was not created");
      await client.sql`
        insert into im_message_deliveries (
          message_id, session_id, attention, state, placement_generation, attempt_count,
          next_attempt_at, expires_at, accepted_at, turn_id, input_hash, report_owner_instance_id
        )
        values (
          ${message.id}, ${chat.session.id}, 'direct', 'accepted', 2, 1,
          now(), now() + interval '1 day', now(), 'turn-boot', ${"b".repeat(64)}, ${instanceId}
        )
      `;
      await expect(sessions.movePlacement(chat.session.id, enrollment.workspaceComputerId)).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_PENDING",
      });
      const [blocked] = await client.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, chat.session.id));
      expect(blocked).toMatchObject({
        generation: 2,
        computerId: enrollment.workspaceComputerId,
        workspaceComputerId: enrollment.workspaceComputerId,
      });
    } finally {
      await client.sql.end();
    }
  });
});
