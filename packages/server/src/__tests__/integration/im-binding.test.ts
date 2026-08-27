import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import {
  computeDirectInputHash,
  computeRuntimeSnapshotHashes,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  FEISHU_REQUIRED_TENANT_SCOPES,
  type NormalizedInboundImEvent,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  SLACK_REQUIRED_BOT_SCOPES,
  type TurnReportRequest,
  type UpdateAgentRequest,
} from "@opentag/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  users,
  workspaceAdminGrants,
  workspaceComputers,
  workspaces,
} from "../../db/schema/index.js";
import { stopAgentSessions } from "../../runtime/agent-session-stopper.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImMessageInbox, ImResourceService } from "../../services/im/index.js";
import {
  type FeishuAdapter,
  FeishuConnectionManager,
  type FeishuRegistration,
  type FeishuRegistrationGateway,
  FeishuSetupService,
} from "../../services/im-bindings/feishu/index.js";
import { createImProviderAdapterResolver, ImBindingService } from "../../services/im-bindings/index.js";
import { SlackConfigurationService } from "../../services/im-bindings/slack/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "../../services/runtime-config/index.js";
import { SessionService } from "../../services/sessions/index.js";
import { WorkspaceSetupService } from "../../services/workspaces/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());

beforeEach(async () => testDatabase.reset());

async function validatingFeishuAttempt(
  database: ReturnType<typeof createDatabaseClient>["database"],
  agentId: string,
  ownerInstanceId: string,
  intent: "create" | "reauthorize" | "replace",
): Promise<string> {
  const attemptId = crypto.randomUUID();
  const [existing] = await database.select().from(imBindings).where(eq(imBindings.agentId, agentId)).limit(1);
  const values = {
    setupAttemptId: attemptId,
    setupIntent: intent,
    setupState: "validating" as const,
    setupOwnerInstanceId: ownerInstanceId,
    setupOwnerHeartbeatAt: new Date(),
    encryptedSetupContext: "test-only",
    setupExpiresAt: new Date(Date.now() + 60_000),
    updatedAt: new Date(),
  };
  if (existing) {
    await database.update(imBindings).set(values).where(eq(imBindings.id, existing.id));
  } else {
    await database.insert(imBindings).values({
      agentId,
      provider: "feishu",
      status: "provisioning",
      ...values,
    });
  }
  return attemptId;
}

async function fixture() {
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    workspaceDisplayName: "Example",
    workspaceName: "example",
  });
  const computerProfile = {
    displayName: "workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.1",
  };
  const [computer] = await client.database.insert(computers).values({ id: crypto.randomUUID() }).returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const [workspaceComputer] = await client.database
    .insert(workspaceComputers)
    .values({
      workspaceId: bootstrap.workspaceId,
      computerId: computer.id,
      ...computerProfile,
      enrolledByUserId: bootstrap.userId,
    })
    .returning();
  if (!workspaceComputer) throw new Error("Workspace Computer fixture was not created");
  const agent = await new AgentService(client.database).createForWorkspace(bootstrap.userId, bootstrap.workspaceId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindingService = new ImBindingService(client.database, cipher, {
    now: () => new Date("2026-08-19T00:00:00.000Z"),
  });
  const activated = await imBindingService.activateSlack(
    {
      intent: "create",
      agentId: agent.id,
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      grantedBotScopes: [
        "chat:write",
        "app_mentions:read",
        "files:read",
        "im:history",
        "channels:history",
        "groups:history",
        "mpim:history",
      ],
      botAccessToken: "xoxb-secret",
      signingSecret: "signing-secret",
      installedAt: new Date("2026-08-19T00:00:00.000Z"),
    },
    "B_BOT",
  );
  const imBindingId = activated.imBindingId;
  await imBindingService.recordSlackIdentityClosure(imBindingId, activated.credentialGeneration);
  return {
    ...client,
    agent,
    bootstrap,
    computer: { ...computer, ...computerProfile },
    workspaceComputer,
    cipher,
    imBindingId,
    imBindingService,
  };
}

async function unboundFixture() {
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    workspaceDisplayName: "Example",
    workspaceName: "example",
  });
  const computerProfile = {
    displayName: "workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.1",
  };
  const [computer] = await client.database.insert(computers).values({ id: crypto.randomUUID() }).returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const [workspaceComputer] = await client.database
    .insert(workspaceComputers)
    .values({
      workspaceId: bootstrap.workspaceId,
      computerId: computer.id,
      ...computerProfile,
      enrolledByUserId: bootstrap.userId,
    })
    .returning();
  if (!workspaceComputer) throw new Error("Workspace Computer fixture was not created");
  const created = await new AgentService(client.database).createForWorkspace(bootstrap.userId, bootstrap.workspaceId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  await client.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, created.id));
  const agent = { ...created, receiveMode: "mention_only" as const };
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindingService = new ImBindingService(client.database, cipher);
  return {
    ...client,
    agent,
    bootstrap,
    computer: { ...computer, ...computerProfile },
    workspaceComputer,
    cipher,
    imBindingService,
  };
}

function imDeliveryWorker(input: Omit<ConstructorParameters<typeof ImDeliveryWorker>[0], "assembler">) {
  return new ImDeliveryWorker({
    ...input,
    assembler: new EffectiveRuntimeSnapshotAssembler(input.database),
  });
}

function computerAuthFor(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    computerId: value.computer.id,
    credentialId: crypto.randomUUID(),
    workspaceComputerId: value.workspaceComputer.id,
    workspaceId: value.bootstrap.workspaceId,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function dispatchedRuntimeResult<T>(result: T) {
  return vi.fn((_computerId: string, _instanceId: string, _request: unknown, onDispatched?: () => void): Promise<T> => {
    onDispatched?.();
    return Promise.resolve(result);
  });
}

function dispatchedRuntimeFailure(error: Error) {
  return vi.fn(
    (_computerId: string, _instanceId: string, _request: unknown, onDispatched?: () => void): Promise<never> => {
      onDispatched?.();
      return Promise.reject(error);
    },
  );
}

async function settleWithin<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Concurrent database operations did not settle")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createClientSessionBindingStore(home: string) {
  const moduleUrl = new URL("../../../../client/src/runtime/session-binding-store.ts", import.meta.url).href;
  const module = (await import(moduleUrl)) as {
    SessionBindingStore: new (options: {
      home: string;
      providerArtifactIdentity(providerId: string): string | undefined;
    }) => {
      prepare: (
        request: Parameters<PostgresRuntimeCustodyStore["claimRetainedReports"]>[0],
        hashes: ReturnType<typeof computeRuntimeSnapshotHashes>,
      ) => Promise<unknown>;
      read: (
        agentId: string,
        sessionId: string,
      ) => Promise<
        | {
            unresolvedTurn?: {
              deliveryId: string;
              inputHash: string;
              phase: string;
              requestId: string;
              resultHash?: string;
              turnId: string;
            };
          }
        | undefined
      >;
      recordAccepted: (request: DirectImMessageDeliveryRequest, inputHash: string, turnId: string) => Promise<unknown>;
      recordResult: (agentId: string, sessionId: string, turnId: string, resultHash: string) => Promise<unknown>;
      updateUnresolved: (
        agentId: string,
        sessionId: string,
        turnId: string,
        phase: "reporting",
        fields: { report: TurnReportRequest; resultHash: string },
      ) => Promise<unknown>;
    };
  };
  return new module.SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
}

async function createDurableClientReconciler(home: string, computerId: string) {
  const bindingStore = await createClientSessionBindingStore(home);
  const workspaceModuleUrl = new URL("../../../../client/src/runtime/agent-workspace.ts", import.meta.url).href;
  const reconcilerModuleUrl = new URL("../../../../client/src/runtime/session-reconciler.ts", import.meta.url).href;
  const workspaceModule = (await import(workspaceModuleUrl)) as {
    AgentWorkspaceManager: new (options: { bindingStore: typeof bindingStore; home: string }) => object;
  };
  const reconcilerModule = (await import(reconcilerModuleUrl)) as {
    SessionReconciler: new (options: {
      computerId: string;
      preparation: object;
    }) => {
      clearRecovery: (sessionId: string, turnId: string) => boolean;
      getAgent: (agentId: string) => { revisionSequence: number } | undefined;
      reconcile: (request: SessionReconcileRequest) => Promise<SessionReconcileResult>;
    };
  };
  const workspace = new workspaceModule.AgentWorkspaceManager({ bindingStore, home });
  const reconciler = new reconcilerModule.SessionReconciler({ computerId, preparation: workspace });
  return { bindingStore, reconciler };
}

async function respondingRuntime(input: {
  acceptDeliveries?: boolean;
  database: ReturnType<typeof createDatabaseClient>["database"];
  computerId: string;
  deliveryGate?: Promise<void>;
  instanceId: string;
  requestTimeoutMs?: number;
  reconcileResult?: (frame: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  workspaceComputerId: string;
  workspaceId: string;
}) {
  const frames: unknown[] = [];
  const registry = new ConnectionRegistry();
  const context = {
    computerId: input.computerId,
    workspaceComputerId: input.workspaceComputerId,
    workspaceId: input.workspaceId,
    instanceId: input.instanceId,
    signal: new AbortController().signal,
  };
  let domain!: RuntimeDomainOwner;
  const socket = {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn((serialized: string, callback: (error?: Error) => void) => {
      const frame = JSON.parse(serialized) as Record<string, unknown>;
      frames.push(frame);
      callback();
      queueMicrotask(() => {
        void (async () => {
          if (frame.type === "session:reconcile") {
            const result = input.reconcileResult
              ? await input.reconcileResult(frame)
              : {
                  type: "session:reconcile:result",
                  requestId: frame.requestId,
                  sessionId: frame.sessionId,
                  placementGeneration: frame.placementGeneration,
                  status: "ready",
                };
            await domain.handle(result as never, context);
          } else if (frame.type === "im:deliver") {
            if (input.acceptDeliveries === false) return;
            await input.deliveryGate;
            await domain.handle(
              {
                type: "im:deliver:result",
                requestId: frame.requestId,
                deliveryId: frame.deliveryId,
                sessionId: frame.sessionId,
                placementGeneration: frame.placementGeneration,
                status: "accepted",
                turnId: `turn-${String(frame.deliveryId)}`,
              } as never,
              context,
            );
          }
        })();
      });
    }),
  } as unknown as WebSocket;
  await registry.register(
    {
      capabilities: { imCredentialGrant: 1 },
      capabilitiesUpdatedAt: Date.now(),
      computerId: input.computerId,
      workspaceComputerId: input.workspaceComputerId,
      workspaceId: input.workspaceId,
      instanceId: input.instanceId,
      lastHeartbeatAt: Date.now(),
      socket,
    },
    async () => undefined,
  );
  domain = new RuntimeDomainOwner(registry, new PostgresRuntimeCustodyStore(input.database), {
    requestTimeoutMs: input.requestTimeoutMs,
  });
  return { context, domain, frames, registry };
}

function turnReportFor(input: {
  agentId: string;
  deliveryId: string;
  placementGeneration: number;
  sessionId: string;
  turnId: string;
}): TurnReportRequest {
  const body = {
    deliveryId: input.deliveryId,
    turnId: input.turnId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    placementGeneration: input.placementGeneration,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "done",
    usage: { inputTokens: 1, outputTokens: 1 },
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: crypto.randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}

function inbound(
  providerEventId: string,
  operation: "created" | "edited" | "deleted" = "created",
): NormalizedInboundImEvent {
  return {
    providerEventId,
    externalAppId: "A1",
    externalTeamId: "T1",
    providerContext: { provider: "slack", channelType: "channel" },
    conversation: { externalId: "C1", kind: "channel" as const },
    message: {
      externalId: "1000.1",
      revisionKey: `${operation}:1000.1`,
      operation,
      threadKey: null,
      replyToExternalId: null,
      author: { externalId: "U_HUMAN", kind: "human" as const, displayName: "Human" },
      occurredAt: new Date("2026-08-19T00:00:01.000Z"),
      content: {
        version: 1 as const,
        fallbackText: "hello",
        blocks: [{ type: "text" as const, text: "hello" }],
        truncated: false,
      },
      resources: [],
    },
    mentions: [{ externalId: "U_BOT", displayName: "Assistant" }],
  };
}

function revisionEvent(input: {
  providerEventId: string;
  externalMessageId: string;
  operation: "created" | "edited" | "deleted";
  occurredAt: string;
  revisionKey: string;
}): NormalizedInboundImEvent {
  const event = inbound(input.providerEventId, input.operation);
  return {
    ...event,
    message: {
      ...event.message,
      externalId: input.externalMessageId,
      occurredAt: new Date(input.occurredAt),
      revisionKey: input.revisionKey,
      content: {
        version: 1,
        fallbackText: input.operation,
        blocks: [{ type: "text", text: input.operation }],
        truncated: false,
      },
    },
  };
}

function slackThreadEvent(input: {
  providerEventId: string;
  externalMessageId: string;
  rootExternalMessageId: string;
  occurredAt: string;
  channelId?: string;
  direct?: boolean;
  text?: string;
}): NormalizedInboundImEvent {
  const event = revisionEvent({
    providerEventId: input.providerEventId,
    externalMessageId: input.externalMessageId,
    operation: "created",
    occurredAt: input.occurredAt,
    revisionKey: "1",
  });
  event.providerContext = {
    provider: "slack",
    channelType: "channel",
    threadTs: input.rootExternalMessageId,
  };
  event.conversation.externalId = input.channelId ?? "C1";
  event.message.threadKey = input.rootExternalMessageId;
  event.message.content = {
    version: 1,
    fallbackText: input.text ?? input.externalMessageId,
    blocks: [{ type: "text", text: input.text ?? input.externalMessageId }],
    truncated: false,
  };
  event.mentions = input.direct === true ? [{ externalId: "U_BOT", displayName: "Assistant" }] : [];
  return event;
}

describe("IM binding persistence", () => {
  it("completes Workspace setup only from a ready handoff and never reopens it", async () => {
    const value = await fixture();
    try {
      const completedAt = new Date("2026-08-20T12:00:00.000Z");
      const runtimeUnavailable = new ImBindingService(value.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
        imCliReadiness: () => "unavailable",
      });
      const unavailableSetup = new WorkspaceSetupService(value.database, runtimeUnavailable, {
        now: () => completedAt,
      });

      await expect(
        unavailableSetup.complete(value.bootstrap.userId, value.bootstrap.workspaceId, value.agent.id),
      ).rejects.toMatchObject({ code: "WORKSPACE_SETUP_NOT_READY", statusCode: 409 });
      await expect(
        value.database.select({ setupCompletedAt: workspaces.setupCompletedAt }).from(workspaces).limit(1),
      ).resolves.toEqual([{ setupCompletedAt: null }]);

      const setup = new WorkspaceSetupService(value.database, value.imBindingService, {
        now: () => completedAt,
      });
      await expect(
        setup.complete(value.bootstrap.userId, value.bootstrap.workspaceId, value.agent.id),
      ).resolves.toEqual({
        setupCompletedAt: completedAt.toISOString(),
      });

      await value.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
      await expect(
        unavailableSetup.complete(value.bootstrap.userId, value.bootstrap.workspaceId, crypto.randomUUID()),
      ).resolves.toEqual({ setupCompletedAt: completedAt.toISOString() });

      const [member] = await value.database
        .insert(users)
        .values({ email: "setup-member@example.com", displayName: "Setup Member" })
        .returning();
      if (!member) throw new Error("Setup member fixture was not created");
      await expect(setup.complete(member.id, value.bootstrap.workspaceId, value.agent.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("filters the bound Bot's own ingress before message persistence and delivery", async () => {
    const value = await fixture();
    try {
      const selfEvent = inbound("Ev-self-message");
      selfEvent.message.author = { externalId: "B_BOT", kind: "bot", displayName: "Assistant", isSelf: true };
      await expect(new ImMessageInbox(value.database).ingest(value.imBindingId, 1, selfEvent)).resolves.toEqual({
        duplicate: false,
        deliveryIds: [],
      });
      await expect(value.database.select().from(imMessages)).resolves.toEqual([]);
      await expect(value.database.select().from(imMessageDeliveries)).resolves.toEqual([]);
    } finally {
      await value.sql.end();
    }
  });

  it("grants only the bound Slack Bot token across attention modes and fences placement authority", async () => {
    const value = await fixture();
    try {
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-credential-grant"));
      const [session] = await value.database.select().from(sessions).limit(1);
      if (!session) throw new Error("Credential grant Session fixture was not created");
      const request = {
        type: "im:credential" as const,
        requestId: crypto.randomUUID(),
        sessionId: session.id,
        agentId: value.agent.id,
        placementGeneration: 1,
      };

      await value.database
        .update(imBindings)
        .set({ observedConnectedAt: null })
        .where(eq(imBindings.id, value.imBindingId));
      await expect(value.imBindingService.findSlackIngressBinding("A1", "T1")).resolves.toMatchObject({
        imBindingId: value.imBindingId,
        generation: 1,
      });
      await expect(value.imBindingService.getSlackConnectionMaterial(value.imBindingId)).resolves.toBeUndefined();
      await expect(
        value.imBindingService.issueRuntimeCredentialGrant(request, computerAuthFor(value)),
      ).resolves.toMatchObject({ status: "rejected", code: "binding_inactive" });
      await value.imBindingService.recordSlackIdentityClosure(value.imBindingId, 1);

      const direct = await value.imBindingService.issueRuntimeCredentialGrant(request, computerAuthFor(value));
      const ambient = await value.imBindingService.issueRuntimeCredentialGrant(
        { ...request, requestId: crypto.randomUUID() },
        computerAuthFor(value),
      );
      expect(direct).toEqual({
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: 1,
        grant: { provider: "slack", botAccessToken: "xoxb-secret" },
      });
      expect(ambient).toMatchObject({ status: "succeeded", grant: { provider: "slack" } });
      expect(JSON.stringify(direct)).not.toContain("signing-secret");
      expect(JSON.stringify(direct)).not.toContain("attention");

      const sessionService = new SessionService(value.database);
      const thread = await sessionService.ensureChatSession(
        {
          imBindingId: value.imBindingId,
          channelId: session.channelId,
          conversationKind: session.conversationKind,
        },
        "thread",
        "credential-thread",
      );
      await expect(
        value.imBindingService.issueRuntimeCredentialGrant(
          { ...request, requestId: crypto.randomUUID(), sessionId: thread.session.id },
          computerAuthFor(value),
        ),
      ).resolves.toMatchObject({ status: "succeeded", grant: { provider: "slack" } });
      const internal = await sessionService.createInternalSessionWithMessage({
        creatorSessionId: session.id,
        creatorComputerId: value.computer.id,
        creatorWorkspaceComputerId: value.workspaceComputer.id,
        creatorPlacementGeneration: 1,
        messageId: crypto.randomUUID(),
        initialMessage: "Do not expose provider credentials",
      });
      const internalGrant = await value.imBindingService.issueRuntimeCredentialGrant(
        { ...request, requestId: crypto.randomUUID(), sessionId: internal.session.id },
        computerAuthFor(value),
      );
      expect(internalGrant).toMatchObject({ status: "rejected", code: "agent_mismatch" });
      expect(JSON.stringify(internalGrant)).not.toContain("xoxb-secret");

      await expect(
        value.imBindingService.issueRuntimeCredentialGrant(
          { ...request, requestId: crypto.randomUUID(), placementGeneration: 2 },
          computerAuthFor(value),
        ),
      ).resolves.toMatchObject({ status: "rejected", code: "placement_stale" });
      await expect(
        value.imBindingService.issueRuntimeCredentialGrant(request, {
          ...computerAuthFor(value),
          workspaceComputerId: crypto.randomUUID(),
        }),
      ).resolves.toMatchObject({ status: "rejected", code: "agent_mismatch" });
      await expect(
        value.imBindingService.issueRuntimeCredentialGrant(
          { ...request, requestId: crypto.randomUUID(), agentId: crypto.randomUUID() },
          computerAuthFor(value),
        ),
      ).resolves.toMatchObject({ status: "rejected", code: "agent_mismatch" });
      await value.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, session.id));
      await expect(
        value.imBindingService.issueRuntimeCredentialGrant(
          { ...request, requestId: crypto.randomUUID() },
          computerAuthFor(value),
        ),
      ).resolves.toMatchObject({ status: "rejected", code: "placement_stale" });
      await value.database.update(sessions).set({ endedAt: null }).where(eq(sessions.id, session.id));
      await value.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
      await expect(
        value.imBindingService.issueRuntimeCredentialGrant(
          { ...request, requestId: crypto.randomUUID() },
          computerAuthFor(value),
        ),
      ).resolves.toMatchObject({ status: "rejected", code: "agent_mismatch" });
    } finally {
      await value.sql.end();
    }
  });

  it("returns Admin-safe Slack handoff readiness while preserving Workspace authorization boundaries", async () => {
    const value = await fixture();
    try {
      const [member] = await value.database
        .insert(users)
        .values({ email: "member@example.com", displayName: "Member" })
        .returning();
      if (!member) throw new Error("Member fixture was not created");
      const summary = await value.imBindingService.getForAgent(value.bootstrap.userId, value.agent.id);
      expect(summary).toMatchObject({ provider: "slack", bindingState: "active", receiveMode: "all_message" });
      expect(JSON.stringify(summary)).not.toMatch(/credential|identity|appId|botUserId|lastError/i);
      const handoff = await value.imBindingService.getHandoffForAgent(value.bootstrap.userId, value.agent.id);
      expect(handoff).toEqual({ bindingState: "active", handoffReady: true });
      expect(JSON.stringify(handoff)).not.toMatch(/credential|identity|appId|botUserId|error|connection|secret/i);
      await expect(value.imBindingService.getForAgent(member.id, value.agent.id)).rejects.toMatchObject({
        code: "IM_BINDING_NOT_FOUND",
        statusCode: 404,
      });

      const runtimeUnavailable = new ImBindingService(value.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
        imCliReadiness: () => "unavailable",
      });
      await expect(runtimeUnavailable.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toEqual({
        bindingState: "active",
        handoffReady: false,
      });

      const [otherWorkspace] = await value.database
        .insert(workspaces)
        .values({ name: "other-workspace", displayName: "Other Workspace" })
        .returning();
      const [outsider] = await value.database
        .insert(users)
        .values({ email: "outsider@example.com", displayName: "Outsider" })
        .returning();
      if (!otherWorkspace || !outsider) throw new Error("Cross-Workspace fixture was not created");
      await expect(value.imBindingService.getHandoffForAgent(outsider.id, value.agent.id)).rejects.toMatchObject({
        code: "IM_BINDING_NOT_FOUND",
        statusCode: 404,
      });

      await expect(value.imBindingService.getConfigForAgent(member.id, value.agent.id)).rejects.toMatchObject({
        code: "IM_BINDING_NOT_FOUND",
        statusCode: 404,
      });
      await expect(value.imBindingService.diagnostics(member.id, value.imBindingId)).rejects.toMatchObject({
        code: "IM_BINDING_NOT_FOUND",
        statusCode: 404,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("fails closed on unreadable Slack credentials and reports honest validation timestamps", async () => {
    const value = await fixture();
    try {
      const summary = await value.imBindingService.getForAgent(value.bootstrap.userId, value.agent.id);
      expect(summary).toMatchObject({
        lastValidatedAt: "2026-08-19T00:00:00.000Z",
        lastRuntimeObservationAt: "2026-08-19T00:00:00.000Z",
        lastInboundAt: null,
      });
      expect(JSON.stringify(summary)).not.toContain("lastConfirmedAt");
      const diagnostics = await value.imBindingService.diagnostics(value.bootstrap.userId, value.imBindingId);
      expect(diagnostics).toMatchObject({
        ready: true,
        credentialGeneration: 1,
        credentialStatus: "valid",
        requiredCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
        missingCapabilities: [],
        lastValidatedAt: "2026-08-19T00:00:00.000Z",
        lastRuntimeObservationAt: "2026-08-19T00:00:00.000Z",
        slackIdentityClosure: { status: "verified", verifiedAt: "2026-08-19T00:00:00.000Z" },
      });
      expect(diagnostics.grantedCapabilities).toEqual([...SLACK_REQUIRED_BOT_SCOPES]);

      const [original] = await value.database
        .select({ encryptedCredential: imBindings.encryptedCredential })
        .from(imBindings)
        .where(eq(imBindings.id, value.imBindingId));
      if (!original?.encryptedCredential) throw new Error("Slack credential fixture was not created");

      await value.database
        .update(imBindings)
        .set({ credentialSchemaVersion: 2 })
        .where(eq(imBindings.id, value.imBindingId));
      await expect(value.imBindingService.findSlackIngressBinding("A1", "T1")).resolves.toBeUndefined();
      await expect(
        value.imBindingService.diagnostics(value.bootstrap.userId, value.imBindingId),
      ).resolves.toMatchObject({
        ready: false,
        credentialStatus: "invalid",
        grantedCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
        missingCapabilities: [],
        lastErrorCode: "IM_BINDING_CREDENTIAL_INVALID",
      });

      await value.database
        .update(imBindings)
        .set({
          credentialSchemaVersion: 1,
          encryptedCredential: value.cipher.encrypt(
            JSON.stringify({
              botId: "B_BOT",
              botAccessToken: "xoxb-secret",
              signingSecret: "signing-secret",
              grantedScopes: [...SLACK_REQUIRED_BOT_SCOPES, "users:read"],
            }),
          ),
        })
        .where(eq(imBindings.id, value.imBindingId));
      await expect(value.imBindingService.findSlackIngressBindingForAgent(value.agent.id)).resolves.toBeUndefined();
      await expect(
        value.imBindingService.diagnostics(value.bootstrap.userId, value.imBindingId),
      ).resolves.toMatchObject({
        ready: false,
        credentialStatus: "invalid",
        grantedCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
        missingCapabilities: [],
        lastErrorCode: "IM_BINDING_CREDENTIAL_INVALID",
      });

      await value.database
        .update(imBindings)
        .set({ encryptedCredential: "not-ciphertext" })
        .where(eq(imBindings.id, value.imBindingId));
      await expect(value.imBindingService.findSlackIngressBinding("A1", "T1")).resolves.toBeUndefined();
      await expect(value.imBindingService.findSlackIngressBindingForAgent(value.agent.id)).resolves.toBeUndefined();
      await expect(value.imBindingService.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toEqual({
        bindingState: "reauthorization_required",
        handoffReady: false,
      });
      const broken = await value.imBindingService.diagnostics(value.bootstrap.userId, value.imBindingId);
      expect(broken).toMatchObject({
        ready: false,
        credentialGeneration: 1,
        credentialStatus: "invalid",
        grantedCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
        missingCapabilities: [],
        lastErrorCode: "IM_BINDING_CREDENTIAL_INVALID",
      });
      expect(JSON.stringify(broken)).not.toContain("xoxb-secret");
      expect(JSON.stringify(broken)).not.toContain("signing-secret");
      expect(JSON.stringify(broken)).not.toContain("not-ciphertext");
    } finally {
      await value.sql.end();
    }
  });

  it("lets suspension fence delivery before any ready or delivery runtime frame", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    const authorityLocked = deferred<void>();
    const releaseSuspend = deferred<void>();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(
        value.imBindingId,
        1,
        inbound("Ev-lifecycle-delivery-suspend-wins"),
      );
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: frame.desired === "stopped" ? "stopped" : "ready",
        }),
      });
      owners.push(runtime.domain);
      const lifecycle = new AgentService(value.database, {
        afterAgentLocked: async () => {
          authorityLocked.resolve();
          await releaseSuspend.promise;
        },
        stopSessions: async (targets) => {
          await Promise.all(
            targets.map((target) =>
              runtime.domain.requestReconcile(target.workspaceComputerId, instanceId, {
                type: "session:reconcile",
                requestId: crypto.randomUUID(),
                computerId: target.computerId,
                sessionId: target.sessionId,
                agentId: target.agentId,
                placementGeneration: target.placementGeneration,
                desired: "stopped",
              }),
            ),
          );
        },
      });
      const suspend = lifecycle.suspendById(value.bootstrap.userId, value.agent.id);
      await authorityLocked.promise;
      const delivery = imDeliveryWorker({
        database: value.database,
        domain: runtime.domain,
        registry: runtime.registry,
      }).runOnce();
      releaseSuspend.resolve();
      await expect(settleWithin(suspend)).resolves.toMatchObject({ status: "suspended" });
      await settleWithin(delivery);
      expect(runtime.frames).toEqual([expect.objectContaining({ type: "session:reconcile", desired: "stopped" })]);
    } finally {
      releaseSuspend.resolve();
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("orders an admitted runtime delivery before the final suspension stop", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    const releaseDelivery = deferred<void>();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(
        value.imBindingId,
        1,
        inbound("Ev-lifecycle-delivery-admission-wins"),
      );
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: releaseDelivery.promise,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: frame.desired === "stopped" ? "stopped" : "ready",
        }),
      });
      owners.push(runtime.domain);
      const workerRun = imDeliveryWorker({
        database: value.database,
        domain: runtime.domain,
        registry: runtime.registry,
      }).runOnce();
      await vi.waitFor(() =>
        expect(runtime.frames).toEqual(expect.arrayContaining([expect.objectContaining({ type: "im:deliver" })])),
      );
      const lifecycle = new AgentService(value.database, {
        stopSessions: async (targets) => {
          await Promise.all(
            targets.map((target) =>
              runtime.domain.requestReconcile(target.workspaceComputerId, instanceId, {
                type: "session:reconcile",
                requestId: crypto.randomUUID(),
                computerId: target.computerId,
                sessionId: target.sessionId,
                agentId: target.agentId,
                placementGeneration: target.placementGeneration,
                desired: "stopped",
              }),
            ),
          );
        },
      });
      const suspend = lifecycle.suspendById(value.bootstrap.userId, value.agent.id);
      releaseDelivery.resolve();
      await settleWithin(workerRun);
      await expect(settleWithin(suspend)).resolves.toMatchObject({ status: "suspended" });
      expect(runtime.frames.map((frame) => (frame as Record<string, unknown>).type)).toEqual([
        "session:reconcile",
        "im:deliver",
        "session:reconcile",
      ]);
      expect(runtime.frames.at(-1)).toMatchObject({ type: "session:reconcile", desired: "stopped" });
    } finally {
      releaseDelivery.resolve();
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("does not let a delayed suspension stop fence work admitted after reactivation", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    const oldStopStarted = deferred<void>();
    const releaseOldStop = deferred<void>();
    const releaseDelivery = deferred<void>();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(
        value.imBindingId,
        1,
        inbound("Ev-lifecycle-reactivation-fences-old-stop"),
      );
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: releaseDelivery.promise,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(runtime.domain);
      const lifecycle = new AgentService(value.database, {
        stopSessions: async (targets) => {
          oldStopStarted.resolve();
          await releaseOldStop.promise;
          await stopAgentSessions(value.database, targets, {
            currentInstanceId: () => instanceId,
            requestReconcile: (computerId, currentInstanceId, request, onDispatched) =>
              runtime.domain.requestReconcile(computerId, currentInstanceId, request, onDispatched),
          });
        },
      });

      const suspend = lifecycle.suspendById(value.bootstrap.userId, value.agent.id);
      await oldStopStarted.promise;
      await expect(
        new AgentService(value.database).reactivateById(value.bootstrap.userId, value.agent.id),
      ).resolves.toMatchObject({ status: "active" });
      const workerRun = imDeliveryWorker({
        database: value.database,
        domain: runtime.domain,
        registry: runtime.registry,
      }).runOnce();
      await vi.waitFor(() =>
        expect(runtime.frames).toEqual(expect.arrayContaining([expect.objectContaining({ type: "im:deliver" })])),
      );

      releaseOldStop.resolve();
      await expect(settleWithin(suspend)).resolves.toMatchObject({ status: "suspended" });
      releaseDelivery.resolve();
      await settleWithin(workerRun);
      expect(runtime.frames).toEqual([
        expect.objectContaining({ type: "session:reconcile", desired: "ready" }),
        expect.objectContaining({ type: "im:deliver" }),
      ]);
    } finally {
      releaseOldStop.resolve();
      releaseDelivery.resolve();
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("settles a reclaimed delivery without reversing the Delivery and Agent lock order", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    const firstBeforeAdmission = deferred<void>();
    const releaseFirstAdmission = deferred<void>();
    const secondClaimLocked = deferred<void>();
    const releaseSecondClaim = deferred<void>();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(
        value.imBindingId,
        1,
        inbound("Ev-lifecycle-delivery-reclaim-lock-order"),
      );
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(runtime.domain);
      const firstWorker = imDeliveryWorker({
        beforeDeliveryAdmission: async () => {
          firstBeforeAdmission.resolve();
          await releaseFirstAdmission.promise;
        },
        claimLeaseMs: 50,
        claimRenewMs: 1_000,
        database: value.database,
        domain: runtime.domain,
        registry: runtime.registry,
      });
      const secondWorker = imDeliveryWorker({
        afterClaimRowLocked: async () => {
          secondClaimLocked.resolve();
          await releaseSecondClaim.promise;
        },
        claimLeaseMs: 50,
        claimRenewMs: 1_000,
        database: value.database,
        domain: runtime.domain,
        registry: runtime.registry,
      });

      const firstRun = firstWorker.runOnce();
      await firstBeforeAdmission.promise;
      await new Promise((resolve) => setTimeout(resolve, 75));
      const secondRun = secondWorker.runOnce();
      await settleWithin(secondClaimLocked.promise);
      releaseFirstAdmission.resolve();
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseSecondClaim.resolve();

      await settleWithin(Promise.all([firstRun, secondRun]), 5_000);
      expect(runtime.frames).toEqual(expect.arrayContaining([expect.objectContaining({ type: "im:deliver" })]));
    } finally {
      releaseFirstAdmission.resolve();
      releaseSecondClaim.resolve();
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("recovers and settles accepted Turn custody while the Agent is suspended", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-suspended-recovery"));
      const firstRuntime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(firstRuntime.domain);
      await imDeliveryWorker({
        database: value.database,
        domain: firstRuntime.domain,
        registry: firstRuntime.registry,
      }).runOnce();
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (!accepted?.turnId) throw new Error("Accepted custody was not created");

      await new AgentService(value.database).suspendById(value.bootstrap.userId, value.agent.id);
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, accepted.id));
      const recoveryRuntime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: (frame) => {
          expect(frame).toMatchObject({ desired: "stopped" });
          expect(frame).not.toHaveProperty("runtime");
          return {
            type: "session:reconcile:result",
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            placementGeneration: frame.placementGeneration,
            status: "stopped",
          };
        },
      });
      owners.push(recoveryRuntime.domain);
      await imDeliveryWorker({
        database: value.database,
        domain: recoveryRuntime.domain,
        registry: recoveryRuntime.registry,
      }).runOnce();
      expect(recoveryRuntime.frames).toEqual([
        expect.objectContaining({ type: "session:reconcile", desired: "stopped" }),
      ]);

      const report = turnReportFor({
        agentId: value.agent.id,
        deliveryId: accepted.id,
        placementGeneration: accepted.placementGeneration,
        sessionId: accepted.sessionId,
        turnId: accepted.turnId,
      });
      await expect(recoveryRuntime.domain.handle(report, recoveryRuntime.context)).resolves.toMatchObject({
        status: "recorded",
      });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("waits for an in-flight admin downgrade and rejects the IM mutation after revocation commits", async () => {
    const value = await fixture();
    const revoker = createDatabaseClient(databaseUrl);
    const workspaceLocked = deferred<void>();
    const releaseRevocation = deferred<void>();
    try {
      const revocation = revoker.database.transaction(async (transaction) => {
        await transaction
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, value.bootstrap.workspaceId))
          .limit(1)
          .for("update");
        await transaction
          .update(workspaceAdminGrants)
          .set({ revokedByUserId: value.bootstrap.userId, revokedAt: new Date() })
          .where(
            and(
              eq(workspaceAdminGrants.workspaceId, value.bootstrap.workspaceId),
              eq(workspaceAdminGrants.userId, value.bootstrap.userId),
              isNull(workspaceAdminGrants.revokedAt),
            ),
          );
        workspaceLocked.resolve();
        await releaseRevocation.promise;
      });
      await workspaceLocked.promise;
      const mutation = value.imBindingService.disable(value.bootstrap.userId, value.imBindingId);
      let settled = false;
      void mutation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      releaseRevocation.resolve();
      await revocation;
      await expect(mutation).rejects.toMatchObject({ code: "IM_BINDING_NOT_FOUND", statusCode: 404 });
      expect(
        (await value.database.select().from(imBindings).where(eq(imBindings.id, value.imBindingId)))[0]?.status,
      ).toBe("active");
    } finally {
      releaseRevocation.resolve();
      await Promise.all([revoker.sql.end(), value.sql.end()]);
    }
  });

  it("migrates the authority tables with partial Session uniqueness and self-scope provenance", async () => {
    const value = await fixture();
    try {
      const indexes = await value.sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes
        where indexname in ('sessions_active_channel_unique', 'sessions_active_thread_unique')
        order by indexname
      `;
      expect(indexes).toHaveLength(2);
      expect(indexes.every((index) => index.indexdef.includes("ended_at IS NULL"))).toBe(true);
      const [creatorForeignKey] = await value.sql<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'sessions_created_by_session_id_sessions_id_fk'
      `;
      expect(creatorForeignKey?.definition).toContain("REFERENCES sessions(id)");
    } finally {
      await value.sql.end();
    }
  });

  it("atomically deduplicates provider events and converges duplicate Slack message event types", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database, { now: () => new Date("2026-08-19T00:00:02.000Z") });
      const first = await inbox.ingest(value.imBindingId, 1, inbound("Ev1"));
      const retry = await inbox.ingest(value.imBindingId, 1, inbound("Ev1"));
      const companion = await inbox.ingest(value.imBindingId, 1, inbound("Ev2"));
      expect(first.deliveryIds).toHaveLength(1);
      expect(retry).toEqual({ duplicate: true, messageId: first.messageId, deliveryIds: [] });
      expect(companion).toMatchObject({ duplicate: true, messageId: first.messageId, deliveryIds: [] });
      expect(await value.database.select().from(imMessages)).toHaveLength(1);
      expect(await value.database.select().from(imMessageDeliveries)).toHaveLength(1);
      expect(await value.database.select().from(sessions)).toHaveLength(1);
      expect(await value.database.select().from(sessionPlacements)).toMatchObject([
        { workspaceComputerId: value.workspaceComputer.id, generation: 1 },
      ]);

      const edit = await inbox.ingest(value.imBindingId, 1, inbound("Ev3", "edited"));
      expect(edit).toMatchObject({ duplicate: false });
      expect(await value.database.select().from(imMessages)).toHaveLength(2);
      expect(await value.database.select().from(imMessageDeliveries)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ messageId: first.messageId, state: "expired", reason: "superseded_revision" }),
          expect.objectContaining({ messageId: edit.messageId, state: "pending" }),
        ]),
      );
    } finally {
      await value.sql.end();
    }
  });

  it("keeps actionable deliveries independent of create-edit-delete arrival order", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      const revisions = (externalMessageId: string) => [
        revisionEvent({
          providerEventId: `${externalMessageId}-create`,
          externalMessageId,
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
        revisionEvent({
          providerEventId: `${externalMessageId}-edit`,
          externalMessageId,
          operation: "edited",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "2",
        }),
        revisionEvent({
          providerEventId: `${externalMessageId}-delete`,
          externalMessageId,
          operation: "deleted",
          occurredAt: "2026-08-19T00:00:03.000Z",
          revisionKey: "3",
        }),
      ];
      for (const event of revisions("ordered")) await inbox.ingest(value.imBindingId, 1, event);
      for (const event of revisions("reversed").reverse()) await inbox.ingest(value.imBindingId, 1, event);

      const messages = await value.database.select().from(imMessages);
      expect(messages).toHaveLength(6);
      for (const externalMessageId of ["ordered", "reversed"]) {
        const current = messages
          .filter((message) => message.externalMessageId === externalMessageId)
          .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())[0];
        expect(current?.operation).toBe("deleted");
      }
      const deliveries = await value.database
        .select({
          operation: imMessages.operation,
          externalMessageId: imMessages.externalMessageId,
          state: imMessageDeliveries.state,
        })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId));
      expect(deliveries.filter((delivery) => delivery.state === "pending")).toEqual(
        expect.arrayContaining([
          { externalMessageId: "ordered", operation: "deleted", state: "pending" },
          { externalMessageId: "reversed", operation: "deleted", state: "pending" },
        ]),
      );
      expect(deliveries.filter((delivery) => delivery.state === "pending")).toHaveLength(2);
    } finally {
      await value.sql.end();
    }
  });

  it("serializes concurrent revisions under one logical message authority", async () => {
    const value = await fixture();
    try {
      const authorityHeld = deferred<void>();
      const releaseAuthority = deferred<void>();
      const olderInbox = new ImMessageInbox(value.database, {
        afterMessageAuthority: async () => {
          authorityHeld.resolve();
          await releaseAuthority.promise;
        },
      });
      const newerInbox = new ImMessageInbox(value.database);
      const older = olderInbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "concurrent-create",
          externalMessageId: "concurrent-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      await authorityHeld.promise;
      let newerSettled = false;
      const newer = newerInbox
        .ingest(
          value.imBindingId,
          1,
          revisionEvent({
            providerEventId: "concurrent-delete",
            externalMessageId: "concurrent-message",
            operation: "deleted",
            occurredAt: "2026-08-19T00:00:02.000Z",
            revisionKey: "2",
          }),
        )
        .finally(() => {
          newerSettled = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(newerSettled).toBe(false);
      releaseAuthority.resolve();
      await Promise.all([older, newer]);

      const deliveries = await value.database
        .select({ operation: imMessages.operation, state: imMessageDeliveries.state })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId));
      expect(deliveries).toEqual(
        expect.arrayContaining([
          { operation: "created", state: "expired" },
          { operation: "deleted", state: "pending" },
        ]),
      );
      expect(deliveries.filter((delivery) => delivery.state === "pending")).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("preserves in-flight delivery custody when a newer revision supersedes it", async () => {
    const value = await fixture();
    try {
      const first = await new ImMessageInbox(value.database).ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "custody-create",
          externalMessageId: "custody-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      const deliveryId = first.deliveryIds[0];
      if (!deliveryId || !first.messageId) throw new Error("Delivery fixture was not created");
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const deliveryGate = deferred<void>();
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: deliveryGate.promise,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      const deliveryRun = imDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      await expect
        .poll(() => runtime.frames.filter((frame) => (frame as { type?: string }).type === "im:deliver").length)
        .toBe(1);
      const newer = await new ImMessageInbox(value.database).ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "custody-delete",
          externalMessageId: "custody-message",
          operation: "deleted",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "2",
        }),
      );
      expect(newer.deliveryIds).toHaveLength(1);
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId)))[0],
      ).toMatchObject({
        state: "expired",
        reason: "superseded_revision",
      });
      deliveryGate.resolve();
      await deliveryRun;
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const turnId = `turn-${deliveryId}`;
      expect(await runtime.domain.getDelivery(deliveryId)).toMatchObject({ turnId, deliveryId });
      await expect(
        runtime.domain.handle(
          turnReportFor({
            agentId: value.agent.id,
            deliveryId,
            placementGeneration: 1,
            sessionId: session.id,
            turnId,
          }),
          runtime.context,
        ),
      ).resolves.toMatchObject({ status: "recorded" });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("preserves in-flight custody when TTL expiry commits before acceptance", async () => {
    const value = await fixture();
    try {
      const admitted = await new ImMessageInbox(value.database).ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "ttl-create",
          externalMessageId: "ttl-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      const deliveryId = admitted.deliveryIds[0];
      if (!deliveryId || !admitted.messageId) throw new Error("TTL fixture was not created");
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const deliveryGate = deferred<void>();
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: deliveryGate.promise,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      const deliveryRun = imDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      await expect
        .poll(() => runtime.frames.filter((frame) => (frame as { type?: string }).type === "im:deliver").length)
        .toBe(1);
      await value.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, deliveryId));
      await imDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "expired",
        reason: "ttl",
      });

      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const turnId = `turn-${deliveryId}`;
      deliveryGate.resolve();
      await deliveryRun;
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "accepted",
        reason: null,
        turnId,
      });
      await expect(
        runtime.domain.handle(
          turnReportFor({
            agentId: value.agent.id,
            deliveryId,
            placementGeneration: 1,
            sessionId: session.id,
            turnId,
          }),
          runtime.context,
        ),
      ).resolves.toMatchObject({ status: "recorded" });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("preserves in-flight custody when capacity eviction commits before acceptance", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      const first = await inbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "capacity-first",
          externalMessageId: "capacity-first-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      const deliveryId = first.deliveryIds[0];
      if (!deliveryId || !first.messageId) throw new Error("Capacity fixture was not created");
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const deliveryGate = deferred<void>();
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: deliveryGate.promise,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      const deliveryRun = imDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      await expect
        .poll(() => runtime.frames.filter((frame) => (frame as { type?: string }).type === "im:deliver").length)
        .toBe(1);
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const fillerMessages = await value.database
        .insert(imMessages)
        .values(
          Array.from({ length: 99 }, (_, index) => ({
            imBindingId: value.imBindingId,
            providerEventId: `capacity-filler-${index}`,
            channelId: "C1",
            externalMessageId: `capacity-filler-message-${index}`,
            providerRevisionKey: "1",
            operation: "created" as const,
            direction: "inbound" as const,
            providerContext: { provider: "slack" as const, channelType: "channel" },
            threadKey: null,
            replyToExternalId: null,
            authorKind: "human" as const,
            authorExternalId: "U_HUMAN",
            authorDisplayName: "Human",
            content: {
              version: 1 as const,
              fallbackText: "filler",
              blocks: [{ type: "text" as const, text: "filler" }],
              truncated: false,
            },
            occurredAt: new Date(`2026-08-19T00:00:01.${String(index + 1).padStart(3, "0")}Z`),
          })),
        )
        .returning({ id: imMessages.id });
      await value.database.insert(imMessageDeliveries).values(
        fillerMessages.map((message) => ({
          messageId: message.id,
          sessionId: session.id,
          attention: "direct" as const,
          placementGeneration: 1,
          expiresAt: new Date("2026-08-26T00:00:00.000Z"),
        })),
      );
      await inbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "capacity-second",
          externalMessageId: "capacity-second-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "1",
        }),
      );
      const [evicted] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, deliveryId));
      expect(evicted).toMatchObject({ state: "expired", reason: "capacity" });
      const turnId = `turn-${deliveryId}`;
      deliveryGate.resolve();
      await deliveryRun;
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId)))[0],
      ).toMatchObject({
        state: "accepted",
        reason: null,
        turnId,
      });
      await expect(
        runtime.domain.handle(
          turnReportFor({
            agentId: value.agent.id,
            deliveryId,
            placementGeneration: 1,
            sessionId: session.id,
            turnId,
          }),
          runtime.context,
        ),
      ).resolves.toMatchObject({ status: "recorded" });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("lazily materializes Slack Thread Sessions from existing, current-direct, or root-direct evidence", async () => {
    const value = await fixture();
    try {
      await value.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, value.agent.id));
      const inbox = new ImMessageInbox(value.database);
      const directRoot = revisionEvent({
        providerEventId: "lazy-root",
        externalMessageId: "2000.100",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      expect((await inbox.ingest(value.imBindingId, 1, directRoot)).deliveryIds).toHaveLength(1);
      expect(await value.database.select().from(sessions)).toEqual([
        expect.objectContaining({ kind: "channel", threadKey: null }),
      ]);

      const firstReply = await inbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "lazy-thread-first",
          externalMessageId: "2000.101",
          rootExternalMessageId: "2000.100",
          occurredAt: "2026-08-19T00:00:02.000Z",
        }),
      );
      const [firstThreadDelivery] = await value.database
        .select({ attention: imMessageDeliveries.attention, sessionId: sessions.id, kind: sessions.kind })
        .from(imMessageDeliveries)
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .where(eq(imMessageDeliveries.id, firstReply.deliveryIds[0] as string));
      expect(firstThreadDelivery).toMatchObject({ attention: "direct", kind: "thread" });

      const followUp = await inbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "lazy-thread-follow-up",
          externalMessageId: "2000.102",
          rootExternalMessageId: "2000.100",
          occurredAt: "2026-08-19T00:00:03.000Z",
        }),
      );
      const [followUpDelivery] = await value.database
        .select({ attention: imMessageDeliveries.attention, sessionId: sessions.id, kind: sessions.kind })
        .from(imMessageDeliveries)
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .where(eq(imMessageDeliveries.id, followUp.deliveryIds[0] as string));
      expect(followUpDelivery).toEqual({
        attention: "direct",
        kind: "thread",
        sessionId: firstThreadDelivery?.sessionId,
      });

      const unrelatedRoot = revisionEvent({
        providerEventId: "unrelated-root",
        externalMessageId: "3000.100",
        operation: "created",
        occurredAt: "2026-08-19T00:00:04.000Z",
        revisionKey: "1",
      });
      unrelatedRoot.mentions = [];
      expect((await inbox.ingest(value.imBindingId, 1, unrelatedRoot)).deliveryIds).toEqual([]);
      expect(
        (
          await inbox.ingest(
            value.imBindingId,
            1,
            slackThreadEvent({
              providerEventId: "unrelated-thread",
              externalMessageId: "3000.101",
              rootExternalMessageId: "3000.100",
              occurredAt: "2026-08-19T00:00:05.000Z",
            }),
          )
        ).deliveryIds,
      ).toEqual([]);

      const otherChannelRoot = revisionEvent({
        providerEventId: "other-channel-root",
        externalMessageId: "3500.100",
        operation: "created",
        occurredAt: "2026-08-19T00:00:05.100Z",
        revisionKey: "1",
      });
      otherChannelRoot.conversation.externalId = "C_OTHER";
      await inbox.ingest(value.imBindingId, 1, otherChannelRoot);
      expect(
        (
          await inbox.ingest(
            value.imBindingId,
            1,
            slackThreadEvent({
              providerEventId: "other-channel-thread",
              externalMessageId: "3500.101",
              rootExternalMessageId: "3500.100",
              occurredAt: "2026-08-19T00:00:05.200Z",
            }),
          )
        ).deliveryIds,
      ).toEqual([]);

      const otherAgent = await new AgentService(value.database).createForWorkspace(
        value.bootstrap.userId,
        value.bootstrap.workspaceId,
        {
          name: "other-assistant",
          displayName: "Other Assistant",
          runtimeProvider: "codex",
          computerId: value.computer.id,
        },
      );
      const otherBindingId = (
        await value.imBindingService.activateSlack(
          {
            intent: "create",
            agentId: otherAgent.id,
            appId: "A2",
            teamId: "T2",
            botUserId: "U_OTHER_BOT",
            grantedBotScopes: [
              "chat:write",
              "app_mentions:read",
              "files:read",
              "im:history",
              "channels:history",
              "groups:history",
              "mpim:history",
            ],
            botAccessToken: "xoxb-other",
            signingSecret: "other-signing-secret",
            installedAt: new Date("2026-08-19T00:00:00.000Z"),
          },
          "B_OTHER_BOT",
        )
      ).imBindingId;
      const otherBindingRoot = revisionEvent({
        providerEventId: "other-binding-root",
        externalMessageId: "3600.100",
        operation: "created",
        occurredAt: "2026-08-19T00:00:05.300Z",
        revisionKey: "1",
      });
      otherBindingRoot.externalAppId = "A2";
      otherBindingRoot.externalTeamId = "T2";
      otherBindingRoot.mentions = [{ externalId: "U_OTHER_BOT", displayName: "Other Assistant" }];
      await inbox.ingest(otherBindingId, 1, otherBindingRoot);
      expect(
        (
          await inbox.ingest(
            value.imBindingId,
            1,
            slackThreadEvent({
              providerEventId: "other-binding-thread",
              externalMessageId: "3600.101",
              rootExternalMessageId: "3600.100",
              occurredAt: "2026-08-19T00:00:05.400Z",
            }),
          )
        ).deliveryIds,
      ).toEqual([]);

      const currentDirect = await inbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "unrelated-thread-direct",
          externalMessageId: "3000.102",
          rootExternalMessageId: "3000.100",
          occurredAt: "2026-08-19T00:00:06.000Z",
          direct: true,
        }),
      );
      expect(
        await value.database
          .select({ kind: sessions.kind, threadKey: sessions.threadKey })
          .from(imMessageDeliveries)
          .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
          .where(eq(imMessageDeliveries.id, currentDirect.deliveryIds[0] as string)),
      ).toEqual([{ kind: "thread", threadKey: "3000.100" }]);
    } finally {
      await value.sql.end();
    }
  });

  it("reconciles a Thread reply that commits before its direct root", async () => {
    const value = await fixture();
    try {
      await value.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, value.agent.id));
      const replyHeld = deferred<void>();
      const releaseReply = deferred<void>();
      const replyInbox = new ImMessageInbox(value.database, {
        afterMessageAuthority: async () => {
          replyHeld.resolve();
          await releaseReply.promise;
        },
      });
      const replyRun = replyInbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "reordered-thread-reply",
          externalMessageId: "2100.101",
          rootExternalMessageId: "2100.100",
          occurredAt: "2026-08-19T00:00:02.000Z",
        }),
      );
      await replyHeld.promise;

      let rootSettled = false;
      const rootRun = new ImMessageInbox(value.database)
        .ingest(
          value.imBindingId,
          1,
          revisionEvent({
            providerEventId: "reordered-direct-root",
            externalMessageId: "2100.100",
            operation: "created",
            occurredAt: "2026-08-19T00:00:01.000Z",
            revisionKey: "1",
          }),
        )
        .finally(() => {
          rootSettled = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rootSettled).toBe(false);
      releaseReply.resolve();

      const [reply, root] = await Promise.all([replyRun, rootRun]);
      expect(reply.deliveryIds).toEqual([]);
      expect(root.deliveryIds).toHaveLength(1);
      expect(
        await value.database
          .select({ attention: imMessageDeliveries.attention, kind: sessions.kind, threadKey: sessions.threadKey })
          .from(imMessageDeliveries)
          .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
          .where(eq(imMessageDeliveries.messageId, reply.messageId as string)),
      ).toEqual([{ attention: "direct", kind: "thread", threadKey: "2100.100" }]);
    } finally {
      await value.sql.end();
    }
  });

  it("uses only a reliable Feishu rootId for implicit Thread admission", async () => {
    const value = await unboundFixture();
    try {
      const imBindingId = await value.imBindingService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_1",
        teamId: "workspace_1",
        botOpenId: "ou_bot",
        teamBrand: "feishu",
        appSecret: "secret",
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
      });
      const inbox = new ImMessageInbox(value.database);
      const root = revisionEvent({
        providerEventId: "feishu-root",
        externalMessageId: "om_root",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      root.externalAppId = "cli_1";
      root.externalTeamId = "workspace_1";
      root.providerContext = { provider: "feishu", chatType: "group" };
      root.mentions = [{ externalId: "ou_bot", displayName: "Assistant" }];
      await inbox.ingest(imBindingId, 1, root);

      const reliable = revisionEvent({
        providerEventId: "feishu-thread-reliable",
        externalMessageId: "om_reply",
        operation: "created",
        occurredAt: "2026-08-19T00:00:02.000Z",
        revisionKey: "1",
      });
      reliable.externalAppId = "cli_1";
      reliable.externalTeamId = "workspace_1";
      reliable.providerContext = { provider: "feishu", chatType: "group", threadId: "omt_1", rootId: "om_root" };
      reliable.message.threadKey = "omt_1";
      reliable.mentions = [];
      expect((await inbox.ingest(imBindingId, 1, reliable)).deliveryIds).toHaveLength(1);

      const secondRoot = {
        ...root,
        providerEventId: "feishu-root-2",
        message: { ...root.message, externalId: "om_root_2" },
      };
      await inbox.ingest(imBindingId, 1, secondRoot);
      const missingRoot = revisionEvent({
        providerEventId: "feishu-thread-missing-root",
        externalMessageId: "om_reply_2",
        operation: "created",
        occurredAt: "2026-08-19T00:00:04.000Z",
        revisionKey: "1",
      });
      missingRoot.externalAppId = "cli_1";
      missingRoot.externalTeamId = "workspace_1";
      missingRoot.providerContext = {
        provider: "feishu",
        chatType: "group",
        threadId: "omt_2",
        parentId: "om_root_2",
      };
      missingRoot.message.threadKey = "omt_2";
      missingRoot.mentions = [];
      expect((await inbox.ingest(imBindingId, 1, missingRoot)).deliveryIds).toEqual([]);
      missingRoot.providerEventId = "feishu-thread-current-direct";
      missingRoot.message = { ...missingRoot.message, externalId: "om_reply_3" };
      missingRoot.mentions = [{ externalId: "ou_bot", displayName: "Assistant" }];
      expect((await inbox.ingest(imBindingId, 1, missingRoot)).deliveryIds).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("inherits an unknown Feishu revision when only a Thread Session exists", async () => {
    const value = await unboundFixture();
    try {
      const imBindingId = await value.imBindingService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_revision",
        teamId: "workspace_revision",
        botOpenId: "ou_revision_bot",
        teamBrand: "feishu",
        appSecret: "secret",
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
      });
      const inbox = new ImMessageInbox(value.database);
      const created = revisionEvent({
        providerEventId: "feishu-thread-created",
        externalMessageId: "om_thread_message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      created.externalAppId = "cli_revision";
      created.externalTeamId = "workspace_revision";
      created.providerContext = {
        provider: "feishu",
        chatType: "group",
        threadId: "omt_revision",
        rootId: "om_unseen_root",
      };
      created.message.threadKey = "omt_revision";
      created.mentions = [{ externalId: "ou_revision_bot", displayName: "Assistant" }];
      const first = await inbox.ingest(imBindingId, 1, created);
      const [firstTarget] = await value.database
        .select({ sessionId: sessions.id, kind: sessions.kind })
        .from(imMessageDeliveries)
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .where(eq(imMessageDeliveries.id, first.deliveryIds[0] as string));
      expect(firstTarget).toMatchObject({ kind: "thread" });
      expect(await value.database.select().from(sessions).where(eq(sessions.kind, "channel"))).toEqual([]);

      const recalled = revisionEvent({
        providerEventId: "feishu-thread-recalled",
        externalMessageId: "om_thread_message",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:02.000Z",
        revisionKey: "2",
      });
      recalled.externalAppId = "cli_revision";
      recalled.externalTeamId = "workspace_revision";
      recalled.providerContext = { provider: "feishu" };
      recalled.conversation.kind = "unknown";
      recalled.message.threadKey = null;
      recalled.mentions = [];
      const revision = await inbox.ingest(imBindingId, 1, recalled);
      const [revisionTarget] = await value.database
        .select({ sessionId: sessions.id, kind: sessions.kind })
        .from(imMessageDeliveries)
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .where(eq(imMessageDeliveries.id, revision.deliveryIds[0] as string));
      expect(revisionTarget).toEqual(firstTarget);
      expect(
        await value.database
          .select({ threadKey: imMessages.threadKey })
          .from(imMessages)
          .where(eq(imMessages.id, revision.messageId as string)),
      ).toEqual([{ threadKey: "omt_revision" }]);
    } finally {
      await value.sql.end();
    }
  });

  it("keeps all-message Channel ambient fan-out independent and does not implicitly revive ended Threads", async () => {
    const value = await fixture();
    try {
      await value.database.update(agents).set({ receiveMode: "all_message" }).where(eq(agents.id, value.agent.id));
      const inbox = new ImMessageInbox(value.database);
      await inbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "fanout-root",
          externalMessageId: "4000.100",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      const admission = await inbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "fanout-thread",
          externalMessageId: "4000.101",
          rootExternalMessageId: "4000.100",
          occurredAt: "2026-08-19T00:00:02.000Z",
        }),
      );
      const scopes = await value.database
        .select({ attention: imMessageDeliveries.attention, kind: sessions.kind, threadKey: sessions.threadKey })
        .from(imMessageDeliveries)
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .where(eq(imMessageDeliveries.messageId, admission.messageId as string));
      expect(scopes).toEqual(
        expect.arrayContaining([
          { attention: "direct", kind: "thread", threadKey: "4000.100" },
          { attention: "ambient", kind: "channel", threadKey: null },
        ]),
      );
      const thread = await value.database
        .select()
        .from(sessions)
        .where(and(eq(sessions.kind, "thread"), eq(sessions.threadKey, "4000.100"), isNull(sessions.endedAt)))
        .then((rows) => rows[0]);
      if (!thread) throw new Error("Thread Session fixture was not created");
      await new SessionService(value.database).end(thread.id);

      const unmentioned = await inbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "ended-thread-unmentioned",
          externalMessageId: "4000.102",
          rootExternalMessageId: "4000.100",
          occurredAt: "2026-08-19T00:00:03.000Z",
        }),
      );
      expect(
        await value.database
          .select({ attention: imMessageDeliveries.attention, kind: sessions.kind })
          .from(imMessageDeliveries)
          .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
          .where(eq(imMessageDeliveries.messageId, unmentioned.messageId as string)),
      ).toEqual([{ attention: "ambient", kind: "channel" }]);
      expect(
        await value.database
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.kind, "thread"), eq(sessions.threadKey, "4000.100"), isNull(sessions.endedAt))),
      ).toEqual([]);

      const currentDirect = slackThreadEvent({
        providerEventId: "ended-thread-current-direct",
        externalMessageId: "4000.103",
        rootExternalMessageId: "4000.100",
        occurredAt: "2026-08-19T00:00:04.000Z",
        direct: true,
      });
      expect((await inbox.ingest(value.imBindingId, 1, currentDirect)).deliveryIds).toHaveLength(2);
    } finally {
      await value.sql.end();
    }
  });

  it("converges concurrent first Thread admissions on one active Session and placement", async () => {
    const value = await fixture();
    try {
      await value.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, value.agent.id));
      const inbox = new ImMessageInbox(value.database);
      await inbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "concurrent-root",
          externalMessageId: "6000.100",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      const admissions = await Promise.all([
        inbox.ingest(
          value.imBindingId,
          1,
          slackThreadEvent({
            providerEventId: "concurrent-thread-a",
            externalMessageId: "6000.101",
            rootExternalMessageId: "6000.100",
            occurredAt: "2026-08-19T00:00:02.000Z",
          }),
        ),
        inbox.ingest(
          value.imBindingId,
          1,
          slackThreadEvent({
            providerEventId: "concurrent-thread-b",
            externalMessageId: "6000.102",
            rootExternalMessageId: "6000.100",
            occurredAt: "2026-08-19T00:00:03.000Z",
          }),
        ),
      ]);
      expect(admissions.every((admission) => admission.deliveryIds.length === 1)).toBe(true);
      const threadRows = await value.database
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.kind, "thread"), eq(sessions.threadKey, "6000.100"), isNull(sessions.endedAt)));
      expect(threadRows).toHaveLength(1);
      expect(
        await value.database
          .select({ sessionId: sessionPlacements.sessionId })
          .from(sessionPlacements)
          .where(eq(sessionPlacements.sessionId, threadRows[0]?.id as string)),
      ).toHaveLength(1);
      expect(
        await value.database
          .select({ sessionId: imMessageDeliveries.sessionId })
          .from(imMessageDeliveries)
          .where(
            inArray(
              imMessageDeliveries.id,
              admissions.flatMap((admission) => admission.deliveryIds),
            ),
          ),
      ).toEqual([{ sessionId: threadRows[0]?.id }, { sessionId: threadRows[0]?.id }]);
    } finally {
      await value.sql.end();
    }
  });

  it("bootstraps a cold Thread delivery with root and same-thread inbound history", async () => {
    const value = await fixture();
    try {
      await value.database.update(agents).set({ receiveMode: "all_message" }).where(eq(agents.id, value.agent.id));
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      const inbox = new ImMessageInbox(value.database);
      const rootEvent = revisionEvent({
        providerEventId: "history-root",
        externalMessageId: "7000.100",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      rootEvent.message.content = {
        version: 1,
        fallbackText: "root message",
        blocks: [{ type: "text", text: "root message" }],
        truncated: false,
      };
      const root = await inbox.ingest(value.imBindingId, 1, rootEvent);
      const rootEditEvent = revisionEvent({
        providerEventId: "history-root-edit",
        externalMessageId: "7000.100",
        operation: "edited",
        occurredAt: "2026-08-19T00:00:01.500Z",
        revisionKey: "2",
      });
      rootEditEvent.message.content = {
        version: 1,
        fallbackText: "edited root message",
        blocks: [{ type: "text", text: "edited root message" }],
        truncated: false,
      };
      const rootEdit = await inbox.ingest(value.imBindingId, 1, rootEditEvent);
      const firstThread = await inbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "history-thread-first",
          externalMessageId: "7000.101",
          rootExternalMessageId: "7000.100",
          occurredAt: "2026-08-19T00:00:02.000Z",
          text: "first thread message",
        }),
      );
      const firstThreadDeleteEvent = revisionEvent({
        providerEventId: "history-thread-first-delete",
        externalMessageId: "7000.101",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:02.250Z",
        revisionKey: "2",
      });
      firstThreadDeleteEvent.conversation.kind = "unknown";
      firstThreadDeleteEvent.message.threadKey = null;
      firstThreadDeleteEvent.mentions = [];
      const firstThreadDelete = await inbox.ingest(value.imBindingId, 1, firstThreadDeleteEvent);
      const sibling = await inbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "history-sibling",
          externalMessageId: "8000.101",
          rootExternalMessageId: "8000.100",
          occurredAt: "2026-08-19T00:00:02.500Z",
          text: "sibling thread message",
        }),
      );
      await value.database
        .update(imMessageDeliveries)
        .set({ state: "expired", reason: "history_fixture" })
        .where(
          inArray(
            imMessageDeliveries.messageId,
            [
              root.messageId,
              rootEdit.messageId,
              firstThread.messageId,
              firstThreadDelete.messageId,
              sibling.messageId,
            ].filter((messageId): messageId is string => messageId !== undefined),
          ),
        );
      await inbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "history-thread-current",
          externalMessageId: "7000.102",
          rootExternalMessageId: "7000.100",
          occurredAt: "2026-08-19T00:00:03.000Z",
          text: "deleted current thread message",
        }),
      );
      const currentDeleteEvent = slackThreadEvent({
        providerEventId: "history-thread-current-delete",
        externalMessageId: "7000.102",
        rootExternalMessageId: "7000.100",
        occurredAt: "2026-08-19T00:00:03.250Z",
        text: "deleted current thread message",
      });
      currentDeleteEvent.message.operation = "deleted";
      currentDeleteEvent.message.revisionKey = "2";
      const current = await inbox.ingest(value.imBindingId, 1, currentDeleteEvent);
      const currentDeliveries = await value.database
        .select({ id: imMessageDeliveries.id, kind: sessions.kind })
        .from(imMessageDeliveries)
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .where(eq(imMessageDeliveries.messageId, current.messageId as string));
      const threadDelivery = currentDeliveries.find((delivery) => delivery.kind === "thread");
      if (!threadDelivery) throw new Error("Current Thread delivery fixture was not created");
      await value.database
        .update(imMessageDeliveries)
        .set({ state: "expired", reason: "history_fixture" })
        .where(
          inArray(
            imMessageDeliveries.id,
            currentDeliveries.filter((delivery) => delivery.kind !== "thread").map((delivery) => delivery.id),
          ),
        );

      await imDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      const delivered = runtime.frames.find(
        (frame) =>
          (frame as { type?: string; deliveryId?: string }).type === "im:deliver" &&
          (frame as { deliveryId?: string }).deliveryId === threadDelivery.id,
      ) as DirectImMessageDeliveryRequest | undefined;
      expect(delivered?.content.text).toBe("[deleted]");
      expect(delivered?.content.history).toEqual([
        expect.objectContaining({
          imMessageId: rootEdit.messageId,
          occurredAt: "2026-08-19T00:00:01.500Z",
          text: "edited root message",
          providerRef: expect.objectContaining({ provider: "slack", messageTs: "7000.100" }),
        }),
        expect.objectContaining({
          imMessageId: firstThreadDelete.messageId,
          occurredAt: "2026-08-19T00:00:02.250Z",
          text: "[deleted]",
          providerRef: expect.objectContaining({
            provider: "slack",
            messageTs: "7000.101",
          }),
        }),
      ]);
      const serializedHistory = JSON.stringify(delivered?.content.history);
      expect(serializedHistory).not.toContain('"text":"root message"');
      expect(serializedHistory).not.toContain("first thread message");
      expect(serializedHistory).not.toContain("deleted current thread message");
      expect(serializedHistory).not.toContain("sibling thread message");
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("reserves the verified root beyond the rolling Thread history item cap", async () => {
    const value = await fixture();
    try {
      await value.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, value.agent.id));
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      const inbox = new ImMessageInbox(value.database);
      const rootEvent = revisionEvent({
        providerEventId: "history-cap-root",
        externalMessageId: "7100.100",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      rootEvent.message.content = {
        version: 1,
        fallbackText: "reserved root message",
        blocks: [{ type: "text", text: "reserved root message" }],
        truncated: false,
      };
      const root = await inbox.ingest(value.imBindingId, 1, rootEvent);
      const priorMessageIds = [root.messageId];
      for (let index = 0; index < 101; index += 1) {
        const reply = await inbox.ingest(
          value.imBindingId,
          1,
          slackThreadEvent({
            providerEventId: `history-cap-thread-${index}`,
            externalMessageId: `7100.${index + 101}`,
            rootExternalMessageId: "7100.100",
            occurredAt: new Date(Date.parse("2026-08-19T00:00:02.000Z") + index * 1_000).toISOString(),
            text: `boundary thread message ${index}`,
          }),
        );
        priorMessageIds.push(reply.messageId);
      }
      await value.database
        .update(imMessageDeliveries)
        .set({ state: "expired", reason: "history_fixture" })
        .where(
          inArray(
            imMessageDeliveries.messageId,
            priorMessageIds.filter((messageId): messageId is string => messageId !== undefined),
          ),
        );
      const current = await inbox.ingest(
        value.imBindingId,
        1,
        slackThreadEvent({
          providerEventId: "history-cap-current",
          externalMessageId: "7100.999",
          rootExternalMessageId: "7100.100",
          occurredAt: "2026-08-19T00:03:00.000Z",
          text: "current message after history cap",
        }),
      );
      const [currentDelivery] = await value.database
        .select({ id: imMessageDeliveries.id })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.messageId, current.messageId as string));
      if (!currentDelivery) throw new Error("Current Thread delivery fixture was not created");

      await imDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      const delivered = runtime.frames.find(
        (frame) =>
          (frame as { type?: string; deliveryId?: string }).type === "im:deliver" &&
          (frame as { deliveryId?: string }).deliveryId === currentDelivery.id,
      ) as DirectImMessageDeliveryRequest | undefined;
      expect(delivered?.content.history).toHaveLength(100);
      expect(delivered?.content.history?.[0]).toEqual(expect.objectContaining({ text: "reserved root message" }));
      expect(delivered?.content.history?.[1]).toEqual(expect.objectContaining({ text: "boundary thread message 2" }));
      expect(delivered?.content.history?.[99]).toEqual(
        expect.objectContaining({ text: "boundary thread message 100" }),
      );
      expect(delivered?.content.historyTruncated).toBe(true);
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("inherits DM scope for a Feishu recall without guessing provider fields", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      const created = revisionEvent({
        providerEventId: "dm-create",
        externalMessageId: "dm-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      created.conversation = { externalId: "DM1", kind: "dm" };
      created.mentions = [];
      await inbox.ingest(value.imBindingId, 1, created);
      const recalled = revisionEvent({
        providerEventId: "dm-recall",
        externalMessageId: "dm-message",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:02.000Z",
        revisionKey: "2",
      });
      recalled.conversation = { externalId: "DM1", kind: "unknown" };
      recalled.mentions = [];
      const result = await inbox.ingest(value.imBindingId, 1, recalled);
      const [message] = await value.database
        .select()
        .from(imMessages)
        .where(eq(imMessages.id, result.messageId as string));
      expect(message).toMatchObject({ threadKey: null, operation: "deleted" });
      expect(message).not.toHaveProperty("conversationKind");
      expect(result.deliveryIds).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("inherits thread scope for a Feishu recall and targets the existing thread Session", async () => {
    const value = await fixture();
    try {
      await value.database.update(agents).set({ receiveMode: "all_message" }).where(eq(agents.id, value.agent.id));
      const inbox = new ImMessageInbox(value.database);
      const created = revisionEvent({
        providerEventId: "thread-create",
        externalMessageId: "thread-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      created.message.threadKey = "thread-root";
      await inbox.ingest(value.imBindingId, 1, created);
      const recalled = revisionEvent({
        providerEventId: "thread-recall",
        externalMessageId: "thread-message",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:02.000Z",
        revisionKey: "2",
      });
      recalled.conversation.kind = "unknown";
      recalled.message.threadKey = null;
      recalled.mentions = [];
      const result = await inbox.ingest(value.imBindingId, 1, recalled);
      const [message] = await value.database
        .select()
        .from(imMessages)
        .where(eq(imMessages.id, result.messageId as string));
      expect(message).toMatchObject({ threadKey: "thread-root", operation: "deleted" });
      expect(message).not.toHaveProperty("conversationKind");
      const deliveryScopes = await value.database
        .select({ kind: sessions.kind, threadKey: sessions.threadKey })
        .from(imMessageDeliveries)
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .where(eq(imMessageDeliveries.messageId, result.messageId as string));
      expect(deliveryScopes).toEqual(
        expect.arrayContaining([
          { kind: "thread", threadKey: "thread-root" },
          { kind: "channel", threadKey: null },
        ]),
      );
    } finally {
      await value.sql.end();
    }
  });

  it("stores recall-before-create history without inventing a Session or delivery", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      const recalled = revisionEvent({
        providerEventId: "early-recall",
        externalMessageId: "early-message",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:02.000Z",
        revisionKey: "2",
      });
      recalled.conversation.kind = "unknown";
      recalled.mentions = [];
      const recallResult = await inbox.ingest(value.imBindingId, 1, recalled);
      expect(recallResult.deliveryIds).toEqual([]);
      const created = revisionEvent({
        providerEventId: "late-create",
        externalMessageId: "early-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      const createResult = await inbox.ingest(value.imBindingId, 1, created);
      expect(createResult.deliveryIds).toEqual([]);
      expect(await value.database.select().from(sessions)).toEqual([]);
      expect(await value.database.select().from(imMessageDeliveries)).toEqual([]);
      const messages = await value.database.select().from(imMessages);
      expect(messages.find((message) => message.id === recallResult.messageId)).toMatchObject({
        operation: "deleted",
      });
      expect(messages.find((message) => message.id === recallResult.messageId)).not.toHaveProperty("conversationKind");
    } finally {
      await value.sql.end();
    }
  });

  it("keeps pending delivery durable across a failed worker and accepts it after restart", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-worker"));
      const registry = { currentInstanceId: () => instanceId };
      const failedDomain = {
        requestReconcile: dispatchedRuntimeFailure(new Error("runtime unavailable")),
        requestDelivery: vi.fn(),
      };
      await imDeliveryWorker({
        database: value.database,
        registry: registry as never,
        domain: failedDomain as never,
      }).runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]?.state).toBe("pending");

      await value.database.update(imMessageDeliveries).set({ nextAttemptAt: new Date(0) });
      const recovered = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      await imDeliveryWorker({
        database: value.database,
        registry: recovered.registry,
        domain: recovered.domain,
      }).runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({ state: "accepted" });
      expect(recovered.frames).toEqual([
        expect.objectContaining({ type: "session:reconcile" }),
        expect.objectContaining({
          type: "im:deliver",
          attention: "direct",
          runtime: expect.objectContaining({}),
        }),
      ]);
      recovered.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("advances both effective revisions when an existing Session receives each Agent config update", async () => {
    const value = await fixture();
    const clientHome = await mkdtemp(resolve(tmpdir(), "opentag-im-config-update-"));
    const owners: RuntimeDomainOwner[] = [];
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(runtime.domain);
      const inbox = new ImMessageInbox(value.database);
      const clientStore = await createClientSessionBindingStore(clientHome);
      const service = new AgentService(value.database);
      let currentAgent = value.agent;
      let previousSequence = 0;

      const deliverAndRecord = async (event: NormalizedInboundImEvent) => {
        const before = runtime.frames.length;
        await inbox.ingest(value.imBindingId, 1, event);
        await imDeliveryWorker({
          database: value.database,
          registry: runtime.registry,
          domain: runtime.domain,
        }).runOnce();
        const request = runtime.frames
          .slice(before)
          .find(
            (frame): frame is DirectImMessageDeliveryRequest =>
              typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
          );
        if (!request) throw new Error("Updated Agent delivery was not dispatched");
        await clientStore.prepare(
          {
            type: "session:reconcile",
            requestId: crypto.randomUUID(),
            computerId: value.computer.id,
            sessionId: request.sessionId,
            agentId: request.agentId,
            placementGeneration: request.placementGeneration,
            desired: "ready",
            runtime: request.runtime,
          },
          computeRuntimeSnapshotHashes(request.runtime),
        );
        const turnId = `turn-${request.deliveryId}`;
        await expect(
          runtime.domain.handle(
            turnReportFor({
              agentId: request.agentId,
              deliveryId: request.deliveryId,
              placementGeneration: request.placementGeneration,
              sessionId: request.sessionId,
              turnId,
            }),
            runtime.context,
          ),
        ).resolves.toMatchObject({ status: "recorded" });
        return request.runtime;
      };

      const initial = await deliverAndRecord(inbound("Ev-config-initial"));
      previousSequence = initial.revision.session.sequence;
      const changes: Array<{
        expected: Record<string, unknown>;
        runtimeConfig: NonNullable<UpdateAgentRequest["runtimeConfig"]>;
      }> = [
        { runtimeConfig: { model: "gpt-5" }, expected: { model: "gpt-5" } },
        { runtimeConfig: { reasoningEffort: "high" }, expected: { reasoningEffort: "high" } },
        { runtimeConfig: { instructions: "Updated instructions." }, expected: {} },
        { runtimeConfig: { maxDurationMs: 45_000 }, expected: { budget: { maxDurationMs: 45_000 } } },
      ];
      for (const [index, change] of changes.entries()) {
        currentAgent = await service.updateById(value.bootstrap.userId, value.agent.id, {
          expectedRevision: currentAgent.revision,
          runtimeConfig: change.runtimeConfig,
        });
        const snapshot = await deliverAndRecord(
          revisionEvent({
            providerEventId: `Ev-config-${index}`,
            externalMessageId: `config-message-${index}`,
            operation: "created",
            occurredAt: `2026-08-19T00:00:0${index + 2}.000Z`,
            revisionKey: "1",
          }),
        );
        expect(snapshot).toMatchObject(change.expected);
        if ("instructions" in change.runtimeConfig) {
          expect(snapshot.instructions.agent).toBe(change.runtimeConfig.instructions);
        }
        expect(snapshot.revision.agent.sequence).toBe(currentAgent.runtimeConfig.revision);
        expect(snapshot.revision.session.sequence).toBe(currentAgent.runtimeConfig.revision);
        expect(snapshot.revision.session.sequence).toBeGreaterThan(previousSequence);
        previousSequence = snapshot.revision.session.sequence;
      }
    } finally {
      for (const owner of owners) owner.close();
      await rm(clientHome, { recursive: true, force: true });
      await value.sql.end();
    }
  });

  it("fences a higher Agent revision until pinned accepted custody recovers and reports", async () => {
    const value = await fixture();
    const clientHome = await mkdtemp(resolve(tmpdir(), "opentag-agent-custody-fence-"));
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const firstClient = await createDurableClientReconciler(clientHome, value.computer.id);
      const first = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: (frame) => firstClient.reconciler.reconcile(frame as unknown as SessionReconcileRequest),
      });
      owners.push(first.domain);
      const inbox = new ImMessageInbox(value.database);
      await inbox.ingest(value.imBindingId, 1, inbound("Ev-agent-fence-accepted"));
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const firstRequest = first.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      if (!firstRequest) throw new Error("Initial Agent custody request was not dispatched");
      const turnId = `turn-${firstRequest.deliveryId}`;
      await firstClient.bindingStore.recordAccepted(firstRequest, computeDirectInputHash(firstRequest), turnId);
      const report = turnReportFor({
        agentId: firstRequest.agentId,
        deliveryId: firstRequest.deliveryId,
        placementGeneration: firstRequest.placementGeneration,
        sessionId: firstRequest.sessionId,
        turnId,
      });
      await firstClient.bindingStore.updateUnresolved(
        firstRequest.agentId,
        firstRequest.sessionId,
        turnId,
        "reporting",
        {
          report,
          resultHash: report.resultHash,
        },
      );
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
        .where(eq(imMessageDeliveries.id, firstRequest.deliveryId));

      const updatedAgent = await new AgentService(value.database).updateById(value.bootstrap.userId, value.agent.id, {
        expectedRevision: value.agent.revision,
        runtimeConfig: { model: "gpt-5-after-custody" },
      });
      const pendingAdmission = await inbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "Ev-agent-fence-pending",
          externalMessageId: "agent-fence-pending",
          operation: "created",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "1",
        }),
      );
      const pendingId = pendingAdmission.deliveryIds[0];
      if (!pendingId) throw new Error("Higher revision pending request was not admitted");
      const [accepted] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, firstRequest.deliveryId));
      if (!accepted?.dispatchRequestId || !accepted.dispatchInputHash || !accepted.inputHash || !accepted.turnId) {
        throw new Error("Accepted Agent custody was not persisted");
      }
      first.domain.close();

      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const rebuiltClient = await createDurableClientReconciler(clientHome, value.computer.id);
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: async (frame) => {
          const result = await rebuiltClient.reconciler.reconcile(frame as unknown as SessionReconcileRequest);
          return result.status === "recovery_required"
            ? {
                ...result,
                retainedReports: [
                  {
                    dispatchRequestId: accepted.dispatchRequestId,
                    deliveryId: accepted.id,
                    inputHash: accepted.inputHash,
                    turnId: accepted.turnId,
                    placementGeneration: accepted.placementGeneration,
                    resultHash: report.resultHash,
                  },
                ],
              }
            : result;
        },
      });
      owners.push(second.domain);
      const worker = imDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      });

      await worker.runOnce();
      expect(second.frames).toEqual([]);
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, pendingId)))[0],
      ).toMatchObject({ attemptCount: 0, state: "pending" });

      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, firstRequest.deliveryId));
      await worker.runOnce();
      const recovery = second.frames[0] as SessionReconcileRequest | undefined;
      expect(recovery).toMatchObject({ type: "session:reconcile", runtime: firstRequest.runtime });
      expect(rebuiltClient.reconciler.getAgent(value.agent.id)?.revisionSequence).toBe(
        firstRequest.runtime.revision.agent.sequence,
      );
      await expect(second.domain.handle(report, second.context)).resolves.toMatchObject({ status: "recorded" });
      await rebuiltClient.bindingStore.recordResult(value.agent.id, firstRequest.sessionId, turnId, report.resultHash);
      expect(rebuiltClient.reconciler.clearRecovery(firstRequest.sessionId, turnId)).toBe(true);

      const beforePending = second.frames.length;
      await worker.runOnce();
      const pendingFrames = second.frames.slice(beforePending);
      expect(pendingFrames).toEqual([
        expect.objectContaining({
          type: "session:reconcile",
          runtime: expect.objectContaining({
            model: "gpt-5-after-custody",
            revision: {
              agent: expect.objectContaining({ sequence: updatedAgent.runtimeConfig.revision }),
              session: expect.objectContaining({ sequence: updatedAgent.runtimeConfig.revision }),
            },
          }),
        }),
        expect.objectContaining({ type: "im:deliver", deliveryId: pendingId }),
      ]);
      expect(rebuiltClient.reconciler.getAgent(value.agent.id)?.revisionSequence).toBe(
        updatedAgent.runtimeConfig.revision,
      );
    } finally {
      for (const owner of owners) owner.close();
      await rm(clientHome, { recursive: true, force: true });
      await value.sql.end();
    }
  });

  it("rechecks Agent custody after claim before a higher revision can reach runtime side effects", async () => {
    const value = await fixture();
    const clientHome = await mkdtemp(resolve(tmpdir(), "opentag-agent-custody-claim-race-"));
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const inbox = new ImMessageInbox(value.database);
      const firstAdmission = await inbox.ingest(value.imBindingId, 1, inbound("Ev-agent-claim-race-accepted"));
      const firstDeliveryId = firstAdmission.deliveryIds[0];
      if (!firstDeliveryId || !firstAdmission.messageId) throw new Error("Race fixture was not admitted");
      const [firstDelivery] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, firstDeliveryId));
      if (!firstDelivery) throw new Error("Race delivery was not persisted");
      const assembler = new EffectiveRuntimeSnapshotAssembler(value.database);
      const pinnedRuntime = await assembler.assembleForSession(firstDelivery.sessionId);
      const firstRequest: DirectImMessageDeliveryRequest = {
        type: "im:deliver",
        requestId: crypto.randomUUID(),
        deliveryId: firstDelivery.id,
        imMessageId: firstDelivery.messageId,
        sessionId: firstDelivery.sessionId,
        agentId: value.agent.id,
        placementGeneration: firstDelivery.placementGeneration,
        attention: firstDelivery.attention,
        content: {
          kind: "text",
          text: "late accepted input",
          providerRef: {
            provider: "slack",
            appId: "A1",
            teamId: "T1",
            botUserId: "U_BOT",
            channelId: "C1",
            messageTs: "1000.1",
          },
        },
        runtime: pinnedRuntime,
        deadlineAt: firstDelivery.expiresAt.toISOString(),
      };
      const firstClient = await createDurableClientReconciler(clientHome, value.computer.id);
      await expect(
        firstClient.reconciler.reconcile({
          type: "session:reconcile",
          requestId: crypto.randomUUID(),
          computerId: value.computer.id,
          sessionId: firstRequest.sessionId,
          agentId: firstRequest.agentId,
          placementGeneration: firstRequest.placementGeneration,
          desired: "ready",
          runtime: firstRequest.runtime,
        }),
      ).resolves.toMatchObject({ status: "ready" });
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
        .where(eq(imMessageDeliveries.id, firstDelivery.id));

      const updatedAgent = await new AgentService(value.database).updateById(value.bootstrap.userId, value.agent.id, {
        expectedRevision: value.agent.revision,
        runtimeConfig: { model: "gpt-5-after-late-accept" },
      });
      const secondAdmission = await inbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "Ev-agent-claim-race-pending",
          externalMessageId: "agent-claim-race-pending",
          operation: "created",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "1",
        }),
      );
      const secondDeliveryId = secondAdmission.deliveryIds[0];
      if (!secondDeliveryId) throw new Error("Higher revision race delivery was not admitted");

      const assemblerEntered = deferred<void>();
      const releaseAssembler = deferred<void>();
      const guardedAssembler = {
        assembleForSession: async (sessionId: string) => {
          const runtime = await assembler.assembleForSession(sessionId);
          assemblerEntered.resolve();
          await releaseAssembler.promise;
          return runtime;
        },
      };
      const oldDomain = { requestReconcile: vi.fn(), requestDelivery: vi.fn() };
      const oldRegistry = { currentInstanceId: () => firstInstanceId };
      const racingRun = new ImDeliveryWorker({
        assembler: guardedAssembler,
        database: value.database,
        domain: oldDomain as never,
        registry: oldRegistry as never,
      }).runOnce();
      await assemblerEntered.promise;
      expect(
        (
          await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, secondDeliveryId))
        )[0],
      ).toMatchObject({ lastErrorCode: expect.stringMatching(/^IM_DELIVERY_CLAIM_[A-F0-9]{32}$/) });

      const firstInputHash = computeDirectInputHash(firstRequest);
      const custody = new PostgresRuntimeCustodyStore(value.database);
      const firstContext = {
        computerId: value.computer.id,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        instanceId: firstInstanceId,
        signal: new AbortController().signal,
      };
      await expect(custody.beginDeliveryDispatch(firstRequest, firstInputHash, firstContext)).resolves.toBe(
        "dispatched",
      );
      const turnId = `turn-${firstRequest.deliveryId}`;
      await expect(custody.acceptDelivery(firstRequest, firstInputHash, turnId, firstContext)).resolves.toBe(
        "accepted",
      );
      await firstClient.bindingStore.recordAccepted(firstRequest, firstInputHash, turnId);
      const report = turnReportFor({
        agentId: firstRequest.agentId,
        deliveryId: firstRequest.deliveryId,
        placementGeneration: firstRequest.placementGeneration,
        sessionId: firstRequest.sessionId,
        turnId,
      });
      await firstClient.bindingStore.updateUnresolved(
        firstRequest.agentId,
        firstRequest.sessionId,
        turnId,
        "reporting",
        { report, resultHash: report.resultHash },
      );
      const [accepted] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, firstDelivery.id));
      if (!accepted?.dispatchRequestId || !accepted.inputHash || !accepted.turnId) {
        throw new Error("Late accepted custody was not persisted");
      }

      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const rebuiltClient = await createDurableClientReconciler(clientHome, value.computer.id);
      const recovered = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: async (frame) => {
          const result = await rebuiltClient.reconciler.reconcile(frame as unknown as SessionReconcileRequest);
          return result.status === "recovery_required"
            ? {
                ...result,
                retainedReports: [
                  {
                    dispatchRequestId: accepted.dispatchRequestId,
                    deliveryId: accepted.id,
                    inputHash: accepted.inputHash,
                    turnId: accepted.turnId,
                    placementGeneration: accepted.placementGeneration,
                    resultHash: report.resultHash,
                  },
                ],
              }
            : result;
        },
      });
      owners.push(recovered.domain);
      releaseAssembler.resolve();
      await racingRun;
      expect(oldDomain.requestReconcile).not.toHaveBeenCalled();
      expect(oldDomain.requestDelivery).not.toHaveBeenCalled();
      expect(
        (
          await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, secondDeliveryId))
        )[0],
      ).toMatchObject({ lastErrorCode: "IM_DELIVERY_AGENT_CUSTODY_FENCED", state: "pending" });

      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, firstDelivery.id));
      const recoveryWorker = imDeliveryWorker({
        database: value.database,
        registry: recovered.registry,
        domain: recovered.domain,
      });
      await recoveryWorker.runOnce();
      expect(recovered.frames[0]).toMatchObject({ type: "session:reconcile", runtime: pinnedRuntime });
      await expect(recovered.domain.handle(report, recovered.context)).resolves.toMatchObject({ status: "recorded" });
      await rebuiltClient.bindingStore.recordResult(value.agent.id, firstRequest.sessionId, turnId, report.resultHash);
      expect(rebuiltClient.reconciler.clearRecovery(firstRequest.sessionId, turnId)).toBe(true);

      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, secondDeliveryId));
      const beforePending = recovered.frames.length;
      await recoveryWorker.runOnce();
      expect(recovered.frames.slice(beforePending)).toEqual([
        expect.objectContaining({
          type: "session:reconcile",
          runtime: expect.objectContaining({
            model: "gpt-5-after-late-accept",
            revision: {
              agent: expect.objectContaining({ sequence: updatedAgent.runtimeConfig.revision }),
              session: expect.objectContaining({ sequence: updatedAgent.runtimeConfig.revision }),
            },
          }),
        }),
        expect.objectContaining({ type: "im:deliver", deliveryId: secondDeliveryId }),
      ]);
    } finally {
      for (const owner of owners) owner.close();
      await rm(clientHome, { recursive: true, force: true });
      await value.sql.end();
    }
  });

  it("renews an active claim lease and fences same-Agent work across workers", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const inbox = new ImMessageInbox(value.database);
      const firstAdmission = await inbox.ingest(value.imBindingId, 1, inbound("Ev-owned-claim-first"));
      const firstDeliveryId = firstAdmission.deliveryIds[0];
      if (!firstDeliveryId) throw new Error("Owned claim fixture was not admitted");
      const reconcileEntered = deferred<void>();
      const releaseReconcile = deferred<void>();
      const firstDomain = {
        requestReconcile: vi.fn(
          async (_computerId: string, _instanceId: string, _request: unknown, onDispatched?: () => void) => {
            onDispatched?.();
            reconcileEntered.resolve();
            await releaseReconcile.promise;
            return { status: "ready" };
          },
        ),
        requestDelivery: dispatchedRuntimeResult({
          status: "rejected",
          reason: "configuration_unsupported",
        }),
      };
      const firstWorker = imDeliveryWorker({
        database: value.database,
        registry: { currentInstanceId: () => instanceId } as never,
        domain: firstDomain as never,
        claimLeaseMs: 300,
        claimRenewMs: 50,
      });
      const firstRun = firstWorker.runOnce();
      await reconcileEntered.promise;
      const [claimed] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, firstDeliveryId));
      expect(claimed?.lastErrorCode).toMatch(/^IM_DELIVERY_CLAIM_[A-F0-9]{32}$/);

      await new AgentService(value.database).updateById(value.bootstrap.userId, value.agent.id, {
        expectedRevision: value.agent.revision,
        runtimeConfig: { model: "gpt-5-owned-claim" },
      });
      const secondAdmission = await inbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "Ev-owned-claim-second",
          externalMessageId: "owned-claim-second",
          operation: "created",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "1",
        }),
      );
      const secondDeliveryId = secondAdmission.deliveryIds[0];
      if (!secondDeliveryId) throw new Error("Same-Agent fenced fixture was not admitted");

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
      const [renewedClaim] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, firstDeliveryId));
      expect(renewedClaim?.nextAttemptAt.getTime()).toBeGreaterThan(claimed?.nextAttemptAt.getTime() ?? 0);
      const secondDomain = { requestReconcile: vi.fn(), requestDelivery: vi.fn() };
      const secondWorker = imDeliveryWorker({
        database: value.database,
        registry: { currentInstanceId: () => undefined } as never,
        domain: secondDomain as never,
      });
      await secondWorker.runOnce();
      expect(firstDomain.requestReconcile).toHaveBeenCalledTimes(1);
      expect(secondDomain.requestReconcile).not.toHaveBeenCalled();
      expect(secondDomain.requestDelivery).not.toHaveBeenCalled();
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, firstDeliveryId)))[0]
          ?.lastErrorCode,
      ).toBe(claimed?.lastErrorCode);
      expect(
        (
          await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, secondDeliveryId))
        )[0],
      ).toMatchObject({ attemptCount: 0, state: "pending" });

      releaseReconcile.resolve();
      await firstRun;
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, firstDeliveryId)))[0],
      ).toMatchObject({ lastErrorCode: "IM_DELIVERY_TERMINAL", state: "terminal_rejected" });
      await secondWorker.runOnce();
      expect(
        (
          await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, secondDeliveryId))
        )[0],
      ).toMatchObject({ attemptCount: 1, lastErrorCode: "IM_DELIVERY_RUNTIME_UNAVAILABLE", state: "pending" });
    } finally {
      await value.sql.end();
    }
  });

  /**
   * The dispatch guard is `!instanceId || row.computer.currentInstanceId !== instanceId`. The first
   * disjunct — no runtime connected at all — is covered above. This pins the second: a runtime IS
   * connected, but the persisted enrollment still names a superseded instance, so it is the persisted
   * column that withholds the dispatch. De-persisting it would make this disjunct vacuous and silently
   * let a superseded generation be served.
   */
  it("withholds delivery when the persisted instance disagrees with the connected runtime", async () => {
    const value = await fixture();
    try {
      const supersededInstanceId = crypto.randomUUID();
      const liveInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: supersededInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const admission = await new ImMessageInbox(value.database).ingest(
        value.imBindingId,
        1,
        inbound("Ev-persisted-instance-fence"),
      );
      const deliveryId = admission.deliveryIds[0];
      if (!deliveryId) throw new Error("Persisted instance fence fixture was not admitted");

      const domain = { requestReconcile: vi.fn(), requestDelivery: vi.fn() };
      await imDeliveryWorker({
        database: value.database,
        registry: { currentInstanceId: () => liveInstanceId } as never,
        domain: domain as never,
      }).runOnce();

      expect(domain.requestReconcile).not.toHaveBeenCalled();
      expect(domain.requestDelivery).not.toHaveBeenCalled();
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId)))[0],
      ).toMatchObject({ attemptCount: 1, lastErrorCode: "IM_DELIVERY_RUNTIME_UNAVAILABLE", state: "pending" });
    } finally {
      await value.sql.end();
    }
  });
  it("does not let a pending delivery for an ended Session fence another active Session of the Agent", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const inbox = new ImMessageInbox(value.database);
      const endedAdmission = await inbox.ingest(value.imBindingId, 1, inbound("Ev-ended-session-pending"));
      const endedDeliveryId = endedAdmission.deliveryIds[0];
      if (!endedDeliveryId) throw new Error("Ended Session fixture was not admitted");
      const [endedDelivery] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, endedDeliveryId));
      if (!endedDelivery) throw new Error("Ended Session delivery was not found");
      await value.database
        .update(sessions)
        .set({ endedAt: new Date() })
        .where(eq(sessions.id, endedDelivery.sessionId));

      const activeAdmission = await inbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "Ev-active-session-pending",
          externalMessageId: "active-session-pending",
          operation: "created",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "1",
        }),
      );
      const activeDeliveryId = activeAdmission.deliveryIds[0];
      if (!activeDeliveryId) throw new Error("Active Session fixture was not admitted");

      const worker = imDeliveryWorker({
        database: value.database,
        registry: { currentInstanceId: () => instanceId } as never,
        domain: {
          requestReconcile: dispatchedRuntimeResult({ status: "ready" }),
          requestDelivery: dispatchedRuntimeResult({
            status: "rejected",
            reason: "configuration_unsupported",
          }),
        } as never,
      });
      await worker.runOnce();

      const [stillEnded] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, endedDeliveryId));
      const [processedActive] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, activeDeliveryId));
      expect(stillEnded).toMatchObject({ attemptCount: 0, lastErrorCode: null, state: "pending" });
      expect(processedActive).toMatchObject({ attemptCount: 1, state: "terminal_rejected" });
    } finally {
      await value.sql.end();
    }
  });

  it.each(["pending", "accepted"] as const)(
    "rejects a schema-valid %s payload mutation that no longer matches custody hashes",
    async (state) => {
      const value = await fixture();
      try {
        const instanceId = crypto.randomUUID();
        await value.database
          .update(workspaceComputers)
          .set({ currentInstanceId: instanceId })
          .where(eq(workspaceComputers.id, value.workspaceComputer.id));
        await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound(`Ev-payload-hash-${state}`));
        const runtime = await respondingRuntime({
          acceptDeliveries: state === "accepted",
          database: value.database,
          computerId: value.computer.id,
          instanceId,
          requestTimeoutMs: 100,
          workspaceComputerId: value.workspaceComputer.id,
          workspaceId: value.bootstrap.workspaceId,
        });
        const worker = imDeliveryWorker({
          database: value.database,
          registry: runtime.registry,
          domain: runtime.domain,
        });
        await worker.runOnce();
        const [stored] = await value.database.select().from(imMessageDeliveries);
        if (!stored?.dispatchPayload) throw new Error("Custody payload was not persisted");
        await value.database
          .update(imMessageDeliveries)
          .set({
            dispatchPayload: {
              ...stored.dispatchPayload,
              runtime: { ...stored.dispatchPayload.runtime, model: "schema-valid-tampering" },
            },
            nextAttemptAt: new Date(0),
          })
          .where(eq(imMessageDeliveries.id, stored.id));
        const beforeRetry = runtime.frames.length;
        await worker.runOnce();
        expect(runtime.frames).toHaveLength(beforeRetry);
        expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
          lastErrorCode:
            state === "accepted" ? "IM_DELIVERY_RECOVERY_PAYLOAD_INVALID" : "IM_DELIVERY_DISPATCH_PAYLOAD_INVALID",
          state,
        });
        runtime.domain.close();
      } finally {
        await value.sql.end();
      }
    },
  );

  it("expires a never-dispatched delivery even after reconcile increased its attempt count", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-reconcile-expiry"));
      const failedDomain = {
        requestReconcile: dispatchedRuntimeFailure(new Error("reconcile failed before dispatch")),
        requestDelivery: vi.fn(),
      };
      const registry = { currentInstanceId: () => instanceId };
      const worker = imDeliveryWorker({
        database: value.database,
        registry: registry as never,
        domain: failedDomain as never,
      });
      await worker.runOnce();
      const [failed] = await value.database.select().from(imMessageDeliveries);
      expect(failed).toMatchObject({
        attemptCount: 1,
        dispatchRequestId: null,
        state: "pending",
      });
      await value.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(0), nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, failed?.id as string));
      await worker.runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "expired",
        reason: "ttl",
        dispatchRequestId: null,
      });
      expect(failedDomain.requestDelivery).not.toHaveBeenCalled();
    } finally {
      await value.sql.end();
    }
  });

  it("recovers accepted custody and retained Turn reports across rebuilt Server owners", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-custody-restart"));
      const first = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(first.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (
        !accepted?.turnId ||
        !accepted.dispatchRequestId ||
        !accepted.dispatchInputHash ||
        !accepted.dispatchPayload
      ) {
        throw new Error("Accepted delivery fixture was not persisted");
      }
      const pinnedRuntime = accepted.dispatchPayload.runtime;
      const report = turnReportFor({
        agentId: value.agent.id,
        deliveryId: accepted.id,
        placementGeneration: accepted.placementGeneration,
        sessionId: accepted.sessionId,
        turnId: accepted.turnId,
      });
      const updatedAgent = await new AgentService(value.database).updateById(value.bootstrap.userId, value.agent.id, {
        expectedRevision: value.agent.revision,
        runtimeConfig: { model: "gpt-5-after-accept" },
      });
      expect(updatedAgent.runtimeConfig.revision).toBeGreaterThan(pinnedRuntime.revision.session.sequence);
      first.domain.close();

      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, accepted.id));
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: "recovery_required",
          reason: "unresolved_turn",
          turn: { deliveryId: report.deliveryId, turnId: report.turnId },
          retainedReports: [
            {
              dispatchRequestId: accepted.dispatchRequestId,
              deliveryId: report.deliveryId,
              inputHash: accepted.dispatchInputHash,
              turnId: report.turnId,
              placementGeneration: report.placementGeneration,
              resultHash: report.resultHash,
            },
          ],
        }),
      });
      owners.push(second.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      const recoveryReconcile = second.frames.find(
        (frame): frame is Record<string, unknown> & { runtime: DirectImMessageDeliveryRequest["runtime"] } =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "session:reconcile",
      );
      expect(recoveryReconcile?.runtime).toEqual(pinnedRuntime);
      expect(await second.domain.getDelivery(accepted.id)).toMatchObject({ instanceId: secondInstanceId });
      await expect(second.domain.handle(report, second.context)).resolves.toMatchObject({ status: "recorded" });
      expect(await second.domain.getTurn(report.turnId)).toMatchObject({ resultHash: report.resultHash });
      expect((await value.database.select().from(imMessageDeliveries))[0]?.dispatchPayload).toBeNull();
      second.domain.close();

      const thirdInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: thirdInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const third = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: thirdInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(third.domain);
      await expect(
        third.domain.handle({ ...report, requestId: crypto.randomUUID() }, third.context),
      ).resolves.toMatchObject({ status: "already_recorded" });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("uses a diagnostic best-effort assembler fallback only for legacy accepted rows without payload", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-legacy-recovery"));
      const first = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(first.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (!accepted) throw new Error("Legacy accepted fixture was not persisted");
      await value.database
        .update(imMessageDeliveries)
        .set({ dispatchPayload: null, nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, accepted.id));
      first.domain.close();

      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(second.domain);
      const diagnostic = vi.fn();
      await imDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
        onDiagnostic: diagnostic,
      }).runOnce();
      expect(diagnostic).toHaveBeenCalledWith("IM_DELIVERY_RECOVERY_LEGACY_SNAPSHOT_FALLBACK");
      expect(second.frames).toEqual([
        expect.objectContaining({
          type: "session:reconcile",
          runtime: expect.objectContaining({ agentId: value.agent.id }),
        }),
      ]);
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it.each(["pending", "expired"] as const)(
    "recovers a retained Client Turn from a %s dispatch after rebuilding the Server owner",
    async (durableState) => {
      const value = await fixture();
      const owners: RuntimeDomainOwner[] = [];
      try {
        const firstInstanceId = crypto.randomUUID();
        await value.database
          .update(workspaceComputers)
          .set({ currentInstanceId: firstInstanceId })
          .where(eq(workspaceComputers.id, value.workspaceComputer.id));
        await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound(`Ev-retained-${durableState}`));
        const first = await respondingRuntime({
          acceptDeliveries: false,
          database: value.database,
          computerId: value.computer.id,
          instanceId: firstInstanceId,
          requestTimeoutMs: 100,
          workspaceComputerId: value.workspaceComputer.id,
          workspaceId: value.bootstrap.workspaceId,
        });
        owners.push(first.domain);
        await imDeliveryWorker({
          database: value.database,
          registry: first.registry,
          domain: first.domain,
        }).runOnce();
        const firstFrame = first.frames.find(
          (frame): frame is DirectImMessageDeliveryRequest =>
            typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
        );
        if (!firstFrame) throw new Error("Initial delivery frame was not dispatched");
        const turnId = `turn-${durableState}-retained`;
        const report = turnReportFor({
          agentId: firstFrame.agentId,
          deliveryId: firstFrame.deliveryId,
          placementGeneration: firstFrame.placementGeneration,
          sessionId: firstFrame.sessionId,
          turnId,
        });

        if (durableState === "expired") {
          await value.database
            .update(imMessageDeliveries)
            .set({ expiresAt: new Date(0), nextAttemptAt: new Date(0) })
            .where(eq(imMessageDeliveries.id, firstFrame.deliveryId));
          const expiryDomain = {
            requestReconcile: dispatchedRuntimeResult({ status: "recovery_required" }),
            requestDelivery: vi.fn(),
          };
          await imDeliveryWorker({
            database: value.database,
            registry: first.registry,
            domain: expiryDomain as never,
          }).runOnce();
          expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
            dispatchRequestId: firstFrame.requestId,
            state: "expired",
          });
          expect(expiryDomain.requestDelivery).not.toHaveBeenCalled();
        }
        first.domain.close();

        const secondInstanceId = crypto.randomUUID();
        await value.database
          .update(workspaceComputers)
          .set({ currentInstanceId: secondInstanceId })
          .where(eq(workspaceComputers.id, value.workspaceComputer.id));
        await value.database
          .update(imMessageDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(imMessageDeliveries.id, firstFrame.deliveryId));
        const second = await respondingRuntime({
          database: value.database,
          computerId: value.computer.id,
          instanceId: secondInstanceId,
          workspaceComputerId: value.workspaceComputer.id,
          workspaceId: value.bootstrap.workspaceId,
          reconcileResult: (frame) => ({
            type: "session:reconcile:result",
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            placementGeneration: frame.placementGeneration,
            status: "recovery_required",
            reason: "unresolved_turn",
            turn: { deliveryId: firstFrame.deliveryId, turnId },
            retainedReports: [
              {
                dispatchRequestId: firstFrame.requestId,
                deliveryId: firstFrame.deliveryId,
                inputHash: computeDirectInputHash(firstFrame),
                turnId,
                placementGeneration: firstFrame.placementGeneration,
                resultHash: report.resultHash,
              },
            ],
          }),
        });
        owners.push(second.domain);
        await imDeliveryWorker({
          database: value.database,
          registry: second.registry,
          domain: second.domain,
        }).runOnce();
        expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
        expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
          dispatchPayload: firstFrame,
          reportOwnerInstanceId: secondInstanceId,
          state: "accepted",
          turnId,
        });
        await expect(second.domain.handle(report, second.context)).resolves.toMatchObject({ status: "recorded" });
        expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
          dispatchPayload: null,
          reportedAt: expect.any(Date),
          state: "accepted",
          turnId,
        });
      } finally {
        for (const owner of owners) owner.close();
        await value.sql.end();
      }
    },
  );

  it("releases an unclaimed persisted dispatch before creating one fresh attempt", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-immutable-dispatch"));
      const first = await respondingRuntime({
        acceptDeliveries: false,
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        requestTimeoutMs: 100,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(first.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const firstFrame = first.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      if (!firstFrame) throw new Error("Initial delivery frame was not dispatched");
      first.domain.close();

      await value.database
        .update(agentRuntimeConfigs)
        .set({ revision: firstFrame.runtime.revision.agent.sequence + 1 })
        .where(eq(agentRuntimeConfigs.agentId, value.agent.id));
      await value.database
        .update(sessions)
        .set({ revision: firstFrame.runtime.revision.session.sequence + 1 })
        .where(eq(sessions.id, firstFrame.sessionId));
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, firstFrame.deliveryId));
      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(second.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchInputHash: null,
        dispatchPayload: null,
        dispatchRequestId: null,
        state: "pending",
      });

      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, firstFrame.deliveryId));
      await imDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      const replacement = second.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      expect(replacement).toMatchObject({
        deliveryId: firstFrame.deliveryId,
        runtime: {
          revision: {
            agent: { sequence: firstFrame.runtime.revision.agent.sequence + 1 },
            session: { sequence: firstFrame.runtime.revision.session.sequence + 1 },
          },
        },
      });
      expect(replacement?.requestId).not.toBe(firstFrame.requestId);
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toHaveLength(1);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "accepted",
        turnId: `turn-${firstFrame.deliveryId}`,
      });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("binds a pending delivery to a moved placement before send", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-move-before-send"));
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      await new SessionService(value.database).movePlacement(session.id, value.workspaceComputer.id);
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      await imDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      expect(runtime.frames).toEqual([
        expect.objectContaining({ type: "session:reconcile", placementGeneration: 2 }),
        expect.objectContaining({ type: "im:deliver", placementGeneration: 2 }),
      ]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "accepted",
        placementGeneration: 2,
      });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("rejects placement movement until an in-flight delivery reports", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-move-awaiting"));
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const gate = deferred<void>();
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: gate.promise,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      const run = imDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      await expect.poll(() => runtime.frames.length).toBe(2);
      const sessionService = new SessionService(value.database);
      await expect(sessionService.movePlacement(session.id, value.workspaceComputer.id)).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN",
      });
      gate.resolve();
      await run;
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (!accepted?.turnId) throw new Error("Accepted custody was not persisted");
      await expect(sessionService.movePlacement(session.id, value.workspaceComputer.id)).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_PENDING",
      });
      const report = turnReportFor({
        agentId: value.agent.id,
        deliveryId: accepted.id,
        placementGeneration: accepted.placementGeneration,
        sessionId: accepted.sessionId,
        turnId: accepted.turnId,
      });
      await expect(runtime.domain.handle(report, runtime.context)).resolves.toMatchObject({ status: "recorded" });
      await expect(sessionService.movePlacement(session.id, value.workspaceComputer.id)).resolves.toMatchObject({
        generation: 2,
      });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("requires old-placement reconciliation before moving a pending dispatch", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-move-persisted-pending"));
      const first = await respondingRuntime({
        acceptDeliveries: false,
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        requestTimeoutMs: 100,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(first.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const oldRequest = first.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      if (!oldRequest) throw new Error("Old generation dispatch was not persisted");
      first.domain.close();

      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.workspaceComputer.id),
      ).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN",
      });

      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: "rejected",
          reason: "session_binding_conflict",
        }),
      });
      owners.push(second.domain);
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await imDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchRequestId: oldRequest.requestId,
        placementGeneration: 1,
        state: "pending",
      });
      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.workspaceComputer.id),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN" });
      second.domain.close();

      const thirdInstanceId = crypto.randomUUID();
      const conflictingReport = turnReportFor({
        agentId: oldRequest.agentId,
        deliveryId: oldRequest.deliveryId,
        placementGeneration: oldRequest.placementGeneration,
        sessionId: oldRequest.sessionId,
        turnId: "turn-conflicting-retained-claim",
      });
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: thirdInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const third = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: thirdInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: "ready",
          retainedReports: [
            {
              dispatchRequestId: oldRequest.requestId,
              deliveryId: oldRequest.deliveryId,
              inputHash: "f".repeat(64),
              turnId: conflictingReport.turnId,
              placementGeneration: oldRequest.placementGeneration,
              resultHash: conflictingReport.resultHash,
            },
          ],
        }),
      });
      owners.push(third.domain);
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await imDeliveryWorker({
        database: value.database,
        registry: third.registry,
        domain: third.domain,
      }).runOnce();
      expect(third.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchRequestId: oldRequest.requestId,
        lastErrorCode: "IM_DELIVERY_RETAINED_CUSTODY_CONFLICT",
        placementGeneration: 1,
        state: "pending",
      });
      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.workspaceComputer.id),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN" });
      third.domain.close();

      const fourthInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: fourthInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const fourth = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: fourthInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(fourth.domain);
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await imDeliveryWorker({
        database: value.database,
        registry: fourth.registry,
        domain: fourth.domain,
      }).runOnce();
      expect(fourth.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchRequestId: null,
        dispatchPayload: null,
        placementGeneration: 1,
        state: "pending",
      });
      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.workspaceComputer.id),
      ).resolves.toMatchObject({ generation: 2 });
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await imDeliveryWorker({
        database: value.database,
        registry: fourth.registry,
        domain: fourth.domain,
      }).runOnce();
      const newRequest = fourth.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      expect(newRequest).toMatchObject({ deliveryId: oldRequest.deliveryId, placementGeneration: 2 });
      expect(newRequest?.requestId).not.toBe(oldRequest.requestId);
      expect(fourth.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toHaveLength(1);
      const custody = new PostgresRuntimeCustodyStore(value.database);
      await expect(
        custody.acceptDelivery(oldRequest, computeDirectInputHash(oldRequest), "turn-old-generation", first.context),
      ).resolves.toBe("stale_generation");
      if (!newRequest) throw new Error("New generation dispatch was not sent");
      const staleReport = turnReportFor({
        agentId: oldRequest.agentId,
        deliveryId: oldRequest.deliveryId,
        placementGeneration: oldRequest.placementGeneration,
        sessionId: oldRequest.sessionId,
        turnId: `turn-${newRequest.deliveryId}`,
      });
      await expect(fourth.domain.handle(staleReport, fourth.context)).resolves.toMatchObject({
        status: "stale_generation",
      });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("requires old-placement reconciliation before moving an expired dispatch", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-move-persisted-expired"));
      const first = await respondingRuntime({
        acceptDeliveries: false,
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        requestTimeoutMs: 100,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(first.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const oldRequest = first.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      if (!oldRequest) throw new Error("Old generation dispatch was not persisted");
      await value.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(0), nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: {
          requestReconcile: dispatchedRuntimeResult({ status: "recovery_required" }),
          requestDelivery: vi.fn(),
        } as never,
      }).runOnce();
      first.domain.close();

      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.workspaceComputer.id),
      ).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN",
      });
      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(second.domain);
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await imDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchInputHash: null,
        dispatchPayload: null,
        dispatchRequestId: null,
        state: "expired",
      });
      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.workspaceComputer.id),
      ).resolves.toMatchObject({ generation: 2 });
      await expect(
        new PostgresRuntimeCustodyStore(value.database).acceptDelivery(
          oldRequest,
          computeDirectInputHash(oldRequest),
          "turn-expired-old-generation",
          first.context,
        ),
      ).resolves.toBe("stale_generation");
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("rejects placement migration while accepted custody is still unreported", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-move-accepted"));
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(runtime.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (!accepted?.turnId) throw new Error("Accepted custody was not persisted");
      expect(accepted.dispatchPayload).not.toBeNull();
      const sessionsService = new SessionService(value.database);
      await expect(sessionsService.movePlacement(accepted.sessionId, value.workspaceComputer.id)).rejects.toMatchObject(
        {
          code: "SESSION_PLACEMENT_CUSTODY_PENDING",
        },
      );
      const report = turnReportFor({
        agentId: value.agent.id,
        deliveryId: accepted.id,
        placementGeneration: accepted.placementGeneration,
        sessionId: accepted.sessionId,
        turnId: accepted.turnId,
      });
      await expect(runtime.domain.handle(report, runtime.context)).resolves.toMatchObject({ status: "recorded" });
      expect((await value.database.select().from(imMessageDeliveries))[0]?.dispatchPayload).toBeNull();
      await expect(
        sessionsService.movePlacement(accepted.sessionId, value.workspaceComputer.id),
      ).resolves.toMatchObject({
        generation: 2,
      });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("rejects placement migration after the Client durably accepts but loses its accepted frame", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    const clientHome = await mkdtemp(resolve(tmpdir(), "opentag-im-client-custody-"));
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound("Ev-client-custody-lost-frame"));
      const first = await respondingRuntime({
        acceptDeliveries: false,
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        requestTimeoutMs: 100,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(first.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const dispatched = first.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      if (!dispatched) throw new Error("The Client custody fixture was not dispatched");

      const clientStore = await createClientSessionBindingStore(clientHome);
      await clientStore.prepare(
        {
          type: "session:reconcile",
          requestId: crypto.randomUUID(),
          computerId: value.computer.id,
          sessionId: dispatched.sessionId,
          agentId: dispatched.agentId,
          placementGeneration: dispatched.placementGeneration,
          desired: "ready",
          runtime: dispatched.runtime,
        },
        computeRuntimeSnapshotHashes(dispatched.runtime),
      );
      const inputHash = computeDirectInputHash(dispatched);
      const turnId = `turn-client-${dispatched.deliveryId}`;
      const report = turnReportFor({
        agentId: dispatched.agentId,
        deliveryId: dispatched.deliveryId,
        placementGeneration: dispatched.placementGeneration,
        sessionId: dispatched.sessionId,
        turnId,
      });
      await clientStore.recordAccepted(dispatched, inputHash, turnId);
      await clientStore.updateUnresolved(dispatched.agentId, dispatched.sessionId, turnId, "reporting", {
        report,
        resultHash: report.resultHash,
      });
      expect((await clientStore.read(dispatched.agentId, dispatched.sessionId))?.unresolvedTurn).toMatchObject({
        deliveryId: dispatched.deliveryId,
        phase: "reporting",
        turnId,
      });
      await expect(
        new SessionService(value.database).movePlacement(dispatched.sessionId, value.workspaceComputer.id),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN" });
      first.domain.close();

      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, dispatched.deliveryId));
      const retained = await clientStore.read(dispatched.agentId, dispatched.sessionId);
      if (!retained?.unresolvedTurn?.resultHash) throw new Error("The Client retained report was not persisted");
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: "recovery_required",
          reason: "unresolved_turn",
          turn: { deliveryId: dispatched.deliveryId, turnId },
          retainedReports: [
            {
              dispatchRequestId: retained.unresolvedTurn?.requestId,
              deliveryId: dispatched.deliveryId,
              inputHash: retained.unresolvedTurn?.inputHash,
              turnId,
              placementGeneration: dispatched.placementGeneration,
              resultHash: retained.unresolvedTurn?.resultHash,
            },
          ],
        }),
      });
      owners.push(second.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      await expect(second.domain.handle(report, second.context)).resolves.toMatchObject({ status: "recorded" });
      await clientStore.recordResult(dispatched.agentId, dispatched.sessionId, turnId, report.resultHash);
      await expect(
        new SessionService(value.database).movePlacement(dispatched.sessionId, value.workspaceComputer.id),
      ).resolves.toMatchObject({ generation: 2 });
      expect((await clientStore.read(dispatched.agentId, dispatched.sessionId))?.unresolvedTurn).toBeUndefined();
    } finally {
      for (const owner of owners) owner.close();
      await rm(clientHome, { recursive: true, force: true });
      await value.sql.end();
    }
  });

  it.each(["accepted-result", "retained-claim"] as const)(
    "serializes placement movement with a concurrent %s custody transition",
    async (transition) => {
      const value = await fixture();
      const owners: RuntimeDomainOwner[] = [];
      try {
        const instanceId = crypto.randomUUID();
        await value.database
          .update(workspaceComputers)
          .set({ currentInstanceId: instanceId })
          .where(eq(workspaceComputers.id, value.workspaceComputer.id));
        await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, inbound(`Ev-lock-order-${transition}`));
        const runtime = await respondingRuntime({
          acceptDeliveries: false,
          database: value.database,
          computerId: value.computer.id,
          instanceId,
          requestTimeoutMs: 100,
          workspaceComputerId: value.workspaceComputer.id,
          workspaceId: value.bootstrap.workspaceId,
        });
        owners.push(runtime.domain);
        await imDeliveryWorker({
          database: value.database,
          registry: runtime.registry,
          domain: runtime.domain,
        }).runOnce();
        const dispatched = runtime.frames.find(
          (frame): frame is DirectImMessageDeliveryRequest =>
            typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
        );
        if (!dispatched) throw new Error("The lock-order fixture was not dispatched");
        const placementLocked = deferred<void>();
        const releaseMove = deferred<void>();
        const move = new SessionService(value.database, {
          afterPlacementLock: async () => {
            placementLocked.resolve();
            await releaseMove.promise;
          },
        })
          .movePlacement(dispatched.sessionId, value.workspaceComputer.id)
          .then(
            () => "moved",
            (error: unknown) => (error as { code?: string }).code ?? "failed",
          );
        await placementLocked.promise;

        const custody = new PostgresRuntimeCustodyStore(value.database);
        const inputHash = computeDirectInputHash(dispatched);
        const turnId = `turn-lock-${transition}`;
        const report = turnReportFor({
          agentId: dispatched.agentId,
          deliveryId: dispatched.deliveryId,
          placementGeneration: dispatched.placementGeneration,
          sessionId: dispatched.sessionId,
          turnId,
        });
        const transitionResult =
          transition === "accepted-result"
            ? custody.acceptDelivery(dispatched, inputHash, turnId, runtime.context)
            : custody
                .claimRetainedReports(
                  {
                    type: "session:reconcile",
                    requestId: crypto.randomUUID(),
                    computerId: value.computer.id,
                    sessionId: dispatched.sessionId,
                    agentId: dispatched.agentId,
                    placementGeneration: dispatched.placementGeneration,
                    desired: "ready",
                    runtime: dispatched.runtime,
                  },
                  [
                    {
                      dispatchRequestId: dispatched.requestId,
                      deliveryId: dispatched.deliveryId,
                      inputHash,
                      turnId,
                      placementGeneration: dispatched.placementGeneration,
                      resultHash: report.resultHash,
                    },
                  ],
                  runtime.context,
                )
                .then(() => "claimed" as const);
        releaseMove.resolve();
        const [moveResult, custodyResult] = await settleWithin(Promise.all([move, transitionResult]));
        expect(moveResult).toBe("SESSION_PLACEMENT_CUSTODY_UNCERTAIN");
        expect(custodyResult).toBe(transition === "accepted-result" ? "accepted" : "claimed");
        expect((await value.database.select().from(sessionPlacements))[0]).toMatchObject({ generation: 1 });
        expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
          placementGeneration: 1,
          state: "accepted",
          turnId,
        });
      } finally {
        for (const owner of owners) owner.close();
        await value.sql.end();
      }
    },
  );

  it("claims due report recovery fairly while newer pending deliveries remain due", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const inbox = new ImMessageInbox(value.database);
      await inbox.ingest(value.imBindingId, 1, inbound("Ev-recovery-fair-first"));
      const first = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      });
      owners.push(first.domain);
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (!accepted) throw new Error("Accepted recovery fixture was not persisted");

      await inbox.ingest(
        value.imBindingId,
        1,
        revisionEvent({
          providerEventId: "Ev-recovery-fair-pending",
          externalMessageId: "recovery-fair-pending",
          operation: "created",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "1",
        }),
      );
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, accepted.id));
      const pendingRows = await value.database.select().from(imMessageDeliveries);
      const pending = pendingRows.find((delivery) => delivery.id !== accepted.id);
      if (!pending) throw new Error("Pending fairness fixture was not persisted");
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(1) })
        .where(eq(imMessageDeliveries.id, pending.id));

      const before = first.frames.length;
      await imDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      expect(first.frames.slice(before)).toEqual([expect.objectContaining({ type: "session:reconcile" })]);
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, pending.id)))[0],
      ).toMatchObject({ attemptCount: 0, state: "pending" });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("fences stale placement generations and ends chat Sessions only on explicit replacement", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      await inbox.ingest(value.imBindingId, 1, inbound("Ev1"));
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const sessionService = new SessionService(value.database);
      await expect(sessionService.assertPlacement(session.id, value.workspaceComputer.id, 1)).resolves.toBeUndefined();
      await sessionService.movePlacement(session.id, value.workspaceComputer.id);
      await expect(sessionService.assertPlacement(session.id, value.workspaceComputer.id, 1)).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_STALE",
      });

      const replacementImBindingId = (
        await value.imBindingService.activateSlack(
          {
            intent: "replace",
            agentId: value.agent.id,
            appId: "A2",
            teamId: "T1",
            botUserId: "U_BOT_2",
            grantedBotScopes: [
              "chat:write",
              "app_mentions:read",
              "files:read",
              "im:history",
              "channels:history",
              "groups:history",
              "mpim:history",
            ],
            botAccessToken: "xoxb-replacement",
            signingSecret: "replacement-secret",
            installedAt: new Date(),
          },
          "B_BOT_2",
        )
      ).imBindingId;
      expect(
        (await value.database.select().from(sessions).where(eq(sessions.id, session.id)))[0]?.endedAt,
      ).not.toBeNull();
      expect(await value.database.select().from(imMessages)).toHaveLength(1);
      const imBindingRows = await value.database.select().from(imBindings);
      expect(imBindingRows.find((row) => row.id === value.imBindingId)?.status).toBe("disabled");
      expect(imBindingRows.find((row) => row.id === replacementImBindingId)?.status).toBe("active");
      const rebound = inbound("Ev2");
      rebound.externalAppId = "A2";
      rebound.message.externalId = "1000.2";
      rebound.mentions = [{ externalId: "U_BOT_2", displayName: "Assistant" }];
      await inbox.ingest(replacementImBindingId, 1, rebound);
      const sessionRows = await value.database.select().from(sessions);
      expect(sessionRows).toHaveLength(2);
      expect(sessionRows.find((row) => row.id !== session.id)?.endedAt).toBeNull();
    } finally {
      await value.sql.end();
    }
  });

  it("authorizes lazy resources by Session placement and preserves oversized messages", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(workspaceComputers)
        .set({ currentInstanceId: instanceId })
        .where(eq(workspaceComputers.id, value.workspaceComputer.id));
      const event = inbound("Ev-resource");
      event.message.resources = [
        {
          providerResourceKey: "F1",
          kind: "file",
          filename: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
        },
        {
          providerResourceKey: "F2",
          kind: "file",
          filename: "oversized.bin",
          mediaType: "application/octet-stream",
          sizeBytes: 25 * 1024 * 1024 + 1,
        },
      ];
      const admitted = await new ImMessageInbox(value.database).ingest(value.imBindingId, 1, event);
      if (!admitted.messageId) throw new Error("Resource message fixture was not created");
      const [message] = await value.database.select().from(imMessages).where(eq(imMessages.id, admitted.messageId));
      const [session] = await value.database.select().from(sessions);
      if (!session || !message) throw new Error("Resource fixture was not created");
      expect(message.content.resources?.map((resource) => resource.availability)).toEqual(["available", "too_large"]);

      const resources = new ImResourceService(value.database, async () => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTeamId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({
          stream: Readable.from(Buffer.from("hello world!")),
          filename: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
        }),
      }));
      const runtimeScope = {
        sessionId: session.id,
        computerId: value.computer.id,
        instanceId,
        placementGeneration: 1,
      };
      const opened = await resources.open(computerAuthFor(value), runtimeScope, message.id, 0);
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("hello world!");
      await expect(
        resources.open(
          { ...computerAuthFor(value), workspaceComputerId: crypto.randomUUID() },
          runtimeScope,
          message.id,
          0,
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        resources.open(computerAuthFor(value), { ...runtimeScope, placementGeneration: 2 }, message.id, 0),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(resources.open(computerAuthFor(value), runtimeScope, message.id, 1)).rejects.toMatchObject({
        statusCode: 413,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("reuses one Feishu QR attempt and activates only after candidate validation", async () => {
    const value = await unboundFixture();
    try {
      const completion = deferred<{
        appId: string;
        appSecret: string;
        teamBrand: "feishu";
      }>();
      let aborted = false;
      const registration: FeishuRegistration = {
        qrReady: Promise.resolve({
          url: "https://open.feishu.cn/qr/example",
          expiresAt: new Date(Date.now() + 60_000),
        }),
        result: completion.promise,
        abort: () => {
          aborted = true;
        },
      };
      const gateway: FeishuRegistrationGateway = { start: () => registration };
      let validations = 0;
      const instanceId = crypto.randomUUID();
      const manager = new FeishuConnectionManager({
        database: value.database,
        inbox: new ImMessageInbox(value.database),
        instanceId,
        imBindings: value.imBindingService,
        createAdapter: (input) =>
          ({
            channel: {
              on: () => () => undefined,
              disconnect: async () => undefined,
            },
            validateBinding: async () => {
              validations += 1;
              return {
                externalAppId: input.appId,
                externalTeamId: input.appId,
                externalBotId: "ou_bot",
              };
            },
            listGrantedWorkspaceScopes: async () => [...FEISHU_REQUIRED_TENANT_SCOPES],
          }) as unknown as FeishuAdapter,
        maintenanceMs: 1_000_000,
      });
      const setup = new FeishuSetupService({
        database: value.database,
        cipher: value.cipher,
        instanceId,
        imBindings: value.imBindingService,
        registrations: gateway,
        activation: manager,
      });
      const first = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      const second = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      expect(second.id).toBe(first.id);
      expect(first).toMatchObject({ state: "awaiting_user", qrUrl: "https://open.feishu.cn/qr/example" });
      expect(aborted).toBe(false);

      completion.resolve({
        appId: "cli_1",
        appSecret: "secret",
        teamBrand: "feishu",
      });
      await expect.poll(async () => (await setup.get(value.bootstrap.userId, first.id)).state).toBe("succeeded");
      expect(validations).toBe(1);
      expect(await value.imBindingService.getConfigForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
        identity: { provider: "feishu", appId: "cli_1", botOpenId: "ou_bot", teamId: null },
      });
      const [stored] = await value.database.select().from(imBindings);
      expect(stored?.encryptedSetupContext).toBeNull();
      await manager.stop();
    } finally {
      await value.sql.end();
    }
  });

  it("derives expired and stale Feishu setup projections without mutating rows on GET", async () => {
    const value = await unboundFixture();
    const completion = deferred<{
      appId: string;
      appSecret: string;
      teamBrand: "feishu";
    }>();
    const instanceId = crypto.randomUUID();
    const setup = new FeishuSetupService({
      database: value.database,
      cipher: value.cipher,
      instanceId,
      imBindings: value.imBindingService,
      registrations: {
        start: () => ({
          qrReady: Promise.resolve({
            url: "https://open.feishu.cn/qr/read-only",
            expiresAt: new Date(Date.now() + 60_000),
          }),
          result: completion.promise,
          abort: () => undefined,
        }),
      },
      activation: { activateAtomicAttempt: vi.fn() },
    });
    try {
      const attempt = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      await value.database
        .update(imBindings)
        .set({ setupExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(imBindings.setupAttemptId, attempt.id));
      const [beforeExpired] = await value.database.select().from(imBindings);
      await expect(setup.get(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({
        state: "expired",
        errorCode: "FEISHU_SETUP_EXPIRED",
        qrUrl: null,
      });
      const [afterExpired] = await value.database.select().from(imBindings);
      expect(afterExpired).toEqual(beforeExpired);

      await value.database
        .update(imBindings)
        .set({
          setupExpiresAt: new Date(Date.now() + 60_000),
          setupOwnerHeartbeatAt: new Date(Date.now() - 60_000),
        })
        .where(eq(imBindings.setupAttemptId, attempt.id));
      const [beforeStale] = await value.database.select().from(imBindings);
      await expect(setup.get(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({
        state: "failed",
        errorCode: "FEISHU_SETUP_OWNER_RESTARTED",
        qrUrl: null,
      });
      const [afterStale] = await value.database.select().from(imBindings);
      expect(afterStale).toEqual(beforeStale);
    } finally {
      await setup.stop();
      await value.sql.end();
    }
  });

  it("contains setup completion when activation and failure-state persistence both fail", async () => {
    const value = await unboundFixture();
    let armed = false;
    let completionUpdates = 0;
    const database = new Proxy(value.database, {
      get(target, property) {
        if (property === "update") {
          return (...args: Parameters<typeof target.update>) => {
            if (armed) {
              completionUpdates += 1;
              if (completionUpdates >= 2) throw new Error("database unavailable");
            }
            return target.update(...args);
          };
        }
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const completion = deferred<{
      appId: string;
      appSecret: string;
      teamBrand: "feishu";
    }>();
    const diagnostics: string[] = [];
    const setup = new FeishuSetupService({
      database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindingService,
      registrations: {
        start: () => ({
          qrReady: Promise.resolve({
            url: "https://open.feishu.cn/qr/failure",
            expiresAt: new Date(Date.now() + 60_000),
          }),
          result: completion.promise,
          abort: () => undefined,
        }),
      },
      activation: {
        activateAtomicAttempt: vi.fn().mockRejectedValue(new Error("FEISHU_CONNECTION_ERROR")),
      },
      onDiagnostic: (code) => diagnostics.push(code),
    });
    try {
      await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      armed = true;
      completion.resolve({
        appId: "cli_failure",
        appSecret: "secret",
        teamBrand: "feishu",
      });
      await expect.poll(() => diagnostics).toContain("FEISHU_SETUP_FAILURE_STATE_WRITE_FAILED");
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      armed = false;
      await setup.stop();
      await value.sql.end();
    }
  });

  it("requires a fresh Feishu Channel observation before diagnostics handoff", async () => {
    const value = await unboundFixture();
    try {
      const now = new Date("2026-08-19T00:00:00.000Z");
      let agentRuntimeReady = true;
      let providerCliReady = true;
      const service = new ImBindingService(value.database, value.cipher, {
        now: () => now,
        agentRuntimeReadiness: () => (agentRuntimeReady ? "ready" : "unavailable"),
        imCliReadiness: () => (providerCliReady ? "ready" : "unavailable"),
      });
      const imBindingId = await service.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_diagnostics",
        teamId: "workspace_diagnostics",
        botOpenId: "ou_diagnostics",
        teamBrand: "feishu",
        appSecret: "secret-diagnostics",
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
      });
      const ownerInstanceId = crypto.randomUUID();
      await value.database
        .update(imBindings)
        .set({
          connectionOwnerInstanceId: ownerInstanceId,
          connectionLeaseExpiresAt: new Date("2026-08-19T00:01:00.000Z"),
          observedAt: now,
          observedConnectedAt: null,
        })
        .where(eq(imBindings.id, imBindingId));
      await expect(service.diagnostics(value.bootstrap.userId, imBindingId)).resolves.toMatchObject({
        ready: false,
        agentRuntimeReadiness: "ready",
        providerCliReadiness: "ready",
        connection: { state: "disconnected" },
      });
      await expect(service.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toEqual({
        bindingState: "active",
        handoffReady: false,
      });

      await value.database
        .update(imBindings)
        .set({
          connectionOwnerInstanceId: ownerInstanceId,
          connectionLeaseExpiresAt: new Date("2026-08-18T23:59:59.000Z"),
          observedAt: now,
          observedConnectedAt: now,
        })
        .where(eq(imBindings.id, imBindingId));
      await expect(service.diagnostics(value.bootstrap.userId, imBindingId)).resolves.toMatchObject({
        ready: false,
        connection: { state: "disconnected" },
      });
      await expect(service.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toEqual({
        bindingState: "active",
        handoffReady: false,
      });

      await value.database
        .update(imBindings)
        .set({
          connectionOwnerInstanceId: ownerInstanceId,
          connectionLeaseExpiresAt: new Date("2026-08-19T00:01:00.000Z"),
          observedAt: now,
          observedConnectedAt: now,
        })
        .where(eq(imBindings.id, imBindingId));
      await expect(service.diagnostics(value.bootstrap.userId, imBindingId)).resolves.toMatchObject({
        ready: true,
        agentRuntimeReadiness: "ready",
        providerCliReadiness: "ready",
        connection: { state: "connected" },
      });
      await expect(service.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toEqual({
        bindingState: "active",
        handoffReady: true,
      });

      agentRuntimeReady = false;
      await expect(service.diagnostics(value.bootstrap.userId, imBindingId)).resolves.toMatchObject({
        ready: false,
        agentRuntimeReadiness: "unavailable",
        providerCliReadiness: "ready",
        connection: { state: "connected" },
      });
      await expect(service.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toEqual({
        bindingState: "active",
        handoffReady: false,
      });

      agentRuntimeReady = true;
      providerCliReady = false;
      await expect(service.diagnostics(value.bootstrap.userId, imBindingId)).resolves.toMatchObject({
        ready: false,
        agentRuntimeReadiness: "ready",
        providerCliReadiness: "unavailable",
        connection: { state: "connected" },
      });
    } finally {
      await value.sql.end();
    }
  });

  it("keeps a legacy Feishu binding online until a complete same-App grant is atomically activated", async () => {
    const value = await unboundFixture();
    try {
      const now = new Date();
      const legacyScopes = ["im:message:send_as_bot", "im:message.group_msg"];
      const encryptedCredential = value.cipher.encrypt(
        JSON.stringify({ appId: "cli_legacy", appSecret: "legacy-secret", grantedScopes: legacyScopes }),
      );
      const [legacy] = await value.database
        .insert(imBindings)
        .values({
          agentId: value.agent.id,
          provider: "feishu",
          status: "active",
          externalAppId: "cli_legacy",
          externalTeamId: "workspace_legacy",
          externalBotId: "ou_legacy",
          externalTeamBrand: "feishu",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential,
          grantedCapabilities: legacyScopes,
          connectionOwnerInstanceId: crypto.randomUUID(),
          connectionFencingEpoch: 1,
          connectionLeaseExpiresAt: new Date(now.getTime() + 60_000),
          observedConnectedAt: now,
          observedAt: now,
          activatedAt: now,
        })
        .returning({ id: imBindings.id });
      if (!legacy) throw new Error("Legacy Feishu fixture was not created");
      const [session] = await value.database
        .insert(sessions)
        .values({ imBindingId: legacy.id, channelId: "chat_legacy", conversationKind: "channel", kind: "channel" })
        .returning({ id: sessions.id });
      if (!session) throw new Error("Legacy Session fixture was not created");

      await expect(
        value.imBindingService.activateFeishu({
          agentId: value.agent.id,
          appId: "cli_legacy",
          teamId: "workspace_legacy",
          botOpenId: "ou_legacy",
          teamBrand: "feishu",
          appSecret: "incomplete-secret",
          grantedScopes: legacyScopes,
        }),
      ).rejects.toMatchObject({ code: "IM_BINDING_SCOPE_REAUTH_REQUIRED" });

      await expect(value.imBindingService.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toMatchObject({
        bindingState: "reauthorization_required",
      });
      await expect(
        value.imBindingService.getConfigForAgent(value.bootstrap.userId, value.agent.id),
      ).resolves.toMatchObject({
        reauthorizationRequired: true,
        lastErrorCode: "FEISHU_SCOPE_REAUTH_REQUIRED",
      });
      await expect(value.imBindingService.diagnostics(value.bootstrap.userId, legacy.id)).resolves.toMatchObject({
        ready: false,
        reauthorizationRequired: true,
        connection: { state: "connected" },
        lastErrorCode: "FEISHU_SCOPE_REAUTH_REQUIRED",
      });
      await expect(value.imBindingService.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toEqual({
        bindingState: "reauthorization_required",
        handoffReady: false,
      });
      await expect(value.imBindingService.listFeishuConnectionIds(undefined)).resolves.toContain(legacy.id);
      await expect(value.imBindingService.getFeishuConnectionMaterial(legacy.id)).resolves.toMatchObject({
        appSecret: "legacy-secret",
        generation: 1,
      });
      const [unchanged] = await value.database.select().from(imBindings).where(eq(imBindings.id, legacy.id));
      expect(unchanged).toMatchObject({ status: "active", credentialGeneration: 1, encryptedCredential });

      const activatedId = await value.imBindingService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_legacy",
        teamId: "workspace_legacy",
        botOpenId: "ou_legacy",
        teamBrand: "feishu",
        appSecret: "updated-secret",
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
      });
      expect(activatedId).toBe(legacy.id);
      await expect(
        value.imBindingService.getConfigForAgent(value.bootstrap.userId, value.agent.id),
      ).resolves.toMatchObject({
        bindingState: "active",
        credentialGeneration: 2,
        reauthorizationRequired: false,
      });
      const [preservedSession] = await value.database.select().from(sessions).where(eq(sessions.id, session.id));
      expect(preservedSession?.endedAt).toBeNull();
    } finally {
      await value.sql.end();
    }
  });

  it("rejects same-App Feishu Bot or Workspace identity drift without replacing the binding", async () => {
    const value = await unboundFixture();
    try {
      const scopes = [...FEISHU_REQUIRED_TENANT_SCOPES];
      const imBindingId = await value.imBindingService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_identity",
        teamId: "team_identity",
        botOpenId: "ou_identity",
        teamBrand: "feishu",
        appSecret: "original-secret",
        grantedScopes: scopes,
      });
      const [session] = await value.database
        .insert(sessions)
        .values({ imBindingId, channelId: "chat_identity", conversationKind: "channel", kind: "channel" })
        .returning({ id: sessions.id });
      if (!session) throw new Error("Identity Session fixture was not created");
      const [before] = await value.database.select().from(imBindings).where(eq(imBindings.id, imBindingId));
      if (!before) throw new Error("Identity binding fixture was not created");

      for (const identity of [
        { teamId: "team_identity", botOpenId: "ou_other" },
        { teamId: "workspace_other", botOpenId: "ou_identity" },
      ]) {
        await expect(
          value.imBindingService.activateFeishu({
            agentId: value.agent.id,
            appId: "cli_identity",
            ...identity,
            teamBrand: "feishu",
            appSecret: "candidate-secret",
            grantedScopes: scopes,
          }),
        ).rejects.toMatchObject({
          code: "FEISHU_BINDING_IDENTITY_MISMATCH",
          statusCode: 409,
        });
      }

      const currentRows = await value.database.select().from(imBindings).where(eq(imBindings.agentId, value.agent.id));
      expect(currentRows).toHaveLength(1);
      expect(currentRows[0]).toMatchObject({
        id: imBindingId,
        status: "active",
        externalAppId: before.externalAppId,
        externalTeamId: before.externalTeamId,
        externalBotId: before.externalBotId,
        credentialGeneration: before.credentialGeneration,
        encryptedCredential: before.encryptedCredential,
      });
      const [preservedSession] = await value.database.select().from(sessions).where(eq(sessions.id, session.id));
      expect(preservedSession?.endedAt).toBeNull();
    } finally {
      await value.sql.end();
    }
  });

  it("rejects a Feishu App already owned by another Agent with a stable domain error", async () => {
    const value = await unboundFixture();
    try {
      const secondAgent = await new AgentService(value.database).createForWorkspace(
        value.bootstrap.userId,
        value.bootstrap.workspaceId,
        {
          name: "second-agent",
          displayName: "Second Agent",
          runtimeProvider: "codex",
          computerId: value.computer.id,
        },
      );
      const firstId = await value.imBindingService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_shared",
        teamId: "workspace_shared",
        botOpenId: "ou_shared",
        teamBrand: "feishu",
        appSecret: "first-secret",
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
      });
      await expect(
        value.imBindingService.activateFeishu({
          agentId: secondAgent.id,
          appId: "cli_shared",
          teamId: "workspace_shared",
          botOpenId: "ou_shared",
          teamBrand: "feishu",
          appSecret: "second-secret",
          grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
        }),
      ).rejects.toMatchObject({
        code: "FEISHU_APP_ALREADY_BOUND",
        statusCode: 409,
        message: "The selected Feishu App is already bound to another Agent",
      });
      expect(await value.imBindingService.getForAgent(value.bootstrap.userId, secondAgent.id)).toBeUndefined();

      const completion = deferred<{ appId: string; appSecret: string; teamBrand: "feishu" }>();
      const instanceId = crypto.randomUUID();
      const manager = new FeishuConnectionManager({
        database: value.database,
        inbox: new ImMessageInbox(value.database),
        instanceId,
        imBindings: value.imBindingService,
        createAdapter: () =>
          ({
            channel: { on: () => () => undefined, disconnect: async () => undefined },
            validateBinding: async () => ({
              externalAppId: "cli_shared",
              externalTeamId: "workspace_shared",
              externalBotId: "ou_shared",
            }),
            listGrantedWorkspaceScopes: async () => [...FEISHU_REQUIRED_TENANT_SCOPES],
          }) as unknown as FeishuAdapter,
        maintenanceMs: 1_000_000,
      });
      const setup = new FeishuSetupService({
        database: value.database,
        cipher: value.cipher,
        instanceId,
        imBindings: value.imBindingService,
        registrations: {
          start: () => ({
            qrReady: Promise.resolve({
              url: "https://open.feishu.cn/qr/already-bound",
              expiresAt: new Date(Date.now() + 60_000),
            }),
            result: completion.promise,
            abort: () => undefined,
          }),
        },
        activation: manager,
      });
      const attempt = await setup.createOrReuse(value.bootstrap.userId, secondAgent.id, "create");
      completion.resolve({ appId: "cli_shared", appSecret: "candidate-secret", teamBrand: "feishu" });
      await expect
        .poll(() => setup.get(value.bootstrap.userId, attempt.id))
        .toMatchObject({ state: "failed", errorCode: "FEISHU_APP_ALREADY_BOUND" });
      await manager.stop();
      await expect(value.imBindingService.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toMatchObject({
        id: firstId,
        bindingState: "active",
      });
    } finally {
      await value.sql.end();
    }
  });

  it("builds Feishu resource HTTP capability on a replica that does not own the Channel lease", async () => {
    const value = await unboundFixture();
    try {
      const imBindingId = await value.imBindingService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_http",
        teamId: "workspace_http",
        botOpenId: "ou_http",
        teamBrand: "feishu",
        appSecret: "secret-http",
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
      });
      await value.database
        .update(imBindings)
        .set({
          connectionOwnerInstanceId: crypto.randomUUID(),
          connectionFencingEpoch: 7,
          connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
        })
        .where(eq(imBindings.id, imBindingId));
      const resources: string[] = [];
      const resolver = createImProviderAdapterResolver({
        imBindings: value.imBindingService,
        slackApi: {} as never,
        createFeishuAdapter: (options) =>
          new (class {
            readonly provider = "feishu" as const;
            validateBinding = async () => ({
              externalAppId: options.appId,
              externalTeamId: options.teamId ?? "workspace_http",
              externalBotId: "ou_http",
            });
            normalizeInbound = () => [];
            fetchResource = async () => {
              resources.push(options.appSecret);
              return { stream: Readable.from(Buffer.from("resource")) };
            };
          })(),
      });
      const adapter = await resolver(imBindingId, 1);
      await expect(
        adapter.fetchResource({ messageExternalId: "om_1", providerResourceKey: "file_1", kind: "file" }),
      ).resolves.toMatchObject({ stream: expect.any(Readable) });
      expect(resources).toEqual(["secret-http"]);
    } finally {
      await value.sql.end();
    }
  });

  it("keeps a replacement Feishu ImBinding Workspace unset until its own verified event arrives", async () => {
    const value = await unboundFixture();
    try {
      const scopes = [...FEISHU_REQUIRED_TENANT_SCOPES];
      const oldImBindingId = await value.imBindingService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_old",
        teamId: "workspace_old",
        botOpenId: "ou_old",
        teamBrand: "feishu",
        appSecret: "secret-old",
        grantedScopes: scopes,
      });
      const replacementId = await value.imBindingService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_new",
        teamId: null,
        botOpenId: "ou_new",
        teamBrand: "feishu",
        appSecret: "secret-new",
        grantedScopes: scopes,
      });
      expect(replacementId).not.toBe(oldImBindingId);
      const [replacementBeforeEvent] = await value.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.id, replacementId));
      expect(replacementBeforeEvent?.externalTeamId).toBeNull();
      const event = revisionEvent({
        providerEventId: "new-workspace-event",
        externalMessageId: "new-workspace-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      await expect(
        new ImMessageInbox(value.database).ingest(replacementId, 1, {
          ...event,
          externalAppId: "cli_new",
          externalTeamId: "workspace_new",
        }),
      ).resolves.toMatchObject({ duplicate: false });
      const [replacementAfterEvent] = await value.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.id, replacementId));
      expect(replacementAfterEvent?.externalTeamId).toBe("workspace_new");
    } finally {
      await value.sql.end();
    }
  });

  it("does not persist a Feishu binding when the external Workspace grant omits a requested scope", async () => {
    const value = await unboundFixture();
    const instanceId = crypto.randomUUID();
    const manager = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId,
      imBindings: value.imBindingService,
      createAdapter: () =>
        ({
          channel: { on: () => undefined, disconnect: async () => undefined },
          validateBinding: async () => ({
            externalAppId: "cli_missing_scope",
            externalTeamId: "workspace",
            externalBotId: "ou_bot",
          }),
          listGrantedWorkspaceScopes: async () => ["im:message:send_as_bot"],
        }) as unknown as FeishuAdapter,
      maintenanceMs: 1_000_000,
    });
    try {
      const attemptId = await validatingFeishuAttempt(value.database, value.agent.id, instanceId, "create");
      await expect(
        manager.activateAtomicAttempt({
          attemptId,
          ownerInstanceId: instanceId,
          agentId: value.agent.id,
          appId: "cli_missing_scope",
          appSecret: "secret",
          teamBrand: "feishu",
        }),
      ).rejects.toThrow("FEISHU_SCOPE_REAUTH_REQUIRED");
      await expect(value.imBindingService.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toMatchObject({
        bindingState: "provisioning",
      });
    } finally {
      await manager.stop();
      await value.sql.end();
    }
  });

  it("serializes Feishu setup completion before an admin disable without reversing Agent and binding locks", async () => {
    const value = await unboundFixture();
    const instanceId = crypto.randomUUID();
    const agentLocked = deferred<void>();
    const releaseActivation = deferred<void>();
    const grantedScopes = [...FEISHU_REQUIRED_TENANT_SCOPES];
    const manager = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId,
      imBindings: value.imBindingService,
      createAdapter: () =>
        ({
          channel: { on: () => () => undefined, disconnect: async () => undefined },
          validateBinding: async () => ({
            externalAppId: "cli_activation_race",
            externalTeamId: "workspace_activation_race",
            externalBotId: "ou_activation_race",
          }),
          listGrantedWorkspaceScopes: async () => grantedScopes,
        }) as unknown as FeishuAdapter,
      afterActivationAgentLocked: async () => {
        agentLocked.resolve();
        await releaseActivation.promise;
      },
      maintenanceMs: 1_000_000,
    });
    try {
      const attemptId = await validatingFeishuAttempt(value.database, value.agent.id, instanceId, "create");
      const [slot] = await value.database
        .select({ id: imBindings.id })
        .from(imBindings)
        .where(eq(imBindings.setupAttemptId, attemptId));
      if (!slot) throw new Error("Setup slot fixture was not created");

      const activation = manager.activateAtomicAttempt({
        attemptId,
        ownerInstanceId: instanceId,
        agentId: value.agent.id,
        appId: "cli_activation_race",
        appSecret: "secret",
        teamBrand: "feishu",
      });
      await agentLocked.promise;

      let disableSettled = false;
      const disable = value.imBindingService.disable(value.bootstrap.userId, slot.id).finally(() => {
        disableSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(disableSettled).toBe(false);

      releaseActivation.resolve();
      await expect(activation).resolves.toMatchObject({ appId: "cli_activation_race" });
      await expect(disable).resolves.toBeUndefined();
      const [finalBinding] = await value.database.select().from(imBindings).where(eq(imBindings.id, slot.id));
      expect(finalBinding).toMatchObject({ status: "disabled", setupState: "succeeded" });
    } finally {
      releaseActivation.resolve();
      await manager.stop();
      await value.sql.end();
    }
  });

  it("pages through every active Feishu connection candidate", async () => {
    const value = await fixture();
    try {
      const createdAgents = await value.database
        .insert(agents)
        .values(
          Array.from({ length: 101 }, (_, index) => ({
            workspaceId: value.bootstrap.workspaceId,
            createdByUserId: value.bootstrap.userId,
            workspaceComputerId: value.workspaceComputer.id,
            name: `feishu-${String(index).padStart(3, "0")}`,
            displayName: `Feishu ${index}`,
            runtimeProvider: "codex" as const,
          })),
        )
        .returning({ id: agents.id });
      await value.database.insert(imBindings).values(
        createdAgents.map((agent, index) => ({
          agentId: agent.id,
          provider: "feishu" as const,
          status: "active" as const,
          externalAppId: `cli_page_${String(index).padStart(3, "0")}`,
          externalBotId: `ou_page_${index}`,
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential: "test-only",
          grantedCapabilities: [],
          activatedAt: new Date(),
        })),
      );

      const first = await value.imBindingService.listFeishuConnectionIds(undefined, 100);
      const second = await value.imBindingService.listFeishuConnectionIds(first.at(-1), 100);
      expect(first).toHaveLength(100);
      expect(second).toHaveLength(1);
      expect(new Set([...first, ...second]).size).toBe(101);
    } finally {
      await value.sql.end();
    }
  });

  it("fails reauthorization without an existing binding and lets cancel win before activation", async () => {
    const value = await unboundFixture();
    const completion = deferred<{
      appId: string;
      appSecret: string;
      teamBrand: "feishu";
    }>();
    const start = vi.fn(() => ({
      qrReady: Promise.resolve({ url: "https://open.feishu.cn/qr/cancel", expiresAt: new Date(Date.now() + 60_000) }),
      result: completion.promise,
      abort: vi.fn(),
    }));
    const activateAtomicAttempt = vi.fn();
    const setup = new FeishuSetupService({
      database: value.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindingService,
      registrations: { start },
      activation: { activateAtomicAttempt },
    });
    try {
      await expect(setup.createOrReuse(value.bootstrap.userId, value.agent.id, "reauthorize")).rejects.toThrow(
        "FEISHU_REAUTHORIZATION_REQUIRES_BINDING",
      );
      expect(start).not.toHaveBeenCalled();
      const attempt = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      await expect(setup.cancel(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({ state: "canceled" });
      completion.resolve({
        appId: "cli_canceled",
        appSecret: "secret",
        teamBrand: "feishu",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(activateAtomicAttempt).not.toHaveBeenCalled();
      await expect(value.imBindingService.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toMatchObject({
        bindingState: "provisioning",
      });
    } finally {
      await value.sql.end();
    }
  });

  it("fences the previous Feishu Channel owner when reauthorization moves an active lease", async () => {
    const value = await unboundFixture();
    const firstInstanceId = crypto.randomUUID();
    const secondInstanceId = crypto.randomUUID();
    const disconnects: string[] = [];
    const createAdapter = (input: { appId: string; appSecret: string; teamId: string | null }) =>
      ({
        provider: "feishu" as const,
        channel: {
          on: () => () => undefined,
          disconnect: async () => {
            disconnects.push(input.appId);
          },
        },
        validateBinding: async () => ({
          externalAppId: input.appId,
          externalTeamId: input.teamId ?? input.appId,
          externalBotId: "ou_bot",
        }),
        listGrantedWorkspaceScopes: async () => [...FEISHU_REQUIRED_TENANT_SCOPES],
        normalizeInbound: () => [],
        send: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }) as unknown as FeishuAdapter;
    const first = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId: firstInstanceId,
      imBindings: value.imBindingService,
      createAdapter,
      maintenanceMs: 1_000_000,
    });
    const second = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId: secondInstanceId,
      imBindings: value.imBindingService,
      createAdapter,
      maintenanceMs: 1_000_000,
    });
    try {
      first.start();
      const firstAttemptId = await validatingFeishuAttempt(value.database, value.agent.id, firstInstanceId, "create");
      await first.activateAtomicAttempt({
        attemptId: firstAttemptId,
        ownerInstanceId: firstInstanceId,
        agentId: value.agent.id,
        appId: "cli_lease",
        appSecret: "secret",
        teamBrand: "feishu",
      });
      const [initial] = await value.database.select().from(imBindings);
      expect(initial).toMatchObject({ connectionOwnerInstanceId: firstInstanceId, connectionFencingEpoch: 1 });
      if (!initial) throw new Error("Lease fixture was not created");
      second.start();
      const secondAttemptId = await validatingFeishuAttempt(
        value.database,
        value.agent.id,
        secondInstanceId,
        "reauthorize",
      );
      await second.activateAtomicAttempt({
        attemptId: secondAttemptId,
        ownerInstanceId: secondInstanceId,
        agentId: value.agent.id,
        appId: "cli_lease",
        appSecret: "secret-rotated",
        teamBrand: "feishu",
      });
      const [claimed] = await value.database.select().from(imBindings);
      expect(claimed).toMatchObject({ connectionOwnerInstanceId: secondInstanceId, connectionFencingEpoch: 2 });
      await first.maintain();
      expect(disconnects).toContain("cli_lease");
    } finally {
      await first.stop();
      await second.stop();
      await value.sql.end();
    }
  });

  it("configures Slack in one atomic generation while keeping receive mode local", async () => {
    const value = await unboundFixture();
    const service = new SlackConfigurationService({
      api: {
        inspectInstallation: vi.fn().mockResolvedValue({
          appId: null,
          teamId: "T_CONFIG",
          enterpriseId: null,
          botUserId: "U_CONFIG",
          botId: "B_CONFIG",
          grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        }),
      } as never,
      database: value.database,
      imBindings: value.imBindingService,
      publicOrigin: "https://opentag.example.com",
      now: () => new Date("2026-08-25T00:00:00.000Z"),
    });
    try {
      const configuration = await service.get(value.bootstrap.userId, value.agent.id);
      expect(configuration).toMatchObject({
        currentBinding: null,
        requiredBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        subscribedBotEvents: [
          "app_mention",
          "app_uninstalled",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "tokens_revoked",
        ],
      });
      expect(configuration.manifest).toMatchObject({
        oauth_config: { scopes: { bot: [...SLACK_REQUIRED_BOT_SCOPES] } },
        settings: {
          event_subscriptions: {
            request_url: `https://opentag.example.com/api/v1/agents/${value.agent.id}/im-binding/slack/events`,
          },
        },
      });

      const configuredResult = await service.configure(value.bootstrap.userId, value.agent.id, {
        intent: "create",
        expectedBinding: null,
        appId: "A_CONFIGURED",
        botAccessToken: "xoxb-configured",
        signingSecret: "configured-secret",
      });
      const imBindingId = configuredResult.imBindingId;
      expect(configuredResult).toMatchObject({
        appId: "A_CONFIGURED",
        teamId: "T_CONFIG",
        botUserId: "U_CONFIG",
        credentialGeneration: 1,
        identityClosure: { status: "pending", verifiedAt: null },
      });
      const [configured] = await value.database.select().from(imBindings).where(eq(imBindings.id, imBindingId));
      expect(configured).toMatchObject({
        provider: "slack",
        status: "active",
        externalAppId: "A_CONFIGURED",
        externalTeamId: "T_CONFIG",
        externalBotId: "U_CONFIG",
        credentialGeneration: 1,
        grantedCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
        setupAttemptId: null,
        setupState: null,
        encryptedSetupContext: null,
      });
      expect(configured?.encryptedCredential).not.toContain("xoxb-configured");
      await expect(
        value.imBindingService.getConfigForAgent(value.bootstrap.userId, value.agent.id),
      ).resolves.toMatchObject({
        identity: { provider: "slack", appId: "A_CONFIGURED", appIdEvidence: "configured" },
        reauthorizationRequired: false,
      });
      await expect(value.imBindingService.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toEqual({
        bindingState: "active",
        handoffReady: false,
      });
      await expect(value.imBindingService.diagnostics(value.bootstrap.userId, imBindingId)).resolves.toMatchObject({
        ready: false,
        credentialStatus: "valid",
        slackIdentityClosure: { status: "pending", verifiedAt: null },
      });
      await value.imBindingService.recordSlackIdentityClosure(imBindingId, 1);
      await expect(value.imBindingService.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toEqual({
        bindingState: "active",
        handoffReady: true,
      });
      await expect(value.imBindingService.diagnostics(value.bootstrap.userId, imBindingId)).resolves.toMatchObject({
        ready: true,
        slackIdentityClosure: { status: "verified", verifiedAt: expect.any(String) },
      });

      const agentService = new AgentService(value.database);
      const before = await agentService.getConfigById(value.bootstrap.userId, value.agent.id);
      await agentService.updateById(value.bootstrap.userId, value.agent.id, {
        expectedRevision: before.revision,
        receiveMode: "all_message",
      });
      const [afterModeChange] = await value.database.select().from(imBindings).where(eq(imBindings.id, imBindingId));
      expect(afterModeChange).toMatchObject({ status: "active", credentialGeneration: 1 });
    } finally {
      await value.sql.end();
    }
  });

  it("rejects incomplete scopes and contradictory Slack App identity without persisting a binding", async () => {
    const value = await unboundFixture();
    const inspectInstallation = vi
      .fn()
      .mockResolvedValueOnce({
        appId: null,
        teamId: "T1",
        enterpriseId: null,
        botUserId: "U1",
        botId: "B1",
        grantedBotScopes: SLACK_REQUIRED_BOT_SCOPES.slice(1),
      })
      .mockResolvedValueOnce({
        appId: "A_API",
        teamId: "T1",
        enterpriseId: null,
        botUserId: "U1",
        botId: "B1",
        grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      });
    const service = new SlackConfigurationService({
      api: { inspectInstallation } as never,
      database: value.database,
      imBindings: value.imBindingService,
      publicOrigin: "https://opentag.example.com",
    });
    try {
      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "create",
          expectedBinding: null,
          appId: "A_CONFIGURED",
          botAccessToken: "xoxb-missing-scope",
          signingSecret: "secret",
        }),
      ).rejects.toMatchObject({ code: "SLACK_SCOPE_REAUTH_REQUIRED", category: "credential" });
      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "create",
          expectedBinding: null,
          appId: "A_CONFIGURED",
          botAccessToken: "xoxb-wrong-app",
          signingSecret: "secret",
        }),
      ).rejects.toMatchObject({ code: "SLACK_BINDING_IDENTITY_MISMATCH", category: "credential" });
      await expect(value.database.select().from(imBindings)).resolves.toEqual([]);
    } finally {
      await value.sql.end();
    }
  });

  it("rechecks Admin authority after Slack token inspection before committing configuration", async () => {
    const value = await unboundFixture();
    const service = new SlackConfigurationService({
      api: {
        inspectInstallation: vi.fn().mockResolvedValue({
          appId: null,
          teamId: "T_AUTHORITY",
          enterpriseId: null,
          botUserId: "U_AUTHORITY",
          botId: "B_AUTHORITY",
          grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        }),
      } as never,
      database: value.database,
      imBindings: value.imBindingService,
      publicOrigin: "https://opentag.example.com",
      beforeConfigurationTransaction: async () => {
        await value.database
          .update(workspaceAdminGrants)
          .set({ revokedByUserId: value.bootstrap.userId, revokedAt: new Date() })
          .where(
            and(
              eq(workspaceAdminGrants.workspaceId, value.bootstrap.workspaceId),
              eq(workspaceAdminGrants.userId, value.bootstrap.userId),
            ),
          );
      },
    });
    try {
      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "create",
          expectedBinding: null,
          appId: "A_AUTHORITY",
          botAccessToken: "xoxb-authority",
          signingSecret: "authority-secret",
        }),
      ).rejects.toMatchObject({ code: "IM_BINDING_NOT_FOUND", statusCode: 404 });
      await expect(value.database.select().from(imBindings)).resolves.toEqual([]);
    } finally {
      await value.sql.end();
    }
  });

  it("fences Slack configuration revisions and atomically replaces a changed identity", async () => {
    const value = await unboundFixture();
    const inspectInstallation = vi.fn(async (token: string) => ({
      appId: null,
      teamId: "T_CONFIG",
      enterpriseId: null,
      botUserId: token === "xoxb-replacement" ? "U_REPLACEMENT" : "U_CONFIG",
      botId:
        token === "xoxb-replacement" ? "B_REPLACEMENT" : token === "xoxb-different-bot-id" ? "B_OTHER" : "B_CONFIG",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    }));
    const service = new SlackConfigurationService({
      api: { inspectInstallation } as never,
      database: value.database,
      imBindings: value.imBindingService,
      publicOrigin: "https://opentag.example.com",
    });
    try {
      const firstId = await service
        .configure(value.bootstrap.userId, value.agent.id, {
          intent: "create",
          expectedBinding: null,
          appId: "A_CONFIG",
          botAccessToken: "xoxb-first",
          signingSecret: "first-secret",
        })
        .then((result) => result.imBindingId);
      const firstGuide = await service.get(value.bootstrap.userId, value.agent.id);
      if (!firstGuide.currentBinding) throw new Error("Configured Slack binding was not projected");
      const firstEvent = inbound("Ev-configured-session");
      firstEvent.externalAppId = "A_CONFIG";
      firstEvent.externalTeamId = "T_CONFIG";
      firstEvent.mentions = [{ externalId: "U_CONFIG", displayName: "Assistant" }];
      await new ImMessageInbox(value.database).ingest(firstId, 1, firstEvent);
      const [session] = await value.database.select().from(sessions).where(eq(sessions.imBindingId, firstId)).limit(1);
      if (!session) throw new Error("Configured Slack Session was not created");

      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "reauthorize",
          expectedBinding: {
            id: firstGuide.currentBinding.id,
            credentialGeneration: firstGuide.currentBinding.credentialGeneration,
          },
          appId: "A_CONFIG_TYPO",
          botAccessToken: "xoxb-second",
          signingSecret: "typo-secret",
        }),
      ).rejects.toMatchObject({ code: "SLACK_BINDING_IDENTITY_MISMATCH" });
      await expect(value.database.select().from(imBindings).where(eq(imBindings.id, firstId))).resolves.toEqual([
        expect.objectContaining({ status: "active", credentialGeneration: 1, replacementImBindingId: null }),
      ]);
      expect((await value.database.select().from(sessions).where(eq(sessions.id, session.id)))[0]?.endedAt).toBeNull();

      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "reauthorize",
          expectedBinding: {
            id: firstGuide.currentBinding.id,
            credentialGeneration: firstGuide.currentBinding.credentialGeneration,
          },
          appId: "A_CONFIG",
          botAccessToken: "xoxb-different-bot-id",
          signingSecret: "different-bot-secret",
        }),
      ).rejects.toMatchObject({ code: "SLACK_BINDING_IDENTITY_MISMATCH" });

      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "reauthorize",
          expectedBinding: {
            id: firstGuide.currentBinding.id,
            credentialGeneration: firstGuide.currentBinding.credentialGeneration,
          },
          appId: "A_CONFIG",
          botAccessToken: "xoxb-second",
          signingSecret: "second-secret",
        }),
      ).resolves.toMatchObject({ imBindingId: firstId, credentialGeneration: 2 });
      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "reauthorize",
          expectedBinding: {
            id: firstGuide.currentBinding.id,
            credentialGeneration: firstGuide.currentBinding.credentialGeneration,
          },
          appId: "A_CONFIG",
          botAccessToken: "xoxb-stale",
          signingSecret: "stale-secret",
        }),
      ).rejects.toMatchObject({ code: "SLACK_CONFIGURATION_CONFLICT" });

      const currentGuide = await service.get(value.bootstrap.userId, value.agent.id);
      if (!currentGuide.currentBinding) throw new Error("Reauthorized Slack binding was not projected");
      expect((await value.database.select().from(sessions).where(eq(sessions.id, session.id)))[0]?.endedAt).toBeNull();
      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "replace",
          expectedBinding: {
            id: currentGuide.currentBinding.id,
            credentialGeneration: currentGuide.currentBinding.credentialGeneration,
          },
          appId: "A_CONFIG",
          botAccessToken: "xoxb-second",
          signingSecret: "same-app-secret",
        }),
      ).rejects.toMatchObject({ code: "SLACK_CONFIGURATION_CONFLICT" });
      const replacementId = await service
        .configure(value.bootstrap.userId, value.agent.id, {
          intent: "replace",
          expectedBinding: {
            id: currentGuide.currentBinding.id,
            credentialGeneration: currentGuide.currentBinding.credentialGeneration,
          },
          appId: "A_REPLACEMENT",
          botAccessToken: "xoxb-replacement",
          signingSecret: "replacement-secret",
        })
        .then((result) => result.imBindingId);
      expect(replacementId).not.toBe(firstId);
      expect(
        (await value.database.select().from(sessions).where(eq(sessions.id, session.id)))[0]?.endedAt,
      ).not.toBeNull();
      const rows = await value.database
        .select()
        .from(imBindings)
        .where(inArray(imBindings.id, [firstId, replacementId]));
      expect(rows.find((row) => row.id === firstId)).toMatchObject({
        status: "disabled",
        encryptedCredential: null,
        replacementImBindingId: replacementId,
      });
      expect(rows.find((row) => row.id === replacementId)).toMatchObject({
        status: "active",
        credentialGeneration: 1,
        externalAppId: "A_REPLACEMENT",
        externalBotId: "U_REPLACEMENT",
      });
    } finally {
      await value.sql.end();
    }
  });

  it("fences every Slack event mutation to the exact credential generation", async () => {
    const value = await fixture();
    try {
      const reauthorized = await value.imBindingService.activateSlack(
        {
          intent: "reauthorize",
          agentId: value.agent.id,
          appId: "A1",
          teamId: "T1",
          botUserId: "U_BOT",
          grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
          botAccessToken: "xoxb-generation-2",
          signingSecret: "generation-2-secret",
          installedAt: new Date("2026-08-25T01:00:00.000Z"),
        },
        "B_BOT",
      );
      expect(reauthorized).toMatchObject({ imBindingId: value.imBindingId, credentialGeneration: 2 });

      await expect(value.imBindingService.recordSlackObservation(value.imBindingId, 1)).resolves.toBe(false);
      await expect(value.imBindingService.recordSlackIdentityClosure(value.imBindingId, 1)).resolves.toBe(false);
      await expect(
        value.imBindingService.requireReauthorization(value.imBindingId, 1, "SLACK_TOKEN_REVOKED"),
      ).resolves.toBe(false);
      await expect(value.imBindingService.disableFromProvider(value.imBindingId, 1)).resolves.toBe(false);
      await expect(
        value.database.select().from(imBindings).where(eq(imBindings.id, value.imBindingId)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: "active",
          credentialGeneration: 2,
          observedAt: null,
          observedConnectedAt: null,
          lastErrorCode: null,
        }),
      ]);

      await expect(value.imBindingService.recordSlackObservation(value.imBindingId, 2)).resolves.toBe(true);
      await expect(value.imBindingService.recordSlackIdentityClosure(value.imBindingId, 2)).resolves.toBe(true);
      await expect(
        value.imBindingService.requireReauthorization(value.imBindingId, 2, "SLACK_TOKEN_REVOKED"),
      ).resolves.toBe(true);
      await expect(value.imBindingService.disableFromProvider(value.imBindingId, 2)).resolves.toBe(true);
      await expect(
        value.database.select().from(imBindings).where(eq(imBindings.id, value.imBindingId)),
      ).resolves.toEqual([expect.objectContaining({ status: "disabled", credentialGeneration: 2 })]);
    } finally {
      await value.sql.end();
    }
  });

  it("preserves the first Slack identity closure timestamp while refreshing runtime observation", async () => {
    const value = await fixture();
    try {
      const firstClosureAt = new Date("2026-08-19T00:00:00.000Z");
      const laterObservationAt = new Date("2026-08-25T02:00:00.000Z");
      const service = new ImBindingService(value.database, value.cipher, { now: () => laterObservationAt });

      await expect(service.recordSlackIdentityClosure(value.imBindingId, 1)).resolves.toBe(true);
      await expect(
        value.database.select().from(imBindings).where(eq(imBindings.id, value.imBindingId)),
      ).resolves.toEqual([
        expect.objectContaining({
          observedAt: laterObservationAt,
          observedConnectedAt: firstClosureAt,
          updatedAt: firstClosureAt,
        }),
      ]);
    } finally {
      await value.sql.end();
    }
  });

  it("returns the exact committed Slack generation even if it is mutated immediately after commit", async () => {
    const value = await unboundFixture();
    const service = new SlackConfigurationService({
      api: {
        inspectInstallation: vi.fn().mockResolvedValue({
          appId: null,
          teamId: "T_SNAPSHOT",
          enterpriseId: null,
          botUserId: "U_SNAPSHOT",
          botId: "B_SNAPSHOT",
          grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        }),
      } as never,
      database: value.database,
      imBindings: value.imBindingService,
      publicOrigin: "https://opentag.example.com",
      afterConfigurationTransaction: async () => {
        await value.database
          .update(workspaceAdminGrants)
          .set({ revokedByUserId: value.bootstrap.userId, revokedAt: new Date() })
          .where(
            and(
              eq(workspaceAdminGrants.workspaceId, value.bootstrap.workspaceId),
              eq(workspaceAdminGrants.userId, value.bootstrap.userId),
            ),
          );
        const [committed] = await value.database
          .select({ id: imBindings.id, generation: imBindings.credentialGeneration })
          .from(imBindings)
          .where(eq(imBindings.agentId, value.agent.id));
        if (!committed) throw new Error("Committed Slack binding was not found by the concurrency hook");
        await value.imBindingService.disableFromProvider(committed.id, committed.generation);
      },
    });
    try {
      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "create",
          expectedBinding: null,
          appId: "A_SNAPSHOT",
          botAccessToken: "xoxb-snapshot",
          signingSecret: "snapshot-secret",
        }),
      ).resolves.toMatchObject({
        agentId: value.agent.id,
        appId: "A_SNAPSHOT",
        credentialGeneration: 1,
        bindingState: "active",
        identityClosure: { status: "pending", verifiedAt: null },
      });
      await expect(value.database.select().from(imBindings)).resolves.toEqual([
        expect.objectContaining({ status: "disabled", credentialGeneration: 1, encryptedCredential: null }),
      ]);
    } finally {
      await value.sql.end();
    }
  });

  it("maps a Slack user token without Bot identity to a deterministic 4xx without persistence", async () => {
    const value = await unboundFixture();
    const service = new SlackConfigurationService({
      api: { inspectInstallation: vi.fn().mockRejectedValue(new Error("SLACK_AUTH_IDENTITY_INCOMPLETE")) } as never,
      database: value.database,
      imBindings: value.imBindingService,
      publicOrigin: "https://opentag.example.com",
    });
    try {
      await expect(
        service.configure(value.bootstrap.userId, value.agent.id, {
          intent: "create",
          expectedBinding: null,
          appId: "A_USER_TOKEN",
          botAccessToken: "xoxp-user-token",
          signingSecret: "user-token-secret",
        }),
      ).rejects.toMatchObject({
        code: "SLACK_AUTH_IDENTITY_INCOMPLETE",
        statusCode: 400,
        category: "credential",
      });
      await expect(value.database.select().from(imBindings)).resolves.toEqual([]);
    } finally {
      await value.sql.end();
    }
  });

  it("checks the Feishu lease holder and epoch inside the admission transaction", async () => {
    const value = await unboundFixture();
    try {
      const imBindingId = await value.imBindingService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_fence",
        appSecret: "secret",
        teamId: null,
        botOpenId: "ou_bot",
        teamBrand: "feishu",
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
      });
      const staleHolder = crypto.randomUUID();
      const currentHolder = crypto.randomUUID();
      await value.database
        .update(imBindings)
        .set({
          connectionOwnerInstanceId: currentHolder,
          connectionFencingEpoch: 2,
          connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
          observedConnectedAt: new Date(),
          observedAt: new Date(),
        })
        .where(eq(imBindings.id, imBindingId));
      const fenceAcquired = deferred<void>();
      const releaseAdmission = deferred<void>();
      const inbox = new ImMessageInbox(value.database, {
        afterAdmissionFence: async () => {
          fenceAcquired.resolve();
          await releaseAdmission.promise;
        },
      });
      await expect(
        inbox.ingest(
          imBindingId,
          1,
          { ...inbound("Ev-stale-fence"), externalAppId: "cli_fence" },
          {
            provider: "feishu",
            holderInstanceId: staleHolder,
            fencingEpoch: 1,
          },
        ),
      ).rejects.toThrow("FEISHU_CONNECTION_LEASE_STALE");

      const admission = inbox.ingest(
        imBindingId,
        1,
        { ...inbound("Ev-current-fence"), externalAppId: "cli_fence" },
        {
          provider: "feishu",
          holderInstanceId: currentHolder,
          fencingEpoch: 2,
        },
      );
      await fenceAcquired.promise;
      const takeoverHolder = crypto.randomUUID();
      let takeoverSettled = false;
      const takeover = value.database
        .update(imBindings)
        .set({
          connectionOwnerInstanceId: takeoverHolder,
          connectionFencingEpoch: 3,
          connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
        })
        .where(eq(imBindings.id, imBindingId))
        .then(() => {
          takeoverSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(takeoverSettled).toBe(false);
      releaseAdmission.resolve();
      await expect(admission).resolves.toMatchObject({ duplicate: false });
      await takeover;
      await expect(
        new ImMessageInbox(value.database).ingest(
          imBindingId,
          1,
          { ...inbound("Ev-after-takeover"), externalAppId: "cli_fence" },
          {
            provider: "feishu",
            holderInstanceId: currentHolder,
            fencingEpoch: 2,
          },
        ),
      ).rejects.toThrow("FEISHU_CONNECTION_LEASE_STALE");
    } finally {
      await value.sql.end();
    }
  });
});
