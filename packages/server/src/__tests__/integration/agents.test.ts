import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import { agents, computers, memberships, teams, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "../../services/runtime-config/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
let container: StartedPostgreSqlContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  databaseUrl = container.getConnectionUri();
}, 120_000);

afterAll(async () => container.stop());

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

async function fixture() {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    teamDisplayName: "Example",
    teamName: "example",
  });
  return { ...client, bootstrap, service: new AgentService(client.database) };
}

async function createUser(
  database: DatabaseClient,
  teamId: string,
  email: string,
  role: "admin" | "member" = "member",
) {
  const [user] = await database.insert(users).values({ displayName: email, email }).returning();
  if (!user) throw new Error("User fixture was not created");
  await database.insert(memberships).values({ role, teamId, userId: user.id });
  return user;
}

async function createComputer(database: DatabaseClient, ownerUserId: string) {
  const [computer] = await database
    .insert(computers)
    .values({
      id: crypto.randomUUID(),
      ownerUserId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  return computer;
}

function createInput(computerId: string, name = "code-reviewer") {
  return { computerId, displayName: "Code Reviewer", name, runtimeProvider: "codex" as const };
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the database barrier");
}

describe("Agent persistence and authorization", () => {
  it("installs the Agent enum, revision check, active-name index, and restrictive foreign keys", async () => {
    const value = await fixture();
    try {
      const enumValues = await value.sql<{ enumlabel: string }[]>`
        select enumlabel
        from pg_enum
        join pg_type on pg_type.oid = pg_enum.enumtypid
        where pg_type.typname = 'agent_runtime_provider'
        order by enumsortorder
      `;
      expect(enumValues.map(({ enumlabel }) => enumlabel)).toEqual(["codex", "claude-code"]);

      const [sequence] = await value.sql<{ max_value: string; min_value: string }[]>`
        select min_value::text, max_value::text
        from pg_sequences
        where schemaname = 'public' and sequencename = 'runtime_config_revision_sequence'
      `;
      expect(sequence).toEqual({ min_value: "1", max_value: String(Number.MAX_SAFE_INTEGER) });

      const constraints = await value.sql<{ conname: string; definition: string }[]>`
        select conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conrelid = 'agents'::regclass
      `;
      expect(constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conname: "agents_revision_positive",
            definition: expect.stringContaining("revision"),
          }),
          expect.objectContaining({
            conname: "agents_team_id_teams_id_fk",
            definition: expect.stringContaining("ON DELETE RESTRICT"),
          }),
          expect.objectContaining({
            conname: "agents_manager_user_id_users_id_fk",
            definition: expect.stringContaining("ON DELETE RESTRICT"),
          }),
          expect.objectContaining({
            conname: "agents_computer_id_computers_id_fk",
            definition: expect.stringContaining("ON DELETE RESTRICT"),
          }),
        ]),
      );

      const [activeNameIndex] = await value.sql<{ indexdef: string }[]>`
        select indexdef
        from pg_indexes
        where schemaname = 'public' and indexname = 'agents_team_name_active_unique'
      `;
      expect(activeNameIndex?.indexdef).toContain("UNIQUE INDEX");
      expect(activeNameIndex?.indexdef).toContain("lower(name)");
      expect(activeNameIndex?.indexdef).toContain("WHERE (deleted_at IS NULL)");

      const runtimeConfigConstraints = await value.sql<{ conname: string; definition: string }[]>`
        select conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conrelid = 'agent_runtime_configs'::regclass
      `;
      expect(runtimeConfigConstraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ conname: "agent_runtime_configs_revision_safe_positive" }),
          expect.objectContaining({ conname: "agent_runtime_configs_max_duration_valid" }),
          expect.objectContaining({
            conname: "agent_runtime_configs_agent_id_agents_id_fk",
            definition: expect.stringContaining("ON DELETE CASCADE"),
          }),
        ]),
      );
    } finally {
      await value.sql.end();
    }
  });

  it("creates an Agent on an offline owned Computer and returns stable active projections", async () => {
    const value = await fixture();
    try {
      await expect(value.service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId)).resolves.toEqual({
        agents: [],
      });
      const computer = await createComputer(value.database, value.bootstrap.userId);
      const created = await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id),
      );
      expect(created).toMatchObject({
        teamId: value.bootstrap.teamId,
        managerUserId: value.bootstrap.userId,
        computerId: computer.id,
        revision: 1,
        runtimeConfig: DEFAULT_AGENT_RUNTIME_CONFIG,
      });
      expect((await value.service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId)).agents).toEqual([
        expect.objectContaining({
          id: created.id,
          runtimeConfigRevision: created.runtimeConfig.revision,
        }),
      ]);
      await expect(value.service.getById(value.bootstrap.userId, created.id)).resolves.toEqual(created);
    } finally {
      await value.sql.end();
    }
  });

  it("evaluates collection membership and Agent rows in one authorization statement", async () => {
    const value = await fixture();
    const blocker = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const revoker = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    let releaseTableLock: (() => void) | undefined;
    const tableLockReleased = new Promise<void>((resolve) => {
      releaseTableLock = resolve;
    });
    let markTableLocked: (() => void) | undefined;
    const tableLocked = new Promise<void>((resolve) => {
      markTableLocked = resolve;
    });
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId);
      await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, createInput(computer.id));

      const blockingTransaction = blocker.begin(async (transaction) => {
        await transaction.unsafe("lock table agents in access exclusive mode");
        markTableLocked?.();
        await tableLockReleased;
      });
      await tableLocked;

      const listOutcome = value.service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId).then(
        (response) => ({ status: "fulfilled" as const, response }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await waitUntil(async () => {
        const [waiting] = await revoker<{ count: number }[]>`
          select count(*)::int as count
          from pg_locks
          where relation = 'agents'::regclass and not granted
        `;
        return (waiting?.count ?? 0) > 0;
      });

      await revoker`
        update memberships
        set status = 'left', updated_at = now()
        where team_id = ${value.bootstrap.teamId} and user_id = ${value.bootstrap.userId}
      `;
      releaseTableLock?.();
      await blockingTransaction;

      await expect(listOutcome).resolves.toMatchObject({
        status: "rejected",
        error: { code: "RESOURCE_NOT_FOUND", statusCode: 404 },
      });
    } finally {
      releaseTableLock?.();
      await Promise.all([value.sql.end(), blocker.end(), revoker.end()]);
    }
  });

  it("rejects another user's Computer without exposing its ownership", async () => {
    const value = await fixture();
    try {
      const other = await createUser(value.database, value.bootstrap.teamId, "other@example.com");
      const computer = await createComputer(value.database, other.id);
      await expect(
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, createInput(computer.id)),
      ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND", statusCode: 404 });
    } finally {
      await value.sql.end();
    }
  });

  it("allows Team reads, restricts management, and hides resources across Teams", async () => {
    const value = await fixture();
    try {
      const manager = await createUser(value.database, value.bootstrap.teamId, "manager@example.com");
      const member = await createUser(value.database, value.bootstrap.teamId, "member@example.com");
      const managerComputer = await createComputer(value.database, manager.id);
      const created = await value.service.createForTeam(
        manager.id,
        value.bootstrap.teamId,
        createInput(managerComputer.id),
      );

      await expect(value.service.getById(member.id, created.id)).resolves.toMatchObject({ id: created.id });
      await expect(
        value.service.updateById(member.id, created.id, { displayName: "No", expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "AGENT_FORBIDDEN", statusCode: 403 });
      await expect(
        value.service.updateById(value.bootstrap.userId, created.id, {
          displayName: "Admin Updated",
          expectedRevision: 1,
        }),
      ).resolves.toMatchObject({ displayName: "Admin Updated", revision: 2 });

      const [otherTeam] = await value.database
        .insert(teams)
        .values({ displayName: "Other", name: "other" })
        .returning();
      if (!otherTeam) throw new Error("Other Team fixture was not created");
      const outsider = await createUser(value.database, otherTeam.id, "outsider@example.com");
      const outsiderComputer = await createComputer(value.database, outsider.id);
      await expect(value.service.getById(outsider.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(
        value.service.updateById(outsider.id, created.id, {
          displayName: "Hidden",
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
      await expect(value.service.deleteById(outsider.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(
        value.service.createForTeam(
          outsider.id,
          value.bootstrap.teamId,
          createInput(outsiderComputer.id, "outsider-agent"),
        ),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });

      await expect(value.service.deleteById(member.id, created.id)).rejects.toMatchObject({
        code: "AGENT_FORBIDDEN",
        statusCode: 403,
      });
      await value.service.deleteById(value.bootstrap.userId, created.id);
      await expect(value.service.deleteById(member.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(value.service.deleteById(manager.id, created.id)).resolves.toBeUndefined();
      await expect(value.service.deleteById(value.bootstrap.userId, created.id)).resolves.toBeUndefined();
    } finally {
      await value.sql.end();
    }
  });

  it("uses revision compare-and-swap without overwriting a newer display name", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId);
      const created = await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id),
      );
      await expect(
        value.service.updateById(value.bootstrap.userId, created.id, {
          displayName: "Reviewer",
          expectedRevision: 1,
        }),
      ).resolves.toMatchObject({ displayName: "Reviewer", revision: 2 });
      await expect(
        value.service.updateById(value.bootstrap.userId, created.id, {
          displayName: "Stale overwrite",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT", statusCode: 409 });
      await expect(value.service.getById(value.bootstrap.userId, created.id)).resolves.toMatchObject({
        displayName: "Reviewer",
        revision: 2,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("updates runtime config atomically and advances only semantic runtime revisions", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId);
      const created = await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, {
        ...createInput(computer.id),
        runtimeConfig: {
          allowedTools: ["opentag_message_send", "opentag_message_react"],
          instructions: "Custom instructions",
          maxDurationMs: 30_000,
          model: "gpt-5.6",
          reasoningEffort: "high",
        },
      });
      expect(created.runtimeConfig).toMatchObject({
        allowedTools: ["opentag_message_react", "opentag_message_send"],
        instructions: "Custom instructions",
        maxDurationMs: 30_000,
        model: "gpt-5.6",
        reasoningEffort: "high",
      });
      const initialRuntimeRevision = created.runtimeConfig.revision;

      const profileOnly = await value.service.updateById(value.bootstrap.userId, created.id, {
        displayName: "Profile only",
        expectedRevision: 1,
      });
      expect(profileOnly).toMatchObject({ revision: 2, runtimeConfig: { revision: initialRuntimeRevision } });

      const sameConfig = await value.service.updateById(value.bootstrap.userId, created.id, {
        expectedRevision: 2,
        runtimeConfig: { allowedTools: ["opentag_message_send", "opentag_message_react"] },
      });
      expect(sameConfig).toMatchObject({ revision: 3, runtimeConfig: { revision: initialRuntimeRevision } });

      const cleared = await value.service.updateById(value.bootstrap.userId, created.id, {
        expectedRevision: 3,
        runtimeConfig: { maxDurationMs: null, model: null, reasoningEffort: null },
      });
      expect(cleared.runtimeConfig.revision).toBeGreaterThan(initialRuntimeRevision);
      expect(cleared.runtimeConfig).toMatchObject({ maxDurationMs: null, model: null, reasoningEffort: null });
      const secondAgent = await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id, "second-agent"),
      );
      expect(secondAgent.runtimeConfig.revision).toBeGreaterThan(cleared.runtimeConfig.revision);
      await expect(
        value.service.updateById(value.bootstrap.userId, created.id, {
          expectedRevision: 3,
          runtimeConfig: { instructions: "stale" },
        }),
      ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT", statusCode: 409 });
    } finally {
      await value.sql.end();
    }
  });

  it("soft-deletes idempotently and permits active name reuse without reviving the old UUID", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId);
      const created = await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id),
      );
      await value.service.deleteById(value.bootstrap.userId, created.id);
      await value.service.deleteById(value.bootstrap.userId, created.id);
      await expect(value.service.getById(value.bootstrap.userId, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      const [deleted] = await value.database.select().from(agents);
      expect(deleted).toMatchObject({ id: created.id, revision: 2 });
      expect(deleted?.deletedAt).toBeInstanceOf(Date);

      const replacement = await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id),
      );
      expect(replacement.id).not.toBe(created.id);
      expect((await value.service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId)).agents).toEqual([
        expect.objectContaining({ id: replacement.id, runtimeConfigRevision: replacement.runtimeConfig.revision }),
      ]);
    } finally {
      await value.sql.end();
    }
  });

  it("backfills runtime config for Agents created before the runtime config migration", async () => {
    const rawSql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      for (const migration of [
        "0000_strong_thunderbolt_ross.sql",
        "0001_living_franklin_richards.sql",
        "0002_sticky_crystal.sql",
        "0003_noisy_husk.sql",
      ]) {
        const contents = await readFile(new URL(`../../../drizzle/${migration}`, import.meta.url), "utf8");
        for (const statement of contents.split("--> statement-breakpoint")) {
          if (statement.trim()) await rawSql.unsafe(statement);
        }
      }
      const [user] = await rawSql<{ id: string }[]>`
        insert into users (email, display_name) values ('legacy@example.com', 'Legacy') returning id
      `;
      const [team] = await rawSql<{ id: string }[]>`
        insert into teams (name, display_name) values ('legacy', 'Legacy') returning id
      `;
      if (!user || !team) throw new Error("Legacy fixture authority was not created");
      const computerId = crypto.randomUUID();
      await rawSql`
        insert into computers (id, owner_user_id, display_name, platform, arch, client_version)
        values (${computerId}, ${user.id}, 'legacy', 'linux', 'x64', '0.0.1')
      `;
      const [legacyAgent] = await rawSql<{ id: string }[]>`
        insert into agents (team_id, manager_user_id, computer_id, name, display_name, runtime_provider)
        values (${team.id}, ${user.id}, ${computerId}, 'legacy', 'Legacy', 'codex')
        returning id
      `;
      if (!legacyAgent) throw new Error("Legacy Agent fixture was not created");

      const migration = await readFile(new URL("../../../drizzle/0004_sad_thunderbolt.sql", import.meta.url), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await rawSql.unsafe(statement);
      }
      const [backfilled] = await rawSql<
        {
          agent_id: string;
          allowed_tools: string[];
          instructions: string;
          revision: string;
        }[]
      >`
        select agent_id, revision::text, instructions, allowed_tools
        from agent_runtime_configs
        where agent_id = ${legacyAgent.id}
      `;
      expect(backfilled).toEqual({
        agent_id: legacyAgent.id,
        revision: "1",
        instructions: DEFAULT_AGENT_RUNTIME_CONFIG.instructions,
        allowed_tools: DEFAULT_AGENT_RUNTIME_CONFIG.allowedTools,
      });
    } finally {
      await rawSql.end();
    }
  });

  it("lets the partial unique index choose exactly one concurrent Team/name winner", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId);
      const settled = await Promise.allSettled([
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, createInput(computer.id)),
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, createInput(computer.id)),
      ]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ reason: { code: "AGENT_NAME_CONFLICT", statusCode: 409 } });
      expect(await value.database.select().from(agents)).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("allows the same name in another Team and stores claude-code as configuration only", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId);
      await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id, "assistant"),
      );

      const [otherTeam] = await value.database
        .insert(teams)
        .values({ displayName: "Other", name: "other" })
        .returning();
      if (!otherTeam) throw new Error("Other Team fixture was not created");
      await value.database.insert(memberships).values({
        role: "member",
        teamId: otherTeam.id,
        userId: value.bootstrap.userId,
      });
      const created = await value.service.createForTeam(value.bootstrap.userId, otherTeam.id, {
        ...createInput(computer.id, "assistant"),
        runtimeProvider: "claude-code",
      });
      expect(created).toMatchObject({
        name: "assistant",
        runtimeProvider: "claude-code",
        teamId: otherTeam.id,
      });
    } finally {
      await value.sql.end();
    }
  });
});
