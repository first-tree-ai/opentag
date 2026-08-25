import type { TurnReportRequest } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  memberships,
  sessions,
  teams,
  users,
  workspaceComputers,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "../../services/runtime-config/index.js";
import { TeamMembershipService } from "../../services/teams/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());

beforeEach(async () => testDatabase.reset());

async function fixture() {
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

async function createComputer(database: DatabaseClient, ownerUserId: string, workspaceId: string) {
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
  await database.insert(workspaceComputers).values({
    workspaceId,
    computerId: computer.id,
    displayName: computer.displayName,
    platform: computer.platform,
    arch: computer.arch,
    clientVersion: computer.clientVersion,
    enrolledByUserId: ownerUserId,
  });
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

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Agent persistence and authorization", () => {
  it("resets standalone sequences without changing the migration ledger", async () => {
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      const migrationsBefore = await sql<{ createdAt: string; hash: string; id: number }[]>`
        select id, hash, created_at::text as "createdAt"
        from drizzle.__drizzle_migrations
        order by id
      `;
      const [sequence] = await sql<{ startValue: string }[]>`
        select start_value::text as "startValue"
        from pg_sequences
        where schemaname = 'public' and sequencename = 'runtime_config_revision_sequence'
      `;
      const [first] = await sql<{ value: string }[]>`
        select nextval('public.runtime_config_revision_sequence')::text as value
      `;
      const [second] = await sql<{ value: string }[]>`
        select nextval('public.runtime_config_revision_sequence')::text as value
      `;
      expect(BigInt(second?.value ?? "0")).toBe(BigInt(first?.value ?? "0") + 1n);

      await testDatabase.reset();

      const [afterReset] = await sql<{ value: string }[]>`
        select nextval('public.runtime_config_revision_sequence')::text as value
      `;
      const migrationsAfter = await sql<{ createdAt: string; hash: string; id: number }[]>`
        select id, hash, created_at::text as "createdAt"
        from drizzle.__drizzle_migrations
        order by id
      `;
      expect(afterReset?.value).toBe(sequence?.startValue);
      expect(migrationsAfter).toEqual(migrationsBefore);
    } finally {
      await sql.end();
    }
  });

  it("installs Agent constraints, creation-intent uniqueness, and restrictive foreign keys", async () => {
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
            conname: "agents_manager_membership_fk",
            definition: expect.stringContaining("ON DELETE RESTRICT"),
          }),
          expect.objectContaining({ conname: "agents_creation_intent_pair" }),
        ]),
      );
      expect(constraints).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ conname: "agents_manager_computer_owner_fk" })]),
      );

      const [activeNameIndex] = await value.sql<{ indexdef: string }[]>`
        select indexdef
        from pg_indexes
        where schemaname = 'public' and indexname = 'agents_team_name_active_unique'
      `;
      expect(activeNameIndex?.indexdef).toContain("UNIQUE INDEX");
      expect(activeNameIndex?.indexdef).toContain("lower(name)");
      expect(activeNameIndex?.indexdef).toContain("status <> 'deleted'::agent_status");

      const [creationIntentIndex] = await value.sql<{ indexdef: string }[]>`
        select indexdef
        from pg_indexes
        where schemaname = 'public' and indexname = 'agents_creation_intent_unique'
      `;
      expect(creationIntentIndex?.indexdef).toContain("UNIQUE INDEX");
      expect(creationIntentIndex?.indexdef).toContain("team_id, manager_user_id, creation_intent_id");
      expect(creationIntentIndex?.indexdef).toContain("creation_intent_id IS NOT NULL");

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
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const created = await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id),
      );
      expect(created).toMatchObject({
        teamId: value.bootstrap.teamId,
        managerUserId: value.bootstrap.userId,
        computerId: computer.id,
        receiveMode: "all_message",
        revision: 1,
        runtimeConfig: DEFAULT_AGENT_RUNTIME_CONFIG,
      });
      expect((await value.service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId)).agents).toEqual([
        expect.objectContaining({
          id: created.id,
          activity: { state: "idle" },
          usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
          manager: expect.objectContaining({ userId: value.bootstrap.userId }),
          computer: expect.objectContaining({ id: computer.id }),
        }),
      ]);
      await expect(value.service.getById(value.bootstrap.userId, created.id)).resolves.toMatchObject({
        id: created.id,
        viewerCapabilities: { canManage: true },
      });
      await expect(value.service.getConfigById(value.bootstrap.userId, created.id)).resolves.toEqual(created);
    } finally {
      await value.sql.end();
    }
  });

  it.each([
    ["codex", 4],
    ["claude-code", 116],
  ] as const)("projects current work and Provider-correct historical usage for %s", async (runtimeProvider, tokens) => {
    // Runtime usage fields are independently optional. The Codex case preserves a valid partial report where
    // cached input exceeds the reported provider-native input count.
    const inputTokens = runtimeProvider === "claude-code" ? 110 : 0;
    const value = await fixture();
    try {
      const now = new Date("2026-08-24T12:00:00.000Z");
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const created = await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, {
        ...createInput(computer.id),
        runtimeProvider,
      });
      const [binding] = await value.database
        .insert(imBindings)
        .values({
          agentId: created.id,
          provider: "slack",
          status: "active",
          externalAppId: "A1",
          externalTeamId: "T1",
          externalBotId: "B1",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential: "fixture",
          activatedAt: now,
        })
        .returning();
      if (!binding) throw new Error("IM binding fixture was not created");
      const [session] = await value.database
        .insert(sessions)
        .values({
          imBindingId: binding.id,
          channelId: "C1",
          conversationKind: "channel",
          kind: "channel",
        })
        .returning();
      if (!session) throw new Error("Session fixture was not created");

      const messageRows = await value.database
        .insert(imMessages)
        .values(
          ["reported", "working"].map((suffix, index) => ({
            imBindingId: binding.id,
            providerEventId: `event-${suffix}`,
            channelId: "C1",
            externalMessageId: `message-${suffix}`,
            providerRevisionKey: "1",
            operation: "created" as const,
            direction: "inbound" as const,
            providerContext: { provider: "slack" as const, channelType: "channel" },
            authorKind: "human" as const,
            authorExternalId: "U_HUMAN",
            content: {
              version: 1 as const,
              fallbackText: suffix === "working" ? "Review PR #127" : suffix,
              blocks: [{ type: "text" as const, text: suffix === "working" ? "Review PR #127" : suffix }],
              truncated: false,
            },
            occurredAt: new Date(now.getTime() - (index + 1) * 60_000),
          })),
        )
        .returning({ id: imMessages.id });
      const reportedMessage = messageRows[0];
      const workingMessage = messageRows[1];
      if (!reportedMessage || !workingMessage) throw new Error("Message fixtures were not created");

      const reportedDeliveryId = crypto.randomUUID();
      const workingDeliveryId = crypto.randomUUID();
      const report: TurnReportRequest = {
        type: "turn:report",
        requestId: crypto.randomUUID(),
        deliveryId: reportedDeliveryId,
        turnId: "turn-reported",
        sessionId: session.id,
        agentId: created.id,
        placementGeneration: 1,
        outcome: "failed",
        executionEffects: "may_have_occurred",
        errorReason: "workspace_failed",
        usage: { inputTokens, cachedInputTokens: 2, outputTokens: 4 },
        traceSummary: { lastSequence: 1, droppedEvents: 0 },
        resultHash: "0".repeat(64),
      };
      const workingAcceptedAt = new Date(now.getTime() - 4 * 60_000);
      await value.database.insert(imMessageDeliveries).values([
        {
          id: reportedDeliveryId,
          messageId: reportedMessage.id,
          sessionId: session.id,
          attention: "direct",
          state: "accepted",
          placementGeneration: 1,
          inputHash: "reported-input",
          turnId: report.turnId,
          reportOwnerInstanceId: crypto.randomUUID(),
          resultHash: report.resultHash,
          turnReport: report,
          reportedAt: new Date(now.getTime() - 8 * 60_000),
          acceptedAt: new Date(now.getTime() - 10 * 60_000),
          expiresAt: new Date(now.getTime() + 60_000),
        },
        {
          id: workingDeliveryId,
          messageId: workingMessage.id,
          sessionId: session.id,
          attention: "direct",
          state: "accepted",
          placementGeneration: 1,
          inputHash: "working-input",
          turnId: "turn-working",
          reportOwnerInstanceId: crypto.randomUUID(),
          acceptedAt: workingAcceptedAt,
          expiresAt: new Date(now.getTime() + 60_000),
        },
      ]);

      const service = new AgentService(value.database, { now: () => now });
      const projectedAgents = await service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId);
      expect(projectedAgents).toMatchObject({
        agents: [
          {
            id: created.id,
            activity: {
              state: "working",
              startedAt: workingAcceptedAt.toISOString(),
            },
            usage: { windowDays: 30, tasks: 2, failed: 1, tokens },
          },
        ],
      });
      expect(projectedAgents.agents[0]?.activity).not.toHaveProperty("summary");
      expect(JSON.stringify(projectedAgents)).not.toContain("Review PR #127");
      await expect(service.getById(value.bootstrap.userId, created.id)).resolves.toMatchObject({
        id: created.id,
        activity: { state: "working", startedAt: workingAcceptedAt.toISOString() },
      });
      const usage = await service.getUsageById(value.bootstrap.userId, created.id, 30);
      expect(usage).toMatchObject({
        windowDays: 30,
        startedAt: "2026-07-25T12:00:00.000Z",
        endedAt: now.toISOString(),
        tasks: 2,
        measuredTasks: 1,
        failed: 1,
        inputTokens: runtimeProvider === "claude-code" ? 112 : 0,
        cachedInputTokens: 2,
        outputTokens: 4,
        tokens,
      });
      expect(usage.daily).toHaveLength(31);
      expect(usage.daily[0]).toEqual({
        date: "2026-07-25",
        tasks: 0,
        measuredTasks: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        tokens: 0,
      });
      expect(usage.daily[15]).toMatchObject({ date: "2026-08-09", tasks: 0, tokens: 0 });
      expect(usage.daily.at(-1)).toEqual({
        date: "2026-08-24",
        tasks: 2,
        measuredTasks: 1,
        inputTokens: runtimeProvider === "claude-code" ? 112 : 0,
        cachedInputTokens: 2,
        outputTokens: 4,
        tokens,
      });

      await value.database.update(sessions).set({ endedAt: now }).where(eq(sessions.id, session.id));
      await expect(service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId)).resolves.toMatchObject({
        agents: [
          {
            id: created.id,
            activity: { state: "idle" },
            usage: { windowDays: 30, tasks: 2, failed: 1, tokens },
          },
        ],
      });

      await value.database.update(sessions).set({ endedAt: null }).where(eq(sessions.id, session.id));
      await value.database
        .update(imBindings)
        .set({ status: "reauthorization_required" })
        .where(eq(imBindings.id, binding.id));
      await expect(service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId)).resolves.toMatchObject({
        agents: [
          {
            id: created.id,
            activity: { state: "idle" },
            usage: { windowDays: 30, tasks: 2, failed: 1, tokens },
          },
        ],
      });
    } finally {
      await value.sql.end();
    }
  });

  it("replays one creation intent without creating a second Agent", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const input = {
        ...createInput(computer.id),
        creationIntentId: "a3adbe5e-8e8e-4ac2-a013-b026684ab185",
        runtimeConfig: { instructions: "Review carefully", model: "gpt-5.6" },
      };
      const created = await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input);
      await expect(value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input)).resolves.toEqual(
        created,
      );
      await expect(value.service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId)).resolves.toMatchObject({
        agents: [{ id: created.id }],
      });
    } finally {
      await value.sql.end();
    }
  });

  it("serializes concurrent submissions of one creation intent", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const input = {
        ...createInput(computer.id),
        creationIntentId: "a3adbe5e-8e8e-4ac2-a013-b026684ab185",
      };
      const [left, right] = await Promise.all([
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input),
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input),
      ]);
      expect(right).toEqual(left);
      await expect(value.service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId)).resolves.toMatchObject({
        agents: [{ id: left.id }],
      });
    } finally {
      await value.sql.end();
    }
  });

  it("replays one Workspace creation intent across different Admins", async () => {
    const value = await fixture();
    try {
      const otherAdmin = await createUser(
        value.database,
        value.bootstrap.teamId,
        "creation-intent-admin@example.com",
        "admin",
      );
      const computer = await createComputer(value.database, otherAdmin.id, value.bootstrap.teamId);
      const input = {
        ...createInput(computer.id),
        creationIntentId: "d2af68d9-9017-4584-a29d-c4c00f5e5b6d",
      };
      const [left, right] = await Promise.all([
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input),
        value.service.createForTeam(otherAdmin.id, value.bootstrap.teamId, input),
      ]);
      expect(right.id).toBe(left.id);
      expect(await value.database.select({ id: agents.id }).from(agents)).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("replays the original intent after the Agent changes", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const input = {
        ...createInput(computer.id),
        creationIntentId: "a3adbe5e-8e8e-4ac2-a013-b026684ab185",
      };
      const created = await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input);
      const updated = await value.service.updateById(value.bootstrap.userId, created.id, {
        displayName: "Updated elsewhere",
        expectedRevision: 1,
        runtimeConfig: { instructions: "Updated instructions" },
      });
      await expect(value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input)).resolves.toEqual(
        updated,
      );
      await expect(
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, { ...input, runtimeConfig: {} }),
      ).resolves.toEqual(updated);
    } finally {
      await value.sql.end();
    }
  });

  it("rejects replay after the Agent is deleted", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const input = {
        ...createInput(computer.id),
        creationIntentId: "a3adbe5e-8e8e-4ac2-a013-b026684ab185",
      };
      const created = await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input);
      await value.service.suspendById(value.bootstrap.userId, created.id);
      await value.service.deleteById(value.bootstrap.userId, created.id);

      await expect(
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input),
      ).rejects.toMatchObject({ code: "AGENT_CREATION_INTENT_CONFLICT", statusCode: 409 });
    } finally {
      await value.sql.end();
    }
  });

  it("returns one atomic Agent and runtime-config revision during concurrent replay", async () => {
    const value = await fixture();
    const updater = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const observer = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const lockHeld = deferred<void>();
    const releaseUpdate = deferred<void>();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const input = {
        ...createInput(computer.id),
        creationIntentId: "a3adbe5e-8e8e-4ac2-a013-b026684ab185",
      };
      const created = await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input);
      const update = updater.begin(async (transaction) => {
        await transaction.unsafe("lock table agent_runtime_configs in access exclusive mode");
        lockHeld.resolve();
        await releaseUpdate.promise;
        await transaction`
          update agents
          set display_name = 'Concurrent update', revision = revision + 1, updated_at = now()
          where id = ${created.id}
        `;
        await transaction`
          update agent_runtime_configs
          set instructions = 'Concurrent instructions',
              revision = nextval('runtime_config_revision_sequence'),
              updated_at = now()
          where agent_id = ${created.id}
        `;
      });
      await lockHeld.promise;

      const replay = value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, input);
      await waitUntil(async () => {
        const [waiting] = await observer<{ count: number }[]>`
          select count(*)::int as count
          from pg_locks
          where relation = 'agent_runtime_configs'::regclass and not granted
        `;
        return (waiting?.count ?? 0) > 0;
      });
      releaseUpdate.resolve();
      await update;

      const current = await value.service.getConfigById(value.bootstrap.userId, created.id);
      await expect(replay).resolves.toEqual(current);
      expect(current).toMatchObject({
        displayName: "Concurrent update",
        runtimeConfig: { instructions: "Concurrent instructions" },
      });
    } finally {
      releaseUpdate.resolve();
      await Promise.all([value.sql.end(), updater.end(), observer.end()]);
    }
  });

  it("rejects reuse of a creation intent for different Agent inputs", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const creationIntentId = "a3adbe5e-8e8e-4ac2-a013-b026684ab185";
      await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, {
        ...createInput(computer.id),
        creationIntentId,
      });
      await expect(
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, {
          ...createInput(computer.id, "different-agent"),
          creationIntentId,
        }),
      ).rejects.toMatchObject({ code: "AGENT_CREATION_INTENT_CONFLICT", statusCode: 409 });
    } finally {
      await value.sql.end();
    }
  });

  it("keeps ordinary same-name creation conflicts distinct from intent replay", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, {
        ...createInput(computer.id),
        creationIntentId: "a3adbe5e-8e8e-4ac2-a013-b026684ab185",
      });
      await expect(
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, {
          ...createInput(computer.id),
          creationIntentId: "e778fc37-5052-4c83-99cc-bfe1f4aa1bd9",
        }),
      ).rejects.toMatchObject({ code: "AGENT_NAME_CONFLICT", statusCode: 409 });
    } finally {
      await value.sql.end();
    }
  });

  it("linearizes a collection read when Admin authority is valid before a later revocation", async () => {
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
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
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

      await expect(listOutcome).resolves.toMatchObject({ status: "fulfilled" });
    } finally {
      releaseTableLock?.();
      await Promise.all([value.sql.end(), blocker.end(), revoker.end()]);
    }
  });

  it("allows an Admin to use another Account's active Workspace Computer enrollment", async () => {
    const value = await fixture();
    try {
      const other = await createUser(value.database, value.bootstrap.teamId, "other@example.com", "admin");
      const computer = await createComputer(value.database, other.id, value.bootstrap.teamId);
      await expect(
        value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, createInput(computer.id)),
      ).resolves.toMatchObject({ computerId: computer.id, managerUserId: value.bootstrap.userId });
    } finally {
      await value.sql.end();
    }
  });

  it("allows all Workspace Admins, rejects legacy members, and hides resources across Workspaces", async () => {
    const value = await fixture();
    try {
      const manager = await createUser(value.database, value.bootstrap.teamId, "manager@example.com", "admin");
      const member = await createUser(value.database, value.bootstrap.teamId, "member@example.com");
      const managerComputer = await createComputer(value.database, manager.id, value.bootstrap.teamId);
      const created = await value.service.createForTeam(
        manager.id,
        value.bootstrap.teamId,
        createInput(managerComputer.id),
      );
      await value.database
        .update(memberships)
        .set({ role: "member" })
        .where(and(eq(memberships.teamId, value.bootstrap.teamId), eq(memberships.userId, manager.id)));
      await expect(
        value.service.createForTeam(manager.id, value.bootstrap.teamId, createInput(managerComputer.id, "forbidden")),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });

      await expect(value.service.getById(member.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(value.service.getConfigById(member.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(
        value.service.updateById(member.id, created.id, { displayName: "No", expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
      await expect(
        value.service.updateById(manager.id, created.id, { displayName: "Manager cannot write", expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
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
      const outsiderComputer = await createComputer(value.database, outsider.id, value.bootstrap.teamId);
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
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(value.service.deleteById(value.bootstrap.userId, created.id)).rejects.toMatchObject({
        code: "AGENT_LIFECYCLE_CONFLICT",
        statusCode: 409,
      });
      await value.service.suspendById(value.bootstrap.userId, created.id);
      await value.service.deleteById(value.bootstrap.userId, created.id);
      await expect(value.service.deleteById(member.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(value.service.deleteById(manager.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(value.service.deleteById(value.bootstrap.userId, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
    } finally {
      await value.sql.end();
    }
  });

  it("uses revision compare-and-swap without overwriting a newer display name", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
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
      await expect(value.service.getConfigById(value.bootstrap.userId, created.id)).resolves.toMatchObject({
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
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const created = await value.service.createForTeam(value.bootstrap.userId, value.bootstrap.teamId, {
        ...createInput(computer.id),
        runtimeConfig: {
          instructions: "Custom instructions",
          maxDurationMs: 30_000,
          model: "gpt-5.6",
          reasoningEffort: "high",
        },
      });
      expect(created.runtimeConfig).toMatchObject({
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

      const cleared = await value.service.updateById(value.bootstrap.userId, created.id, {
        expectedRevision: 2,
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
          expectedRevision: 2,
          runtimeConfig: { instructions: "stale" },
        }),
      ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT", statusCode: 409 });
    } finally {
      await value.sql.end();
    }
  });

  it("enforces the active-suspended-deleted lifecycle without blocking suspended administration", async () => {
    const value = await fixture();
    try {
      const member = await createUser(value.database, value.bootstrap.teamId, "member-lifecycle@example.com");
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const created = await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id),
      );

      await expect(value.service.deleteById(value.bootstrap.userId, created.id)).rejects.toMatchObject({
        code: "AGENT_LIFECYCLE_CONFLICT",
        statusCode: 409,
      });
      await expect(value.service.suspendById(member.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      const suspended = await value.service.suspendById(value.bootstrap.userId, created.id);
      expect(suspended).toMatchObject({ status: "suspended", revision: 2 });
      await expect(value.service.suspendById(value.bootstrap.userId, created.id)).rejects.toMatchObject({
        code: "AGENT_LIFECYCLE_CONFLICT",
        statusCode: 409,
      });
      await expect(value.service.getById(member.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(
        value.service.updateById(value.bootstrap.userId, created.id, {
          displayName: "Suspended but configurable",
          expectedRevision: 2,
        }),
      ).resolves.toMatchObject({ displayName: "Suspended but configurable", status: "suspended", revision: 3 });
      const active = await value.service.reactivateById(value.bootstrap.userId, created.id);
      expect(active).toMatchObject({ status: "active", revision: 4 });
      await expect(value.service.reactivateById(value.bootstrap.userId, created.id)).rejects.toMatchObject({
        code: "AGENT_LIFECYCLE_CONFLICT",
        statusCode: 409,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("holds live Admin authority through a lifecycle mutation before a concurrent downgrade", async () => {
    const value = await fixture();
    const authorityLocked = deferred<void>();
    const releaseMutation = deferred<void>();
    try {
      const secondAdmin = await createUser(
        value.database,
        value.bootstrap.teamId,
        "lifecycle-admin@example.com",
        "admin",
      );
      const computer = await createComputer(value.database, secondAdmin.id, value.bootstrap.teamId);
      const created = await value.service.createForTeam(
        secondAdmin.id,
        value.bootstrap.teamId,
        createInput(computer.id),
      );
      const lifecycle = new AgentService(value.database, {
        afterAgentLocked: async () => {
          authorityLocked.resolve();
          await releaseMutation.promise;
        },
      });
      const suspend = lifecycle.suspendById(secondAdmin.id, created.id);
      await authorityLocked.promise;
      const downgrade = new TeamMembershipService(value.database).changeRole(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        secondAdmin.id,
        "member",
      );
      let downgradeSettled = false;
      void downgrade.finally(() => {
        downgradeSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(downgradeSettled).toBe(false);
      releaseMutation.resolve();
      await expect(suspend).resolves.toMatchObject({ status: "suspended" });
      await expect(downgrade).resolves.toMatchObject({ role: "member" });
      await expect(lifecycle.reactivateById(secondAdmin.id, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
    } finally {
      releaseMutation.resolve();
      await value.sql.end();
    }
  });

  it("deletes only from suspended and permits active name reuse without reviving the old UUID", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
      const created = await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id),
      );
      await value.service.suspendById(value.bootstrap.userId, created.id);
      await value.service.deleteById(value.bootstrap.userId, created.id);
      await expect(value.service.deleteById(value.bootstrap.userId, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      await expect(value.service.getById(value.bootstrap.userId, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      const [deleted] = await value.database.select().from(agents);
      expect(deleted).toMatchObject({ id: created.id, revision: 3, status: "deleted" });

      const replacement = await value.service.createForTeam(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        createInput(computer.id),
      );
      expect(replacement.id).not.toBe(created.id);
      expect((await value.service.listForTeam(value.bootstrap.userId, value.bootstrap.teamId)).agents).toEqual([
        expect.objectContaining({ id: replacement.id, computer: expect.objectContaining({ id: computer.id }) }),
      ]);
    } finally {
      await value.sql.end();
    }
  });

  it("lets the partial unique index choose exactly one concurrent Team/name winner", async () => {
    const value = await fixture();
    try {
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
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
      const computer = await createComputer(value.database, value.bootstrap.userId, value.bootstrap.teamId);
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
        role: "admin",
        teamId: otherTeam.id,
        userId: value.bootstrap.userId,
      });
      await expect(
        value.service.createForTeam(value.bootstrap.userId, otherTeam.id, {
          ...createInput(computer.id, "assistant"),
          runtimeProvider: "claude-code",
        }),
      ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND", statusCode: 404 });
      await value.database.insert(workspaceComputers).values({
        workspaceId: otherTeam.id,
        computerId: computer.id,
        displayName: computer.displayName,
        platform: computer.platform,
        arch: computer.arch,
        clientVersion: computer.clientVersion,
        enrolledByUserId: value.bootstrap.userId,
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
