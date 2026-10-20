import { type AgentPermissions, type AgentRuntimeProvider, FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../__tests__/support/unit-database.js";
import {
  agentMcpServers,
  agentRuntimeConfigs,
  agentSchedules,
  agentSkills,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  mcpServerAuthorizations,
  mcpServers,
  sessionPlacements,
  sessions,
  slackInstallations,
  slackOAuthNonces,
  users,
} from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { disableImBindingInTransaction, ImBindingService } from "../../services/im-bindings/index.js";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "../../services/runtime-config/index.js";
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
async function suspendedAgent(ownerUserId: string, computerId: string, name = "code-reviewer") {
  const created = await createAgent(ownerUserId, computerId, name);
  await service().suspendById(ownerUserId, created.id);
  return created;
}

async function createSlackBinding(agentId: string) {
  const externalAppId = `A${crypto.randomUUID().slice(0, 8)}`;
  const externalTeamId = `T${crypto.randomUUID().slice(0, 8)}`;
  const [installation] = await unitDatabase.database
    .insert(slackInstallations)
    .values({
      agentId,
      status: "active",
      externalAppId,
      externalTeamId,
      externalBotId: "B1",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "sealed-installation-credential",
      activatedAt: NOW,
    })
    .returning();
  if (!installation) throw new Error("Slack installation fixture was not created");
  const [binding] = await unitDatabase.database
    .insert(imBindings)
    .values({
      agentId,
      provider: "slack",
      status: "active",
      externalAppId,
      externalTeamId,
      externalBotId: "B1",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      slackInstallationId: installation.id,
      slackRouteKind: "default",
      activatedAt: NOW,
    })
    .returning();
  if (!binding) throw new Error("Slack binding fixture was not created");
  return { binding, installation };
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

async function createSkill(agentId: string) {
  const [skill] = await unitDatabase.database
    .insert(agentSkills)
    .values({
      agentId,
      name: "release-notes",
      description: "Writes release notes",
      source: "web_upload",
      objectKey: `agents/${agentId}/skills/release-notes.tar.gz`,
      archiveSha256: "a".repeat(64),
      archiveBytes: 128,
      fileCount: 1,
      files: [{ path: "SKILL.md", bytes: 42 }],
    })
    .returning();
  if (!skill) throw new Error("Skill fixture was not created");
  return skill;
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
function dueScheduleIds() {
  return unitDatabase.database
    .select({ id: agentSchedules.id })
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.enabled, true),
        isNotNull(agentSchedules.nextTriggerAt),
        lte(agentSchedules.nextTriggerAt, sql`clock_timestamp()`),
      ),
    );
}

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
    await expect(transfer({ agentId: created.id, targetAccountId })).resolves.toMatchObject({
      agentId: created.id,
      targetAccountId,
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

  it("moves ownership, detaches the Computer, and keeps Account-independent data", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
    const binding = await createFeishuBinding(created.id);
    const session = await createSession(binding.id, computer.id);
    const skill = await createSkill(created.id);
    const schedule = await createSchedule(created.id, session.id);
    const mcpServer = await createMcpMount(source, created.id);
    const [runtimeConfigBefore] = await unitDatabase.database
      .select()
      .from(agentRuntimeConfigs)
      .where(eq(agentRuntimeConfigs.agentId, created.id));

    const result = await transfer({ agentId: created.id, targetAccountId, slack: "disable" });

    expect(result).toMatchObject({
      agentId: created.id,
      imBinding: "disabled",
      previousComputerId: computer.id,
      revision: created.revision + 2,
      runtimeConfigReset: [],
      schedulesPaused: 1,
      slack: "disable",
      sourceAccountId: source,
      targetAccountId,
    });
    expect(await agentRow(created.id)).toMatchObject({
      createdByUserId: targetAccountId,
      computerId: null,
      revision: created.revision + 2,
      status: "suspended",
    });

    const [runtimeConfigAfter] = await unitDatabase.database
      .select()
      .from(agentRuntimeConfigs)
      .where(eq(agentRuntimeConfigs.agentId, created.id));
    expect(runtimeConfigAfter).toEqual(runtimeConfigBefore);
    const [skillRow] = await unitDatabase.database.select().from(agentSkills).where(eq(agentSkills.id, skill.id));
    expect(skillRow).toEqual(skill);
    const [scheduleRow] = await unitDatabase.database
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.id, schedule.id));
    // Kept as a record, paused because its pinned target Session ended with the transfer.
    expect(scheduleRow).toMatchObject({
      id: schedule.id,
      prompt: schedule.prompt,
      schedule: schedule.schedule,
      enabled: false,
      nextTriggerAt: null,
    });
    expect(scheduleRow?.revision).toBe(schedule.revision + 1);

    expect(await unitDatabase.database.select().from(agentMcpServers)).toEqual([]);
    expect(await unitDatabase.database.select().from(mcpServerAuthorizations)).toEqual([]);
    // The definition stays with the source Account; only the new owner's mounts are gone.
    expect(await unitDatabase.database.select().from(mcpServers).where(eq(mcpServers.id, mcpServer.id))).toHaveLength(
      1,
    );
  });

  it("disables the messaging binding by default and ends its Sessions", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
    const { binding, installation } = await createSlackBinding(created.id);
    const session = await createSession(binding.id, computer.id);
    await unitDatabase.database.insert(slackOAuthNonces).values({
      nonceHash: "b".repeat(64),
      userId: source,
      agentId: created.id,
      intent: "create",
      sessionBindingHash: "c".repeat(64),
      expiresAt: new Date(NOW.getTime() + 600_000),
      createdAt: NOW,
    });

    const result = await transfer({ agentId: created.id, targetAccountId });

    expect(result.imBinding).toBe("disabled");
    const [disabled] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, binding.id));
    expect(disabled).toMatchObject({ status: "disabled", encryptedCredential: null });
    const [releasedInstallation] = await unitDatabase.database
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.id, installation.id));
    expect(releasedInstallation).toMatchObject({ status: "disabled", encryptedCredential: null });
    const [endedSession] = await unitDatabase.database.select().from(sessions).where(eq(sessions.id, session.id));
    expect(endedSession?.endedAt).toEqual(NOW);
    expect(await unitDatabase.database.select().from(slackOAuthNonces)).toEqual([]);
  });

  it("keeps a Slack binding serving the Agent under the new owner", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
    const { binding, installation } = await createSlackBinding(created.id);
    const session = await createSession(binding.id, computer.id);

    const result = await transfer({ agentId: created.id, targetAccountId, slack: "keep" });

    expect(result.imBinding).toBe("kept");
    const [kept] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, binding.id));
    expect(kept).toMatchObject({
      status: "active",
      credentialGeneration: binding.credentialGeneration,
      slackInstallationId: installation.id,
    });
    const [keptInstallation] = await unitDatabase.database
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.id, installation.id));
    expect(keptInstallation).toMatchObject({ status: "active", credentialGeneration: 1 });
    // The previous owner's Session history is closed even though the installation stays live.
    const [endedSession] = await unitDatabase.database.select().from(sessions).where(eq(sessions.id, session.id));
    expect(endedSession?.endedAt).toEqual(NOW);
    await expect(service().getConfigById(targetAccountId, created.id)).resolves.toMatchObject({
      createdByUserId: targetAccountId,
      computerId: null,
    });
  });

  for (const slack of ["disable", "keep"] as const) {
    it(`pauses Schedules that can no longer dispatch (slack=${slack})`, async () => {
      const source = await createAccount("source");
      const targetAccountId = await createAccount("target");
      const computer = await createComputer(source);
      const created = await suspendedAgent(source, computer.id);
      const { binding } = await createSlackBinding(created.id);
      const session = await createSession(binding.id, computer.id);
      const schedule = await createSchedule(created.id, session.id);
      expect(await dueScheduleIds()).toEqual([{ id: schedule.id }]);

      const result = await transfer({ agentId: created.id, targetAccountId, slack });

      expect(result.schedulesPaused).toBe(1);
      expect(await dueScheduleIds()).toEqual([]);
      const [paused] = await unitDatabase.database
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.id, schedule.id));
      expect(paused).toMatchObject({ enabled: false, nextTriggerAt: null });
      // The target the Schedule pinned is gone, which is why the row had to be paused rather than kept live.
      const [endedTarget] = await unitDatabase.database.select().from(sessions).where(eq(sessions.id, session.id));
      expect(endedTarget?.endedAt).toEqual(NOW);
    });
  }

  it("refuses to keep a Feishu binding", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
    await createFeishuBinding(created.id);

    await expect(transfer({ agentId: created.id, targetAccountId, slack: "keep" })).rejects.toMatchObject({
      reason: "im_binding_keep_unsupported",
    });
    expect(await agentRow(created.id)).toMatchObject({ createdByUserId: source });
  });

  it("resets the Context Tree selection and a Cloud Computer model", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const cloudComputer = await createComputer(source, "cloud");
    const [created] = await unitDatabase.database
      .insert(agents)
      .values({
        createdByUserId: source,
        computerId: cloudComputer.id,
        name: "cloud-agent",
        displayName: "Cloud agent",
        runtimeProvider: "pi",
        status: "suspended",
      })
      .returning();
    if (!created) throw new Error("Agent fixture was not created");
    await unitDatabase.database.insert(agentRuntimeConfigs).values({
      ...DEFAULT_AGENT_RUNTIME_CONFIG,
      agentId: created.id,
      contextTrees: [{ alias: "product", repository: "example/product" }],
      model: "router-only-model",
      permissions: { approvalPolicy: "on-request", allowCommands: [] } satisfies AgentPermissions,
    });

    const result = await transfer({ agentId: created.id, targetAccountId });

    expect(result.runtimeConfigReset).toEqual(["contextTrees", "model"]);
    const [runtimeConfig] = await unitDatabase.database
      .select()
      .from(agentRuntimeConfigs)
      .where(eq(agentRuntimeConfigs.agentId, created.id));
    expect(runtimeConfig).toMatchObject({ contextTrees: [], model: null });
  });

  it("keeps a Local Computer's model but still clears the Context Tree selection", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
    await unitDatabase.database
      .update(agentRuntimeConfigs)
      .set({ contextTrees: [{ alias: "product", repository: "example/product" }], model: "gpt-5" })
      .where(eq(agentRuntimeConfigs.agentId, created.id));

    const result = await transfer({ agentId: created.id, targetAccountId });

    expect(result.runtimeConfigReset).toEqual(["contextTrees"]);
    const [runtimeConfig] = await unitDatabase.database
      .select()
      .from(agentRuntimeConfigs)
      .where(eq(agentRuntimeConfigs.agentId, created.id));
    expect(runtimeConfig).toMatchObject({ contextTrees: [], model: "gpt-5" });
  });

  it("moves the Agent out of the previous owner's view without a rebind requirement", async () => {
    const source = await createAccount("source");
    const targetAccountId = await createAccount("target");
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
    const oldService = service();
    await expect(oldService.getById(source, created.id)).resolves.toMatchObject({ id: created.id });

    await transfer({ agentId: created.id, targetAccountId });

    await expect(oldService.getById(source, created.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const moved = await oldService.getById(targetAccountId, created.id);
    expect(moved).toMatchObject({ id: created.id, createdBy: { userId: targetAccountId }, computer: null });
    expect(moved).not.toHaveProperty("requiresComputerRebind");
    expect((await oldService.listForAccount(targetAccountId)).agents.map((agent) => agent.id)).toEqual([created.id]);
    expect((await oldService.listForAccount(source)).agents).toEqual([]);
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
    const computer = await createComputer(source);
    const created = await suspendedAgent(source, computer.id);
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
