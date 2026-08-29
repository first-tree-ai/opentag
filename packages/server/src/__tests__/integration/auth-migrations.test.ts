import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createBetterAuth } from "../../auth/better-auth.js";
import { BetterAuthSessionTokens } from "../../auth/session-tokens.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  MigrationVerificationError,
  migrateDatabase,
  verifyDatabaseMigrations,
  withMigrationLock,
} from "../../db/migrate.js";
import { accountCliLoginCodes, authSessions, users, workspaceAdminGrants, workspaces } from "../../db/schema/index.js";
import {
  AuthService,
  AuthServiceError,
  type AuthTokenProvider,
  ConnectCodeService,
  hashSecret,
} from "../../services/auth/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const betterAuthSecret = "im-binding-test-secret-at-least-32-characters";

/** The credential provider the server composes, so these fixtures exercise the shipped one. */
function sessionAuth(database: DatabaseClient) {
  return createBetterAuth(database, {
    onSessionCreating: async () => {},
    publicUrl: "http://localhost:8000",
    secret: betterAuthSecret,
    secureCookies: false,
    sessionTtlSeconds: 60 * 60 * 24 * 30,
  });
}
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

/** A migrations folder stopping at `lastIndex`, for replaying what a revision from that point would have done. */
async function truncatedMigrations(lastIndex: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `opentag-${lastIndex}-migrations-`));
  await mkdir(join(folder, "meta"));
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter(({ idx }) => idx <= lastIndex);
  for (const entry of entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  return folder;
}

async function createAuthFixture(now = new Date("2026-08-18T00:00:00.000Z"), authTokens?: AuthTokenProvider) {
  let currentNow = now;
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(
    client.database,
    {
      displayName: "Admin",
      email: "admin@example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    },
    now,
  );
  const auth = new AuthService(
    client.database,
    authTokens ?? new BetterAuthSessionTokens(sessionAuth(client.database), client.database, { now: () => currentNow }),
    {
      now: () => currentNow,
    },
  );
  return {
    auth,
    bootstrap,
    setNow: (value: Date) => {
      currentNow = value;
    },
    ...client,
  };
}

describe("database migrations", () => {
  it("orders Slack workspace routing after the deployed auth and Session collaboration migrations", async () => {
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    // Anchored to the fixed 0010..0025 range rather than the tail: a trailing slice silently stops covering the
    // earliest entry every time a migration is appended, which would quietly shrink what this test guarantees.
    expect(journal.entries.slice(10, 26).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 10, tag: "0010_optimal_jazinda" },
      { idx: 11, tag: "0011_staging_team_setup_repair" },
      { idx: 12, tag: "0012_supreme_maddog" },
      { idx: 13, tag: "0013_bizarre_gamma_corps" },
      { idx: 14, tag: "0014_illegal_wolfsbane" },
      { idx: 15, tag: "0015_spotty_machine_man" },
      { idx: 16, tag: "0016_certain_revanche" },
      { idx: 17, tag: "0017_sour_tiger_shark" },
      { idx: 18, tag: "0018_salty_tombstone" },
      { idx: 19, tag: "0019_previous_magneto" },
      { idx: 20, tag: "0020_large_jack_power" },
      { idx: 21, tag: "0021_slow_gamora" },
      { idx: 22, tag: "0022_short_kitty_pryde" },
      { idx: 23, tag: "0023_motionless_gideon" },
      { idx: 24, tag: "0024_icy_warlock" },
      { idx: 25, tag: "0025_retire_legacy_credentials" },
    ]);
  });

  it("orders the Account and Better Auth expansions before Session collaboration storage", async () => {
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.slice(20, 26).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 20, tag: "0020_large_jack_power" },
      { idx: 21, tag: "0021_slow_gamora" },
      { idx: 22, tag: "0022_short_kitty_pryde" },
      // Recorded which session a legacy credential was exchanged for, so a replayed exchange converged on one row.
      { idx: 23, tag: "0023_motionless_gideon" },
      { idx: 24, tag: "0024_icy_warlock" },
      /*
       * Retires that record with the bridge it served, and takes over the one-Account-per-address invariant from the
       * resolver. It lands last because it could not exist while a revision that wrote unnormalized addresses might
       * still be serving.
       */
      { idx: 25, tag: "0025_retire_legacy_credentials" },
    ]);
  });

  it("removes only Slack setup state, disables incomplete rows, and fences incomplete legacy scopes", async () => {
    const legacyFolder = await mkdtemp(join(tmpdir(), "opentag-0013-migrations-"));
    const legacyMeta = join(legacyFolder, "meta");
    await mkdir(legacyMeta);
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const legacyEntries = journal.entries.filter(({ idx }) => idx <= 13);
    for (const entry of legacyEntries) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
    }
    await writeFile(join(legacyMeta, "_journal.json"), JSON.stringify({ ...journal, entries: legacyEntries }, null, 2));

    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const userId = "00000000-0000-4000-8000-000000000001";
        const teamId = "00000000-0000-4000-8000-000000000002";
        const computerId = "00000000-0000-4000-8000-000000000003";
        const slackProvisioningAgentId = "00000000-0000-4000-8000-000000000011";
        const slackIncompleteAgentId = "00000000-0000-4000-8000-000000000012";
        const slackCompleteAgentId = "00000000-0000-4000-8000-000000000013";
        const feishuAgentId = "00000000-0000-4000-8000-000000000014";
        await sql`
          insert into users (id, email, display_name) values (${userId}, 'migration@example.com', 'Migration')
        `;
        await sql`insert into teams (id, name, display_name) values (${teamId}, 'migration', 'Migration')`;
        await sql`
          insert into memberships (team_id, user_id, role, status) values (${teamId}, ${userId}, 'admin', 'active')
        `;
        await sql`
          insert into computers (id, owner_user_id, display_name, platform, arch, client_version)
          values (${computerId}, ${userId}, 'Migration Computer', 'linux', 'x64', 'test')
        `;
        await sql`
          insert into agents (id, team_id, manager_user_id, computer_id, name, display_name, runtime_provider)
          values
            (${slackProvisioningAgentId}, ${teamId}, ${userId}, ${computerId}, 'slack-provisioning', 'Slack Provisioning', 'codex'),
            (${slackIncompleteAgentId}, ${teamId}, ${userId}, ${computerId}, 'slack-incomplete', 'Slack Incomplete', 'codex'),
            (${slackCompleteAgentId}, ${teamId}, ${userId}, ${computerId}, 'slack-complete', 'Slack Complete', 'codex'),
            (${feishuAgentId}, ${teamId}, ${userId}, ${computerId}, 'feishu-setup', 'Feishu Setup', 'codex')
        `;
        await sql`
          insert into im_bindings (
            agent_id, provider, status, setup_attempt_id, setup_intent, setup_state,
            setup_owner_instance_id, setup_owner_heartbeat_at, encrypted_setup_context, setup_expires_at,
            pending_receive_mode
          ) values (
            ${slackProvisioningAgentId}, 'slack', 'provisioning', gen_random_uuid(), 'create', 'awaiting_user',
            gen_random_uuid(), now(), 'encrypted-slack-setup', now() + interval '30 minutes', 'all_message'
          )
        `;
        await sql`
          insert into im_bindings (
            agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
            credential_schema_version, credential_generation, encrypted_credential, granted_capabilities,
            activated_at, pending_receive_mode
          ) values (
            ${slackIncompleteAgentId}, 'slack', 'active', 'A_INCOMPLETE', 'T1', 'U1',
            1, 2, 'encrypted-incomplete',
            array['app_mentions:read', 'chat:write', 'files:read', 'im:history']::text[], now(), 'all_message'
          )
        `;
        await sql`
          insert into im_bindings (
            agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
            credential_schema_version, credential_generation, encrypted_credential, granted_capabilities,
            activated_at, observed_connected_at, last_error_code, pending_receive_mode
          ) values (
            ${slackCompleteAgentId}, 'slack', 'reauthorization_required', 'A_COMPLETE', 'T1', 'U2',
            1, 3, 'encrypted-complete',
            array[
              'app_mentions:read', 'channels:history', 'chat:write', 'files:read',
              'groups:history', 'im:history', 'mpim:history'
            ]::text[], now(), now(), 'IM_BINDING_SCOPE_REAUTH_REQUIRED', 'all_message'
          )
        `;
        const [feishuSetup] = await sql<{ attempt_id: string }[]>`
          insert into im_bindings (
            agent_id, provider, status, setup_attempt_id, setup_intent, setup_state,
            setup_owner_instance_id, setup_owner_heartbeat_at, encrypted_setup_context, setup_expires_at,
            observed_connected_at,
            pending_receive_mode
          ) values (
            ${feishuAgentId}, 'feishu', 'provisioning', gen_random_uuid(), 'create', 'awaiting_user',
            gen_random_uuid(), now(), 'encrypted-feishu-setup', now() + interval '15 minutes', now(), null
          ) returning setup_attempt_id::text as attempt_id
        `;

        await migrateDatabase(databaseUrl, migrationsFolder);

        const rows = await sql<
          {
            agent_id: string;
            encrypted_credential: string | null;
            encrypted_setup_context: string | null;
            last_error_code: string | null;
            observed_connected_at: Date | null;
            setup_attempt_id: string | null;
            slack_installation_id: string | null;
            slack_route_kind: string | null;
            status: string;
          }[]
        >`
          select agent_id::text, status, encrypted_credential, setup_attempt_id::text,
                 encrypted_setup_context, observed_connected_at, last_error_code,
                 slack_installation_id::text, slack_route_kind::text
          from im_bindings
          order by agent_id
        `;
        expect(rows).toEqual([
          {
            agent_id: slackProvisioningAgentId,
            status: "disabled",
            encrypted_credential: null,
            setup_attempt_id: null,
            encrypted_setup_context: null,
            observed_connected_at: null,
            last_error_code: "SLACK_CONFIGURATION_REQUIRED",
            slack_installation_id: null,
            slack_route_kind: null,
          },
          {
            agent_id: slackIncompleteAgentId,
            status: "disabled",
            encrypted_credential: null,
            setup_attempt_id: null,
            encrypted_setup_context: null,
            observed_connected_at: null,
            last_error_code: "SLACK_SCOPE_REAUTH_REQUIRED",
            slack_installation_id: null,
            slack_route_kind: null,
          },
          {
            agent_id: slackCompleteAgentId,
            status: "active",
            encrypted_credential: null,
            setup_attempt_id: null,
            encrypted_setup_context: null,
            observed_connected_at: null,
            last_error_code: null,
            slack_installation_id: expect.any(String),
            slack_route_kind: "default",
          },
          {
            agent_id: feishuAgentId,
            status: "provisioning",
            encrypted_credential: null,
            setup_attempt_id: feishuSetup?.attempt_id ?? null,
            encrypted_setup_context: "encrypted-feishu-setup",
            observed_connected_at: expect.any(Date),
            last_error_code: null,
            slack_installation_id: null,
            slack_route_kind: null,
          },
        ]);
        const installations = await sql<{ encrypted_credential: string | null; status: string }[]>`
          select status::text, encrypted_credential from slack_installations
        `;
        expect(installations).toEqual([{ status: "active", encrypted_credential: "encrypted-complete" }]);
        const pendingColumn = await sql<{ count: number }[]>`
          select count(*)::int as count from information_schema.columns
          where table_name = 'im_bindings' and column_name = 'pending_receive_mode'
        `;
        expect(pendingColumn[0]?.count).toBe(0);
        const slackSetup = await sql<{ count: number }[]>`
          select count(*)::int as count from im_bindings
          where provider = 'slack' and (
            setup_attempt_id is not null or setup_intent is not null or setup_state is not null or
            setup_owner_instance_id is not null or setup_owner_heartbeat_at is not null or
            encrypted_setup_context is not null or setup_expires_at is not null
          )
        `;
        expect(slackSetup[0]?.count).toBe(0);
        const slackSetupCheck = await sql<{ count: number }[]>`
          select count(*)::int as count from pg_constraint
          where conname = 'im_bindings_slack_setup_fields_null'
        `;
        expect(slackSetupCheck[0]?.count).toBe(1);
        await expect(
          sql`
            update im_bindings
            set setup_attempt_id = gen_random_uuid(), setup_intent = 'create', setup_state = 'awaiting_user',
                setup_owner_instance_id = gen_random_uuid(), setup_owner_heartbeat_at = now(),
                encrypted_setup_context = 'encrypted-slack-setup', setup_expires_at = now()
            where agent_id = ${slackCompleteAgentId}
          `,
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    } finally {
      await rm(legacyFolder, { force: true, recursive: true });
    }
  });

  it("ends Sessions for every Slack binding disabled by the workspace installation cutover", async () => {
    const legacyFolder = await mkdtemp(join(tmpdir(), "opentag-0020-migrations-"));
    const legacyMeta = join(legacyFolder, "meta");
    await mkdir(legacyMeta);
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const legacyEntries = journal.entries.filter(({ idx }) => idx <= 20);
    for (const entry of legacyEntries) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
    }
    await writeFile(join(legacyMeta, "_journal.json"), JSON.stringify({ ...journal, entries: legacyEntries }, null, 2));

    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const userId = "10000000-0000-4000-8000-000000000001";
        const workspaceId = "10000000-0000-4000-8000-000000000002";
        const computerId = "10000000-0000-4000-8000-000000000003";
        const workspaceComputerId = "10000000-0000-4000-8000-000000000004";
        const provisioningAgentId = "10000000-0000-4000-8000-000000000011";
        const chosenAgentId = "10000000-0000-4000-8000-000000000012";
        const supersededAgentId = "10000000-0000-4000-8000-000000000013";
        const provisioningBindingId = "10000000-0000-4000-8000-000000000021";
        const chosenBindingId = "10000000-0000-4000-8000-000000000022";
        const supersededBindingId = "10000000-0000-4000-8000-000000000023";
        await sql`
          insert into users (id, email, display_name)
          values (${userId}, 'slack-cutover@example.com', 'Slack Cutover')
        `;
        await sql`
          insert into workspaces (id, name, display_name)
          values (${workspaceId}, 'slack-cutover', 'Slack Cutover')
        `;
        await sql`
          insert into workspace_admin_grants (workspace_id, user_id, granted_by_user_id)
          values (${workspaceId}, ${userId}, ${userId})
        `;
        await sql`insert into computers (id) values (${computerId})`;
        await sql`
          insert into workspace_computers (
            id, workspace_id, computer_id, display_name, platform, arch, client_version, enrolled_by_user_id
          ) values (
            ${workspaceComputerId}, ${workspaceId}, ${computerId}, 'Cutover Computer', 'linux', 'x64', 'test', ${userId}
          )
        `;
        await sql`
          insert into agents (
            id, workspace_id, created_by_user_id, workspace_computer_id, name, display_name, runtime_provider
          ) values
            (${provisioningAgentId}, ${workspaceId}, ${userId}, ${workspaceComputerId}, 'provisioning', 'Provisioning', 'codex'),
            (${chosenAgentId}, ${workspaceId}, ${userId}, ${workspaceComputerId}, 'chosen', 'Chosen', 'codex'),
            (${supersededAgentId}, ${workspaceId}, ${userId}, ${workspaceComputerId}, 'superseded', 'Superseded', 'codex')
        `;
        await sql`
          insert into im_bindings (id, agent_id, provider, status, created_at, updated_at)
          values (
            ${provisioningBindingId}, ${provisioningAgentId}, 'slack', 'provisioning',
            '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
          )
        `;
        await sql`
          insert into im_bindings (
            id, agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
            credential_schema_version, credential_generation, encrypted_credential, granted_capabilities,
            activated_at, created_at, updated_at
          ) values
            (
              ${chosenBindingId}, ${chosenAgentId}, 'slack', 'active', 'A_CUSTOMER', 'T_CUSTOMER', 'U_CUSTOMER',
              1, 3, 'encrypted-customer',
              array[
                'app_mentions:read', 'channels:history', 'chat:write', 'files:read',
                'groups:history', 'im:history', 'mpim:history'
              ]::text[],
              '2026-08-20T01:00:00.000Z', '2026-08-20T01:00:00.000Z', '2026-08-20T01:00:00.000Z'
            ),
            (
              ${supersededBindingId}, ${supersededAgentId}, 'slack', 'active', 'A_OTHER', 'T_OTHER', 'U_OTHER',
              1, 2, 'encrypted-other',
              array[
                'app_mentions:read', 'channels:history', 'chat:write', 'files:read',
                'groups:history', 'im:history', 'mpim:history'
              ]::text[],
              '2026-08-20T02:00:00.000Z', '2026-08-20T02:00:00.000Z', '2026-08-20T02:00:00.000Z'
            )
        `;
        await sql`
          insert into sessions (im_binding_id, channel_id, conversation_kind, kind)
          values
            (${provisioningBindingId}, 'C_PROVISIONING', 'channel', 'channel'),
            (${chosenBindingId}, 'C_CHOSEN', 'channel', 'channel'),
            (${supersededBindingId}, 'C_SUPERSEDED', 'channel', 'channel')
        `;

        await migrateDatabase(databaseUrl, migrationsFolder);

        const rows = await sql<
          {
            binding_id: string;
            encrypted_credential: string | null;
            ended_at: Date | null;
            revision: number;
            slack_installation_id: string | null;
            slack_route_kind: string | null;
            status: string;
          }[]
        >`
          select
            im_bindings.id::text as binding_id,
            im_bindings.status::text,
            im_bindings.encrypted_credential,
            im_bindings.slack_installation_id::text,
            im_bindings.slack_route_kind::text,
            sessions.ended_at,
            sessions.revision::int
          from im_bindings
          inner join sessions on sessions.im_binding_id = im_bindings.id
          order by im_bindings.id
        `;
        expect(rows).toEqual([
          {
            binding_id: provisioningBindingId,
            status: "disabled",
            encrypted_credential: null,
            slack_installation_id: null,
            slack_route_kind: null,
            ended_at: expect.any(Date),
            revision: 2,
          },
          {
            binding_id: chosenBindingId,
            status: "active",
            encrypted_credential: null,
            slack_installation_id: expect.any(String),
            slack_route_kind: "default",
            ended_at: null,
            revision: 1,
          },
          {
            binding_id: supersededBindingId,
            status: "disabled",
            encrypted_credential: null,
            slack_installation_id: null,
            slack_route_kind: null,
            ended_at: expect.any(Date),
            revision: 2,
          },
        ]);
        const installations = await sql<
          { encrypted_credential: string; external_app_id: string; external_team_id: string; workspace_id: string }[]
        >`
          select workspace_id::text, external_app_id, external_team_id, encrypted_credential
          from slack_installations
          where status <> 'disabled'
        `;
        expect(installations).toEqual([
          {
            workspace_id: workspaceId,
            external_app_id: "A_CUSTOMER",
            external_team_id: "T_CUSTOMER",
            encrypted_credential: "encrypted-customer",
          },
        ]);
      } finally {
        await sql.end();
      }
    } finally {
      await rm(legacyFolder, { force: true, recursive: true });
    }
  });

  it("migrates an empty database and reruns idempotently", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    await migrateDatabase(databaseUrl, migrationsFolder);

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const [row] = await sql<{ table_count: number }[]>`
        select count(*)::int as table_count
        from information_schema.tables
        where table_schema = 'public' and table_name in (
          'users', 'workspaces', 'workspace_admin_grants', 'account_cli_login_codes', 'computers',
          'workspace_computers', 'agents', 'auth_identities', 'admin_invitations'
        )
      `;
      expect(row?.table_count).toBe(9);
    } finally {
      await sql.end();
    }
  });

  it("rejects a deployed Team whose only active Admin account is suspended", async () => {
    const legacyFolder = await mkdtemp(join(tmpdir(), "opentag-0015-migrations-"));
    const legacyMeta = join(legacyFolder, "meta");
    await mkdir(legacyMeta);
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const legacyEntries = journal.entries.filter(({ idx }) => idx <= 15);
    for (const entry of legacyEntries) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
    }
    await writeFile(join(legacyMeta, "_journal.json"), JSON.stringify({ ...journal, entries: legacyEntries }, null, 2));

    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const userId = crypto.randomUUID();
        const teamId = crypto.randomUUID();
        await sql`
          insert into users (id, email, display_name, suspended_at)
          values (${userId}, 'suspended-migration@example.com', 'Suspended Migration Admin', now())
        `;
        await sql`insert into teams (id, name, display_name) values (${teamId}, 'suspended', 'Suspended')`;
        await sql`
          insert into memberships (team_id, user_id, role, status)
          values (${teamId}, ${userId}, 'admin', 'active')
        `;

        await expect(migrateDatabase(databaseUrl, migrationsFolder)).rejects.toThrow(
          "Workspace cutover requires at least one active Admin per legacy Team",
        );
        const [state] = await sql<
          {
            migration_count: number;
            grants_table: string | null;
            memberships_table: string | null;
            workspaces_table: string | null;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migration_count,
            to_regclass('public.memberships')::text as memberships_table,
            to_regclass('public.workspace_admin_grants')::text as grants_table,
            to_regclass('public.workspaces')::text as workspaces_table
        `;
        expect(state).toEqual({
          migration_count: 16,
          grants_table: null,
          memberships_table: "memberships",
          workspaces_table: null,
        });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(legacyFolder, { force: true, recursive: true });
    }
  });

  it("normalizes Account email casing and backfills verification without constraining the previous writer", async () => {
    const legacyFolder = await mkdtemp(join(tmpdir(), "opentag-0017-migrations-"));
    const legacyMeta = join(legacyFolder, "meta");
    await mkdir(legacyMeta);
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const legacyEntries = journal.entries.filter(({ idx }) => idx <= 19);
    for (const entry of legacyEntries) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
    }
    await writeFile(join(legacyMeta, "_journal.json"), JSON.stringify({ ...journal, entries: legacyEntries }, null, 2));

    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const casingUserId = crypto.randomUUID();
        const verifiedUserId = crypto.randomUUID();
        await sql`
          insert into users (id, email, display_name)
          values (${casingUserId}, 'Casing@Example.com', 'Mixed Casing')
        `;
        await sql`
          insert into users (id, email, display_name)
          values (${verifiedUserId}, 'Verified@Example.com', 'Verified Identity')
        `;
        await sql`
          insert into auth_identities (user_id, provider, issuer, subject, email)
          values (${verifiedUserId}, 'google', 'https://accounts.google.com', 'google-subject-1', 'Verified@Example.com')
        `;

        const expandOnlyFolder = await truncatedMigrations(23);
        try {
          await migrateDatabase(databaseUrl, expandOnlyFolder);
        } finally {
          await rm(expandOnlyFolder, { force: true, recursive: true });
        }

        const accounts = await sql<{ email: string; email_verified: boolean; id: string }[]>`
          select id, email, email_verified from users order by email
        `;
        expect([...accounts]).toEqual([
          // No identity asserts this address, so the backfill leaves it unverified.
          { email: "casing@example.com", email_verified: false, id: casingUserId },
          { email: "verified@example.com", email_verified: true, id: verifiedUserId },
        ]);

        /*
         * The previous server revision inserts a `users` row for an unknown provider subject without resolving the
         * address first. It had to keep working across the whole expand-only window, because rolling back code does
         * not roll back migrations: uniqueness landing there would have turned its first sign-in into a raw `23505`.
         */
        const [duplicate] = await sql<{ id: string }[]>`
          insert into users (email, display_name) values ('CASING@EXAMPLE.COM', 'Previous Revision') returning id
        `;
        expect(duplicate).toBeDefined();

        /*
         * 0025 closes that window. It is the contract step, and can only run once no revision that writes
         * unnormalized addresses is still serving — which is also why its guard refuses to create the index while a
         * duplicate exists rather than choosing a row to discard.
         */
        await expect(migrateDatabase(databaseUrl, migrationsFolder)).rejects.toThrow(/share an email address/);
        await sql`delete from users where id = ${duplicate?.id ?? ""}`;
        await migrateDatabase(databaseUrl, migrationsFolder);
        await expect(
          sql`insert into users (email, display_name) values ('CASING@EXAMPLE.COM', 'Previous Revision')`,
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await sql.end();
      }
    } finally {
      await rm(legacyFolder, { force: true, recursive: true });
    }
  });

  it("reconciles Accounts a rolled-back server revision left unverified", async () => {
    /*
     * 0020 is expand-only so the previous revision keeps running against the new schema, which a rollback needs
     * because rolling back code does not roll back migrations. That revision predates the writer maintaining
     * `email_verified`, so this replays it: stop at 0020, write the row that revision would have written, then let the
     * next migration reconcile it.
     */
    const legacyFolder = await mkdtemp(join(tmpdir(), "opentag-0020-migrations-"));
    const legacyMeta = join(legacyFolder, "meta");
    await mkdir(legacyMeta);
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const legacyEntries = journal.entries.filter(({ idx }) => idx <= 20);
    for (const entry of legacyEntries) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
    }
    await writeFile(join(legacyMeta, "_journal.json"), JSON.stringify({ ...journal, entries: legacyEntries }, null, 2));

    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const staleId = crypto.randomUUID();
        const untouchedId = crypto.randomUUID();
        await sql`
          insert into users (id, email, display_name, email_verified)
          values
            (${staleId}, 'stale@example.com', 'Stale Account', false),
            (${untouchedId}, 'no-identity@example.com', 'No Identity', false)
        `;
        await sql`
          insert into auth_identities (user_id, provider, issuer, subject, email)
          values (${staleId}, 'google', 'https://accounts.google.com', 'stale-subject', 'stale@example.com')
        `;

        await migrateDatabase(databaseUrl, migrationsFolder);

        const verified = await sql<{ email_verified: boolean; id: string }[]>`
          select id, email_verified from users order by email
        `;
        expect([...verified]).toEqual([
          // An Account with no provider identity has nothing asserting its address, so it stays unverified.
          { email_verified: false, id: untouchedId },
          { email_verified: true, id: staleId },
        ]);
      } finally {
        await sql.end();
      }
    } finally {
      await rm(legacyFolder, { force: true, recursive: true });
    }
  });

  it("maps legacy left_at rows to the single membership status truth", async () => {
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const applyFile = async (name: string) => {
      const source = await readFile(`${migrationsFolder}/${name}`, "utf8");
      for (const statement of source
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean)) {
        await sql.unsafe(statement);
      }
    };
    try {
      await applyFile("0000_strong_thunderbolt_ross.sql");
      await applyFile("0001_living_franklin_richards.sql");
      await applyFile("0002_sticky_crystal.sql");
      const [user] = await sql<{ id: string }[]>`
        insert into users (email, display_name) values ('left@example.com', 'Left User') returning id
      `;
      const [team] = await sql<{ id: string }[]>`
        insert into teams (name, display_name) values ('legacy', 'Legacy') returning id
      `;
      if (!user || !team) throw new Error("Legacy fixtures were not created");
      await sql`
        insert into memberships (team_id, user_id, role, left_at)
        values (${team.id}, ${user.id}, 'admin', now())
      `;
      await applyFile("0003_noisy_husk.sql");
      const [membership] = await sql<{ status: string }[]>`select status from memberships`;
      expect(membership?.status).toBe("left");
      const columns = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'memberships'
      `;
      expect(columns.map(({ column_name }) => column_name)).not.toContain("left_at");
      const emailIndex = await sql<{ count: number }[]>`
        select count(*)::int as count from pg_indexes where indexname = 'users_email_unique'
      `;
      expect(emailIndex[0]?.count).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("upgrades deployed 0005 and 0006 Drizzle histories through each forward migration exactly once", async () => {
    const legacyFolder = await mkdtemp(join(tmpdir(), "opentag-0005-migrations-"));
    const legacyMeta = join(legacyFolder, "meta");
    await mkdir(legacyMeta);
    const through0006Folder = await mkdtemp(join(tmpdir(), "opentag-0006-migrations-"));
    const through0006Meta = join(through0006Folder, "meta");
    await mkdir(through0006Meta);
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    for (const entry of journal.entries.filter(({ idx }) => idx <= 5)) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
    }
    await writeFile(
      join(legacyMeta, "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 5) }, null, 2),
    );
    for (const entry of journal.entries.filter(({ idx }) => idx <= 6)) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(through0006Folder, `${entry.tag}.sql`));
    }
    await writeFile(
      join(through0006Meta, "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 6) }, null, 2),
    );

    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const [before] = await sql<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `;
        expect(before?.count).toBe(6);
        expect(await sql`select to_regclass('public.integrations') as table_name`).toEqual([
          { table_name: "integrations" },
        ]);

        await migrateDatabase(databaseUrl, through0006Folder);
        const [after] = await sql<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `;
        expect(after?.count).toBe(7);
        const [objects] = await sql<
          { im_bindings: string | null; integrations: string | null; new_enum: boolean; old_enum: boolean }[]
        >`
          select
            to_regclass('public.im_bindings')::text as im_bindings,
            to_regclass('public.integrations')::text as integrations,
            exists(select 1 from pg_type where typname = 'im_binding_status') as new_enum,
            exists(select 1 from pg_type where typname = 'integration_status') as old_enum
        `;
        expect(objects).toEqual({ im_bindings: "im_bindings", integrations: null, new_enum: true, old_enum: false });
        const columns = await sql<{ table_name: string; column_name: string; column_default: string | null }[]>`
          select table_name, column_name, column_default
          from information_schema.columns
          where (table_name in ('sessions', 'im_messages') and column_name in ('integration_id', 'im_binding_id'))
             or (table_name = 'agents' and column_name = 'receive_mode')
          order by table_name, column_name
        `;
        expect(columns).toEqual([
          { table_name: "agents", column_name: "receive_mode", column_default: "'mention_only'::agent_receive_mode" },
          { table_name: "im_messages", column_name: "im_binding_id", column_default: null },
          { table_name: "sessions", column_name: "im_binding_id", column_default: null },
        ]);
        const constraints = await sql<{ conname: string }[]>`
          select conname from pg_constraint
          where conname in (
            'agents_manager_membership_fk',
            'agents_manager_computer_owner_fk',
            'im_bindings_agent_id_agents_id_fk',
            'sessions_im_binding_id_im_bindings_id_fk'
          )
          order by conname
        `;
        expect(constraints.map(({ conname }) => conname)).toEqual([
          "agents_manager_computer_owner_fk",
          "agents_manager_membership_fk",
          "im_bindings_agent_id_agents_id_fk",
          "sessions_im_binding_id_im_bindings_id_fk",
        ]);
        const indexes = await sql<{ indexname: string }[]>`
          select indexname from pg_indexes
          where indexname in ('im_bindings_agent_current_unique', 'sessions_im_binding_scope_idx')
          order by indexname
        `;
        expect(indexes.map(({ indexname }) => indexname)).toEqual([
          "im_bindings_agent_current_unique",
          "sessions_im_binding_scope_idx",
        ]);

        const userId = crypto.randomUUID();
        const suspendedUserId = crypto.randomUUID();
        const teamId = crypto.randomUUID();
        const controlTeamId = crypto.randomUUID();
        const activeAgentComputerId = crypto.randomUUID();
        const deletedAgentComputerId = crypto.randomUUID();
        const activeSessionComputerId = crypto.randomUUID();
        const endedSessionComputerId = crypto.randomUUID();
        const activeAgentId = "6eb89d85-0f12-4962-8465-518071f1d3e9";
        const deletedAgentId = crypto.randomUUID();
        const imBindingId = crypto.randomUUID();
        const activeSessionId = crypto.randomUUID();
        const endedSessionId = crypto.randomUUID();
        await sql`insert into users (id, email, display_name) values (${userId}, 'migration@example.com', 'Migration')`;
        await sql`
          insert into users (id, email, display_name, suspended_at)
          values (${suspendedUserId}, 'suspended@example.com', 'Suspended', now())
        `;
        await sql`insert into teams (id, name, display_name) values (${teamId}, 'migration', 'Migration')`;
        await sql`
          insert into teams (id, name, display_name)
          values (${controlTeamId}, 'migration-control', 'Migration Control')
        `;
        await sql`
          insert into memberships (team_id, user_id, role)
          values
            (${teamId}, ${userId}, 'admin'),
            (${teamId}, ${suspendedUserId}, 'admin'),
            (${controlTeamId}, ${userId}, 'admin')
        `;
        await sql`
          insert into computers (id, owner_user_id, display_name, platform, arch, client_version)
          values
            (${activeAgentComputerId}, ${userId}, 'Active Agent Computer', 'linux', 'x64', '0.0.1'),
            (${deletedAgentComputerId}, ${userId}, 'Deleted Agent Computer', 'linux', 'x64', '0.0.1'),
            (${activeSessionComputerId}, ${userId}, 'Active Session Computer', 'linux', 'x64', '0.0.1'),
            (${endedSessionComputerId}, ${userId}, 'Ended Session Computer', 'linux', 'x64', '0.0.1')
        `;
        await sql`
          insert into agents (id, team_id, manager_user_id, computer_id, name, display_name, runtime_provider)
          values (
            ${activeAgentId}, ${teamId}, ${userId}, ${activeAgentComputerId},
            'active-agent', 'Active Agent', 'codex'
          )
        `;
        await sql`
          insert into agents (
            id, team_id, manager_user_id, computer_id, name, display_name, runtime_provider, deleted_at
          )
          values (
            ${deletedAgentId}, ${teamId}, ${userId}, ${deletedAgentComputerId},
            'deleted-agent', 'Deleted Agent', 'codex', now()
          )
        `;
        await sql`
          insert into im_bindings (id, agent_id, provider, status)
          values (${imBindingId}, ${activeAgentId}, 'slack', 'provisioning')
        `;
        await sql`
          insert into sessions (
            id, im_binding_id, channel_id, conversation_kind, kind, ended_at
          )
          values
            (${activeSessionId}, ${imBindingId}, 'active-channel', 'channel', 'channel', null),
            (${endedSessionId}, ${imBindingId}, 'ended-channel', 'channel', 'channel', now())
        `;
        await sql`
          insert into session_placements (session_id, computer_id, generation)
          values
            (${activeSessionId}, ${activeSessionComputerId}, 1),
            (${endedSessionId}, ${endedSessionComputerId}, 1)
        `;

        await migrateDatabase(databaseUrl, migrationsFolder);
        const [lifecycle] = await sql<
          {
            count: number;
            creation_intents_null: boolean;
            deleted_at_exists: boolean;
            setup_completed_at_exists: boolean;
            status_default: string | null;
            receive_mode_default: string | null;
            statuses: string[];
            receive_modes: string[];
            workspace_enrollments: number;
            machine_credentials: number;
            enrollment_presence_offline: boolean;
            creator_owner_constraint_removed: boolean;
          }[]
        >`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as count,
            not exists(
              select 1 from agents
              where creation_intent_id is not null or creation_intent_fingerprint is not null
            ) as creation_intents_null,
            exists(
              select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'deleted_at'
            ) as deleted_at_exists,
            exists(
              select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'workspaces' and column_name = 'setup_completed_at'
            ) as setup_completed_at_exists,
            (
              select column_default from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'status'
            ) as status_default,
            (
              select column_default from information_schema.columns
              where table_schema = 'public' and table_name = 'agents' and column_name = 'receive_mode'
            ) as receive_mode_default,
            array(select status::text from agents order by name) as statuses,
            array(select receive_mode::text from agents order by name) as receive_modes,
            (
              select count(*)::int from workspace_computers
              where workspace_id = ${teamId}
            ) as workspace_enrollments,
            (select count(*)::int from workspace_computer_credentials) as machine_credentials,
            not exists(
              select 1 from workspace_computers
              where current_instance_id is not null or connected_at is not null
            ) as enrollment_presence_offline,
            not exists(
              select 1 from pg_constraint
              where conrelid = 'agents'::regclass and conname = 'agents_manager_computer_owner_fk'
            ) as creator_owner_constraint_removed
        `;
        expect(lifecycle).toEqual({
          // Derived from the journal so appending a migration cannot turn "applied exactly once" into a stale literal.
          count: journal.entries.length,
          creation_intents_null: true,
          deleted_at_exists: false,
          setup_completed_at_exists: true,
          status_default: "'active'::agent_status",
          receive_mode_default: "'all_message'::agent_receive_mode",
          statuses: ["active", "deleted"],
          receive_modes: ["mention_only", "mention_only"],
          workspace_enrollments: 4,
          machine_credentials: 0,
          enrollment_presence_offline: true,
          creator_owner_constraint_removed: true,
        });
        const enrollmentStates = await sql<
          {
            computer_id: string;
            current_instance_id: string | null;
            revoked_at: Date | null;
            revoked_by_user_id: string | null;
          }[]
        >`
          select computer_id, current_instance_id, revoked_at, revoked_by_user_id
          from workspace_computers
          where workspace_id = ${teamId}
        `;
        const statesByComputer = new Map(enrollmentStates.map((row) => [row.computer_id, row]));
        for (const computerId of [activeAgentComputerId, activeSessionComputerId]) {
          expect(statesByComputer.get(computerId)).toMatchObject({
            current_instance_id: null,
            revoked_at: null,
            revoked_by_user_id: null,
          });
        }
        for (const computerId of [deletedAgentComputerId, endedSessionComputerId]) {
          expect(statesByComputer.get(computerId)).toMatchObject({
            current_instance_id: null,
            revoked_at: expect.any(Date),
            revoked_by_user_id: userId,
          });
        }
        const preservedComputerIds = await sql<{ id: string }[]>`
          select id from computers
          where id in (
            ${activeAgentComputerId}, ${deletedAgentComputerId},
            ${activeSessionComputerId}, ${endedSessionComputerId}
          )
        `;
        expect(preservedComputerIds).toHaveLength(4);
        const preservedAgentIds = await sql<{ id: string }[]>`
          select id from agents where id in (${activeAgentId}, ${deletedAgentId})
        `;
        expect(preservedAgentIds).toHaveLength(2);
        const [expansion] = await sql<
          {
            account_computers: number;
            computer_credentials: number;
            agents_filled: number;
            placements_filled: number;
          }[]
        >`
          select
            (select count(*)::int from account_computers) as account_computers,
            (select count(*)::int from computer_credentials) as computer_credentials,
            (select count(*)::int from agents where computer_id is not null) as agents_filled,
            (select count(*)::int from session_placements where computer_id is not null) as placements_filled
        `;
        expect(expansion).toEqual({
          account_computers: 0,
          computer_credentials: 0,
          agents_filled: 0,
          placements_filled: 0,
        });
        const repairedWorkspaces = await sql<{ completed: boolean; name: string }[]>`
          select name, setup_completed_at is not null as completed
          from workspaces
          order by name
        `;
        expect(repairedWorkspaces).toEqual([
          { completed: true, name: "migration" },
          { completed: false, name: "migration-control" },
        ]);
        const migratedAdmins = await sql<{ user_id: string }[]>`
          select user_id::text from workspace_admin_grants where workspace_id = ${teamId} order by user_id
        `;
        expect(migratedAdmins).toEqual([{ user_id: userId }]);
        const [agentStatusEnum] = await sql<{ values: string[] }[]>`
          select array_agg(enumlabel order by enumsortorder)::text[] as values
          from pg_enum join pg_type on pg_type.oid = pg_enum.enumtypid
          where pg_type.typname = 'agent_status'
        `;
        expect(agentStatusEnum?.values).toEqual(["active", "suspended", "deleted"]);
        const [agentNameIndex] = await sql<{ indexdef: string }[]>`
          select indexdef from pg_indexes where indexname = 'agents_workspace_name_active_unique'
        `;
        expect(agentNameIndex?.indexdef).toContain("status <> 'deleted'::agent_status");
        const [creationIntentIndex] = await sql<{ indexdef: string }[]>`
          select indexdef from pg_indexes where indexname = 'agents_creation_intent_unique'
        `;
        expect(creationIntentIndex?.indexdef).toContain("UNIQUE INDEX");

        await migrateDatabase(databaseUrl, migrationsFolder);
        const [rerun] = await sql<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `;
        expect(rerun?.count).toBe(journal.entries.length);
      } finally {
        await sql.end();
      }
    } finally {
      await rm(legacyFolder, { recursive: true, force: true });
      await rm(through0006Folder, { recursive: true, force: true });
    }
  });

  it("serializes two migrators on one session-held advisory lock", async () => {
    const firstSql = postgres(databaseUrl, { max: 1 });
    const secondSql = postgres(databaseUrl, { max: 1 });
    let releaseFirst: (() => void) | undefined;
    let signalFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    try {
      const first = withMigrationLock(firstSql, async () => {
        order.push("first-enter");
        signalFirstEntered?.();
        await firstRelease;
        order.push("first-exit");
      });
      await firstEntered;
      const second = withMigrationLock(secondSql, async () => {
        order.push("second-enter");
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual(["first-enter"]);
      releaseFirst?.();
      await Promise.all([first, second]);
      expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    } finally {
      await Promise.all([firstSql.end(), secondSql.end()]);
    }
  });

  it("releases the migration lock after a failed migration", async () => {
    await expect(migrateDatabase(databaseUrl, `${migrationsFolder}/missing`)).rejects.toThrow();
    await expect(migrateDatabase(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
  });

  it("allows concurrent migrators to complete without racing migration state", async () => {
    await expect(
      Promise.all([migrateDatabase(databaseUrl, migrationsFolder), migrateDatabase(databaseUrl, migrationsFolder)]),
    ).resolves.toEqual([undefined, undefined]);
  });

  it("verifies an exactly current migration history in manual mode", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).resolves.toBeUndefined();
  });

  it("rejects an empty database in manual mode", async () => {
    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).rejects.toMatchObject({
      reason: "empty",
    });
  });

  it("rejects a database behind the checked-in migration history", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql`delete from drizzle.__drizzle_migrations`;
    } finally {
      await sql.end();
    }

    await expect(verifyDatabaseMigrations(databaseUrl, migrationsFolder)).rejects.toMatchObject({
      reason: "behind",
    });
  });

  it("classifies an unreachable database in manual mode", async () => {
    const error = await verifyDatabaseMigrations(
      "postgresql://opentag:opentag@127.0.0.1:1/opentag?connect_timeout=1",
      migrationsFolder,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationVerificationError);
    expect(error).toMatchObject({ reason: "unreachable" });
  });
});

describe("authentication persistence", () => {
  it("allows only one concurrent initial bootstrap", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    const first = createDatabaseClient(databaseUrl);
    const second = createDatabaseClient(databaseUrl);
    const input = {
      displayName: "Admin",
      email: "admin@example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    };

    try {
      const outcomes = await Promise.allSettled([
        bootstrapInitialAdmin(first.database, input),
        bootstrapInitialAdmin(second.database, input),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const storedUsers = await first.database.select().from(users);
      expect(storedUsers).toHaveLength(1);
    } finally {
      await Promise.all([first.sql.end(), second.sql.end()]);
    }
  });

  it("validates and normalizes bootstrap input at the service boundary", async () => {
    await migrateDatabase(databaseUrl, migrationsFolder);
    const client = createDatabaseClient(databaseUrl);
    try {
      await expect(
        bootstrapInitialAdmin(client.database, {
          connectCodeTtlSeconds: 0,
          displayName: "   ",
          email: "not-an-email",
          workspaceDisplayName: "   ",
          workspaceName: "Not Valid",
        }),
      ).rejects.toThrow();
      expect(await client.database.select().from(users)).toHaveLength(0);

      const result = await bootstrapInitialAdmin(client.database, {
        displayName: "  Admin  ",
        email: "  ADMIN@EXAMPLE.COM  ",
        workspaceDisplayName: "  Example  ",
        workspaceName: "  EXAMPLE  ",
      });
      const [storedUser] = await client.database.select().from(users).where(eq(users.id, result.userId));
      const [storedWorkspace] = await client.database
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, result.workspaceId));
      expect(storedUser).toMatchObject({ displayName: "Admin", email: "admin@example.com" });
      expect(storedWorkspace).toMatchObject({ displayName: "Example", name: "example" });
    } finally {
      await client.sql.end();
    }
  });

  it("stores only the connect-code hash and issues an authority-free session", async () => {
    const fixture = await createAuthFixture();
    try {
      const tokens = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      const [storedCode] = await fixture.database.select().from(accountCliLoginCodes);
      expect(storedCode?.tokenHash).toBe(hashSecret(fixture.bootstrap.connectCode));
      expect(storedCode?.tokenHash).not.toBe(fixture.bootstrap.connectCode);
      /*
       * The credential is a row, not a claim set, so nothing is carried inside it that could go stale — authority is
       * read live per request. What the row names is the Account and nothing else.
       */
      const sessions = await fixture.database.select().from(authSessions);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ token: tokens.accessToken, userId: fixture.bootstrap.userId });
      expect(tokens.refreshToken).toBe(tokens.accessToken);

      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toMatchObject({
        code: "AUTH_CODE_CONSUMED",
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("issues user-scoped connect codes with the shared 15-minute, single-use invariants", async () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    const fixture = await createAuthFixture(now);
    try {
      const issuer = new ConnectCodeService(fixture.database, { now: () => now });
      const issued = await issuer.issueForUser(fixture.bootstrap.userId);
      expect(issued).toMatchObject({
        expiresAt: new Date("2026-08-18T00:15:00.000Z"),
        expiresIn: 900,
        issuedAt: now,
      });
      const [stored] = await fixture.database
        .select()
        .from(accountCliLoginCodes)
        .where(eq(accountCliLoginCodes.tokenHash, hashSecret(issued.code)));
      expect(stored).toMatchObject({
        tokenHash: hashSecret(issued.code),
        userId: fixture.bootstrap.userId,
        issuedByUserId: fixture.bootstrap.userId,
        consumedAt: null,
      });
      expect(stored?.tokenHash).not.toBe(issued.code);

      await expect(fixture.auth.exchangeConnectCode(issued.code)).resolves.toMatchObject({ tokenType: "Bearer" });
      await expect(fixture.auth.exchangeConnectCode(issued.code)).rejects.toMatchObject({ code: "AUTH_CODE_CONSUMED" });
    } finally {
      await fixture.sql.end();
    }
  });

  it("allows a zero-grant Account to issue its own CLI login code", async () => {
    const fixture = await createAuthFixture();
    try {
      const [account] = await fixture.database
        .insert(users)
        .values({ email: "zero-grant@example.com", displayName: "Zero Grant Account" })
        .returning();
      if (!account) throw new Error("Account fixture was not created");
      const issuer = new ConnectCodeService(fixture.database);
      await expect(issuer.issueForUser(account.id)).resolves.toMatchObject({ expiresIn: 900 });
      expect(
        (await fixture.database.select().from(accountCliLoginCodes)).filter((row) => row.userId === account.id),
      ).toHaveLength(1);
    } finally {
      await fixture.sql.end();
    }
  });

  it("spends a connect code before issuing, so a failure cannot leave it reusable", async () => {
    /*
     * Issuing first left a live session behind whenever the consume or the commit failed, with the code still
     * unconsumed — one code buying a second credential. Consuming first inverts the failure: the code is spent and no
     * session exists, which for a one-time credential is the direction to fail in.
     */
    const now = new Date("2026-08-18T00:00:00.000Z");
    const client = createDatabaseClient(databaseUrl);
    const delegate = new BetterAuthSessionTokens(sessionAuth(client.database), client.database, { now: () => now });
    let shouldFail = true;
    const authTokens: AuthTokenProvider = {
      issuePairForUser: async (userId) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Injected session issuance failure");
        }
        return delegate.issuePairForUser(userId);
      },
      rotate: (token, userId) => delegate.rotate(token, userId),
      verifyAccess: (token) => delegate.verifyAccess(token),
      verifyRefresh: (token) => delegate.verifyRefresh(token),
    };
    const fixture = await createAuthFixture(now, authTokens);

    try {
      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toThrow(
        "Injected session issuance failure",
      );

      // Spent, and with nothing issued against it — not reusable, and not paired with an orphan session.
      const [afterFailure] = await fixture.database.select().from(accountCliLoginCodes);
      expect(afterFailure?.consumedAt).not.toBeNull();
      expect(await fixture.database.select().from(authSessions)).toHaveLength(0);

      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toMatchObject({
        code: "AUTH_CODE_CONSUMED",
      });
      expect(await fixture.database.select().from(authSessions)).toHaveLength(0);
    } finally {
      await fixture.sql.end();
    }
  });

  it("lets one of several concurrent exchanges of the same code win", async () => {
    /*
     * The consume is conditional, so the code is redeemed exactly once however many callers reach it together. It also
     * has to hold no lock across issuance: waiters would occupy transaction connections while the winner needed
     * another from the same pool to create its session.
     */
    const fixture = await createAuthFixture();

    try {
      const attempts = await Promise.allSettled(
        Array.from({ length: 12 }, () => fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)),
      );

      expect(attempts.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      for (const rejected of attempts.filter((outcome) => outcome.status === "rejected")) {
        expect(rejected.reason).toMatchObject({ code: "AUTH_CODE_CONSUMED" });
      }
      expect(await fixture.database.select().from(authSessions)).toHaveLength(1);
    } finally {
      await fixture.sql.end();
    }
  });

  it("does not consume a connect code when a bound home expects another user", async () => {
    const fixture = await createAuthFixture();
    try {
      await expect(
        fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode, crypto.randomUUID()),
      ).rejects.toMatchObject({
        code: "AUTH_USER_MISMATCH",
        statusCode: 409,
      });
      const [afterMismatch] = await fixture.database.select().from(accountCliLoginCodes);
      expect(afterMismatch?.consumedAt).toBeNull();
      await expect(
        fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode, fixture.bootstrap.userId),
      ).resolves.toMatchObject({ tokenType: "Bearer" });
    } finally {
      await fixture.sql.end();
    }
  });

  it("issues tokens through the provider-neutral post-identity boundary", async () => {
    const fixture = await createAuthFixture();
    try {
      const tokens = await fixture.auth.issueTokensForUser(fixture.bootstrap.userId);
      await expect(fixture.auth.getAuthenticatedUser(tokens.accessToken)).resolves.toMatchObject({
        me: { user: { id: fixture.bootstrap.userId } },
      });

      const [storedCode] = await fixture.database.select().from(accountCliLoginCodes);
      expect(storedCode?.consumedAt).toBeNull();
    } finally {
      await fixture.sql.end();
    }
  });

  it("rejects expired codes and suspended users", async () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    const fixture = await createAuthFixture(now);
    try {
      fixture.setNow(new Date("2026-08-18T00:15:01.000Z"));
      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toMatchObject({
        code: "AUTH_CODE_EXPIRED",
      });

      fixture.setNow(now);
      await fixture.database.update(users).set({ suspendedAt: now }).where(eq(users.id, fixture.bootstrap.userId));
      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toMatchObject({
        code: "AUTH_USER_SUSPENDED",
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("withdraws the credential a refresh replaces, while preserving live account checks", async () => {
    const fixture = await createAuthFixture();
    try {
      const initial = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      const rotated = await fixture.auth.refresh(initial.refreshToken);
      expect(rotated.accessToken).not.toBe(initial.accessToken);
      /*
       * The replaced credential stops working immediately. Leaving it valid until its own expiry would mean revoking
       * what a client currently holds does not lock out a copy taken before its last refresh — which is most of the
       * point of a credential the server can withdraw at all.
       */
      await expect(fixture.auth.refresh(initial.refreshToken)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
      await expect(fixture.auth.getAuthenticatedUser(initial.accessToken)).rejects.toMatchObject({
        code: "AUTH_INVALID_TOKEN",
      });
      expect(await fixture.database.select().from(authSessions)).toHaveLength(1);

      await fixture.database
        .update(users)
        .set({ suspendedAt: new Date() })
        .where(eq(users.id, fixture.bootstrap.userId));
      await expect(fixture.auth.refresh(rotated.refreshToken)).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
      await expect(fixture.auth.getAuthenticatedUser(rotated.accessToken)).rejects.toMatchObject({
        code: "AUTH_USER_SUSPENDED",
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("resolves Admin grant revocation live without invalidating the Account session", async () => {
    const fixture = await createAuthFixture();
    try {
      const tokens = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      await expect(fixture.auth.getAuthenticatedUser(tokens.accessToken)).resolves.toMatchObject({
        me: { workspaces: [{ id: fixture.bootstrap.workspaceId }] },
      });

      await fixture.database
        .update(workspaceAdminGrants)
        .set({
          revokedAt: new Date("2026-08-18T00:01:00.000Z"),
          revokedByUserId: fixture.bootstrap.userId,
        })
        .where(eq(workspaceAdminGrants.userId, fixture.bootstrap.userId));
      // Losing every Admin grant drops Workspace authority but keeps the Account session.
      await expect(fixture.auth.getAuthenticatedUser(tokens.accessToken)).resolves.toMatchObject({
        me: { user: { id: fixture.bootstrap.userId }, workspaces: [] },
      });
      // Refreshing withdraws what it replaces, so the renewed credential is the one that carries on from here.
      const renewed = await fixture.auth.refresh(tokens.refreshToken);
      expect(renewed).toMatchObject({ tokenType: "Bearer" });

      await fixture.database
        .update(users)
        .set({ suspendedAt: new Date("2026-08-18T00:02:00.000Z") })
        .where(eq(users.id, fixture.bootstrap.userId));
      const error = await fixture.auth.getAuthenticatedUser(renewed.accessToken).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthServiceError);
      expect(error).toMatchObject({ code: "AUTH_USER_SUSPENDED" });
    } finally {
      await fixture.sql.end();
    }
  });
});
