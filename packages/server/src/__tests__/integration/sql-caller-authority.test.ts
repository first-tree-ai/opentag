import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient, type DatabaseTransaction } from "../../db/client.js";
import {
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
  users,
} from "../../db/schema/index.js";
import { AgentSelfService, DatabaseAgentOwnerResolver } from "../../services/agents/agent-self-service.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImOutboundCapture } from "../../services/im/im-outbound-capture.js";
import { ImBindingService } from "../../services/im-bindings/im-binding-service.js";
import { SessionCliProofService } from "../../services/sessions/session-cli-proof-service.js";
import { TaskService } from "../../services/tasks/task-service.js";
import { transferLegacyAgentFixture } from "../support/legacy-agent-fixture.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 180_000);
beforeEach(async () => pg.reset());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.sql.end({ timeout: 1 })));
});
afterAll(async () => pg?.stop());

function client() {
  const value = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(value);
  return value;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Pause after PostgreSQL returns authority, also when the read uses a transaction executor.
function pauseAfterFirstRead(database: DatabaseClient, pause: () => Promise<void>): DatabaseClient {
  let first = true;
  const afterRead = async (rows: unknown) => {
    if (first) {
      first = false;
      await pause();
    }
    return rows;
  };
  const query = (builder: object): object =>
    new Proxy(builder, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then") {
          return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(target).then(afterRead).then(resolve, reject);
        }
        return typeof value === "function"
          ? (...args: unknown[]) => {
              const result = Reflect.apply(value, target, args);
              return result && typeof result === "object" ? query(result) : result;
            }
          : value;
      },
    });
  const executor = (database: DatabaseClient | DatabaseTransaction): DatabaseClient | DatabaseTransaction =>
    new Proxy(database, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "transaction") {
          return (read: (transaction: DatabaseTransaction) => Promise<unknown>, options: unknown) =>
            Reflect.apply(value, target, [
              (transaction: DatabaseTransaction) => read(executor(transaction) as DatabaseTransaction),
              options,
            ]);
        }
        if (key === "select") return (...args: unknown[]) => query(Reflect.apply(value, target, args));
        if (key === "execute") {
          return (...args: unknown[]) => Promise.resolve(Reflect.apply(value, target, args)).then(afterRead);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return executor(database) as DatabaseClient;
}

async function account(database: DatabaseClient) {
  const id = randomUUID();
  await database.insert(users).values({ id, email: `${id}@example.test`, displayName: "Authority owner" });
  return id;
}

async function selfFixture() {
  const connection = client();
  const accountId = await account(connection.database);
  const computerId = randomUUID();
  const instanceId = randomUUID();
  await connection.database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    currentInstanceId: instanceId,
    currentInstallationId: randomUUID(),
    displayName: "Authority Computer",
    platform: "linux",
    arch: "arm64",
    clientVersion: "0.1.2",
  });
  const agents = new AgentService(connection.database);
  const agent = await agents.createForAccount(accountId, {
    name: "self-authority",
    displayName: "Self authority",
    runtimeProvider: "codex",
    computerId,
  });
  const [binding] = await connection.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: randomUUID(),
      externalBotId: "fixture-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "fixture",
      activatedAt: new Date(),
    })
    .returning();
  assert(binding);
  const [session] = await connection.database
    .insert(sessions)
    .values({ imBindingId: binding.id, channelId: "C", conversationKind: "channel", kind: "channel" })
    .returning();
  assert(session);
  await connection.database.insert(sessionPlacements).values({ sessionId: session.id, computerId, generation: 1 });
  const proofs = new SessionCliProofService(
    connection.database,
    { currentInstanceId: (id) => (id === computerId ? instanceId : undefined), supportsCapability: () => true },
    randomBytes(32),
  );
  const { token } = await proofs.mint({
    sessionId: session.id,
    computerId,
    placementGeneration: 1,
    connectionInstanceId: instanceId,
  });
  const self = new AgentSelfService({
    agents,
    authorization: {} as never,
    flows: {} as never,
    mcp: {} as never,
    owners: new DatabaseAgentOwnerResolver(connection.database),
    proofs,
    publicOrigin: "https://authority.example.test",
  });
  return { accountId, agent, agents, self, token };
}

it("refuses a previously authenticated self update after opt-out with the current revision", async () => {
  const fixture = await selfFixture();
  const scope = await fixture.self.authenticate(fixture.token);
  const disabled = await fixture.agents.updateById(fixture.accountId, fixture.agent.id, {
    expectedRevision: fixture.agent.revision,
    selfConfigurationEnabled: false,
  });
  await expect(
    fixture.self.updateConfig(scope, {
      expectedRevision: disabled.revision,
      runtimeConfig: { instructions: "late self write" },
    }),
  ).rejects.toMatchObject({ code: "AGENT_SELF_CONFIGURATION_DISABLED", statusCode: 403 });
  expect((await fixture.agents.getConfigById(fixture.accountId, fixture.agent.id)).runtimeConfig.instructions).not.toBe(
    "late self write",
  );
});

it("keeps a normal self update and its revision conflict behavior", async () => {
  const fixture = await selfFixture();
  const scope = await fixture.self.authenticate(fixture.token);
  await expect(
    fixture.self.updateConfig(scope, {
      expectedRevision: fixture.agent.revision,
      runtimeConfig: { instructions: "authorized self write" },
    }),
  ).resolves.toMatchObject({ runtimeConfig: { instructions: "authorized self write" } });
  await expect(
    fixture.self.updateConfig(scope, {
      expectedRevision: fixture.agent.revision,
      runtimeConfig: { instructions: "stale self write" },
    }),
  ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
});

it("allows the Account to update configuration while self configuration is disabled", async () => {
  const fixture = await selfFixture();
  const disabled = await fixture.agents.updateById(fixture.accountId, fixture.agent.id, {
    expectedRevision: fixture.agent.revision,
    selfConfigurationEnabled: false,
  });
  await expect(
    fixture.agents.updateById(fixture.accountId, fixture.agent.id, {
      expectedRevision: disabled.revision,
      runtimeConfig: { instructions: "Account write" },
    }),
  ).resolves.toMatchObject({ selfConfigurationEnabled: false, runtimeConfig: { instructions: "Account write" } });
});

it("does not add a new owner's confirmed reply to an old Account's authorized snapshot", async () => {
  const reader = client();
  const writer = client();
  const oldOwner = await account(writer.database);
  const newOwner = await account(writer.database);
  const agents = new AgentService(writer.database);
  const agent = await agents.createForAccount(oldOwner, { name: "reply", displayName: "Reply", runtimeProvider: "pi" });
  const identity = {
    externalAppId: randomUUID(),
    externalTeamId: randomUUID(),
    externalBotId: "B0BOT",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    activatedAt: new Date(),
  };
  const [installation] = await writer.database
    .insert(slackInstallations)
    .values({ agentId: agent.id, status: "active", ...identity, encryptedCredential: "fixture" })
    .returning();
  assert(installation);
  const [binding] = await writer.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "slack",
      status: "active",
      ...identity,
      slackInstallationId: installation.id,
      slackRouteKind: "default",
    })
    .returning();
  assert(binding);
  // The private chat's Task is its channel Session, created before anything was sent.
  await writer.database.insert(sessions).values({
    imBindingId: binding.id,
    channelId: "C0CHAT",
    conversationKind: "dm",
    kind: "channel",
    createdAt: new Date(Date.now() - 60_000),
  });
  const [message] = await writer.database
    .insert(imMessages)
    .values({
      imBindingId: binding.id,
      providerEventId: randomUUID(),
      channelId: "C0CHAT",
      externalMessageId: "anchor",
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "U1",
      content: { version: 1, fallbackText: "old", blocks: [], truncated: false },
      providerContext: { provider: "slack", channelType: "im" },
      occurredAt: new Date(),
    })
    .returning();
  assert(message);
  await agents.suspendById(oldOwner, agent.id);
  const entered = deferred();
  const release = deferred();
  const service = new TaskService(
    pauseAfterFirstRead(reader.database, async () => {
      entered.resolve();
      await release.promise;
    }),
  );
  const reading = service.listReplies(oldOwner, message.id, { limit: 10 });
  try {
    await entered.promise;
    await transferLegacyAgentFixture(writer.database, { agentId: agent.id, targetAccountId: newOwner, slack: "keep" });
    await new ImOutboundCapture(writer.database).capture({
      bindingId: binding.id,
      provider: "slack",
      operationId: "chat.postMessage",
      pathParams: {},
      query: "",
      requestBody: { channel: "C0CHAT", text: "new owner reply" },
      responsePayload: {
        ok: true,
        channel: "C0CHAT",
        ts: "1790042401.000200",
        message: { type: "message", subtype: "bot_message", bot_id: "B0BOT", text: "new owner reply" },
      },
      observedAt: new Date(),
    });
  } finally {
    release.resolve();
  }
  expect((await reading).items).toEqual([]);
  await expect(new TaskService(reader.database).listReplies(oldOwner, message.id, { limit: 10 })).rejects.toBeDefined();
  expect(
    JSON.stringify(await new TaskService(reader.database).listReplies(newOwner, message.id, { limit: 10 })),
  ).toContain("new owner reply");
});

it("keeps Agent detail activity in the authorized snapshot across a historical ownership change", async () => {
  const reader = client();
  const writer = client();
  const oldOwner = await account(writer.database);
  const newOwner = await account(writer.database);
  const agents = new AgentService(writer.database);
  const agent = await agents.createForAccount(oldOwner, {
    name: "detail",
    displayName: "Detail",
    runtimeProvider: "codex",
  });
  const entered = deferred();
  const release = deferred();
  const now = new Date();
  const service = new AgentService(
    pauseAfterFirstRead(reader.database, async () => {
      entered.resolve();
      await release.promise;
    }),
    { now: () => now },
  );
  const reading = service.getById(oldOwner, agent.id);
  try {
    await entered.promise;
    await agents.suspendById(oldOwner, agent.id);
    await transferLegacyAgentFixture(writer.database, {
      agentId: agent.id,
      targetAccountId: newOwner,
      slack: "disable",
    });
    await agents.reactivateById(newOwner, agent.id);
    const [binding] = await writer.database
      .insert(imBindings)
      .values({
        agentId: agent.id,
        provider: "feishu",
        status: "active",
        externalAppId: randomUUID(),
        externalBotId: "new-bot",
        credentialSchemaVersion: 1,
        credentialGeneration: 1,
        encryptedCredential: "fixture",
        activatedAt: now,
      })
      .returning();
    assert(binding);
    const [session] = await writer.database
      .insert(sessions)
      .values({ imBindingId: binding.id, kind: "channel", channelId: "new-channel", conversationKind: "dm" })
      .returning();
    assert(session);
    const [message] = await writer.database
      .insert(imMessages)
      .values({
        imBindingId: binding.id,
        providerEventId: randomUUID(),
        channelId: "new-channel",
        externalMessageId: randomUUID(),
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "new-owner",
        content: { version: 1, fallbackText: "new", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "dm" },
        occurredAt: now,
      })
      .returning();
    assert(message);
    await writer.database.insert(imMessageDeliveries).values({
      messageId: message.id,
      sessionId: session.id,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      executionOrigin: "local",
      inputHash: randomUUID(),
      turnId: randomUUID(),
      reportOwnerInstanceId: randomUUID(),
      acceptedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
  } finally {
    release.resolve();
  }
  expect((await reading).activity).toEqual({ state: "idle" });
  await expect(agents.getById(oldOwner, agent.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  expect((await agents.getById(newOwner, agent.id)).activity.state).toBe("working");
});

it.each(["getForAgent", "getConfigForAgent", "readSetupForAgent"] as const)(
  "keeps IM owner snapshot in %s across a historical ownership change",
  async (method) => {
    const reader = client();
    const writer = client();
    const oldOwner = await account(writer.database);
    const newOwner = await account(writer.database);
    const agents = new AgentService(writer.database);
    const agent = await agents.createForAccount(oldOwner, { name: "im", displayName: "IM", runtimeProvider: "codex" });
    const bindingValues = {
      agentId: agent.id,
      provider: "feishu" as const,
      status: "active" as const,
      externalAppId: randomUUID(),
      externalBotId: "old-bot",
      botDisplayName: "Old bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "fixture",
      activatedAt: new Date(),
    };
    const [oldBinding] = await writer.database.insert(imBindings).values(bindingValues).returning();
    assert(oldBinding);
    const entered = deferred();
    const release = deferred();
    const cipher = new ApplicationCipher(randomBytes(32));
    const service = new ImBindingService(
      pauseAfterFirstRead(reader.database, async () => {
        entered.resolve();
        await release.promise;
      }),
      cipher,
    );
    const reading = service[method](oldOwner, agent.id);
    try {
      await entered.promise;
      await agents.suspendById(oldOwner, agent.id);
      await transferLegacyAgentFixture(writer.database, {
        agentId: agent.id,
        targetAccountId: newOwner,
        slack: "disable",
      });
      await agents.reactivateById(newOwner, agent.id);
      await writer.database
        .insert(imBindings)
        .values({ ...bindingValues, externalAppId: randomUUID(), externalBotId: "new-bot", botDisplayName: "New bot" });
    } finally {
      release.resolve();
    }
    expect(await reading).toMatchObject(
      method === "readSetupForAgent"
        ? { binding: { bindingId: oldBinding.id } }
        : { id: oldBinding.id, bot: { displayName: "Old bot" } },
    );
    const fresh = new ImBindingService(reader.database, cipher);
    await expect(fresh[method](oldOwner, agent.id)).rejects.toMatchObject({ code: "IM_BINDING_NOT_FOUND" });
    expect(JSON.stringify(await fresh[method](newOwner, agent.id))).not.toContain(oldBinding.id);
  },
);
