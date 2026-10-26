/**
 * The closure activity flag is a second write of `sessions.ended_at`, so it must commit and roll back with it
 * and must survive a create that races the end of its creator's binding.
 *
 * These are real PostgreSQL suites on independent connections. The barrier is a transaction that a second
 * connection holds open, so the interleaving is the one under test and not a scheduler accident. A single
 * connection cannot show the visibility the invariant depends on, and a mock of `sessions` cannot show that
 * two statements observe different snapshots.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { computers, imBindings, sessions, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { disableImBindingInTransaction } from "../../services/im-bindings/disable-im-binding.js";
import { SessionService } from "../../services/sessions/session-service.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const NOW = new Date("2026-04-02T09:00:00.000Z");

let testDatabase: MigratedTestDatabase;
const openClients: ReturnType<typeof createDatabaseClient>[] = [];

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await testDatabase.reset();
});

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.sql.end()));
});

/** One independent connection pool per actor, so a held transaction cannot share a connection. */
function actor(): ReturnType<typeof createDatabaseClient> {
  const client = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  openClients.push(client);
  return client;
}

async function closureDivergence(database: DatabaseClient): Promise<number> {
  const [row] = await database.execute<{ divergent: number }>(sql`
    select count(*)::int as divergent
    from session_descendants link
    inner join sessions child on child.id = link.descendant_session_id
    where link.descendant_active is distinct from (child.ended_at is null)
  `);
  return row?.divergent ?? -1;
}

async function activeDescendantFlags(database: DatabaseClient): Promise<{ active: number; inactive: number }> {
  const [row] = await database.execute<{ active: number; inactive: number }>(sql`
    select count(*) filter (where descendant_active)::int as active,
           count(*) filter (where not descendant_active)::int as inactive
    from session_descendants
  `);
  return { active: row?.active ?? -1, inactive: row?.inactive ?? -1 };
}

async function seed(database: DatabaseClient) {
  const owner = await bootstrapInitialAdmin(database, { displayName: "Owner", email: "owner@example.test" });
  const installationId = randomUUID();
  const connectionInstanceId = randomUUID();
  const [computer] = await database
    .insert(computers)
    .values({
      ownerAccountId: owner.userId,
      currentInstallationId: installationId,
      currentInstanceId: connectionInstanceId,
      displayName: "box",
      platform: "linux",
      arch: "x64",
      clientVersion: "1",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: computers.id });
  if (!computer) throw new Error("Computer fixture missing");
  const agents = new AgentService(database, { now: () => NOW });
  const agent = await agents.createForAccount(owner.userId, {
    computerId: computer.id,
    runtimeProvider: "codex",
    name: "assistant",
    displayName: "Assistant",
  });
  const [binding] = await database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: `app-${randomUUID()}`,
      externalBotId: "bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "sealed",
      activatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: imBindings.id });
  if (!binding) throw new Error("IM binding fixture missing");
  const sessionService = new SessionService(database, { now: () => NOW });
  const root = await sessionService.ensureChatSession(
    { imBindingId: binding.id, channelId: "C1", conversationKind: "dm" },
    "channel",
  );
  /** A fresh create input; each call is one independent attempt from a given connection. */
  const childInput = (creatorSessionId: string) => ({
    creatorSessionId,
    creatorInstallationId: installationId,
    creatorConnectionInstanceId: connectionInstanceId,
    creatorComputerId: computer.id,
    creatorPlacementGeneration: 1,
    messageId: randomUUID(),
    initialMessage: `work-${randomUUID()}`,
  });
  const child = await sessionService.createInternalSessionWithMessage(childInput(root.session.id));
  return {
    owner,
    agents,
    agentId: agent.id,
    bindingId: binding.id,
    computerId: computer.id,
    installationId,
    connectionInstanceId,
    rootSessionId: root.session.id,
    childSessionId: child.session.id,
    childInput,
  };
}

describe("Session closure maintenance", () => {
  it("rolls the ended Session and its closure flag back together", async () => {
    const database = actor();
    const fixture = await seed(database.database);
    const before = await activeDescendantFlags(database.database);

    await expect(
      database.database.transaction(async (transaction) => {
        await disableImBindingInTransaction(transaction, fixture.bindingId, NOW);
        // The lifecycle transaction fails after both writes, so neither may survive.
        throw new Error("simulated failure after the end");
      }),
    ).rejects.toThrow("simulated failure after the end");

    const ended = await database.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(sql`${sessions.endedAt} is not null`);
    expect(ended).toEqual([]);
    expect(await activeDescendantFlags(database.database)).toEqual(before);
    expect(await closureDivergence(database.database)).toBe(0);
  });

  it("fails a create closed while another connection is ending the binding", async () => {
    const ender = actor();
    const creator = actor();
    const fixture = await seed(ender.database);
    const releasingEnd = deferred();

    const ending = ender.database.transaction(async (transaction) => {
      await disableImBindingInTransaction(transaction, fixture.bindingId, NOW);
      // Hold the locks the end has already taken until the create is provably waiting for them.
      await releasingEnd.promise;
    });
    const creating = new SessionService(creator.database, { now: () => NOW })
      .createInternalSessionWithMessage(fixture.childInput(fixture.rootSessionId))
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const blocked = await Promise.race([
      creating.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 500)),
    ]);
    expect(blocked).toBe("pending");

    releasingEnd.resolve();
    await ending;
    const outcome = await creating;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("A create must not pass the binding lock after an end");
    expect(outcome.error).toMatchObject({ code: "SESSION_SOURCE_UNAVAILABLE" });

    expect(await activeDescendantFlags(ender.database)).toEqual({ active: 0, inactive: 1 });
    expect(await closureDivergence(ender.database)).toBe(0);
    const children = await ender.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.kind, "internal"), isNull(sessions.endedAt)));
    expect(children).toEqual([]);
  });

  it("allows two creates under one creator and keeps both descendants active", async () => {
    const first = actor();
    const second = actor();
    const fixture = await seed(first.database);
    const [a, b] = await Promise.all([
      new SessionService(first.database, { now: () => NOW }).createInternalSessionWithMessage(
        fixture.childInput(fixture.rootSessionId),
      ),
      new SessionService(second.database, { now: () => NOW }).createInternalSessionWithMessage(
        fixture.childInput(fixture.rootSessionId),
      ),
    ]);
    expect(a.session.id).not.toBe(b.session.id);
    expect(await activeDescendantFlags(first.database)).toEqual({ active: 3, inactive: 0 });
    expect(await closureDivergence(first.database)).toBe(0);
  });

  it("ends Sessions of every binding when an ownership transfer moves the Agent", async () => {
    const database = actor();
    const fixture = await seed(database.database);
    // A Session that outlived a binding an earlier release disabled: it belongs to the same Agent, so the
    // Agent-scoped end of the transfer must reach it, and only that path covers it.
    const [retiredBinding] = await database.database
      .insert(imBindings)
      .values({
        agentId: fixture.agentId,
        provider: "feishu",
        status: "disabled",
        externalAppId: `retired-${randomUUID()}`,
        externalBotId: "bot",
        credentialGeneration: 1,
        disabledAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: imBindings.id });
    if (!retiredBinding) throw new Error("Retired binding fixture missing");
    const [retiredSession] = await database.database
      .insert(sessions)
      .values({
        imBindingId: retiredBinding.id,
        channelId: "C-retired",
        conversationKind: "dm",
        kind: "internal",
        createdBySessionId: fixture.rootSessionId,
        createdAt: NOW,
      })
      .returning({ id: sessions.id });
    if (!retiredSession) throw new Error("Retired Session fixture missing");
    const target = await database.database
      .insert(users)
      .values({ email: "new-owner@example.test", displayName: "New Owner" })
      .returning({ id: users.id });
    if (!target[0]) throw new Error("Target account fixture missing");

    await fixture.agents.suspendById(fixture.owner.userId, fixture.agentId);
    const result = await fixture.agents.transferToAccount({
      agentId: fixture.agentId,
      slack: "disable",
      targetAccountId: target[0].id,
    });
    expect(result).toMatchObject({ imBinding: "disabled", sourceAccountId: fixture.owner.userId });

    const ended = await database.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(inArray(sessions.imBindingId, [fixture.bindingId, retiredBinding.id]), isNull(sessions.endedAt)));
    expect(ended).toEqual([]);
    expect(await activeDescendantFlags(database.database)).toEqual({ active: 0, inactive: 1 });
    expect(await closureDivergence(database.database)).toBe(0);
  });
});
