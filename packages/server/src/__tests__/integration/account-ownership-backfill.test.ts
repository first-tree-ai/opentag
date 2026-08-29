import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const EXTRA_ADMIN_ID = "00000000-0000-4000-8000-000000000016";
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
const SLACK_AGENT_ID = "00000000-0000-4000-8000-000000000017";
const SLACK_BINDING_ID = "00000000-0000-4000-8000-000000000018";
const SLACK_DISABLED_BINDING_ID = "00000000-0000-4000-8000-000000000019";

const THROUGH_0026_COUNT = 27;
const THROUGH_0027_COUNT = 28;

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

async function populateLegacyOwnership(sql: postgres.Sql): Promise<void> {
  const now = new Date("2026-08-20T00:00:00.000Z");
  const later = new Date("2026-08-21T00:00:00.000Z");
  await sql`
    insert into users (id, email, display_name)
    values
      (${OWNER_ID}, 'owner@example.com', 'Owner'),
      (${CREATOR_ID}, 'creator@example.com', 'Creator'),
      (${EXTRA_ADMIN_ID}, 'extra-admin@example.com', 'Extra Admin')
  `;
  await sql`
    insert into workspaces (id, name, display_name)
    values (${WORKSPACE_ID}, 'legacy', 'Legacy')
  `;
  await sql`
    insert into workspace_admin_grants (workspace_id, user_id, granted_by_user_id, granted_at)
    values
      (${WORKSPACE_ID}, ${OWNER_ID}, ${OWNER_ID}, ${now}),
      (${WORKSPACE_ID}, ${CREATOR_ID}, ${OWNER_ID}, ${now}),
      (${WORKSPACE_ID}, ${EXTRA_ADMIN_ID}, ${OWNER_ID}, ${now})
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
    values
      (
        ${AGENT_ID}, ${WORKSPACE_ID}, ${CREATOR_ID}, ${ACTIVE_ENROLLMENT_ID},
        'mismatched', 'Mismatched', 'codex'
      ),
      (
        ${SLACK_AGENT_ID}, ${WORKSPACE_ID}, ${CREATOR_ID}, ${ACTIVE_ENROLLMENT_ID},
        'slack-owner', 'Slack Owner', 'codex'
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
    insert into im_bindings (
      id, agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
      credential_schema_version, credential_generation, slack_installation_id, slack_route_kind, activated_at
    )
    values (
      ${SLACK_BINDING_ID}, ${SLACK_AGENT_ID}, 'slack', 'active', 'A_LEGACY', 'T_LEGACY', 'U_BOT',
      1, 1, ${SLACK_ACTIVE_ID}, 'default', ${now}
    )
  `;
  await sql`
    insert into im_bindings (
      id, agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
      credential_generation, slack_installation_id, disabled_at
    )
    values (
      ${SLACK_DISABLED_BINDING_ID}, ${SLACK_AGENT_ID}, 'slack', 'disabled', 'A_OLD', 'T_OLD', 'U_OLD',
      1, ${SLACK_DISABLED_ID}, ${later}
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

async function insertMatchingAccountComputer(
  sql: postgres.Sql,
  enrollmentId: string,
  displayName = "active-box",
): Promise<void> {
  const now = new Date("2026-08-20T00:00:00.000Z");
  await sql`
    insert into account_computers (
      id, owner_account_id, current_installation_id, display_name, platform, arch, client_version,
      current_instance_id, connected_at, last_seen_at, created_at, updated_at
    )
    values (
      ${enrollmentId}, ${OWNER_ID}, ${INSTALLATION_ID}, ${displayName}, 'linux', 'x64', '0.0.1',
      ${CURRENT_INSTANCE_ID}, ${now}, ${now}, ${now}, ${now}
    )
  `;
}

async function insertExtraEnrollment(sql: postgres.Sql): Promise<string> {
  const extraInstallation = crypto.randomUUID();
  const extraEnrollment = crypto.randomUUID();
  const now = new Date("2026-08-20T00:00:00.000Z");
  await sql`insert into computers (id, created_at) values (${extraInstallation}, ${now})`;
  await sql`
    insert into workspace_computers (
      id, workspace_id, computer_id, display_name, platform, arch, client_version,
      enrolled_by_user_id, enrolled_at, updated_at
    )
    values (
      ${extraEnrollment}, ${WORKSPACE_ID}, ${extraInstallation}, 'extra-box', 'linux', 'x64', '0.0.1',
      ${OWNER_ID}, ${now}, ${now}
    )
  `;
  await insertMatchingAccountComputer(sql, extraEnrollment, "extra-box");
  await sql`
    update account_computers
    set current_installation_id = ${extraInstallation}, current_instance_id = null, connected_at = null, last_seen_at = null
    where id = ${extraEnrollment}
  `;
  return extraEnrollment;
}

const FAIL_CASES: Array<{ name: string; error: RegExp; inject: (sql: postgres.Sql) => Promise<void> }> = [
  {
    name: "orphan account Computer",
    error: /target Computer that does not match a Workspace enrollment/,
    inject: async (sql) => {
      const orphanId = crypto.randomUUID();
      const now = new Date("2026-08-20T00:00:00.000Z");
      await sql`
        insert into account_computers (
          id, owner_account_id, current_installation_id, display_name, platform, arch, client_version, created_at, updated_at
        )
        values (
          ${orphanId}, ${OWNER_ID}, ${INSTALLATION_ID}, 'orphan', 'linux', 'x64', '0.0.1', ${now}, ${now}
        )
      `;
    },
  },
  {
    name: "account Computer owner mismatch",
    error: /owner or installation does not match the enrollment/,
    inject: async (sql) => {
      await insertMatchingAccountComputer(sql, ACTIVE_ENROLLMENT_ID);
      await sql`update account_computers set owner_account_id = ${CREATOR_ID} where id = ${ACTIVE_ENROLLMENT_ID}`;
    },
  },
  {
    name: "target credential without a legacy source",
    error: /target credential that does not match a Workspace enrollment credential/,
    inject: async (sql) => {
      await insertMatchingAccountComputer(sql, ACTIVE_ENROLLMENT_ID);
      const now = new Date("2026-08-20T00:00:00.000Z");
      await sql`
        insert into computer_credentials (id, computer_id, secret_hash, issued_by_user_id, issued_at)
        values (${crypto.randomUUID()}, ${ACTIVE_ENROLLMENT_ID}, ${"f".repeat(64)}, ${OWNER_ID}, ${now})
      `;
    },
  },
  {
    name: "credential hash mismatch",
    error: /identity or audit history does not match the enrollment credential/,
    inject: async (sql) => {
      await insertMatchingAccountComputer(sql, ACTIVE_ENROLLMENT_ID);
      const now = new Date("2026-08-20T00:00:00.000Z");
      await sql`
        insert into computer_credentials (id, computer_id, secret_hash, issued_by_user_id, issued_at)
        values (${ACTIVE_CREDENTIAL_ID}, ${ACTIVE_ENROLLMENT_ID}, ${"f".repeat(64)}, ${OWNER_ID}, ${now})
      `;
    },
  },
  {
    name: "credential issued-at audit mismatch",
    error: /identity or audit history does not match the enrollment credential/,
    inject: async (sql) => {
      await insertMatchingAccountComputer(sql, ACTIVE_ENROLLMENT_ID);
      const later = new Date("2026-08-21T00:00:00.000Z");
      await sql`
        insert into computer_credentials (id, computer_id, secret_hash, issued_by_user_id, issued_at)
        values (${ACTIVE_CREDENTIAL_ID}, ${ACTIVE_ENROLLMENT_ID}, ${"a".repeat(64)}, ${OWNER_ID}, ${later})
      `;
    },
  },
  {
    name: "credential revoked-at audit mismatch",
    error: /identity or audit history does not match the enrollment credential/,
    inject: async (sql) => {
      await insertMatchingAccountComputer(sql, ACTIVE_ENROLLMENT_ID);
      const now = new Date("2026-08-20T00:00:00.000Z");
      const divergent = new Date("2026-08-22T00:00:00.000Z");
      await sql`
        insert into computer_credentials (
          id, computer_id, secret_hash, issued_by_user_id, issued_at, revoked_by_user_id, revoked_at
        )
        values (
          ${REVOKED_CREDENTIAL_ID}, ${ACTIVE_ENROLLMENT_ID}, ${"b".repeat(64)},
          ${OWNER_ID}, ${now}, ${OWNER_ID}, ${divergent}
        )
      `;
    },
  },
  {
    name: "divergent Agent projection",
    error: /Agent whose Computer does not match its enrollment/,
    inject: async (sql) => {
      const extraEnrollment = await insertExtraEnrollment(sql);
      await sql`update agents set computer_id = ${extraEnrollment} where id = ${AGENT_ID}`;
    },
  },
  {
    name: "divergent Session placement projection",
    error: /placement whose Computer does not match its enrollment/,
    inject: async (sql) => {
      const extraEnrollment = await insertExtraEnrollment(sql);
      await sql`update session_placements set computer_id = ${extraEnrollment} where session_id = ${ACTIVE_SESSION_ID}`;
    },
  },
  {
    name: "divergent Session CLI proof projection",
    error: /proof whose Computer does not match its enrollment/,
    inject: async (sql) => {
      const extraEnrollment = await insertExtraEnrollment(sql);
      await sql`update session_cli_proofs set computer_id = ${extraEnrollment} where session_id = ${ACTIVE_SESSION_ID}`;
    },
  },
  {
    name: "repair-shaped historical connect code",
    error: /repair-shaped code/,
    inject: async (sql) => {
      await sql`update computer_connect_codes set mode = 'repair' where id = ${UNCONSUMED_CODE_ID}`;
    },
  },
  {
    name: "connect-code issuing Account conflict",
    error: /issuing Account that does not match the issuing user/,
    inject: async (sql) => {
      await sql`update computer_connect_codes set issued_by_account_id = ${CREATOR_ID} where id = ${UNCONSUMED_CODE_ID}`;
    },
  },
  {
    name: "consumed Computer conflict",
    error: /consumed Computer that does not match the enrollment/,
    inject: async (sql) => {
      await insertMatchingAccountComputer(sql, ACTIVE_ENROLLMENT_ID);
      await sql`
        update computer_connect_codes
        set consumed_computer_id = ${ACTIVE_ENROLLMENT_ID}
        where id = ${UNCONSUMED_CODE_ID}
      `;
    },
  },
  {
    name: "Slack installation with zero bindings",
    error: /installation with no Slack binding/,
    inject: async (sql) => {
      const orphanInstallation = crypto.randomUUID();
      const later = new Date("2026-08-21T00:00:00.000Z");
      await sql`
        insert into slack_installations (
          id, workspace_id, status, external_app_id, external_team_id, external_bot_id,
          credential_generation, disabled_at, created_at, updated_at
        )
        values (
          ${orphanInstallation}, ${WORKSPACE_ID}, 'disabled', 'A_ORPHAN', 'T_ORPHAN', 'U_ORPHAN',
          1, ${later}, ${later}, ${later}
        )
      `;
    },
  },
  {
    name: "Slack installation bound to multiple Agents",
    error: /installation bound to more than one Agent/,
    inject: async (sql) => {
      const later = new Date("2026-08-21T00:00:00.000Z");
      await sql`
        insert into im_bindings (
          agent_id, provider, status, slack_installation_id, disabled_at
        )
        values (
          ${AGENT_ID}, 'slack', 'disabled', ${SLACK_ACTIVE_ID}, ${later}
        )
      `;
    },
  },
  {
    name: "Slack binding whose Agent is in another Workspace",
    error: /Agent is not in the installation Workspace/,
    inject: async (sql) => {
      const otherWorkspace = crypto.randomUUID();
      const otherUser = EXTRA_ADMIN_ID;
      const otherInstallation = crypto.randomUUID();
      const otherEnrollment = crypto.randomUUID();
      const otherAgent = crypto.randomUUID();
      const now = new Date("2026-08-20T00:00:00.000Z");
      await sql`delete from im_bindings where id = ${SLACK_BINDING_ID}`;
      await sql`insert into workspaces (id, name, display_name) values (${otherWorkspace}, 'other', 'Other')`;
      await sql`insert into computers (id, created_at) values (${otherInstallation}, ${now})`;
      await sql`
        insert into workspace_computers (
          id, workspace_id, computer_id, display_name, platform, arch, client_version,
          enrolled_by_user_id, enrolled_at, updated_at
        )
        values (
          ${otherEnrollment}, ${otherWorkspace}, ${otherInstallation}, 'other-box', 'linux', 'x64', '0.0.1',
          ${otherUser}, ${now}, ${now}
        )
      `;
      await sql`
        insert into agents (
          id, workspace_id, created_by_user_id, workspace_computer_id, name, display_name, runtime_provider
        )
        values (
          ${otherAgent}, ${otherWorkspace}, ${otherUser}, ${otherEnrollment}, 'outsider', 'Outsider', 'codex'
        )
      `;
      await sql`
        insert into im_bindings (
          agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
          credential_schema_version, credential_generation, slack_installation_id, slack_route_kind, activated_at
        )
        values (
          ${otherAgent}, 'slack', 'active', 'A_LEGACY', 'T_LEGACY', 'U_BOT',
          1, 1, ${SLACK_ACTIVE_ID}, 'default', ${now}
        )
      `;
    },
  },
  {
    name: "prefilled Slack owner conflict",
    error: /Agent owner that does not match the bound Agent/,
    inject: async (sql) => {
      await sql`update slack_installations set agent_id = ${AGENT_ID} where id = ${SLACK_ACTIVE_ID}`;
    },
  },
];

async function expectBackfillProjections(sql: postgres.Sql, migrations: number): Promise<void> {
  const computers = await sql<
    {
      id: string;
      owner_account_id: string;
      current_installation_id: string;
      display_name: string;
      platform: string;
      arch: string;
      client_version: string;
      current_instance_id: string | null;
      connected_at: Date | null;
      last_seen_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    select id::text, owner_account_id::text, current_installation_id::text, display_name, platform::text, arch,
           client_version, current_instance_id::text, connected_at, last_seen_at, created_at, updated_at
    from account_computers
    order by display_name
  `;
  expect(computers).toEqual([
    expect.objectContaining({
      id: ACTIVE_ENROLLMENT_ID,
      owner_account_id: OWNER_ID,
      current_installation_id: INSTALLATION_ID,
      display_name: "active-box",
      platform: "linux",
      arch: "x64",
      client_version: "0.0.1",
      current_instance_id: CURRENT_INSTANCE_ID,
      connected_at: new Date("2026-08-20T00:00:00.000Z"),
      last_seen_at: new Date("2026-08-20T00:00:00.000Z"),
      created_at: new Date("2026-08-20T00:00:00.000Z"),
      updated_at: new Date("2026-08-20T00:00:00.000Z"),
    }),
    expect.objectContaining({
      id: REVOKED_ENROLLMENT_ID,
      owner_account_id: OWNER_ID,
      current_installation_id: INSTALLATION_ID,
      display_name: "revoked-box",
      current_instance_id: null,
      connected_at: null,
      last_seen_at: null,
      created_at: new Date("2026-08-20T00:00:00.000Z"),
      updated_at: new Date("2026-08-21T00:00:00.000Z"),
    }),
  ]);

  const credentials = await sql<
    {
      id: string;
      computer_id: string;
      secret_hash: string;
      issued_by_user_id: string;
      issued_at: Date;
      revoked_by_user_id: string | null;
      revoked_at: Date | null;
    }[]
  >`
    select id::text, computer_id::text, secret_hash, issued_by_user_id::text, issued_at,
           revoked_by_user_id::text, revoked_at
    from computer_credentials
    order by secret_hash
  `;
  const legacyCredentials = await sql<
    {
      id: string;
      workspace_computer_id: string;
      secret_hash: string;
      issued_by_user_id: string;
      issued_at: Date;
      revoked_by_user_id: string | null;
      revoked_at: Date | null;
    }[]
  >`
    select id::text, workspace_computer_id::text, secret_hash, issued_by_user_id::text, issued_at,
           revoked_by_user_id::text, revoked_at
    from workspace_computer_credentials
    order by secret_hash
  `;
  expect(credentials).toEqual(
    legacyCredentials.map((row) => ({
      id: row.id,
      computer_id: row.workspace_computer_id,
      secret_hash: row.secret_hash,
      issued_by_user_id: row.issued_by_user_id,
      issued_at: row.issued_at,
      revoked_by_user_id: row.revoked_by_user_id,
      revoked_at: row.revoked_at,
    })),
  );
  expect(credentials).toEqual([
    {
      id: ACTIVE_CREDENTIAL_ID,
      computer_id: ACTIVE_ENROLLMENT_ID,
      secret_hash: "a".repeat(64),
      issued_by_user_id: OWNER_ID,
      issued_at: new Date("2026-08-20T00:00:00.000Z"),
      revoked_by_user_id: null,
      revoked_at: null,
    },
    {
      id: REVOKED_CREDENTIAL_ID,
      computer_id: ACTIVE_ENROLLMENT_ID,
      secret_hash: "b".repeat(64),
      issued_by_user_id: OWNER_ID,
      issued_at: new Date("2026-08-20T00:00:00.000Z"),
      revoked_by_user_id: OWNER_ID,
      revoked_at: new Date("2026-08-21T00:00:00.000Z"),
    },
  ]);

  const [ownership] = await sql<
    {
      migrations: number;
      agent_computer: string;
      agent_creator: string;
      slack_agent_computer: string;
      extra_admin_owns_computer: number;
      active_placement: string;
      ended_placement: string;
      proof_computer: string;
      unconsumed_mode: string;
      unconsumed_account: string;
      unconsumed_consumed: string | null;
      consumed_computer: string;
      slack_active_owner: string;
      slack_disabled_owner: string;
      owner_mismatch: number;
    }[]
  >`
    select
      (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
      (select computer_id::text from agents where id = ${AGENT_ID}) as agent_computer,
      (select created_by_user_id::text from agents where id = ${AGENT_ID}) as agent_creator,
      (select computer_id::text from agents where id = ${SLACK_AGENT_ID}) as slack_agent_computer,
      (
        select count(*)::int from account_computers
        where owner_account_id = ${EXTRA_ADMIN_ID}
      ) as extra_admin_owns_computer,
      (select computer_id::text from session_placements where session_id = ${ACTIVE_SESSION_ID}) as active_placement,
      (select computer_id::text from session_placements where session_id = ${ENDED_SESSION_ID}) as ended_placement,
      (select computer_id::text from session_cli_proofs where session_id = ${ACTIVE_SESSION_ID}) as proof_computer,
      (select mode::text from computer_connect_codes where id = ${UNCONSUMED_CODE_ID}) as unconsumed_mode,
      (select issued_by_account_id::text from computer_connect_codes where id = ${UNCONSUMED_CODE_ID}) as unconsumed_account,
      (select consumed_computer_id::text from computer_connect_codes where id = ${UNCONSUMED_CODE_ID}) as unconsumed_consumed,
      (select consumed_computer_id::text from computer_connect_codes where id = ${CONSUMED_CODE_ID}) as consumed_computer,
      (select agent_id::text from slack_installations where id = ${SLACK_ACTIVE_ID}) as slack_active_owner,
      (select agent_id::text from slack_installations where id = ${SLACK_DISABLED_ID}) as slack_disabled_owner,
      (
        select count(*)::int from agents
        inner join workspace_computers on workspace_computers.id = agents.workspace_computer_id
        where agents.created_by_user_id <> workspace_computers.enrolled_by_user_id
      ) as owner_mismatch
  `;
  expect(ownership).toEqual({
    migrations,
    agent_computer: ACTIVE_ENROLLMENT_ID,
    agent_creator: CREATOR_ID,
    slack_agent_computer: ACTIVE_ENROLLMENT_ID,
    extra_admin_owns_computer: 0,
    active_placement: ACTIVE_ENROLLMENT_ID,
    ended_placement: REVOKED_ENROLLMENT_ID,
    proof_computer: ACTIVE_ENROLLMENT_ID,
    unconsumed_mode: "create",
    unconsumed_account: OWNER_ID,
    unconsumed_consumed: null,
    consumed_computer: ACTIVE_ENROLLMENT_ID,
    slack_active_owner: SLACK_AGENT_ID,
    slack_disabled_owner: SLACK_AGENT_ID,
    owner_mismatch: 2,
  });

  const [preserved] = await sql<
    {
      stale_proof_instance: string;
      pending_deliveries: number;
      accepted_unreported: number;
      ended_sessions: number;
      revoked_enrollments: number;
    }[]
  >`
    select
      (
        select connection_instance_id::text from session_cli_proofs
        where session_id = ${ACTIVE_SESSION_ID}
      ) as stale_proof_instance,
      (
        select count(*)::int from im_message_deliveries
        where id = ${PENDING_DELIVERY_ID} and state = 'pending' and placement_generation = 2
      ) as pending_deliveries,
      (
        select count(*)::int from im_message_deliveries
        where id = ${ACCEPTED_DELIVERY_ID} and state = 'accepted' and reported_at is null
          and report_owner_instance_id = ${CURRENT_INSTANCE_ID}
      ) as accepted_unreported,
      (
        select count(*)::int from sessions where id = ${ENDED_SESSION_ID} and ended_at is not null
      ) as ended_sessions,
      (
        select count(*)::int from workspace_computers
        where id = ${REVOKED_ENROLLMENT_ID} and revoked_at is not null
      ) as revoked_enrollments
  `;
  expect(preserved).toEqual({
    stale_proof_instance: STALE_INSTANCE_ID,
    pending_deliveries: 1,
    accepted_unreported: 1,
    ended_sessions: 1,
    revoked_enrollments: 1,
  });
}

describe("account-owned resource backfill migrations", () => {
  it("journals 0027 without a snapshot immediately before 0028", async () => {
    const journal = await readJournal();
    expect(journal.entries.slice(26, 29).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 26, tag: "0026_wakeful_wildside" },
      { idx: 27, tag: "0027_backfill_account_owned_resources" },
      { idx: 28, tag: "0028_overjoyed_speedball" },
    ]);
    await expect(access(join(migrationsFolder, "meta/0027_snapshot.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(migrationsFolder, "meta/0028_snapshot.json"))).resolves.toBeUndefined();
  });

  it("migrates an empty database to current and reruns idempotently", async () => {
    const journal = await readJournal();
    await migrateDatabase(databaseUrl, migrationsFolder);
    await migrateDatabase(databaseUrl, migrationsFolder);
    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();

    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      const [row] = await sql<
        {
          migrations: number;
          account_computers: number;
          computer_credentials: number;
          agents_nullable: string | null;
          slack_nullable: string | null;
        }[]
      >`
        select
          (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
          (select count(*)::int from account_computers) as account_computers,
          (select count(*)::int from computer_credentials) as computer_credentials,
          (
            select is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = 'agents' and column_name = 'computer_id'
          ) as agents_nullable,
          (
            select is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = 'slack_installations' and column_name = 'agent_id'
          ) as slack_nullable
      `;
      expect(row).toEqual({
        migrations: journal.entries.length,
        account_computers: 0,
        computer_credentials: 0,
        agents_nullable: "NO",
        slack_nullable: "NO",
      });
    } finally {
      await sql.end();
    }
  });

  it("backfills populated 0026 data onto matching account-owned projections", async () => {
    const journal = await readJournal();
    const through0026 = await truncatedMigrations(26);
    try {
      await migrateDatabase(databaseUrl, through0026);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateLegacyOwnership(sql);
        const [before] = await sql<{ migrations: number; account_computers: number; slack_filled: number }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (select count(*)::int from account_computers) as account_computers,
            (select count(*)::int from slack_installations where agent_id is not null) as slack_filled
        `;
        expect(before).toEqual({ migrations: THROUGH_0026_COUNT, account_computers: 0, slack_filled: 0 });

        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
        await expectBackfillProjections(sql, journal.entries.length);
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0026, { force: true, recursive: true });
    }
  });

  it("upgrades representative 0025 history through current when Slack bindings exist", async () => {
    const journal = await readJournal();
    const through0025 = await truncatedMigrations(25);
    try {
      await migrateDatabase(databaseUrl, through0025);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateLegacyOwnership(sql);
        const [before] = await sql<{ migrations: number; slack: number }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (select count(*)::int from slack_installations) as slack
        `;
        expect(before).toEqual({ migrations: 26, slack: 2 });

        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
        await expectBackfillProjections(sql, journal.entries.length);
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0025, { force: true, recursive: true });
    }
  });

  it("keeps already matching rows and fills remaining projections retry-safely", async () => {
    const journal = await readJournal();
    const through0026 = await truncatedMigrations(26);
    try {
      await migrateDatabase(databaseUrl, through0026);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateLegacyOwnership(sql);
        await insertMatchingAccountComputer(sql, ACTIVE_ENROLLMENT_ID, "already-projected");
        await sql`update agents set computer_id = ${ACTIVE_ENROLLMENT_ID} where id = ${AGENT_ID}`;
        await sql`
          update computer_connect_codes
          set issued_by_account_id = issued_by_user_id, mode = 'create'
          where id = ${UNCONSUMED_CODE_ID}
        `;
        await sql`update slack_installations set agent_id = ${SLACK_AGENT_ID} where id = ${SLACK_ACTIVE_ID}`;

        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();

        const [row] = await sql<
          {
            migrations: number;
            prefilled_name: string;
            revoked_name: string;
            slack_agent: string;
            proof_computer: string;
            consumed_computer: string;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (select display_name from account_computers where id = ${ACTIVE_ENROLLMENT_ID}) as prefilled_name,
            (select display_name from account_computers where id = ${REVOKED_ENROLLMENT_ID}) as revoked_name,
            (select agent_id::text from slack_installations where id = ${SLACK_DISABLED_ID}) as slack_agent,
            (select computer_id::text from session_cli_proofs where session_id = ${ACTIVE_SESSION_ID}) as proof_computer,
            (select consumed_computer_id::text from computer_connect_codes where id = ${CONSUMED_CODE_ID}) as consumed_computer
        `;
        expect(row).toEqual({
          migrations: journal.entries.length,
          prefilled_name: "already-projected",
          revoked_name: "revoked-box",
          slack_agent: SLACK_AGENT_ID,
          proof_computer: ACTIVE_ENROLLMENT_ID,
          consumed_computer: ACTIVE_ENROLLMENT_ID,
        });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0026, { force: true, recursive: true });
    }
  });

  it.each(FAIL_CASES)("fail-closes 0027 for $name and leaves the journal at 0026", async ({ error, inject }) => {
    const through0026 = await truncatedMigrations(26);
    try {
      await migrateDatabase(databaseUrl, through0026);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateLegacyOwnership(sql);
        await inject(sql);
        await expect(migrateDatabase(databaseUrl, migrationsFolder)).rejects.toThrow(error);
        const [failed] = await sql<{ migrations: number; agents_nullable: string | null }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (
              select is_nullable from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'computer_id'
            ) as agents_nullable
        `;
        expect(failed).toEqual({ migrations: THROUGH_0026_COUNT, agents_nullable: "YES" });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0026, { force: true, recursive: true });
    }
  });

  it("rolls back a late 0027 failure and retries after the external orphan is removed", async () => {
    const journal = await readJournal();
    const through0026 = await truncatedMigrations(26);
    try {
      await migrateDatabase(databaseUrl, through0026);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateLegacyOwnership(sql);
        const orphanInstallation = crypto.randomUUID();
        const later = new Date("2026-08-21T00:00:00.000Z");
        await sql`
          insert into slack_installations (
            id, workspace_id, status, external_app_id, external_team_id, external_bot_id,
            credential_generation, disabled_at, created_at, updated_at
          )
          values (
            ${orphanInstallation}, ${WORKSPACE_ID}, 'disabled', 'A_RETRY_ORPHAN', 'T_RETRY_ORPHAN', 'U_RETRY_ORPHAN',
            1, ${later}, ${later}, ${later}
          )
        `;

        await expect(migrateDatabase(databaseUrl, migrationsFolder)).rejects.toThrow(
          /installation with no Slack binding/,
        );
        const [rolledBack] = await sql<
          {
            migrations: number;
            account_computers: number;
            credentials: number;
            projected_agents: number;
            projected_placements: number;
            projected_proofs: number;
            projected_slack: number;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (select count(*)::int from account_computers) as account_computers,
            (select count(*)::int from computer_credentials) as credentials,
            (select count(*)::int from agents where computer_id is not null) as projected_agents,
            (select count(*)::int from session_placements where computer_id is not null) as projected_placements,
            (select count(*)::int from session_cli_proofs where computer_id is not null) as projected_proofs,
            (select count(*)::int from slack_installations where agent_id is not null) as projected_slack
        `;
        expect(rolledBack).toEqual({
          migrations: THROUGH_0026_COUNT,
          account_computers: 0,
          credentials: 0,
          projected_agents: 0,
          projected_placements: 0,
          projected_proofs: 0,
          projected_slack: 0,
        });

        await sql`delete from slack_installations where id = ${orphanInstallation}`;
        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
        await expectBackfillProjections(sql, journal.entries.length);
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0026, { force: true, recursive: true });
    }
  });

  it("enforces 0028 NOT NULL, identity checks, and the Slack ownership FK", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    const client = createDatabaseClient(databaseUrl);
    try {
      const bootstrap = await bootstrapInitialAdmin(client.database, {
        displayName: "Admin",
        email: "admin@example.com",
        workspaceDisplayName: "Example",
        workspaceName: "example",
      });
      const machineAuth = new MachineAuthService(client.database);
      const issued = await machineAuth.issueForWorkspaceAdmin(bootstrap.userId, bootstrap.workspaceId);
      const enrollment = await machineAuth.exchangeConnectCode({
        code: issued.code,
        computerId: crypto.randomUUID(),
        displayName: "workstation",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
      });
      const secondIssued = await machineAuth.issueForWorkspaceAdmin(bootstrap.userId, bootstrap.workspaceId);
      const second = await machineAuth.exchangeConnectCode({
        code: secondIssued.code,
        computerId: crypto.randomUUID(),
        displayName: "other-box",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
      });
      const sql = client.sql;
      const missingComputer = await sql`
        insert into agents (
          workspace_id, created_by_user_id, workspace_computer_id, name, display_name, runtime_provider
        )
        values (
          ${bootstrap.workspaceId}, ${bootstrap.userId}, ${enrollment.workspaceComputerId},
          'missing', 'Missing', 'codex'
        )
      `.catch((error: unknown) => error);
      expect(postgresError(missingComputer)).toMatchObject({ code: "23502" });

      const mismatchedAgent = await sql`
        insert into agents (
          workspace_id, created_by_user_id, workspace_computer_id, computer_id, name, display_name, runtime_provider
        )
        values (
          ${bootstrap.workspaceId}, ${bootstrap.userId}, ${enrollment.workspaceComputerId}, ${second.workspaceComputerId},
          'mismatch', 'Mismatch', 'codex'
        )
      `.catch((error: unknown) => error);
      expect(postgresError(mismatchedAgent)).toMatchObject({
        code: "23514",
        constraint_name: "agents_computer_matches_enrollment",
      });

      const [agent] = await sql<{ id: string }[]>`
        insert into agents (
          workspace_id, created_by_user_id, workspace_computer_id, computer_id, name, display_name, runtime_provider
        )
        values (
          ${bootstrap.workspaceId}, ${bootstrap.userId}, ${enrollment.workspaceComputerId}, ${enrollment.workspaceComputerId},
          'bound', 'Bound', 'codex'
        )
        returning id::text
      `;
      if (!agent) throw new Error("Agent fixture was not created");
      const [binding] = await sql<{ id: string }[]>`
        insert into im_bindings (
          agent_id, provider, status, external_app_id, external_bot_id,
          credential_schema_version, credential_generation, encrypted_credential, activated_at
        )
        values (
          ${agent.id}, 'feishu', 'active', 'cli_bound', 'ou_bound', 1, 1, 'encrypted', now()
        )
        returning id::text
      `;
      if (!binding) throw new Error("IM binding fixture was not created");
      const [session] = await sql<{ id: string }[]>`
        insert into sessions (im_binding_id, channel_id, conversation_kind, kind)
        values (${binding.id}, 'C-bound', 'channel', 'channel')
        returning id::text
      `;
      if (!session) throw new Error("Session fixture was not created");

      const mismatchedPlacement = await sql`
        insert into session_placements (session_id, workspace_computer_id, computer_id, generation)
        values (${session.id}, ${enrollment.workspaceComputerId}, ${second.workspaceComputerId}, 1)
      `.catch((error: unknown) => error);
      expect(postgresError(mismatchedPlacement)).toMatchObject({
        code: "23514",
        constraint_name: "session_placements_computer_matches_enrollment",
      });
      await sql`
        insert into session_placements (session_id, workspace_computer_id, computer_id, generation)
        values (${session.id}, ${enrollment.workspaceComputerId}, ${enrollment.workspaceComputerId}, 1)
      `;

      const mismatchedProof = await sql`
        insert into session_cli_proofs (
          session_id, proof_id, token_hash, workspace_computer_id, computer_id, placement_generation, connection_instance_id
        )
        values (
          ${session.id}, ${crypto.randomUUID()}, ${"1".repeat(64)},
          ${enrollment.workspaceComputerId}, ${second.workspaceComputerId}, 1, ${crypto.randomUUID()}
        )
      `.catch((error: unknown) => error);
      expect(postgresError(mismatchedProof)).toMatchObject({
        code: "23514",
        constraint_name: "session_cli_proofs_computer_matches_enrollment",
      });

      const [otherUser] = await sql<{ id: string }[]>`
        insert into users (email, display_name) values ('other-issuer@example.com', 'Other')
        returning id::text
      `;
      if (!otherUser) throw new Error("Other user fixture was not created");
      const issuedAccountPair = await sql`
        insert into computer_connect_codes (
          workspace_id, token_hash, issued_by_user_id, issued_by_account_id, mode, expires_at
        )
        values (
          ${bootstrap.workspaceId}, ${"3".repeat(64)}, ${bootstrap.userId}, ${otherUser.id}, 'create',
          now() + interval '15 minutes'
        )
      `.catch((error: unknown) => error);
      expect(postgresError(issuedAccountPair)).toMatchObject({
        code: "23514",
        constraint_name: "computer_connect_codes_issued_by_account_pair",
      });

      const consumedIdentity = await sql`
        insert into computer_connect_codes (
          workspace_id, token_hash, issued_by_user_id, issued_by_account_id, mode, expires_at,
          consumed_workspace_computer_id, consumed_computer_id, consumed_at
        )
        values (
          ${bootstrap.workspaceId}, ${"4".repeat(64)}, ${bootstrap.userId}, ${bootstrap.userId}, 'create',
          now() + interval '15 minutes',
          ${enrollment.workspaceComputerId}, ${second.workspaceComputerId}, now()
        )
      `.catch((error: unknown) => error);
      expect(postgresError(consumedIdentity)).toMatchObject({
        code: "23514",
        constraint_name: "computer_connect_codes_consumed_computer_identity",
      });

      const repairPair = await sql`
        insert into computer_connect_codes (
          workspace_id, token_hash, issued_by_user_id, issued_by_account_id, mode, expires_at, target_computer_id
        )
        values (
          ${bootstrap.workspaceId}, ${"5".repeat(64)}, ${bootstrap.userId}, ${bootstrap.userId}, 'create',
          now() + interval '15 minutes', ${enrollment.workspaceComputerId}
        )
      `.catch((error: unknown) => error);
      expect(postgresError(repairPair)).toMatchObject({
        code: "23514",
        constraint_name: "computer_connect_codes_repair_target_pair",
      });

      const missingSlackOwner = await sql`
        insert into slack_installations (
          workspace_id, status, external_app_id, external_team_id, external_bot_id,
          credential_schema_version, credential_generation, encrypted_credential, activated_at
        )
        values (
          ${bootstrap.workspaceId}, 'active', 'A_MISSING', 'T_MISSING', 'U_MISSING', 1, 1, 'secret', now()
        )
      `.catch((error: unknown) => error);
      expect(postgresError(missingSlackOwner)).toMatchObject({ code: "23502" });

      const [installation] = await sql<{ id: string }[]>`
        insert into slack_installations (
          workspace_id, agent_id, status, external_app_id, external_team_id, external_bot_id,
          credential_schema_version, credential_generation, encrypted_credential, activated_at
        )
        values (
          ${bootstrap.workspaceId}, ${agent.id}, 'active', 'A_OWNED', 'T_OWNED', 'U_OWNED', 1, 1, 'secret', now()
        )
        returning id::text
      `;
      if (!installation) throw new Error("Slack installation fixture was not created");
      const [otherAgent] = await sql<{ id: string }[]>`
        insert into agents (
          workspace_id, created_by_user_id, workspace_computer_id, computer_id, name, display_name, runtime_provider
        )
        values (
          ${bootstrap.workspaceId}, ${bootstrap.userId}, ${enrollment.workspaceComputerId}, ${enrollment.workspaceComputerId},
          'other-bound', 'Other Bound', 'codex'
        )
        returning id::text
      `;
      if (!otherAgent) throw new Error("Other Agent fixture was not created");
      const ownerFk = await sql`
        insert into im_bindings (
          agent_id, provider, status, slack_installation_id, slack_route_kind, disabled_at
        )
        values (
          ${otherAgent.id}, 'slack', 'disabled', ${installation.id}, 'default', now()
        )
      `.catch((error: unknown) => error);
      expect(postgresError(ownerFk)).toMatchObject({
        code: "23503",
        constraint_name: "im_bindings_slack_installation_owner_fk",
      });
    } finally {
      await client.sql.end();
    }
  });

  it("rolls back a failed 0028 and retries after removing the obstruction", async () => {
    const journal = await readJournal();
    const through0026 = await truncatedMigrations(26);
    const through0027 = await truncatedMigrations(27);
    try {
      await migrateDatabase(databaseUrl, through0026);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await populateLegacyOwnership(sql);
        await migrateDatabase(databaseUrl, through0027);
        const [filled] = await sql<{ migrations: number; agents_nullable: string | null; null_agents: number }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (
              select is_nullable from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'computer_id'
            ) as agents_nullable,
            (select count(*)::int from agents where computer_id is null) as null_agents
        `;
        expect(filled).toEqual({
          migrations: THROUGH_0027_COUNT,
          agents_nullable: "YES",
          null_agents: 0,
        });

        await sql`update agents set computer_id = null`;
        await expect(migrateDatabase(databaseUrl, migrationsFolder)).rejects.toThrow(
          /ALTER TABLE "agents" ALTER COLUMN "computer_id" SET NOT NULL/,
        );
        const [failed] = await sql<
          {
            migrations: number;
            agents_nullable: string | null;
            identity_check: boolean;
            slack_unique: boolean;
            owner_fk: boolean;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (
              select is_nullable from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'computer_id'
            ) as agents_nullable,
            exists(select 1 from pg_constraint where conname = 'agents_computer_matches_enrollment') as identity_check,
            exists(select 1 from pg_constraint where conname = 'slack_installations_agent_id_id_unique') as slack_unique,
            exists(select 1 from pg_constraint where conname = 'im_bindings_slack_installation_owner_fk') as owner_fk
        `;
        expect(failed).toEqual({
          migrations: THROUGH_0027_COUNT,
          agents_nullable: "YES",
          identity_check: false,
          slack_unique: false,
          owner_fk: false,
        });

        await sql`update agents set computer_id = workspace_computer_id`;
        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
        const [retried] = await sql<
          {
            migrations: number;
            agents_nullable: string | null;
            identity_check: boolean;
            slack_unique: boolean;
            owner_fk: boolean;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
            (
              select is_nullable from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'computer_id'
            ) as agents_nullable,
            exists(select 1 from pg_constraint where conname = 'agents_computer_matches_enrollment') as identity_check,
            exists(select 1 from pg_constraint where conname = 'slack_installations_agent_id_id_unique') as slack_unique,
            exists(select 1 from pg_constraint where conname = 'im_bindings_slack_installation_owner_fk') as owner_fk
        `;
        expect(retried).toEqual({
          migrations: journal.entries.length,
          agents_nullable: "NO",
          identity_check: true,
          slack_unique: true,
          owner_fk: true,
        });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(through0026, { force: true, recursive: true });
      await rm(through0027, { force: true, recursive: true });
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
    } finally {
      await client.sql.end();
    }
  });
});
