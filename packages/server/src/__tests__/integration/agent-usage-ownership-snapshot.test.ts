/**
 * RD1 for the Agent read paths: the authorization and the details it enables must come from one snapshot.
 *
 * `getUsageById` used to resolve ownership on the pool, then read the aggregate in a separate Repeatable
 * Read transaction. A transfer committing in that gap let the previous owner read usage the new owner now
 * owns, and the Provider rule that shapes the totals could come from either side of the transfer. The Agent
 * list had the same shape across four Read Committed statements.
 *
 * These are real PostgreSQL suites on independent connections. The rendezvous is a barrier injected into the
 * read path, so the interleaving is the one under test rather than a scheduler accident, and the assertion
 * after it is a Delivery written by the new owner: a read that shares the authorization snapshot cannot see
 * it. A mock cannot express either fact.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { type AgentReadStage, AgentService } from "../../services/agents/index.js";
import { rethrowGateFailure, settle, whilePaused } from "../support/barrier.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const NOW = new Date("2026-05-04T09:00:00.000Z");
const REPORT_OWNER = "11111111-1111-4111-8111-111111111111";

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

function actor(): ReturnType<typeof createDatabaseClient> {
  const client = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  openClients.push(client);
  return client;
}

/** Appends one reported Delivery to a Session; `reportedAt` keeps it out of the transfer custody guard. */
async function insertDelivery(
  database: ReturnType<typeof createDatabaseClient>["database"],
  input: { bindingId: string; sessionId: string | null; acceptedAt: Date; tokens: number },
): Promise<string> {
  let sessionId = input.sessionId;
  if (!sessionId) {
    const [created] = await database
      .insert(sessions)
      .values({
        imBindingId: input.bindingId,
        channelId: `C-${randomUUID()}`,
        conversationKind: "dm",
        kind: "channel",
        createdAt: input.acceptedAt,
      })
      .returning({ id: sessions.id });
    if (!created) throw new Error("Session fixture missing");
    sessionId = created.id;
  }
  const [message] = await database
    .insert(imMessages)
    .values({
      imBindingId: input.bindingId,
      providerEventId: `event-${randomUUID()}`,
      channelId: "channel-fixture",
      externalMessageId: `message-${randomUUID()}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "human-fixture",
      content: { version: 1, fallbackText: "turn", blocks: [{ type: "text", text: "turn" }], truncated: false },
      providerContext: { provider: "feishu", chatType: "dm" },
      occurredAt: input.acceptedAt,
    })
    .returning({ id: imMessages.id });
  if (!message) throw new Error("Message fixture missing");
  const [delivery] = await database
    .insert(imMessageDeliveries)
    .values({
      messageId: message.id,
      sessionId,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      executionOrigin: "local",
      inputHash: `input-${randomUUID()}`,
      turnId: `turn-${randomUUID()}`,
      reportOwnerInstanceId: REPORT_OWNER,
      turnReport: {
        type: "turn:report",
        requestId: randomUUID(),
        deliveryId: randomUUID(),
        turnId: `turn-${randomUUID()}`,
        sessionId,
        agentId: randomUUID(),
        placementGeneration: 1,
        outcome: "completed",
        executionEffects: "completed",
        usage: { inputTokens: input.tokens, outputTokens: 0 },
        traceSummary: { lastSequence: 1, droppedEvents: 0 },
        resultHash: "a".repeat(64),
      } as never,
      reportedAt: input.acceptedAt,
      acceptedAt: input.acceptedAt,
      expiresAt: new Date(input.acceptedAt.getTime() + 86_400_000),
      resultHash: "a".repeat(64),
    })
    .returning({ id: imMessageDeliveries.id });
  if (!delivery) throw new Error("Delivery fixture missing");
  return delivery.id;
}

async function seed(database: ReturnType<typeof createDatabaseClient>["database"]) {
  const owner = await bootstrapInitialAdmin(database, { displayName: "Owner", email: "owner@example.test" });
  const installationId = randomUUID();
  const [computer] = await database
    .insert(computers)
    .values({
      ownerAccountId: owner.userId,
      currentInstallationId: installationId,
      currentInstanceId: randomUUID(),
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
    runtimeProvider: "pi",
    name: "usage-owner",
    displayName: "Usage Owner",
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
  const [session] = await database
    .insert(sessions)
    .values({
      imBindingId: binding.id,
      channelId: "C1",
      conversationKind: "dm",
      kind: "channel",
      createdAt: NOW,
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("Session fixture missing");
  await database.insert(sessionPlacements).values({ sessionId: session.id, computerId: computer.id, generation: 1 });
  await insertDelivery(database, {
    bindingId: binding.id,
    sessionId: session.id,
    acceptedAt: NOW,
    tokens: 15,
  });
  const [target] = await database
    .insert(users)
    .values({ email: "new-owner@example.test", displayName: "New Owner" })
    .returning({ id: users.id });
  if (!target) throw new Error("Target account fixture missing");
  return {
    agents,
    agentId: agent.id,
    bindingId: binding.id,
    sessionId: session.id,
    owner,
    target,
  };
}

/**
 * Suspends and transfers the Agent on its own connections, then writes a Delivery as the new owner.
 *
 * The Delivery is the discriminator: it lands after the transfer commits, so it is visible only to a read
 * that takes a new snapshot.
 */
async function transferAndAppendDelivery(
  fixture: Awaited<ReturnType<typeof seed>>,
  writer: ReturnType<typeof createDatabaseClient>,
): Promise<void> {
  const mover = actor();
  const moverService = new AgentService(mover.database, { now: () => NOW });
  await moverService.suspendById(fixture.owner.userId, fixture.agentId);
  await moverService.transferToAccount({
    agentId: fixture.agentId,
    slack: "disable",
    targetAccountId: fixture.target.id,
  });
  // Inside the queried window and after the read's snapshot: visibility, not the timestamp, is the test.
  await insertDelivery(writer.database, {
    bindingId: fixture.bindingId,
    sessionId: null,
    acceptedAt: new Date(NOW.getTime() - 30_000),
    tokens: 999_999,
  });
}

async function pausedReader(stage: AgentReadStage) {
  const entered = deferred();
  const release = deferred();
  const reader = actor();
  const service = new AgentService(reader.database, {
    now: () => NOW,
    afterReadAuthorization: async (observed) => {
      if (observed !== stage) throw new Error(`Unexpected read stage ${observed}`);
      entered.resolve();
      await release.promise;
    },
  });
  return { entered, release, service };
}

describe("Agent read authorization snapshots", () => {
  it("keeps usage on the authorization snapshot when a transfer commits mid-read", async () => {
    const seedConnection = actor();
    const fixture = await seed(seedConnection.database);
    const writer = actor();
    const { entered, release, service } = await pausedReader("usage");

    const reading = settle(service.getUsageById(fixture.owner.userId, fixture.agentId, 30));
    const gate = await whilePaused({
      release,
      settled: [reading],
      gate: async () => {
        await entered.promise;
        await transferAndAppendDelivery(fixture, writer);
      },
    });
    const outcome = await reading;
    rethrowGateFailure(gate);

    // The Delivery the new owner wrote after the transfer must not appear: same snapshot as authorization.
    expect(outcome).toMatchObject({
      status: "fulfilled",
      value: { tasks: 1, measuredTasks: 1, inputTokens: 15, tokens: 15 },
    });
    // The next read starts its own snapshot, so the previous owner is refused rather than served.
    await expect(service.getUsageById(fixture.owner.userId, fixture.agentId, 30)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(service.getUsageById(fixture.target.id, fixture.agentId, 30)).resolves.toMatchObject({
      tasks: 2,
      inputTokens: 15 + 999_999,
    });
  }, 60_000);

  it("keeps the Agent list on the authorization snapshot when a transfer commits mid-read", async () => {
    const seedConnection = actor();
    const fixture = await seed(seedConnection.database);
    const writer = actor();
    const { entered, release, service } = await pausedReader("list");

    const reading = settle(service.listForAccount(fixture.owner.userId));
    const gate = await whilePaused({
      release,
      settled: [reading],
      gate: async () => {
        await entered.promise;
        await transferAndAppendDelivery(fixture, writer);
      },
    });
    const outcome = await reading;
    rethrowGateFailure(gate);
    expect(outcome.status).toBe("fulfilled");
    if (outcome.status !== "fulfilled") throw outcome.reason;
    const listed = outcome.value;
    expect(listed.agents.map((agent) => agent.id)).toEqual([fixture.agentId]);
    expect(listed.agents[0]?.usage).toEqual({ windowDays: 30, tasks: 1, failed: 0, tokens: 15 });
    // A later call takes a fresh snapshot and the transferred Agent is gone from the previous owner's list.
    await expect(service.listForAccount(fixture.owner.userId)).resolves.toEqual({ agents: [] });
    await expect(service.listForAccount(fixture.target.id)).resolves.toMatchObject({
      agents: [{ id: fixture.agentId, usage: { tasks: 2 } }],
    });
  }, 60_000);

  it("serves a read that begins while the transfer is still uncommitted, then refuses it", async () => {
    const seedConnection = actor();
    const fixture = await seed(seedConnection.database);
    const mover = actor();
    const locked = deferred();
    const release = deferred();
    const moving = settle(
      new AgentService(mover.database, {
        now: () => NOW,
        afterAgentLocked: async () => {
          locked.resolve();
          await release.promise;
        },
      }).suspendById(fixture.owner.userId, fixture.agentId),
    );
    const reader = actor();
    const service = new AgentService(reader.database, { now: () => NOW });
    const gate = await whilePaused({
      release,
      settled: [moving],
      gate: async () => {
        await locked.promise;
        // A transfer that has not committed has not happened: the reader sees the committed owner and is not
        // blocked behind the row lock, which is what makes this a snapshot question rather than a lock one.
        await expect(service.listForAccount(fixture.owner.userId)).resolves.toMatchObject({
          agents: [{ id: fixture.agentId }],
        });
      },
    });
    const moved = await moving;
    rethrowGateFailure(gate);
    expect(moved).toMatchObject({ status: "fulfilled" });
    await new AgentService(mover.database, { now: () => NOW }).transferToAccount({
      agentId: fixture.agentId,
      slack: "disable",
      targetAccountId: fixture.target.id,
    });
    await expect(service.listForAccount(fixture.owner.userId)).resolves.toEqual({ agents: [] });
  }, 60_000);

  it("releases the barrier and settles the read when the paused assertion fails", async () => {
    const seedConnection = actor();
    const fixture = await seed(seedConnection.database);
    const { entered, release, service } = await pausedReader("list");
    const reading = settle(service.listForAccount(fixture.owner.userId));

    const gate = await whilePaused({
      release,
      settled: [reading],
      gate: async () => {
        await entered.promise;
        // A failure between the barrier and its release is the case that used to hang the file's cleanup.
        throw new Error("simulated assertion failure");
      },
    });

    const outcome = await reading;
    expect(gate.failed).toBe(true);
    if (!gate.failed) throw new Error("expected the gated work to fail");
    expect((gate.error as Error).message).toBe("simulated assertion failure");
    // The release ran, so the paused transaction finished instead of pinning its pooled connection.
    expect(outcome.status).toBe("fulfilled");
    // The same pool is usable again, which is what `afterEach` closing it depends on.
    await expect(service.listForAccount(fixture.owner.userId)).resolves.toMatchObject({
      agents: [{ id: fixture.agentId }],
    });
  }, 60_000);

  it("releases the transfer barrier and settles the move when the paused assertion fails", async () => {
    const seedConnection = actor();
    const fixture = await seed(seedConnection.database);
    const mover = actor();
    const locked = deferred();
    const release = deferred();
    const moving = settle(
      new AgentService(mover.database, {
        now: () => NOW,
        afterAgentLocked: async () => {
          locked.resolve();
          await release.promise;
        },
      }).suspendById(fixture.owner.userId, fixture.agentId),
    );

    const gate = await whilePaused({
      release,
      settled: [moving],
      gate: async () => {
        await locked.promise;
        throw new Error("simulated transfer assertion failure");
      },
    });

    const moved = await moving;
    expect(gate.failed).toBe(true);
    if (!gate.failed) throw new Error("expected the gated work to fail");
    expect((gate.error as Error).message).toBe("simulated transfer assertion failure");
    expect(moved.status).toBe("fulfilled");
    // The mover's connection is free again: the suspended transaction committed and the transfer can proceed.
    await expect(
      new AgentService(mover.database, { now: () => NOW }).transferToAccount({
        agentId: fixture.agentId,
        slack: "disable",
        targetAccountId: fixture.target.id,
      }),
    ).resolves.toMatchObject({ agentId: fixture.agentId });
  }, 60_000);
});
