import { FEISHU_REQUIRED_TENANT_SCOPES, type TurnReportRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../../__tests__/support/unit-database.js";
import { bootstrapTestAccount } from "../../../__tests__/test-account.js";
import {
  accountComputers,
  computerCredentials,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  workspaceComputers,
} from "../../../db/schema/index.js";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "../../runtime-config/index.js";
import { AgentService } from "../index.js";

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

async function createComputer(ownerUserId: string, workspaceId: string, label = "workstation") {
  const installationId = crypto.randomUUID();
  const [computer] = await unitDatabase.database.insert(computers).values({ id: installationId }).returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const [enrollment] = await unitDatabase.database
    .insert(workspaceComputers)
    .values({
      workspaceId,
      computerId: installationId,
      displayName: label,
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
      enrolledByUserId: ownerUserId,
    })
    .returning();
  if (!enrollment) throw new Error("Workspace Computer fixture was not created");
  await unitDatabase.database.insert(accountComputers).values({
    id: enrollment.id,
    ownerAccountId: ownerUserId,
    currentInstallationId: installationId,
    displayName: label,
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  await unitDatabase.database.insert(computerCredentials).values({
    computerId: enrollment.id,
    secretHash: `agent-service-${installationId}`,
    issuedByUserId: ownerUserId,
  });
  return { id: enrollment.id, installationId };
}

async function fixture() {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Admin",
    email: "admin@example.com",
    workspaceDisplayName: "Example",
    workspaceName: "example",
  });
  const computer = await createComputer(bootstrap.userId, bootstrap.workspaceId);
  const service = new AgentService(unitDatabase.database, { now: () => NOW });
  return { bootstrap, computer, service };
}

async function createAgent(
  service: AgentService,
  userId: string,
  computerId: string,
  name = "code-reviewer",
  runtimeProvider: "codex" | "claude-code" = "codex",
) {
  return service.createForAccount(userId, { computerId, displayName: name, name, runtimeProvider });
}

async function createBinding(agentId: string, provider: "feishu" | "slack" = "feishu", completeScopes = true) {
  const now = NOW;
  const [binding] = await unitDatabase.database
    .insert(imBindings)
    .values({
      agentId,
      provider,
      status: "active",
      externalAppId: `${provider}-app-${crypto.randomUUID()}`,
      externalBotId: `${provider}-bot`,
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "encrypted-fixture",
      grantedCapabilities: completeScopes
        ? [...FEISHU_REQUIRED_TENANT_SCOPES]
        : [FEISHU_REQUIRED_TENANT_SCOPES[0] ?? "im:message:send_as_bot"],
      activatedAt: now,
    })
    .returning();
  if (!binding) throw new Error("IM binding fixture was not created");
  return binding;
}

async function createSession(
  bindingId: string,
  computerId?: string,
  options: { kind?: "channel" | "thread" | "internal"; createdBySessionId?: string; createdAt?: Date } = {},
) {
  const kind = options.kind ?? "channel";
  const [session] = await unitDatabase.database
    .insert(sessions)
    .values({
      imBindingId: bindingId,
      channelId: `channel-${crypto.randomUUID()}`,
      conversationKind: "channel",
      kind,
      threadKey: kind === "thread" ? "thread-1" : null,
      createdBySessionId: options.createdBySessionId,
      runtimeModel: kind === "internal" ? "internal-model" : null,
      runtimeReasoningEffort: kind === "internal" ? "medium" : null,
      runtimeMaxDurationMs: kind === "internal" ? 5_000 : null,
      createdAt: options.createdAt ?? NOW,
    })
    .returning();
  if (!session) throw new Error("Session fixture was not created");
  if (computerId) {
    await unitDatabase.database.insert(sessionPlacements).values({
      sessionId: session.id,
      workspaceComputerId: computerId,
      computerId,
      generation: 1,
    });
  }
  return session;
}

async function createMessage(bindingId: string, text = "Review this change", occurredAt = NOW) {
  const [message] = await unitDatabase.database
    .insert(imMessages)
    .values({
      imBindingId: bindingId,
      providerEventId: `event-${crypto.randomUUID()}`,
      channelId: "channel-fixture",
      externalMessageId: `message-${crypto.randomUUID()}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "human-fixture",
      authorDisplayName: "Fixture User",
      content: { version: 1, fallbackText: text, blocks: [{ type: "text", text }], truncated: false },
      providerContext: { provider: "feishu", chatType: "group" },
      occurredAt,
    })
    .returning();
  if (!message) throw new Error("Message fixture was not created");
  return message;
}

function report(overrides: Partial<TurnReportRequest> = {}): TurnReportRequest {
  return {
    type: "turn:report",
    requestId: crypto.randomUUID(),
    deliveryId: crypto.randomUUID(),
    turnId: `turn-${crypto.randomUUID()}`,
    sessionId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    placementGeneration: 1,
    outcome: "completed",
    executionEffects: "completed",
    usage: { inputTokens: 10, outputTokens: 5 },
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
    resultHash: "a".repeat(64),
    ...overrides,
  } as TurnReportRequest;
}

async function createDelivery(
  bindingId: string,
  sessionId: string,
  options: {
    state?: "pending" | "accepted" | "steered" | "terminal_rejected" | "expired";
    acceptedAt?: Date | null;
    reportedAt?: Date | null;
    outcome?: "completed" | "failed" | "cancelled" | "unknown";
    usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
    inputHash?: string;
    turnReport?: TurnReportRequest | null;
  } = {},
) {
  const state = options.state ?? "accepted";
  const message = await createMessage(
    bindingId,
    state === "pending" ? "Pending" : "Turn input",
    options.acceptedAt ?? NOW,
  );
  const acceptedAt = state === "accepted" ? (options.acceptedAt ?? NOW) : null;
  const reportedAt = state === "accepted" ? (options.reportedAt ?? null) : null;
  const usage = options.usage ?? { inputTokens: 10, outputTokens: 5 };
  const turnReport = reportedAt
    ? (options.turnReport ?? report({ outcome: options.outcome ?? "completed", usage }))
    : null;
  const [delivery] = await unitDatabase.database
    .insert(imMessageDeliveries)
    .values({
      messageId: message.id,
      sessionId,
      attention: "direct",
      state,
      placementGeneration: 1,
      inputHash: state === "accepted" ? (options.inputHash ?? crypto.randomUUID()) : null,
      turnId: state === "accepted" ? `turn-${crypto.randomUUID()}` : null,
      reportOwnerInstanceId: state === "accepted" ? REPORT_OWNER : null,
      acceptedAt,
      expiresAt: new Date(NOW.getTime() + 60_000),
      reportedAt,
      turnReport,
      resultHash: reportedAt ? "a".repeat(64) : null,
      reason: state === "terminal_rejected" ? "rejected" : null,
      lastErrorCode: state === "terminal_rejected" ? "NO_ROUTE" : null,
    })
    .returning();
  if (!delivery) throw new Error("Delivery fixture was not created");
  return delivery;
}

describe("AgentService", () => {
  it("creates, projects, updates, and authorizes an Agent", async () => {
    const { bootstrap, computer, service } = await fixture();
    await expect(service.listForAccount(bootstrap.userId)).resolves.toEqual({ agents: [] });
    const created = await createAgent(service, bootstrap.userId, computer.id);
    expect(created).toMatchObject({
      id: expect.any(String),
      computerId: computer.id,
      receiveMode: "all_message",
      revision: 1,
      runtimeConfig: DEFAULT_AGENT_RUNTIME_CONFIG,
    });
    await expect(service.getById(bootstrap.userId, created.id)).resolves.toMatchObject({
      id: created.id,
      activity: { state: "idle" },
    });
    await expect(service.getConfigById(bootstrap.userId, created.id)).resolves.toEqual(created);
    await expect(service.listForAccount(bootstrap.userId)).resolves.toMatchObject({
      agents: [
        { id: created.id, usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 }, activity: { state: "idle" } },
      ],
    });
    await expect(service.getById("11111111-1111-4111-8111-111111111111", created.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(
      service.createForAccount(bootstrap.userId, {
        computerId: computer.id,
        displayName: "Bad",
        name: "Bad Name",
        runtimeProvider: "codex",
      }),
    ).rejects.toThrow();
    await expect(
      service.createForAccount(bootstrap.userId, {
        computerId: crypto.randomUUID(),
        displayName: "Missing",
        name: "missing",
        runtimeProvider: "codex",
      }),
    ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND", statusCode: 404 });
    await expect(createAgent(service, bootstrap.userId, computer.id)).rejects.toMatchObject({
      code: "AGENT_NAME_CONFLICT",
      statusCode: 409,
    });
  });

  it("replays creation intents and rejects conflicting reuse", async () => {
    const { bootstrap, computer, service } = await fixture();
    const input = {
      computerId: computer.id,
      displayName: "Intent Agent",
      name: "intent-agent",
      runtimeProvider: "codex" as const,
      creationIntentId: "11111111-1111-4111-8111-111111111111",
      runtimeConfig: { model: "gpt-5.6", instructions: "Intent instructions" },
    };
    const created = await service.createForAccount(bootstrap.userId, input);
    await expect(service.createForAccount(bootstrap.userId, input)).resolves.toEqual(created);
    await expect(
      service.createForAccount(bootstrap.userId, { ...input, displayName: "Changed" }),
    ).rejects.toMatchObject({ code: "AGENT_CREATION_INTENT_CONFLICT", statusCode: 409 });
    await service.suspendById(bootstrap.userId, created.id);
    await service.deleteById(bootstrap.userId, created.id);
    await expect(service.createForAccount(bootstrap.userId, input)).rejects.toMatchObject({
      code: "AGENT_CREATION_INTENT_CONFLICT",
      statusCode: 409,
    });
  });

  it("recovers deterministic uniqueness races and preserves intent conflicts", async () => {
    const { bootstrap, computer, service } = await fixture();
    const sameName = await Promise.allSettled([
      createAgent(service, bootstrap.userId, computer.id, "race-agent"),
      createAgent(service, bootstrap.userId, computer.id, "race-agent"),
    ]);
    expect(sameName.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(sameName.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "AGENT_NAME_CONFLICT" },
    });

    const intent = "22222222-2222-4222-8222-222222222222";
    const racedIntent = await Promise.allSettled([
      service.createForAccount(bootstrap.userId, {
        computerId: computer.id,
        displayName: "Intent A",
        name: "intent-a",
        runtimeProvider: "codex",
        creationIntentId: intent,
      }),
      service.createForAccount(bootstrap.userId, {
        computerId: computer.id,
        displayName: "Intent B",
        name: "intent-b",
        runtimeProvider: "codex",
        creationIntentId: intent,
      }),
    ]);
    expect(racedIntent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(racedIntent.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "AGENT_CREATION_INTENT_CONFLICT" },
    });
  });

  it.each([
    ["codex", 15, { inputTokens: 10, cachedInputTokens: 20, outputTokens: 5 }],
    ["claude-code", 35, { inputTokens: 10, cachedInputTokens: 20, outputTokens: 5 }],
  ] as const)("aggregates %s usage and current activity", async (runtimeProvider, tokens, usageFields) => {
    const { bootstrap, computer, service } = await fixture();
    const created = await createAgent(
      service,
      bootstrap.userId,
      computer.id,
      `${runtimeProvider}-agent`,
      runtimeProvider,
    );
    const binding = await createBinding(created.id);
    const session = await createSession(binding.id);
    const reportedAt = new Date("2026-08-24T10:00:00.000Z");
    await createDelivery(binding.id, session.id, {
      acceptedAt: reportedAt,
      reportedAt,
      usage: usageFields,
      outcome: "failed",
    });
    const workingAt = new Date("2026-08-24T11:00:00.000Z");
    await createDelivery(binding.id, session.id, { acceptedAt: workingAt, usage: {} });
    const listed = await service.listForAccount(bootstrap.userId);
    expect(listed.agents[0]).toMatchObject({
      activity: { state: "working", startedAt: workingAt.toISOString() },
      usage: { tasks: 2, failed: 1, tokens },
    });
    const usage = await service.getUsageById(bootstrap.userId, created.id, 30);
    expect(usage).toMatchObject({
      tasks: 2,
      measuredTasks: 1,
      failed: 1,
      inputTokens: runtimeProvider === "claude-code" ? 30 : 10,
      cachedInputTokens: 20,
      outputTokens: 5,
      tokens,
    });
    expect(usage.daily).toHaveLength(31);
    await unitDatabase.database.update(sessions).set({ endedAt: NOW }).where(eq(sessions.id, session.id));
    await expect(service.listForAccount(bootstrap.userId)).resolves.toMatchObject({
      agents: [{ activity: { state: "idle" }, usage: { tasks: 2 } }],
    });
  });

  it("covers usage validation, date boundaries, and missing resources", async () => {
    const { bootstrap, computer, service } = await fixture();
    const created = await createAgent(service, bootstrap.userId, computer.id);
    await expect(service.getUsageById(bootstrap.userId, crypto.randomUUID(), 7)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    const binding = await createBinding(created.id);
    const session = await createSession(binding.id);
    await createDelivery(binding.id, session.id, {
      acceptedAt: new Date("2026-08-01T00:00:00.000Z"),
      reportedAt: NOW,
      usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    });
    await expect(service.getUsageById(bootstrap.userId, created.id, 30)).rejects.toThrow("invalid token count");
  });

  it("rejects aggregate totals that exceed the safe integer range", async () => {
    const { bootstrap, computer, service } = await fixture();
    const created = await createAgent(service, bootstrap.userId, computer.id, "overflow-agent");
    const binding = await createBinding(created.id);
    const session = await createSession(binding.id);
    await createDelivery(binding.id, session.id, {
      acceptedAt: NOW,
      reportedAt: NOW,
      usage: { inputTokens: Number.MAX_SAFE_INTEGER },
    });
    await createDelivery(binding.id, session.id, {
      acceptedAt: new Date(NOW.getTime() - 1_000),
      reportedAt: NOW,
      usage: { inputTokens: Number.MAX_SAFE_INTEGER },
    });
    await expect(service.getUsageById(bootstrap.userId, created.id, 30)).rejects.toThrow(
      "token total exceeds the safe integer range",
    );
  });

  it("updates profile and runtime configuration with compare-and-swap", async () => {
    const { bootstrap, computer, service } = await fixture();
    const created = await service.createForAccount(bootstrap.userId, {
      computerId: computer.id,
      displayName: "Config",
      name: "config-agent",
      runtimeProvider: "codex",
      runtimeConfig: { model: "gpt-5", instructions: "Initial" },
    });
    const profile = await service.updateById(bootstrap.userId, created.id, {
      expectedRevision: 1,
      displayName: "Renamed",
    });
    expect(profile).toMatchObject({
      displayName: "Renamed",
      revision: 2,
      runtimeConfig: { revision: created.runtimeConfig.revision },
    });
    const changed = await service.updateById(bootstrap.userId, created.id, {
      expectedRevision: 2,
      runtimeConfig: { instructions: "Changed", maxDurationMs: 5_000 },
    });
    expect(changed).toMatchObject({ revision: 3, runtimeConfig: { instructions: "Changed", maxDurationMs: 5_000 } });
    await expect(
      service.updateById(bootstrap.userId, created.id, { expectedRevision: 2, displayName: "Stale" }),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT", statusCode: 409 });
    await expect(
      service.updateById(bootstrap.userId, crypto.randomUUID(), { expectedRevision: 1, displayName: "Missing" }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("enforces Feishu receive-mode scopes and invokes membership hooks", async () => {
    const { bootstrap, computer, service } = await fixture();
    const created = await createAgent(service, bootstrap.userId, computer.id, "receive-agent");
    const binding = await createBinding(created.id, "feishu", false);
    const afterMembershipLocked = vi.fn(async () => undefined);
    const hooked = new AgentService(unitDatabase.database, { now: () => NOW, afterMembershipLocked });
    await expect(
      hooked.createForAccount(bootstrap.userId, {
        computerId: computer.id,
        displayName: "Hooked",
        name: "hooked-agent",
        runtimeProvider: "codex",
      }),
    ).resolves.toMatchObject({ name: "hooked-agent" });
    await expect(
      hooked.updateById(bootstrap.userId, created.id, { expectedRevision: 1, receiveMode: "mention_only" }),
    ).resolves.toMatchObject({ receiveMode: "mention_only" });
    await expect(
      hooked.updateById(bootstrap.userId, created.id, { expectedRevision: 2, receiveMode: "all_message" }),
    ).rejects.toMatchObject({ code: "IM_BINDING_SCOPE_REAUTH_REQUIRED" });
    await unitDatabase.database
      .update(imBindings)
      .set({ grantedCapabilities: [...FEISHU_REQUIRED_TENANT_SCOPES] })
      .where(eq(imBindings.id, binding.id));
    await expect(
      hooked.updateById(bootstrap.userId, created.id, { expectedRevision: 2, receiveMode: "all_message" }),
    ).resolves.toMatchObject({ receiveMode: "all_message", revision: 3 });
    expect(afterMembershipLocked).toHaveBeenCalled();
  });

  it("suspends, reactivates, deletes, and reports failed best-effort stops", async () => {
    const { bootstrap, computer, service } = await fixture();
    const created = await createAgent(service, bootstrap.userId, computer.id, "lifecycle-agent");
    const binding = await createBinding(created.id);
    const session = await createSession(binding.id, computer.id);
    const stopSessions = vi.fn(async () => undefined);
    const lifecycle = new AgentService(unitDatabase.database, { now: () => NOW, stopSessions });
    await expect(lifecycle.deleteById(bootstrap.userId, created.id)).rejects.toMatchObject({
      code: "AGENT_LIFECYCLE_CONFLICT",
    });
    const suspended = await lifecycle.suspendById(bootstrap.userId, created.id);
    expect(suspended).toMatchObject({ status: "suspended", revision: 2 });
    expect(stopSessions).toHaveBeenCalledWith([
      {
        agentId: created.id,
        computerId: expect.any(String),
        workspaceComputerId: computer.id,
        placementGeneration: 1,
        sessionId: session.id,
      },
    ]);
    await expect(lifecycle.suspendById(bootstrap.userId, created.id)).rejects.toMatchObject({
      code: "AGENT_LIFECYCLE_CONFLICT",
    });
    await expect(lifecycle.reactivateById(bootstrap.userId, created.id)).resolves.toMatchObject({
      status: "active",
      revision: 3,
    });
    await expect(lifecycle.reactivateById(bootstrap.userId, created.id)).rejects.toMatchObject({
      code: "AGENT_LIFECYCLE_CONFLICT",
    });
    const diagnostics: string[] = [];
    const failing = new AgentService(unitDatabase.database, {
      now: () => NOW,
      stopSessions: async () => {
        throw new Error("stop failed");
      },
      onDiagnostic: (code) => diagnostics.push(code),
    });
    await failing.suspendById(bootstrap.userId, created.id);
    expect(diagnostics).toEqual(["AGENT_SESSION_STOP_FAILED"]);
    await failing.deleteById(bootstrap.userId, created.id);
    await expect(failing.getById(bootstrap.userId, created.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("rebinds active Sessions, rejects unsafe custody, and handles no-op and missing targets", async () => {
    const { bootstrap, computer, service } = await fixture();
    const target = await createComputer(bootstrap.userId, bootstrap.workspaceId, "target");
    const created = await createAgent(service, bootstrap.userId, computer.id, "rebind-agent");
    const binding = await createBinding(created.id);
    const session = await createSession(binding.id, computer.id);
    const noOp = await service.rebindById(bootstrap.userId, created.id, computer.id);
    expect(noOp).toMatchObject({ computerId: computer.id });
    const pending = await createDelivery(binding.id, session.id, { state: "pending" });
    await expect(service.rebindById(bootstrap.userId, created.id, target.id)).rejects.toMatchObject({
      code: "AGENT_REBIND_BLOCKED",
    });
    await unitDatabase.database.delete(imMessageDeliveries).where(eq(imMessageDeliveries.id, pending.id));
    const accepted = await createDelivery(binding.id, session.id, {
      state: "accepted",
      acceptedAt: NOW,
      reportedAt: null,
    });
    await expect(service.rebindById(bootstrap.userId, created.id, target.id)).rejects.toMatchObject({
      code: "AGENT_REBIND_BLOCKED",
    });
    await unitDatabase.database.delete(imMessageDeliveries).where(eq(imMessageDeliveries.id, accepted.id));
    const expired = await createDelivery(binding.id, session.id, { state: "expired" });
    await unitDatabase.database
      .update(imMessageDeliveries)
      .set({ dispatchRequestId: crypto.randomUUID(), dispatchInputHash: "e".repeat(64), dispatchPayload: {} as never })
      .where(eq(imMessageDeliveries.id, expired.id));
    await expect(service.rebindById(bootstrap.userId, created.id, target.id)).rejects.toMatchObject({
      code: "AGENT_REBIND_BLOCKED",
    });
    await unitDatabase.database.delete(imMessageDeliveries).where(eq(imMessageDeliveries.id, expired.id));
    const rebound = await service.rebindById(bootstrap.userId, created.id, target.id);
    expect(rebound).toMatchObject({ computerId: target.id, revision: 2 });
    const [placement] = await unitDatabase.database
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, session.id));
    expect(placement).toMatchObject({ computerId: target.id, workspaceComputerId: target.id, generation: 2 });
    await expect(service.rebindById(bootstrap.userId, created.id, crypto.randomUUID())).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
    });
  });

  it("notifies provider CLI placement after committed lifecycle changes and reports callback failures", async () => {
    const { bootstrap, computer, service } = await fixture();
    const target = await createComputer(bootstrap.userId, bootstrap.workspaceId, "target-cli");
    const created = await createAgent(service, bootstrap.userId, computer.id, "placement-agent");
    const onProviderCliPlacementChanged = vi.fn(async () => undefined);
    const hooked = new AgentService(unitDatabase.database, {
      now: () => NOW,
      onProviderCliPlacementChanged,
    });
    await hooked.suspendById(bootstrap.userId, created.id);
    expect(onProviderCliPlacementChanged).toHaveBeenCalledWith({
      agentId: created.id,
      previousWorkspaceComputerId: computer.id,
    });
    onProviderCliPlacementChanged.mockClear();
    await hooked.reactivateById(bootstrap.userId, created.id);
    expect(onProviderCliPlacementChanged).toHaveBeenCalledWith({
      agentId: created.id,
      workspaceComputerId: computer.id,
    });
    onProviderCliPlacementChanged.mockClear();
    await hooked.rebindById(bootstrap.userId, created.id, computer.id);
    expect(onProviderCliPlacementChanged).not.toHaveBeenCalled();
    await hooked.rebindById(bootstrap.userId, created.id, target.id);
    expect(onProviderCliPlacementChanged).toHaveBeenCalledWith({
      agentId: created.id,
      previousWorkspaceComputerId: computer.id,
      workspaceComputerId: target.id,
    });
    const diagnostics: string[] = [];
    const failing = new AgentService(unitDatabase.database, {
      now: () => NOW,
      onDiagnostic: (code) => diagnostics.push(code),
      onProviderCliPlacementChanged: async () => {
        throw new Error("notify failed");
      },
    });
    await expect(failing.suspendById(bootstrap.userId, created.id)).resolves.toMatchObject({ status: "suspended" });
    expect(diagnostics).toEqual(["PROVIDER_CLI_PLACEMENT_NOTIFY_FAILED"]);
    diagnostics.length = 0;
    await failing.deleteById(bootstrap.userId, created.id);
    expect(diagnostics).toEqual(["PROVIDER_CLI_PLACEMENT_NOTIFY_FAILED"]);
  });
});
