import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PROTOCOL_V2 } from "@opentag/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "../../db/migrate.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { SessionCliProofService, SessionService } from "../../services/sessions/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

const THROUGH_0030_COUNT = 31;

const ACCOUNT_A = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT_B = "00000000-0000-4000-8000-0000000000a2";
const WS_A = "00000000-0000-4000-8000-0000000000b1";
const WS_B = "00000000-0000-4000-8000-0000000000b2";
const INST_A1 = "00000000-0000-4000-8000-0000000000d1";
const INST_A2 = "00000000-0000-4000-8000-0000000000d2";
const COMP_A1 = "00000000-0000-4000-8000-0000000000c1";
const COMP_A2 = "00000000-0000-4000-8000-0000000000c2";
const CRED_ACTIVE = "00000000-0000-4000-8000-0000000000e1";
const CRED_REVOKED = "00000000-0000-4000-8000-0000000000e2";
const CODE_CREATE = "00000000-0000-4000-8000-0000000000f1";
const CODE_REPAIR = "00000000-0000-4000-8000-0000000000f2";
const CODE_OPEN = "00000000-0000-4000-8000-0000000000f3";
const CODE_REVOKED = "00000000-0000-4000-8000-0000000000f4";
const AGENT_ACTIVE = "00000000-0000-4000-8000-00000000001a";
const AGENT_DELETED = "00000000-0000-4000-8000-00000000001b";
const BINDING = "00000000-0000-4000-8000-00000000001c";
const SESSION_ACTIVE = "00000000-0000-4000-8000-00000000001d";
const SESSION_ENDED = "00000000-0000-4000-8000-00000000001e";
const PROOF = "00000000-0000-4000-8000-00000000001f";
const SLACK_CURRENT = "00000000-0000-4000-8000-00000000002a";
const SLACK_REPLACED = "00000000-0000-4000-8000-00000000002b";
const MESSAGE = "00000000-0000-4000-8000-00000000002c";
const DELIVERY_PENDING = "00000000-0000-4000-8000-00000000002d";
const DELIVERY_ACCEPTED = "00000000-0000-4000-8000-00000000002e";
const INSTANCE_CURRENT = "00000000-0000-4000-8000-00000000003a";
const INSTANCE_STALE = "00000000-0000-4000-8000-00000000003b";

const EARLY = new Date("2026-08-20T00:00:00.000Z");
const LATE = new Date("2026-08-21T00:00:00.000Z");

type Journal = {
  entries: Array<{ idx: number; tag: string; when: number }>;
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
  const folder = await mkdtemp(join(tmpdir(), `opentag-pr6-${lastIndex}-`));
  await mkdir(join(folder, "meta"));
  const entries = journal.entries.filter(({ idx }) => idx <= lastIndex);
  for (const entry of entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  return folder;
}

/**
 * A populated 0030 database: active and terminal records across every table the contract
 * migration touches, including a stale Session CLI proof instance and unconsumed codes.
 * This is an explicit historical upgrade fixture, so it writes pre-contract legacy rows.
 */
async function populateActive0030(sql: postgres.Sql): Promise<void> {
  await sql`
    insert into users (id, email, display_name, setup_completed_at)
    values
      (${ACCOUNT_A}, 'a@example.com', 'A', ${EARLY}),
      (${ACCOUNT_B}, 'b@example.com', 'B', null)
  `;
  await sql`
    insert into workspaces (id, name, display_name, setup_completed_at)
    values
      (${WS_A}, 'schema-a', 'Schema A', ${EARLY}),
      (${WS_B}, 'schema-b', 'Schema B', null)
  `;
  await sql`insert into computers (id, created_at) values (${INST_A1}, ${EARLY}), (${INST_A2}, ${EARLY})`;
  await sql`
    insert into workspace_computers (
      id, workspace_id, computer_id, display_name, platform, arch, client_version,
      enrolled_by_user_id, enrolled_at, current_instance_id, connected_at, last_seen_at, updated_at
    )
    values
      (
        ${COMP_A1}, ${WS_A}, ${INST_A1}, 'active-box', 'linux', 'x64', '0.0.2',
        ${ACCOUNT_A}, ${EARLY}, ${INSTANCE_CURRENT}, ${EARLY}, ${EARLY}, ${EARLY}
      ),
      (
        ${COMP_A2}, ${WS_A}, ${INST_A2}, 'stale-box', 'darwin', 'arm64', '0.0.2',
        ${ACCOUNT_A}, ${EARLY}, ${INSTANCE_STALE}, ${EARLY}, ${EARLY}, ${EARLY}
      )
  `;
  await sql`
    insert into account_computers (
      id, owner_account_id, current_installation_id, display_name, platform, arch, client_version,
      current_instance_id, connected_at, last_seen_at, created_at, updated_at
    )
    values
      (
        ${COMP_A1}, ${ACCOUNT_A}, ${INST_A1}, 'active-box', 'linux', 'x64', '0.0.2',
        ${INSTANCE_CURRENT}, ${EARLY}, ${EARLY}, ${EARLY}, ${EARLY}
      ),
      (
        ${COMP_A2}, ${ACCOUNT_A}, ${INST_A2}, 'stale-box', 'darwin', 'arm64', '0.0.2',
        ${INSTANCE_STALE}, ${EARLY}, ${EARLY}, ${EARLY}, ${EARLY}
      )
  `;
  await sql`
    insert into workspace_computer_credentials (id, workspace_computer_id, secret_hash, issued_by_user_id, issued_at)
    values (${CRED_ACTIVE}, ${COMP_A1}, ${"a".repeat(64)}, ${ACCOUNT_A}, ${EARLY})
  `;
  await sql`
    insert into workspace_computer_credentials (
      id, workspace_computer_id, secret_hash, issued_by_user_id, issued_at, revoked_by_user_id, revoked_at
    )
    values (${CRED_REVOKED}, ${COMP_A1}, ${"b".repeat(64)}, ${ACCOUNT_A}, ${EARLY}, ${ACCOUNT_A}, ${LATE})
  `;
  await sql`
    insert into computer_credentials (id, computer_id, secret_hash, issued_by_user_id, issued_at)
    values (${CRED_ACTIVE}, ${COMP_A1}, ${"a".repeat(64)}, ${ACCOUNT_A}, ${EARLY})
  `;
  await sql`
    insert into computer_credentials (
      id, computer_id, secret_hash, issued_by_user_id, issued_at, revoked_by_user_id, revoked_at
    )
    values (${CRED_REVOKED}, ${COMP_A1}, ${"b".repeat(64)}, ${ACCOUNT_A}, ${EARLY}, ${ACCOUNT_A}, ${LATE})
  `;
  await sql`
    insert into computer_connect_codes (
      id, workspace_id, token_hash, issued_by_user_id, issued_by_account_id, mode, created_at, expires_at,
      consumed_workspace_computer_id, consumed_computer_id, consumed_at
    )
    values (
      ${CODE_CREATE}, ${WS_A}, ${"c".repeat(64)}, ${ACCOUNT_A}, ${ACCOUNT_A}, 'create', ${EARLY}, ${LATE},
      ${COMP_A1}, ${COMP_A1}, ${EARLY}
    )
  `;
  await sql`
    insert into computer_connect_codes (
      id, workspace_id, token_hash, issued_by_user_id, issued_by_account_id, mode, target_computer_id,
      created_at, expires_at
    )
    values (
      ${CODE_REPAIR}, ${WS_A}, ${"d".repeat(64)}, ${ACCOUNT_A}, ${ACCOUNT_A}, 'repair', ${COMP_A1}, ${EARLY}, ${LATE}
    )
  `;
  await sql`
    insert into computer_connect_codes (
      id, workspace_id, token_hash, issued_by_user_id, issued_by_account_id, mode, created_at, expires_at
    )
    values (${CODE_OPEN}, ${WS_A}, ${"e".repeat(64)}, ${ACCOUNT_A}, ${ACCOUNT_A}, 'create', ${EARLY}, ${LATE})
  `;
  await sql`
    insert into computer_connect_codes (
      id, workspace_id, token_hash, issued_by_user_id, issued_by_account_id, mode, created_at, expires_at,
      revoked_by_user_id, revoked_at
    )
    values (
      ${CODE_REVOKED}, ${WS_A}, ${"f".repeat(64)}, ${ACCOUNT_A}, ${ACCOUNT_A}, 'create', ${EARLY}, ${LATE},
      ${ACCOUNT_A}, ${LATE}
    )
  `;
  await sql`
    insert into agents (
      id, workspace_id, created_by_user_id, workspace_computer_id, computer_id,
      name, display_name, runtime_provider, status, created_at, updated_at
    )
    values
      (
        ${AGENT_ACTIVE}, ${WS_A}, ${ACCOUNT_A}, ${COMP_A1}, ${COMP_A1},
        'active-agent', 'Active Agent', 'codex', 'active', ${EARLY}, ${EARLY}
      ),
      (
        ${AGENT_DELETED}, ${WS_A}, ${ACCOUNT_A}, ${COMP_A1}, ${COMP_A1},
        'deleted-agent', 'Deleted Agent', 'codex', 'deleted', ${EARLY}, ${LATE}
      )
  `;
  await sql`
    insert into im_bindings (
      id, agent_id, provider, status, external_app_id, external_bot_id,
      credential_schema_version, credential_generation, encrypted_credential, activated_at
    )
    values (${BINDING}, ${AGENT_ACTIVE}, 'feishu', 'active', 'cli_matrix', 'ou_matrix', 1, 1, 'encrypted', ${EARLY})
  `;
  await sql`
    insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, created_at)
    values
      (${SESSION_ACTIVE}, ${BINDING}, 'C-active', 'channel', 'channel', ${EARLY}),
      (${SESSION_ENDED}, ${BINDING}, 'C-ended', 'channel', 'channel', ${EARLY})
  `;
  await sql`update sessions set ended_at = ${LATE} where id = ${SESSION_ENDED}`;
  await sql`
    insert into session_placements (session_id, workspace_computer_id, computer_id, generation, updated_at)
    values
      (${SESSION_ACTIVE}, ${COMP_A1}, ${COMP_A1}, 2, ${LATE}),
      (${SESSION_ENDED}, ${COMP_A1}, ${COMP_A1}, 1, ${EARLY})
  `;
  await sql`
    insert into session_cli_proofs (
      session_id, proof_id, token_hash, workspace_computer_id, computer_id, placement_generation,
      connection_instance_id, created_at, updated_at
    )
    values (
      ${SESSION_ACTIVE}, ${PROOF}, ${"1".repeat(64)}, ${COMP_A1}, ${COMP_A1}, 2, ${INSTANCE_STALE}, ${EARLY}, ${LATE}
    )
  `;
  await sql`
    insert into slack_installations (
      id, workspace_id, agent_id, status, external_app_id, external_team_id, external_bot_id,
      credential_schema_version, credential_generation, encrypted_credential, activated_at, created_at, updated_at
    )
    values (
      ${SLACK_CURRENT}, ${WS_A}, ${AGENT_ACTIVE}, 'active', 'A_APP', 'T_TEAM', 'U_BOT',
      1, 2, 'encrypted-slack', ${EARLY}, ${EARLY}, ${EARLY}
    )
  `;
  await sql`
    insert into slack_installations (
      id, workspace_id, agent_id, status, external_app_id, external_team_id, external_bot_id,
      credential_generation, replacement_slack_installation_id, disabled_at, created_at, updated_at
    )
    values (
      ${SLACK_REPLACED}, ${WS_A}, ${AGENT_ACTIVE}, 'disabled', 'A_APP', 'T_TEAM', 'U_OLD',
      1, ${SLACK_CURRENT}, ${LATE}, ${EARLY}, ${LATE}
    )
  `;
  await sql`
    insert into im_messages (
      id, im_binding_id, channel_id, external_message_id, provider_revision_key, operation, direction,
      author_kind, author_external_id, content, provider_context, occurred_at, received_at
    )
    values (
      ${MESSAGE}, ${BINDING}, 'C-active', 'om_matrix', '1', 'created', 'inbound',
      'human', 'ou_human',
      '{"version":1,"fallbackText":"hi","blocks":[],"truncated":false}'::jsonb,
      '{"provider":"feishu","chatType":"p2p"}'::jsonb,
      ${EARLY}, ${EARLY}
    )
  `;
  await sql`
    insert into im_message_deliveries (
      id, message_id, session_id, attention, state, placement_generation, attempt_count,
      next_attempt_at, expires_at
    )
    values (
      ${DELIVERY_PENDING}, ${MESSAGE}, ${SESSION_ACTIVE}, 'direct', 'pending', 2, 0, ${EARLY}, ${LATE}
    )
  `;
  await sql`
    insert into im_message_deliveries (
      id, message_id, session_id, attention, state, placement_generation, attempt_count,
      next_attempt_at, expires_at, accepted_at, turn_id, input_hash, report_owner_instance_id
    )
    values (
      ${DELIVERY_ACCEPTED}, ${MESSAGE}, ${SESSION_ENDED}, 'direct', 'accepted', 1, 1,
      ${EARLY}, ${LATE}, ${EARLY}, 'turn-matrix', ${"9".repeat(64)}, ${INSTANCE_CURRENT}
    )
  `;
}

interface FinalShape {
  migrations: number;
  legacy_tables: number;
  legacy_columns: number;
  computers: number;
  credentials: number;
  codes: number;
  agents: number;
  slack: number;
  sessions: number;
  placements: number;
  proofs: number;
  deliveries: number;
}

async function finalShape(sql: postgres.Sql): Promise<FinalShape> {
  const [row] = await sql<FinalShape[]>`
    select
      (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
      (
        select count(*)::int from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'workspaces', 'workspace_admin_grants', 'admin_invitations',
            'workspace_computers', 'workspace_computer_credentials', 'account_computers'
          )
      ) as legacy_tables,
      (
        select count(*)::int from information_schema.columns
        where table_schema = 'public'
          and column_name in ('workspace_id', 'workspace_computer_id', 'consumed_workspace_computer_id')
      ) as legacy_columns,
      (select count(*)::int from computers) as computers,
      (select count(*)::int from computer_credentials) as credentials,
      (select count(*)::int from computer_connect_codes) as codes,
      (select count(*)::int from agents) as agents,
      (select count(*)::int from slack_installations) as slack,
      (select count(*)::int from sessions) as sessions,
      (select count(*)::int from session_placements) as placements,
      (select count(*)::int from session_cli_proofs) as proofs,
      (select count(*)::int from im_message_deliveries) as deliveries
  `;
  if (!row) throw new Error("Final shape query returned no row");
  return row;
}

async function expectCanonicalDataPreserved(sql: postgres.Sql): Promise<void> {
  const computers = await sql<
    { id: string; owner: string; installation: string; display: string; instance: string | null }[]
  >`
    select
      id::text as id,
      owner_account_id::text as owner,
      current_installation_id::text as installation,
      display_name as display,
      current_instance_id::text as instance
    from computers
    order by id
  `;
  expect(computers).toEqual([
    { id: COMP_A1, owner: ACCOUNT_A, installation: INST_A1, display: "active-box", instance: INSTANCE_CURRENT },
    { id: COMP_A2, owner: ACCOUNT_A, installation: INST_A2, display: "stale-box", instance: INSTANCE_STALE },
  ]);

  const credentials = await sql<
    { id: string; computer: string; hash: string; issuedBy: string; revokedBy: string | null }[]
  >`
    select
      id::text as id,
      computer_id::text as computer,
      secret_hash as hash,
      issued_by_user_id::text as "issuedBy",
      revoked_by_user_id::text as "revokedBy"
    from computer_credentials
    order by id
  `;
  expect(credentials).toEqual([
    { id: CRED_ACTIVE, computer: COMP_A1, hash: "a".repeat(64), issuedBy: ACCOUNT_A, revokedBy: null },
    { id: CRED_REVOKED, computer: COMP_A1, hash: "b".repeat(64), issuedBy: ACCOUNT_A, revokedBy: ACCOUNT_A },
  ]);

  const codes = await sql<
    { id: string; account: string; mode: string; target: string | null; consumed: string | null }[]
  >`
    select
      id::text as id,
      issued_by_account_id::text as account,
      mode::text as mode,
      target_computer_id::text as target,
      consumed_computer_id::text as consumed
    from computer_connect_codes
    order by id
  `;
  expect(codes).toEqual([
    { id: CODE_CREATE, account: ACCOUNT_A, mode: "create", target: null, consumed: COMP_A1 },
    { id: CODE_REPAIR, account: ACCOUNT_A, mode: "repair", target: COMP_A1, consumed: null },
    { id: CODE_OPEN, account: ACCOUNT_A, mode: "create", target: null, consumed: null },
    { id: CODE_REVOKED, account: ACCOUNT_A, mode: "create", target: null, consumed: null },
  ]);

  const agentRows = await sql<{ id: string; computer: string; status: string }[]>`
    select id::text as id, computer_id::text as computer, status::text as status
    from agents
    order by id
  `;
  expect(agentRows).toEqual([
    { id: AGENT_ACTIVE, computer: COMP_A1, status: "active" },
    { id: AGENT_DELETED, computer: COMP_A1, status: "deleted" },
  ]);

  const slack = await sql<{ id: string; agent: string; status: string; replacement: string | null }[]>`
    select
      id::text as id,
      agent_id::text as agent,
      status::text as status,
      replacement_slack_installation_id::text as replacement
    from slack_installations
    order by id
  `;
  expect(slack).toEqual([
    { id: SLACK_CURRENT, agent: AGENT_ACTIVE, status: "active", replacement: null },
    { id: SLACK_REPLACED, agent: AGENT_ACTIVE, status: "disabled", replacement: SLACK_CURRENT },
  ]);

  const placements = await sql<{ session: string; computer: string; generation: number }[]>`
    select session_id::text as session, computer_id::text as computer, generation::int
    from session_placements
    order by session_id
  `;
  expect(placements).toEqual([
    { session: SESSION_ACTIVE, computer: COMP_A1, generation: 2 },
    { session: SESSION_ENDED, computer: COMP_A1, generation: 1 },
  ]);

  const proofs = await sql<{ proof: string; computer: string; generation: number; instance: string }[]>`
    select
      proof_id::text as proof,
      computer_id::text as computer,
      placement_generation::int as generation,
      connection_instance_id::text as instance
    from session_cli_proofs
  `;
  expect(proofs).toEqual([{ proof: PROOF, computer: COMP_A1, generation: 2, instance: INSTANCE_STALE }]);

  const deliveries = await sql<{ id: string; state: string; generation: number; reported: string | null }[]>`
    select id::text as id, state::text as state, placement_generation::int as generation, reported_at::text as reported
    from im_message_deliveries
    order by id
  `;
  expect(deliveries).toEqual([
    { id: DELIVERY_PENDING, state: "pending", generation: 2, reported: null },
    { id: DELIVERY_ACCEPTED, state: "accepted", generation: 1, reported: null },
  ]);

  const accounts = await sql<{ id: string; setup: Date | null }[]>`
    select id::text as id, setup_completed_at as setup from users order by id
  `;
  expect(accounts).toEqual([
    { id: ACCOUNT_A, setup: EARLY },
    { id: ACCOUNT_B, setup: null },
  ]);
}

async function expectFinalSchema(sql: postgres.Sql, migrations: number): Promise<void> {
  const shape = await finalShape(sql);
  expect(shape).toMatchObject({
    migrations,
    legacy_tables: 0,
    legacy_columns: 0,
    computers: 2,
    credentials: 2,
    codes: 4,
    agents: 2,
    slack: 2,
    sessions: 2,
    placements: 2,
    proofs: 1,
    deliveries: 2,
  });
  const constraints = await sql<{ conname: string }[]>`
    select conname from pg_constraint
    where conname in (
      'agents_computer_id_computers_id_fk',
      'computer_credentials_computer_id_computers_id_fk',
      'session_placements_computer_id_computers_id_fk',
      'session_cli_proofs_computer_id_computers_id_fk',
      'computer_connect_codes_target_computer_id_computers_id_fk',
      'computer_connect_codes_consumed_computer_id_computers_id_fk'
    )
    order by conname
  `;
  expect(constraints.map(({ conname }) => conname)).toEqual([
    "agents_computer_id_computers_id_fk",
    "computer_connect_codes_consumed_computer_id_computers_id_fk",
    "computer_connect_codes_target_computer_id_computers_id_fk",
    "computer_credentials_computer_id_computers_id_fk",
    "session_cli_proofs_computer_id_computers_id_fk",
    "session_placements_computer_id_computers_id_fk",
  ]);
  const indexes = await sql<{ indexname: string }[]>`
    select indexname from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'computers_current_installation_id_unique',
        'computers_owner_account_id_idx',
        'agents_account_name_active_unique',
        'agents_creation_intent_unique'
      )
    order by indexname
  `;
  expect(indexes.map(({ indexname }) => indexname)).toEqual([
    "agents_account_name_active_unique",
    "agents_creation_intent_unique",
    "computers_current_installation_id_unique",
    "computers_owner_account_id_idx",
  ]);
  const legacyConstraints = await sql<{ count: number }[]>`
    select count(*)::int as count from pg_constraint
    where conname in (
      'agents_computer_matches_enrollment',
      'agents_workspace_enrollment_fk',
      'computer_connect_codes_workspace_enrollment_fk',
      'computer_connect_codes_issued_by_account_pair',
      'session_placements_computer_matches_enrollment',
      'session_cli_proofs_computer_matches_enrollment'
    )
  `;
  expect(legacyConstraints[0]?.count).toBe(0);
}

const FAIL_CASES: Array<{
  name: string;
  error: RegExp;
  inject: (sql: postgres.Sql) => Promise<void>;
}> = [
  {
    name: "an orphaned legacy enrollment",
    error: /unpaired Computer row/,
    inject: async (sql) => {
      await sql`delete from account_computers where id = ${COMP_A2}`;
    },
  },
  {
    name: "an orphaned Account Computer",
    error: /unpaired Computer row/,
    inject: async (sql) => {
      await sql`delete from workspace_computers where id = ${COMP_A2}`;
    },
  },
  {
    name: "an owner mismatch between paired rows",
    error: /owner or installation identity diverges/,
    inject: async (sql) => {
      await sql`update account_computers set owner_account_id = ${ACCOUNT_B} where id = ${COMP_A1}`;
    },
  },
  {
    name: "an installation mismatch between paired rows",
    error: /owner or installation identity diverges/,
    inject: async (sql) => {
      const otherInstallation = crypto.randomUUID();
      await sql`insert into computers (id) values (${otherInstallation})`;
      await sql`update workspace_computers set computer_id = ${otherInstallation} where id = ${COMP_A2}`;
    },
  },
  {
    name: "a legacy credential without a canonical mirror",
    error: /without an identical canonical credential/,
    inject: async (sql) => {
      await sql`delete from computer_credentials where id = ${CRED_REVOKED}`;
    },
  },
  {
    name: "a credential hash mismatch",
    error: /without an identical canonical credential/,
    inject: async (sql) => {
      await sql`update computer_credentials set secret_hash = ${"0".repeat(64)} where id = ${CRED_ACTIVE}`;
    },
  },
  {
    name: "a Slack installation whose scope disagrees with its Agent",
    error: /Slack installation whose Workspace disagrees with its Agent/,
    inject: async (sql) => {
      await sql`update slack_installations set workspace_id = ${WS_B} where id = ${SLACK_CURRENT}`;
    },
  },
  {
    name: "a repair connect code targeting another scope",
    error: /target Computer is outside its Workspace/,
    inject: async (sql) => {
      await sql`update workspace_computers set workspace_id = ${WS_B} where id = ${COMP_A2}`;
      await sql`update computer_connect_codes set target_computer_id = ${COMP_A2} where id = ${CODE_REPAIR}`;
    },
  },
  {
    name: "duplicate active Agent names in one Account",
    error: /agents_account_name_active_unique/,
    inject: async (sql) => {
      const sharedInstallation = crypto.randomUUID();
      const secondComputer = crypto.randomUUID();
      await sql`insert into computers (id) values (${sharedInstallation})`;
      await sql`
        insert into workspace_computers (
          id, workspace_id, computer_id, display_name, platform, arch, client_version, enrolled_by_user_id
        )
        values (${secondComputer}, ${WS_B}, ${sharedInstallation}, 'second-box', 'linux', 'x64', '0.0.2', ${ACCOUNT_A})
      `;
      await sql`
        insert into account_computers (
          id, owner_account_id, current_installation_id, display_name, platform, arch, client_version
        )
        values (${secondComputer}, ${ACCOUNT_A}, ${sharedInstallation}, 'second-box', 'linux', 'x64', '0.0.2')
      `;
      await sql`
        insert into agents (workspace_id, created_by_user_id, workspace_computer_id, computer_id, name, display_name, runtime_provider)
        values (${WS_B}, ${ACCOUNT_A}, ${secondComputer}, ${secondComputer}, 'active-agent', 'Duplicate', 'codex')
      `;
    },
  },
  {
    name: "duplicate current installation identities",
    error: /computers_current_installation_id_unique/,
    inject: async (sql) => {
      await sql`update workspace_computers set workspace_id = ${WS_B}, computer_id = ${INST_A1} where id = ${COMP_A2}`;
      await sql`update account_computers set current_installation_id = ${INST_A1} where id = ${COMP_A2}`;
    },
  },
];

describe("workspace ownership contract migration", () => {
  it("migrates an empty database through the production runner and verifies it", async () => {
    const journal = await readJournal();
    await migrateDatabase(databaseUrl, migrationsFolder);
    await migrateDatabase(databaseUrl, migrationsFolder);
    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      const shape = await finalShape(sql);
      expect(shape).toMatchObject({
        migrations: journal.entries.length,
        legacy_tables: 0,
        legacy_columns: 0,
        computers: 0,
      });
    } finally {
      await sql.end();
    }
  });

  it("migrates the immediately previous 0030 level with populated active and terminal records", async () => {
    const journal = await readJournal();
    const through0030 = await truncatedMigrations(30);
    try {
      await migrateDatabase(databaseUrl, through0030);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateActive0030(sql);
        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
        await expectFinalSchema(sql, journal.entries.length);
        await expectCanonicalDataPreserved(sql);
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0030, { force: true, recursive: true });
    }
  });

  it("migrates representative 0024 history with populated data through the contract migration", async () => {
    const journal = await readJournal();
    const through0024 = await truncatedMigrations(24);
    try {
      await migrateDatabase(databaseUrl, through0024);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        // 0024-era rows predate the expansion columns; the forward chain backfills them first.
        await sql`insert into users (id, email, display_name) values (${ACCOUNT_A}, 'a@example.com', 'A')`;
        await sql`insert into workspaces (id, name, display_name) values (${WS_A}, 'legacy', 'Legacy')`;
        await sql`insert into computers (id, created_at) values (${INST_A1}, ${EARLY})`;
        await sql`
          insert into workspace_computers (
            id, workspace_id, computer_id, display_name, platform, arch, client_version, enrolled_by_user_id
          )
          values (${COMP_A1}, ${WS_A}, ${INST_A1}, 'historical-box', 'linux', 'x64', '0.0.1', ${ACCOUNT_A})
        `;
        await sql`
          insert into workspace_computer_credentials (id, workspace_computer_id, secret_hash, issued_by_user_id)
          values (${CRED_ACTIVE}, ${COMP_A1}, ${"a".repeat(64)}, ${ACCOUNT_A})
        `;
        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
        const [row] = await sql<{ migrations: number; computers: number; credentials: number }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (select count(*)::int from computers) as computers,
            (select count(*)::int from computer_credentials) as credentials
        `;
        expect(row).toEqual({ migrations: journal.entries.length, computers: 1, credentials: 1 });
        const [computer] = await sql<{ id: string; owner: string; installation: string }[]>`
          select id::text as id, owner_account_id::text as owner, current_installation_id::text as installation
          from computers
        `;
        expect(computer).toEqual({ id: COMP_A1, owner: ACCOUNT_A, installation: INST_A1 });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0024, { force: true, recursive: true });
    }
  });

  it.each(FAIL_CASES)("fail-closes on $name and leaves the database exactly at 0030", async ({ error, inject }) => {
    const through0030 = await truncatedMigrations(30);
    try {
      await migrateDatabase(databaseUrl, through0030);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateActive0030(sql);
        await inject(sql);
        await expect(migrateDatabase(databaseUrl, migrationsFolder)).rejects.toThrow(error);
        const [state] = await sql<{ migrations: number; legacy_tables: number; legacy_columns: number }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (
              select count(*)::int from information_schema.tables
              where table_schema = 'public'
                and table_name in (
                  'workspaces', 'workspace_admin_grants', 'admin_invitations',
                  'workspace_computers', 'workspace_computer_credentials', 'account_computers'
                )
            ) as legacy_tables,
            (
              select count(*)::int from information_schema.columns
              where table_schema = 'public' and table_name = 'agents'
                and column_name in ('workspace_id', 'workspace_computer_id')
            ) as legacy_columns
        `;
        expect(state).toEqual({ migrations: THROUGH_0030_COUNT, legacy_tables: 6, legacy_columns: 2 });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0030, { force: true, recursive: true });
    }
  });

  it("rolls back a failed contract migration and retries cleanly after the damage is removed", async () => {
    const journal = await readJournal();
    const through0030 = await truncatedMigrations(30);
    try {
      await migrateDatabase(databaseUrl, through0030);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateActive0030(sql);
        await sql`delete from computer_credentials where id = ${CRED_REVOKED}`;
        await expect(migrateDatabase(databaseUrl, migrationsFolder)).rejects.toThrow(
          /without an identical canonical credential/,
        );
        const [rolledBack] = await sql<{ migrations: number; computers: string | null }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            to_regclass('public.account_computers')::text as computers
        `;
        expect(rolledBack).toEqual({ migrations: THROUGH_0030_COUNT, computers: "account_computers" });

        // The failing fixture row is removed by the test, then the checked-in runner converges unaided.
        await sql`delete from workspace_computer_credentials where id = ${CRED_REVOKED}`;
        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
        const shape = await finalShape(sql);
        expect(shape).toMatchObject({
          migrations: journal.entries.length,
          legacy_tables: 0,
          legacy_columns: 0,
          computers: 2,
          credentials: 1,
        });
        const [credential] = await sql<{ id: string }[]>`select id::text as id from computer_credentials`;
        expect(credential).toEqual({ id: CRED_ACTIVE });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0030, { force: true, recursive: true });
    }
  });

  it("serves startup verification and canonical reads and writes after a populated upgrade", async () => {
    const through0030 = await truncatedMigrations(30);
    try {
      await migrateDatabase(databaseUrl, through0030);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateActive0030(sql);
      } finally {
        await sql.end();
      }
      await migrateDatabase(databaseUrl, migrationsFolder);
      await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();

      const client = createDatabaseClient(databaseUrl);
      try {
        // The migrated Account still owns its Computer and can issue and exchange a repair code.
        const machineAuth = new MachineAuthService(client.database);
        const issued = await machineAuth.issueForAccount(ACCOUNT_A, {
          mode: "repair",
          targetComputerId: COMP_A1,
        });
        const repairedInstallation = crypto.randomUUID();
        const repaired = await machineAuth.exchangeConnectCode({
          code: issued.code,
          installationId: repairedInstallation,
          displayName: "active-box",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.2",
        });
        expect(repaired.computerId).toBe(COMP_A1);

        const computerService = new ComputerService(client.database, {
          getActiveUserById: async () => {
            throw new Error("unused");
          },
        });
        const instanceId = crypto.randomUUID();
        await computerService.register(repaired, {
          type: "computer:register",
          requestId: crypto.randomUUID(),
          installationId: repairedInstallation,
          instanceId,
          displayName: "active-box",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.2",
          capabilities: { imCredentialGrant: 0 as const },
          protocolVersion: RUNTIME_PROTOCOL_V2,
          supportedCapabilities: { imCredentialGrant: { min: 1, max: 1 } },
          requiredServerCapabilities: [],
        });
        await expect(machineAuth.verifyMachineToken(repaired.machineToken)).resolves.toMatchObject({
          computerId: COMP_A1,
          installationId: repairedInstallation,
        });

        const agent = await new AgentService(client.database).createForAccount(ACCOUNT_A, {
          name: "post-migration",
          displayName: "Post Migration",
          runtimeProvider: "codex",
          computerId: COMP_A1,
        });
        expect(agent.computerId).toBe(COMP_A1);

        const sessions = new SessionService(client.database);
        const chat = await sessions.ensureChatSession(
          { imBindingId: BINDING, channelId: "C-post", conversationKind: "channel" },
          "channel",
        );
        expect(chat.placement).toMatchObject({ computerId: COMP_A1, generation: 1 });

        const proofs = new SessionCliProofService(
          client.database,
          {
            currentInstanceId: (computerId: string) => (computerId === COMP_A1 ? instanceId : undefined),
            supportsCapability: (computerId: string, connectionInstanceId: string) =>
              computerId === COMP_A1 && connectionInstanceId === instanceId,
          },
          new Uint8Array(32).fill(3),
        );
        const minted = await proofs.mint({
          sessionId: chat.session.id,
          computerId: COMP_A1,
          placementGeneration: 1,
          connectionInstanceId: instanceId,
        });
        await expect(proofs.authenticate(minted.token)).resolves.toMatchObject({
          sessionId: chat.session.id,
          computerId: COMP_A1,
          installationId: repairedInstallation,
        });
      } finally {
        await client.sql.end();
      }
    } finally {
      await rm(through0030, { force: true, recursive: true });
    }
  });
});
