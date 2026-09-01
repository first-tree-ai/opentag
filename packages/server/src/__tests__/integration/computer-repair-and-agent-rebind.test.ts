import { computeDirectInputHash, type DirectImMessageDeliveryRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  accountComputers,
  agents,
  computerConnectCodes,
  computerCredentials,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  users,
  workspaceComputers,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { bootstrapTestAccount as bootstrapInitialAdmin } from "../test-account.js";
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
    workspaceDisplayName: "Example",
    workspaceName: "example",
  });
  return {
    ...client,
    bootstrap,
    agents: new AgentService(client.database),
    machineAuth: new MachineAuthService(client.database),
  };
}

function exchangeInput(code: string, computerId = crypto.randomUUID()) {
  return {
    code,
    computerId,
    displayName: "workstation" as const,
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
  };
}

async function enroll(value: Awaited<ReturnType<typeof fixture>>) {
  const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
  return value.machineAuth.exchangeConnectCode(exchangeInput(issued.code));
}

async function createAgent(value: Awaited<ReturnType<typeof fixture>>, computerId: string, name = "reviewer") {
  return value.agents.createForAccount(value.bootstrap.userId, {
    name,
    displayName: name,
    runtimeProvider: "codex",
    computerId,
  });
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the database lock barrier");
}

async function bindSession(
  database: DatabaseClient,
  input: {
    agentId: string;
    bindingId?: string;
    computerId: string;
    channelId: string;
    ended?: boolean;
  },
) {
  let bindingId = input.bindingId;
  if (!bindingId) {
    const [binding] = await database
      .insert(imBindings)
      .values({
        agentId: input.agentId,
        provider: "feishu",
        status: "active",
        externalAppId: `cli-${input.channelId}`,
        externalBotId: `ou-${input.channelId}`,
        credentialSchemaVersion: 1,
        credentialGeneration: 1,
        encryptedCredential: "fixture",
        activatedAt: new Date(),
      })
      .returning();
    if (!binding) throw new Error("IM binding fixture was not created");
    bindingId = binding.id;
  }
  const [session] = await database
    .insert(sessions)
    .values({
      imBindingId: bindingId,
      channelId: input.channelId,
      conversationKind: "channel",
      kind: "channel",
      endedAt: input.ended ? new Date() : null,
    })
    .returning();
  if (!session) throw new Error("Session fixture was not created");
  await database.insert(sessionPlacements).values({
    sessionId: session.id,
    workspaceComputerId: input.computerId,
    computerId: input.computerId,
    generation: 1,
  });
  return { bindingId, session };
}

async function pendingDelivery(
  database: DatabaseClient,
  input: {
    bindingId: string;
    sessionId: string;
    agentId: string;
    channelId: string;
    generation?: number;
    dispatch?: boolean;
    state?: "pending" | "expired";
  },
) {
  const [message] = await database
    .insert(imMessages)
    .values({
      imBindingId: input.bindingId,
      providerEventId: `event-${crypto.randomUUID()}`,
      channelId: input.channelId,
      externalMessageId: `message-${crypto.randomUUID()}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "U_HUMAN",
      content: { version: 1, fallbackText: "Do the work", blocks: [], truncated: false },
      providerContext: { provider: "feishu", chatType: "p2p" },
      occurredAt: new Date(),
    })
    .returning();
  if (!message) throw new Error("Message fixture was not created");
  const dispatchRequestId = input.dispatch ? crypto.randomUUID() : null;
  const deliveryId = crypto.randomUUID();
  const dispatchPayload: DirectImMessageDeliveryRequest | null = dispatchRequestId
    ? {
        type: "im:deliver",
        requestId: dispatchRequestId,
        deliveryId,
        imMessageId: message.id,
        sessionId: input.sessionId,
        agentId: input.agentId,
        placementGeneration: input.generation ?? 1,
        attention: "direct",
        content: {
          kind: "text",
          text: "Do the work",
          providerRef: {
            provider: "feishu",
            teamBrand: "feishu",
            appId: `cli-${input.channelId}`,
            botOpenId: `ou-${input.channelId}`,
            chatId: input.channelId,
            messageId: message.id,
          },
        },
        runtime: {
          revision: {
            agent: { sequence: 1, id: "a".repeat(64) },
            session: { sequence: 1, id: "b".repeat(64) },
          },
          agentId: input.agentId,
          provider: "codex",
          instructions: { platform: "platform", agent: "agent" },
          execution: { approvalPolicy: "never", networkAccess: true },
          workspace: { workspaceId: input.agentId, mode: "empty_on_create", sharing: "agent" },
        },
      }
    : null;
  const [delivery] = await database
    .insert(imMessageDeliveries)
    .values({
      id: deliveryId,
      messageId: message.id,
      sessionId: input.sessionId,
      attention: "direct",
      state: input.state ?? "pending",
      placementGeneration: input.generation ?? 1,
      expiresAt: new Date(Date.now() + 60_000),
      dispatchRequestId,
      dispatchInputHash: dispatchPayload ? computeDirectInputHash(dispatchPayload) : null,
      dispatchPayload,
    })
    .returning();
  if (!delivery) throw new Error("Delivery fixture was not created");
  return delivery;
}

describe("Computer repair and Agent rebind boundaries", () => {
  it("serializes Computer removal with an exact-target Agent rebind without a lock-order deadlock", async () => {
    const value = await fixture();
    const observer = createDatabaseClient(databaseUrl, { max: 1 });
    const agentLocked = deferred<void>();
    const releaseRebind = deferred<void>();
    try {
      const computer = await enroll(value);
      const agent = await createAgent(value, computer.workspaceComputerId, "concurrent-removal");
      const rebindService = new AgentService(value.database, {
        afterAgentLocked: async () => {
          agentLocked.resolve();
          await releaseRebind.promise;
        },
      });
      const computerService = new ComputerService(value.database, {
        getActiveUserById: async () => {
          throw new Error("Computer removal does not resolve an active user");
        },
      });

      const rebind = rebindService.rebindById(value.bootstrap.userId, agent.id, computer.workspaceComputerId);
      await agentLocked.promise;
      const removal = computerService.removeFromAccount(value.bootstrap.userId, computer.workspaceComputerId);
      await waitUntil(async () => {
        const result = await observer.sql<{ waiting: boolean }[]>`
          select exists (
            select 1
            from pg_stat_activity
            where datname = current_database()
              and wait_event_type = 'Lock'
              and wait_event = 'transactionid'
              and query like '%"agents"%for update%'
          ) as waiting
        `;
        return result[0]?.waiting ?? false;
      });

      releaseRebind.resolve();
      const [rebindResult, removalResult] = await Promise.allSettled([rebind, removal]);
      expect(rebindResult.status).toBe("fulfilled");
      expect(removalResult.status).toBe("fulfilled");
      expect(
        (
          await value.database
            .select()
            .from(computerCredentials)
            .where(eq(computerCredentials.computerId, computer.workspaceComputerId))
        )[0]?.revokedAt,
      ).not.toBeNull();
      expect((await value.database.select().from(agents).where(eq(agents.id, agent.id)))[0]).toMatchObject({
        computerId: null,
        workspaceComputerId: null,
      });
    } finally {
      releaseRebind.resolve();
      await Promise.all([value.sql.end(), observer.sql.end()]);
    }
  });

  it("repairs the named Computer without inferring identity or moving Session placement", async () => {
    const value = await fixture();
    try {
      const first = await enroll(value);
      const agent = await createAgent(value, first.workspaceComputerId);
      const { session } = await bindSession(value.database, {
        agentId: agent.id,
        computerId: first.workspaceComputerId,
        channelId: "C-repair",
      });
      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {
        mode: "repair",
        targetComputerId: first.workspaceComputerId,
      });
      expect(issued.mode).toBe("repair");
      expect(issued.expiresIn).toBe(15 * 60);
      const repairedInstallation = crypto.randomUUID();
      const repaired = await value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, repairedInstallation));
      expect(repaired.workspaceComputerId).toBe(first.workspaceComputerId);
      expect(repaired.computerId).toBe(repairedInstallation);
      await expect(value.machineAuth.verifyMachineToken(first.machineToken)).rejects.toMatchObject({
        code: "AUTH_INVALID_TOKEN",
      });
      const [accountComputer] = await value.database
        .select()
        .from(accountComputers)
        .where(eq(accountComputers.id, first.workspaceComputerId));
      expect(accountComputer).toMatchObject({
        currentInstallationId: repairedInstallation,
        ownerAccountId: value.bootstrap.userId,
      });
      const [placement] = await value.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, session.id));
      expect(placement).toMatchObject({
        computerId: first.workspaceComputerId,
        generation: 1,
      });
      await expect(value.machineAuth.exchangeConnectCode(exchangeInput(issued.code))).rejects.toMatchObject({
        code: "AUTH_CODE_CONSUMED",
      });
    } finally {
      await value.sql.end();
    }
  });

  it("refuses repair of a Computer the Account does not own", async () => {
    const value = await fixture();
    try {
      const first = await enroll(value);
      const [other] = await value.database
        .insert(users)
        .values({ displayName: "Other", email: "other-repair@example.com" })
        .returning();
      if (!other) throw new Error("Other Account fixture was not created");
      await expect(
        value.machineAuth.issueForAccount(other.id, {
          mode: "repair",
          targetComputerId: first.workspaceComputerId,
        }),
      ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND", statusCode: 404 });
      expect(await value.database.select().from(computerConnectCodes)).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("moves non-ended Sessions atomically and leaves ended Sessions in place", async () => {
    const value = await fixture();
    try {
      const first = await enroll(value);
      const second = await enroll(value);
      const agent = await createAgent(value, first.workspaceComputerId);
      const active = await bindSession(value.database, {
        agentId: agent.id,
        computerId: first.workspaceComputerId,
        channelId: "C-active",
      });
      const alreadyOnTarget = await bindSession(value.database, {
        agentId: agent.id,
        bindingId: active.bindingId,
        computerId: second.workspaceComputerId,
        channelId: "C-target",
      });
      const ended = await bindSession(value.database, {
        agentId: agent.id,
        bindingId: active.bindingId,
        computerId: first.workspaceComputerId,
        channelId: "C-ended",
        ended: true,
      });

      const rebound = await value.agents.rebindById(value.bootstrap.userId, agent.id, second.workspaceComputerId);
      expect(rebound).toMatchObject({
        computerId: second.workspaceComputerId,
        revision: 2,
      });
      const [agentRow] = await value.database.select().from(agents).where(eq(agents.id, agent.id));
      expect(agentRow).toMatchObject({
        computerId: second.workspaceComputerId,
        workspaceId: value.bootstrap.workspaceId,
        workspaceComputerId: second.workspaceComputerId,
      });
      const [moved] = await value.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, active.session.id));
      expect(moved).toMatchObject({
        computerId: second.workspaceComputerId,
        generation: 2,
      });
      const [unchanged] = await value.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, alreadyOnTarget.session.id));
      expect(unchanged).toMatchObject({
        computerId: second.workspaceComputerId,
        generation: 1,
      });
      const [historical] = await value.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, ended.session.id));
      expect(historical).toMatchObject({
        computerId: first.workspaceComputerId,
        generation: 1,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("blocks rebind without partial writes when custody is pending, unreported, uncertain, or stale", async () => {
    const value = await fixture();
    try {
      const first = await enroll(value);
      const second = await enroll(value);
      const cases = [
        { name: "pending", channelId: "C-pending", setup: pendingDelivery },
        {
          name: "unreported",
          channelId: "C-unreported",
          setup: async (database: DatabaseClient, input: Parameters<typeof pendingDelivery>[1]) => {
            const delivery = await pendingDelivery(database, input);
            await database
              .update(imMessageDeliveries)
              .set({
                state: "accepted",
                inputHash: "b".repeat(64),
                turnId: `turn-${delivery.id}`,
                reportOwnerInstanceId: crypto.randomUUID(),
                acceptedAt: new Date(),
              })
              .where(eq(imMessageDeliveries.id, delivery.id));
          },
        },
        {
          name: "uncertain",
          channelId: "C-uncertain",
          setup: (database: DatabaseClient, input: Parameters<typeof pendingDelivery>[1]) =>
            pendingDelivery(database, { ...input, dispatch: true, state: "expired" }),
        },
        {
          name: "stale",
          channelId: "C-stale",
          setup: (database: DatabaseClient, input: Parameters<typeof pendingDelivery>[1]) =>
            pendingDelivery(database, { ...input, generation: 9 }),
        },
      ] as const;

      for (const testCase of cases) {
        const agent = await createAgent(value, first.workspaceComputerId, `agent-${testCase.name}`);
        const bound = await bindSession(value.database, {
          agentId: agent.id,
          computerId: first.workspaceComputerId,
          channelId: testCase.channelId,
        });
        await testCase.setup(value.database, {
          bindingId: bound.bindingId,
          sessionId: bound.session.id,
          agentId: agent.id,
          channelId: testCase.channelId,
        });
        const beforeAgent = await value.database.select().from(agents).where(eq(agents.id, agent.id));
        const beforePlacement = await value.database
          .select()
          .from(sessionPlacements)
          .where(eq(sessionPlacements.sessionId, bound.session.id));
        await expect(
          value.agents.rebindById(value.bootstrap.userId, agent.id, second.workspaceComputerId),
        ).rejects.toMatchObject({ code: "AGENT_REBIND_BLOCKED", statusCode: 409 });
        expect(await value.database.select().from(agents).where(eq(agents.id, agent.id))).toEqual(beforeAgent);
        expect(
          await value.database
            .select()
            .from(sessionPlacements)
            .where(eq(sessionPlacements.sessionId, bound.session.id)),
        ).toEqual(beforePlacement);
      }
    } finally {
      await value.sql.end();
    }
  });

  it("keeps an exact-target retry idempotent even with pending custody", async () => {
    const value = await fixture();
    try {
      const computer = await enroll(value);
      const agent = await createAgent(value, computer.workspaceComputerId, "idempotent");
      const bound = await bindSession(value.database, {
        agentId: agent.id,
        computerId: computer.workspaceComputerId,
        channelId: "C-idempotent",
      });
      await pendingDelivery(value.database, {
        bindingId: bound.bindingId,
        sessionId: bound.session.id,
        agentId: agent.id,
        channelId: "C-idempotent",
      });

      await expect(
        value.agents.rebindById(value.bootstrap.userId, agent.id, computer.workspaceComputerId),
      ).resolves.toMatchObject({ computerId: computer.workspaceComputerId, revision: 1 });
      await expect(
        value.database.select().from(sessionPlacements).where(eq(sessionPlacements.sessionId, bound.session.id)),
      ).resolves.toEqual([expect.objectContaining({ computerId: computer.workspaceComputerId, generation: 1 })]);
    } finally {
      await value.sql.end();
    }
  });

  it("moves a placement past terminal history from an older generation", async () => {
    const value = await fixture();
    try {
      const first = await enroll(value);
      const second = await enroll(value);
      const agent = await createAgent(value, first.workspaceComputerId, "terminal-history");
      const bound = await bindSession(value.database, {
        agentId: agent.id,
        computerId: second.workspaceComputerId,
        channelId: "C-terminal-history",
      });
      const delivery = await pendingDelivery(value.database, {
        bindingId: bound.bindingId,
        sessionId: bound.session.id,
        agentId: agent.id,
        channelId: "C-terminal-history",
      });
      await value.database
        .update(imMessageDeliveries)
        .set({ state: "terminal_rejected", reason: "runtime_rejected" })
        .where(eq(imMessageDeliveries.id, delivery.id));
      await value.database
        .update(sessionPlacements)
        .set({ generation: 2 })
        .where(eq(sessionPlacements.sessionId, bound.session.id));

      await expect(
        value.agents.rebindById(value.bootstrap.userId, agent.id, first.workspaceComputerId),
      ).resolves.toMatchObject({ computerId: first.workspaceComputerId, revision: 1 });
      await expect(
        value.database.select().from(sessionPlacements).where(eq(sessionPlacements.sessionId, bound.session.id)),
      ).resolves.toEqual([expect.objectContaining({ computerId: first.workspaceComputerId, generation: 3 })]);
    } finally {
      await value.sql.end();
    }
  });

  it("rejects a rebind target the Agent creator does not own and keeps a mismatched Agent visible", async () => {
    const value = await fixture();
    try {
      const owned = await enroll(value);
      const agent = await createAgent(value, owned.workspaceComputerId, "mismatch");
      const [other] = await value.database
        .insert(users)
        .values({ displayName: "Other", email: "other-rebind@example.com" })
        .returning();
      if (!other) throw new Error("Other Account fixture was not created");
      const [installation] = await value.database.insert(computers).values({ id: crypto.randomUUID() }).returning();
      if (!installation) throw new Error("Installation fixture was not created");
      const [foreignEnrollment] = await value.database
        .insert(workspaceComputers)
        .values({
          workspaceId: value.bootstrap.workspaceId,
          computerId: installation.id,
          displayName: "foreign",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.2",
          enrolledByUserId: other.id,
        })
        .returning();
      if (!foreignEnrollment) throw new Error("Foreign Computer fixture was not created");
      await value.database.insert(accountComputers).values({
        id: foreignEnrollment.id,
        ownerAccountId: other.id,
        currentInstallationId: installation.id,
        displayName: "foreign",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.2",
      });
      await expect(
        value.agents.rebindById(value.bootstrap.userId, agent.id, foreignEnrollment.id),
      ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND", statusCode: 404 });

      await value.database
        .update(accountComputers)
        .set({ ownerAccountId: other.id })
        .where(eq(accountComputers.id, owned.workspaceComputerId));
      const listed = await value.agents.listForAccount(value.bootstrap.userId);
      expect(listed.agents).toEqual([expect.objectContaining({ id: agent.id, requiresComputerRebind: true })]);
    } finally {
      await value.sql.end();
    }
  });
});
