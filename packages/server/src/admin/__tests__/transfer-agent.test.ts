import { type AgentRuntimeProvider, FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../__tests__/support/unit-database.js";
import {
  agentMcpServers,
  agentSchedules,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  mcpServerAuthorizations,
  mcpServers,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { disableImBindingInTransaction, ImBindingService } from "../../services/im-bindings/index.js";
import { transferAgent } from "../transfer-agent.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const REPORT_OWNER = "11111111-1111-4111-8111-111111111111";

let unitDatabase: UnitDatabase;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unitDatabase?.close();
});

beforeEach(async () => {
  await unitDatabase.reset();
});

function service(): AgentService {
  return new AgentService(unitDatabase.database, { now: () => NOW });
}

function transfer(
  input: { agentId: string; slack?: string; targetAccountId: string },
  options: { logger?: ServiceLogger } = {},
) {
  return transferAgent(unitDatabase.database, input, { now: () => NOW, ...options });
}

async function createAccount(label: string): Promise<string> {
  const [user] = await unitDatabase.database
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID()}@example.test`, displayName: label })
    .returning({ id: users.id });
  if (!user) throw new Error("Account fixture was not created");
  return user.id;
}

async function createComputer(ownerUserId: string, kind: "local" | "cloud" = "local") {
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: ownerUserId,
      kind,
      currentInstallationId: crypto.randomUUID(),
      displayName: `computer-${crypto.randomUUID().slice(0, 8)}`,
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  return computer;
}

async function createAgent(
  ownerUserId: string,
  computerId: string | null,
  name = "code-reviewer",
  runtimeProvider: AgentRuntimeProvider = "codex",
) {
  return service().createForAccount(ownerUserId, {
    ...(computerId ? { computerId } : {}),
    displayName: name,
    name,
    runtimeProvider,
  });
}

/** A suspended Agent with a Computer, which is the only state a transfer admits. */
async function suspendedAgent(ownerUserId: string, computerId: string | null, name = "code-reviewer") {
  const created = await createAgent(ownerUserId, computerId, name);
  await service().suspendById(ownerUserId, created.id);
  return created;
}

async function createFeishuBinding(agentId: string) {
  const [binding] = await unitDatabase.database
    .insert(imBindings)
    .values({
      agentId,
      provider: "feishu",
      status: "active",
      externalAppId: `cli-${crypto.randomUUID().slice(0, 8)}`,
      externalBotId: "feishu-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "sealed-feishu-credential",
      grantedCapabilities: [...FEISHU_REQUIRED_TENANT_SCOPES],
      activatedAt: NOW,
    })
    .returning();
  if (!binding) throw new Error("Feishu binding fixture was not created");
  return binding;
}

async function createSession(bindingId: string, computerId: string) {
  const [session] = await unitDatabase.database
    .insert(sessions)
    .values({
      imBindingId: bindingId,
      channelId: `channel-${crypto.randomUUID()}`,
      conversationKind: "channel",
      kind: "channel",
      threadKey: null,
    })
    .returning();
  if (!session) throw new Error("Session fixture was not created");
  await unitDatabase.database.insert(sessionPlacements).values({ sessionId: session.id, computerId, generation: 1 });
  return session;
}

/**
 * `pending`: never sent. `accepted`: a Turn the Computer owns and has not reported. `expired`: a
 * send with a dispatch request nobody proved. Only `pending` is cleared by ending the Session.
 */
async function createDelivery(bindingId: string, sessionId: string, state: "pending" | "accepted" | "expired") {
  const [message] = await unitDatabase.database
    .insert(imMessages)
    .values({
      imBindingId: bindingId,
      channelId: "channel-fixture",
      externalMessageId: `message-${crypto.randomUUID()}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "human-fixture",
      content: { version: 1, fallbackText: "Pending", blocks: [{ type: "text", text: "Pending" }], truncated: false },
      providerContext: { provider: "feishu", chatType: "group" },
      occurredAt: NOW,
    })
    .returning();
  if (!message) throw new Error("Message fixture was not created");
  const dispatched = state === "expired";
  await unitDatabase.database.insert(imMessageDeliveries).values({
    messageId: message.id,
    sessionId,
    attention: "direct",
    state,
    placementGeneration: 1,
    dispatchRequestId: dispatched ? crypto.randomUUID() : null,
    dispatchInputHash: dispatched ? crypto.randomUUID() : null,
    // Only a send that actually left needs a payload; the constraint permits it for any dispatched row.
    dispatchPayload: dispatched ? ({ invalid: true } as never) : null,
    inputHash: state === "accepted" ? crypto.randomUUID() : null,
    turnId: state === "accepted" ? `turn-${crypto.randomUUID()}` : null,
    reportOwnerInstanceId: state === "accepted" ? REPORT_OWNER : null,
    acceptedAt: state === "accepted" ? NOW : null,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
}

async function createAcceptedDelivery(bindingId: string, sessionId: string) {
  const [message] = await unitDatabase.database
    .insert(imMessages)
    .values({
      imBindingId: bindingId,
      channelId: "channel-fixture",
      externalMessageId: `message-${crypto.randomUUID()}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "human-fixture",
      content: { version: 1, fallbackText: "Accepted", blocks: [{ type: "text", text: "Accepted" }], truncated: false },
      providerContext: { provider: "feishu", chatType: "group" },
      occurredAt: NOW,
    })
    .returning();
  if (!message) throw new Error("Message fixture was not created");
  await unitDatabase.database.insert(imMessageDeliveries).values({
    messageId: message.id,
    sessionId,
    attention: "direct",
    state: "accepted",
    placementGeneration: 1,
    inputHash: crypto.randomUUID(),
    turnId: `turn-${crypto.randomUUID()}`,
    reportOwnerInstanceId: crypto.randomUUID(),
    acceptedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
}

async function createMcpMount(accountId: string, agentId: string) {
  const [server] = await unitDatabase.database
    .insert(mcpServers)
    .values({ accountId, name: `server-${crypto.randomUUID().slice(0, 8)}`, url: "https://mcp.example.test/sse" })
    .returning();
  if (!server) throw new Error("MCP server fixture was not created");
  await unitDatabase.database.insert(agentMcpServers).values({ agentId, mcpServerId: server.id });
  await unitDatabase.database.insert(mcpServerAuthorizations).values({
    agentId,
    mcpServerId: server.id,
    kind: "bearer",
    status: "active",
    ciphertext: "sealed-mcp-credential",
    keyId: "test-key",
  });
  return server;
}

async function createSchedule(agentId: string, targetSessionId: string) {
  const [schedule] = await unitDatabase.database
    .insert(agentSchedules)
    .values({
      agentId,
      targetSessionId,
      name: "daily-digest",
      prompt: "Summarize the day",
      schedule: { kind: "cron", expression: "0 9 * * *" },
      timezone: "UTC",
      nextTriggerAt: NOW,
    })
    .returning();
  if (!schedule) throw new Error("Schedule fixture was not created");
  return schedule;
}

/** The Scheduler's own candidate predicate: enabled, with a claimable occurrence in the past. */
async function agentRow(agentId: string) {
  const [row] = await unitDatabase.database.select().from(agents).where(eq(agents.id, agentId));
  if (!row) throw new Error("Agent row disappeared");
  return row;
}

describe("transferAgent", () => {
  it("rejects an Agent that does not exist", async () => {
    const targetAccountId = await createAccount("target");

    await expect(
      transferAgent(unitDatabase.database, { agentId: crypto.randomUUID(), targetAccountId }),
    ).rejects.toMatchObject({ reason: "agent_not_found" });
  });

  it("rejects a deleted Agent as if it did not exist", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
    await service().deleteById(source, created.id);

    await expect(transferAgent(unitDatabase.database, { agentId: created.id, targetAccountId })).rejects.toMatchObject({
      reason: "agent_not_found",
    });
  });

  it("rejects an Agent that is not suspended", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await createAgent(source, computer.id);

    await expect(transferAgent(unitDatabase.database, { agentId: created.id, targetAccountId })).rejects.toMatchObject({
      reason: "agent_not_suspended",
    });
    expect(await agentRow(created.id)).toMatchObject({ createdByUserId: source, computerId: computer.id });
  });

  it("rejects a target Account that does not exist", async () => {
    const source = await createAccount("source");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);

    await expect(
      transferAgent(unitDatabase.database, { agentId: created.id, targetAccountId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ reason: "target_account_not_found" });
  });

  it("rejects the Account that already owns the Agent", async () => {
    const source = await createAccount("source");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);

    await expect(
      transferAgent(unitDatabase.database, { agentId: created.id, targetAccountId: source }),
    ).rejects.toMatchObject({ reason: "same_account" });
  });

  it("rejects a name the target Account already uses, and ignores a deleted namesake", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const sourceComputer = await createComputer(source);
    const targetComputer = await createComputer(targetAccountId);
    const created = await suspendedAgent(source, sourceComputer.id, "release-bot");
    // Inserted directly: the creation schema only admits lowercase names, and the case-insensitive
    // uniqueness this test is about lives in the index, not in the schema.
    const [namesake] = await unitDatabase.database
      .insert(agents)
      .values({
        createdByUserId: targetAccountId,
        computerId: targetComputer.id,
        name: "Release-Bot",
        displayName: "Release-Bot",
        runtimeProvider: "codex",
      })
      .returning();
    if (!namesake) throw new Error("Namesake fixture was not created");

    await expect(transfer({ agentId: created.id, targetAccountId })).rejects.toMatchObject({ reason: "name_conflict" });

    await unitDatabase.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, namesake.id));
    await expect(transfer({ agentId: created.id, targetAccountId })).rejects.toMatchObject({
      reason: "configuration_immutable",
    });
  });

  it("rejects a transfer while a Session has an uncertain delivery", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
    const binding = await createFeishuBinding(created.id);
    const session = await createSession(binding.id, computer.id);
    await createDelivery(binding.id, session.id, "pending");

    await expect(transfer({ agentId: created.id, targetAccountId })).rejects.toMatchObject({
      reason: "sessions_blocked",
    });
    expect(await agentRow(created.id)).toMatchObject({ createdByUserId: source, computerId: computer.id });
  });

  it("still rejects an accepted unreported Turn after messaging is unbound", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await createAgent(source, computer.id);
    const binding = await createFeishuBinding(created.id);
    const session = await createSession(binding.id, computer.id);
    await createAcceptedDelivery(binding.id, session.id);
    await service().suspendById(source, created.id);

    await expect(transfer({ agentId: created.id, targetAccountId })).rejects.toMatchObject({
      reason: "sessions_blocked",
    });

    const imBindingService = new ImBindingService(unitDatabase.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
      now: () => NOW,
    });
    await service().reactivateById(source, created.id);
    await imBindingService.unbindForAgent(source, created.id, { provider: "feishu", bindingId: binding.id });
    await service().suspendById(source, created.id);

    const [endedSession] = await unitDatabase.database.select().from(sessions).where(eq(sessions.id, session.id));
    expect(endedSession?.endedAt).toEqual(NOW);
    await expect(transfer({ agentId: created.id, targetAccountId })).rejects.toMatchObject({
      reason: "sessions_blocked",
    });
    expect(await agentRow(created.id)).toMatchObject({ createdByUserId: source, computerId: computer.id });
  });
  for (const custody of ["accepted", "expired"] as const) {
    it(`still refuses the transfer after an unbind leaves an unsettled ${custody} Turn behind`, async () => {
      const source = await createAccount("source");
      const targetAccountId = await createAccount("target");
      const computer = await createComputer(source);
      const created = await suspendedAgent(source, computer.id);
      const binding = await createFeishuBinding(created.id);
      const session = await createSession(binding.id, computer.id);
      await createDelivery(binding.id, session.id, custody);
      const mcpServer = await createMcpMount(source, created.id);
      const schedule = await createSchedule(created.id, session.id);
      const revisionBefore = (await agentRow(created.id)).revision;

      await expect(transfer({ agentId: created.id, targetAccountId })).rejects.toMatchObject({
        reason: "sessions_blocked",
      });

      // The real unbind path ends the binding's Sessions; the unreported Turn's custody does not end with them.
      await unitDatabase.database.transaction((transaction) =>
        disableImBindingInTransaction(transaction, binding.id, NOW),
      );
      const [unbound] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, binding.id));
      expect(unbound).toMatchObject({ status: "disabled" });
      const [endedSession] = await unitDatabase.database.select().from(sessions).where(eq(sessions.id, session.id));
      expect(endedSession?.endedAt).toEqual(NOW);

      await expect(transfer({ agentId: created.id, targetAccountId })).rejects.toMatchObject({
        reason: "sessions_blocked",
      });

      expect(await agentRow(created.id)).toMatchObject({
        createdByUserId: source,
        computerId: computer.id,
        revision: revisionBefore,
      });
      expect(await unitDatabase.database.select().from(agentMcpServers)).toHaveLength(1);
      expect(await unitDatabase.database.select().from(mcpServerAuthorizations)).toHaveLength(1);
      const [keptSchedule] = await unitDatabase.database
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.id, schedule.id));
      expect(keptSchedule).toMatchObject({ enabled: true, nextTriggerAt: NOW });
      expect(mcpServer.id).toBeTruthy();
    });
  }

  it("refuses to transfer configured Agents without changing their identities or retained data", async () => {
    const source = await createAccount("source"),
      targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
    const binding = await createFeishuBinding(created.id);
    const session = await createSession(binding.id, computer.id);
    const before = await agentRow(created.id);
    const placements = await unitDatabase.database.select().from(sessionPlacements);
    await expect(transfer({ agentId: created.id, targetAccountId })).rejects.toMatchObject({
      reason: "configuration_immutable",
    });
    expect(await agentRow(created.id)).toEqual(before);
    expect(await unitDatabase.database.select().from(sessionPlacements)).toEqual(placements);
    expect((await unitDatabase.database.select().from(imBindings))[0]).toMatchObject({
      id: binding.id,
      status: "active",
    });
    expect(session.id).toBeTruthy();
  });

  it("allows an edited, unbound Agent to transfer and finish its initial Computer binding", async () => {
    const source = await createAccount("source"),
      targetAccountId = await createAccount("target");
    const created = await createAgent(source, null);
    await service().updateById(source, created.id, { expectedRevision: created.revision, displayName: "Edited" });
    await service().suspendById(source, created.id);
    await expect(transfer({ agentId: created.id, targetAccountId })).resolves.toMatchObject({
      previousComputerId: null,
      imBinding: "none",
      targetAccountId,
    });
    await service().reactivateById(targetAccountId, created.id);
    const target = await createComputer(targetAccountId);
    await expect(service().rebindById(targetAccountId, created.id, target.id)).resolves.toMatchObject({
      computerId: target.id,
      displayName: "Edited",
    });
  });

  it("validates the operator input strictly", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);

    await expect(
      transferAgent(unitDatabase.database, { agentId: created.id, targetAccountId, unexpected: true } as never),
    ).rejects.toThrow();
    await expect(transferAgent(unitDatabase.database, { agentId: "not-a-uuid", targetAccountId })).rejects.toThrow();
    await expect(
      transferAgent(unitDatabase.database, { agentId: created.id, targetAccountId, slack: "retain" as never }),
    ).rejects.toThrow();
    // Every rejected input leaves the Agent where it was.
    expect(await agentRow(created.id)).toMatchObject({ createdByUserId: source, computerId: computer.id });
  });
});

describe("transferAgent audit log", () => {
  it("logs a redacted success at info and a rejection at warn", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const created = await suspendedAgent(source, null);
    const entries: { level: string; bindings: Record<string, unknown>; message: string }[] = [];
    const logger = {
      debug: () => undefined,
      info: (bindings: Record<string, unknown>, message: string) => entries.push({ level: "info", bindings, message }),
      warn: (bindings: Record<string, unknown>, message: string) => entries.push({ level: "warn", bindings, message }),
      error: () => undefined,
    };

    await transferAgent(unitDatabase.database, { agentId: created.id, targetAccountId }, { logger });
    expect(entries.at(-1)).toMatchObject({
      level: "info",
      bindings: { agentId: created.id, sourceAccountId: source, targetAccountId, slack: "disable", schedulesPaused: 0 },
    });

    await expect(
      transferAgent(unitDatabase.database, { agentId: created.id, targetAccountId }, { logger }),
    ).rejects.toMatchObject({ reason: "same_account" });
    expect(entries.at(-1)).toMatchObject({ level: "warn", bindings: { reason: "same_account" } });
  });
});
