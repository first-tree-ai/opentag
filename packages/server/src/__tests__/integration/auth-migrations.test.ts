import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  MigrationVerificationError,
  migrateDatabase,
  verifyDatabaseMigrations,
  withMigrationLock,
} from "../../db/migrate.js";
import { accountCliLoginCodes, users, workspaceAdminGrants, workspaces } from "../../db/schema/index.js";
import {
  AuthService,
  AuthServiceError,
  type AuthTokenProvider,
  AuthTokenService,
  ConnectCodeService,
  hashSecret,
} from "../../services/auth/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const jwtSecret = "im-binding-test-secret-at-least-32-characters";
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
    authTokens ?? new AuthTokenService(jwtSecret, 900, 3600, { now: () => currentNow }),
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
  it("orders the Slack single-configuration cleanup after the deployed setup migrations", async () => {
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    // Anchored to the fixed 0010..0017 range rather than the tail: a trailing slice silently stops covering the
    // earliest entry every time a migration is appended, which would quietly shrink what this test guarantees.
    expect(journal.entries.slice(10, 18).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 10, tag: "0010_optimal_jazinda" },
      { idx: 11, tag: "0011_staging_team_setup_repair" },
      { idx: 12, tag: "0012_supreme_maddog" },
      { idx: 13, tag: "0013_bizarre_gamma_corps" },
      { idx: 14, tag: "0014_illegal_wolfsbane" },
      { idx: 15, tag: "0015_spotty_machine_man" },
      { idx: 16, tag: "0016_certain_revanche" },
      { idx: 17, tag: "0017_sour_tiger_shark" },
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
            status: string;
          }[]
        >`
          select agent_id::text, status, encrypted_credential, setup_attempt_id::text,
                 encrypted_setup_context, observed_connected_at, last_error_code
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
          },
          {
            agent_id: slackIncompleteAgentId,
            status: "reauthorization_required",
            encrypted_credential: "encrypted-incomplete",
            setup_attempt_id: null,
            encrypted_setup_context: null,
            observed_connected_at: null,
            last_error_code: "SLACK_SCOPE_REAUTH_REQUIRED",
          },
          {
            agent_id: slackCompleteAgentId,
            status: "active",
            encrypted_credential: "encrypted-complete",
            setup_attempt_id: null,
            encrypted_setup_context: null,
            observed_connected_at: null,
            last_error_code: null,
          },
          {
            agent_id: feishuAgentId,
            status: "provisioning",
            encrypted_credential: null,
            setup_attempt_id: feishuSetup?.attempt_id ?? null,
            encrypted_setup_context: "encrypted-feishu-setup",
            observed_connected_at: expect.any(Date),
            last_error_code: null,
          },
        ]);
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

  it("refuses to normalize Account email casing while two Accounts share an address, then backfills verification", async () => {
    const legacyFolder = await mkdtemp(join(tmpdir(), "opentag-0017-migrations-"));
    const legacyMeta = join(legacyFolder, "meta");
    await mkdir(legacyMeta);
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const legacyEntries = journal.entries.filter(({ idx }) => idx <= 17);
    for (const entry of legacyEntries) {
      await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
    }
    await writeFile(join(legacyMeta, "_journal.json"), JSON.stringify({ ...journal, entries: legacyEntries }, null, 2));

    try {
      await migrateDatabase(databaseUrl, legacyFolder);
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const keptUserId = crypto.randomUUID();
        const duplicateUserId = crypto.randomUUID();
        await sql`
          insert into users (id, email, display_name)
          values
            (${keptUserId}, 'Casing@Example.com', 'Mixed Casing'),
            (${duplicateUserId}, 'casing@example.com', 'Lower Casing')
        `;

        await expect(migrateDatabase(databaseUrl, migrationsFolder)).rejects.toThrow(
          "Accounts sharing an email address",
        );
        const [blocked] = await sql<{ email_verified_exists: boolean; migration_count: number }[]>`
          select
            (select count(*)::int from drizzle.__drizzle_migrations) as migration_count,
            exists(
              select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'users' and column_name = 'email_verified'
            ) as email_verified_exists
        `;
        expect(blocked).toEqual({ email_verified_exists: false, migration_count: 18 });

        await sql`delete from users where id = ${duplicateUserId}`;
        const verifiedUserId = crypto.randomUUID();
        await sql`
          insert into users (id, email, display_name)
          values (${verifiedUserId}, 'Verified@Example.com', 'Verified Identity')
        `;
        await sql`
          insert into auth_identities (user_id, provider, issuer, subject, email)
          values (${verifiedUserId}, 'google', 'https://accounts.google.com', 'google-subject-1', 'Verified@Example.com')
        `;

        await migrateDatabase(databaseUrl, migrationsFolder);

        const accounts = await sql<{ email: string; email_verified: boolean; id: string }[]>`
          select id, email, email_verified from users order by email
        `;
        expect([...accounts]).toEqual([
          { email: "casing@example.com", email_verified: false, id: keptUserId },
          { email: "verified@example.com", email_verified: true, id: verifiedUserId },
        ]);

        await expect(
          sql`insert into users (email, display_name) values ('CASING@EXAMPLE.COM', 'Rejected')`,
        ).rejects.toThrow("users_email_unique");
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
          count: 19,
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
        expect(rerun?.count).toBe(19);
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

  it("stores only the connect-code hash and issues authority-free JWTs", async () => {
    const fixture = await createAuthFixture();
    try {
      const tokens = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      const [storedCode] = await fixture.database.select().from(accountCliLoginCodes);
      expect(storedCode?.tokenHash).toBe(hashSecret(fixture.bootstrap.connectCode));
      expect(storedCode?.tokenHash).not.toBe(fixture.bootstrap.connectCode);
      for (const token of [tokens.accessToken, tokens.refreshToken]) {
        const claims = decodeJwt(token);
        expect(claims.sub).toBe(fixture.bootstrap.userId);
        expect(claims).toHaveProperty("jti");
        expect(claims).not.toHaveProperty("email");
        expect(claims).not.toHaveProperty("workspaceId");
        expect(claims).not.toHaveProperty("role");
        expect(claims).not.toHaveProperty("sid");
      }

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

  it("does not consume a connect code when token issuance fails", async () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    const delegate = new AuthTokenService(jwtSecret, 900, 3600, { now: () => now });
    let shouldFail = true;
    const authTokens: AuthTokenProvider = {
      issuePairForUser: async (userId) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Injected token signing failure");
        }
        return delegate.issuePairForUser(userId);
      },
      verifyAccess: (token) => delegate.verifyAccess(token),
      verifyRefresh: (token) => delegate.verifyRefresh(token),
    };
    const fixture = await createAuthFixture(now, authTokens);

    try {
      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).rejects.toThrow(
        "Injected token signing failure",
      );
      const [afterFailure] = await fixture.database.select().from(accountCliLoginCodes);
      expect(afterFailure?.consumedAt).toBeNull();

      await expect(fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode)).resolves.toMatchObject({
        tokenType: "Bearer",
      });
      const [afterRetry] = await fixture.database.select().from(accountCliLoginCodes);
      expect(afterRetry?.consumedAt).not.toBeNull();
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

  it("uses stateless sliding refresh JWTs while preserving live account checks", async () => {
    const fixture = await createAuthFixture();
    try {
      const initial = await fixture.auth.exchangeConnectCode(fixture.bootstrap.connectCode);
      const rotated = await fixture.auth.refresh(initial.refreshToken);
      expect(rotated.accessToken).not.toBe(initial.accessToken);
      expect(rotated.refreshToken).not.toBe(initial.refreshToken);
      await expect(fixture.auth.refresh(initial.refreshToken)).resolves.toMatchObject({ tokenType: "Bearer" });
      await expect(fixture.auth.getAuthenticatedUser(initial.accessToken)).resolves.toMatchObject({
        me: { user: { id: fixture.bootstrap.userId } },
      });

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
      await expect(fixture.auth.refresh(tokens.refreshToken)).resolves.toMatchObject({ tokenType: "Bearer" });

      await fixture.database
        .update(users)
        .set({ suspendedAt: new Date("2026-08-18T00:02:00.000Z") })
        .where(eq(users.id, fixture.bootstrap.userId));
      const error = await fixture.auth.getAuthenticatedUser(tokens.accessToken).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthServiceError);
      expect(error).toMatchObject({ code: "AUTH_USER_SUSPENDED" });
    } finally {
      await fixture.sql.end();
    }
  });
});
