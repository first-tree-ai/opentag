import { randomUUID } from "node:crypto";
import { computeDirectInputHash, type DirectImMessageDeliveryRequest, type RunnerServerFrame } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { runImDeliveryExpiry } from "../../runtime/im-delivery-janitor.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "../../services/runtime-config/index.js";
import { CloudDeliveryOwner } from "../../services/sandboxes/cloud-delivery-owner.js";
import { CloudModelGrantService } from "../../services/sandboxes/cloud-model-grants.js";
import { CloudRuntimeFence } from "../../services/sandboxes/cloud-runtime-fence.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import { SandboxService } from "../../services/sandboxes/sandbox-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * E4 dispatch/lifecycle custody on REAL PostgreSQL: the aged-Cloud-deadline claim boundary versus
 * the Local TTL, and the persisted-allocation recovery boundary (Server restart and superseded
 * generation) against the actual durable store. The Cloud Runner socket/Cloud API/model upstream
 * are explicit fixtures; no external service is contacted.
 */

const RUNNER_VERSION = "0.0.5";
const cloudIdentities = { enabled: true as const, runnerVersion: RUNNER_VERSION, storageBase: "gs://unit-cloud/x" };
const MODEL = "fixture-cloud-model";
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);

afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});

beforeEach(async () => {
  await testDatabase.reset();
});

function fakeSocket(sent: RunnerServerFrame[]): RunnerControlSocket {
  return {
    send(frame) {
      sent.push(frame);
    },
    close() {
      // no-op
    },
  };
}

const READINESS = {
  sandboxName: "ots-s-unit-1",
  rootfs: "/opt/sandbox-root",
  nodeVersion: "v24.19.0",
  piVersion: "0.84.2",
  runnerVersion: RUNNER_VERSION,
  reportedAt: new Date().toISOString(),
};

async function cloudScope() {
  const accountId = randomUUID();
  await client.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "E4" });
  const cloud = await new ComputerService(client.database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(client.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e4-pi-${randomUUID().slice(0, 8)}`,
    displayName: "E4 Pi",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  await client.database
    .update(agentRuntimeConfigs)
    .set({ instructions: "Agent instructions.", model: MODEL })
    .where(eq(agentRuntimeConfigs.agentId, agent.id));
  const bindingId = randomUUID();
  await client.database.insert(imBindings).values({
    id: bindingId,
    agentId: agent.id,
    provider: "feishu",
    status: "active",
    externalAppId: `unit-app-${randomUUID().slice(0, 8)}`,
    externalBotId: "unit-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: new Date(),
  });
  const sandbox = await new SandboxService(client.database, new SessionService(client.database), {
    cloudIdentities,
  }).ensureForAccount(accountId, {
    imBindingId: bindingId,
    channelId: "unit-channel",
    conversationKind: "channel",
    kind: "channel",
  });
  const resourceName = `projects/unit/locations/us-west1/instances/ots-s-${sandbox.sandboxId.slice(0, 8)}-1`;
  await client.database
    .update(sandboxes)
    .set({
      lifecycle: "ready",
      environmentGeneration: 1,
      currentResourceName: resourceName,
      currentResourceUid: `unit-uid-${sandbox.sandboxId.slice(0, 8)}`,
    })
    .where(eq(sandboxes.id, sandbox.sandboxId));
  const scope: RunnerScope = {
    sandboxId: sandbox.sandboxId,
    sessionId: sandbox.sessionId,
    environmentGeneration: 1,
    resourceName,
  };
  return { accountId, agent, bindingId, sandbox, scope, cloud };
}

async function localScope() {
  const accountId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  await client.database
    .insert(users)
    .values({ id: accountId, email: `${accountId}@example.test`, displayName: "Local" });
  await client.database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    kind: "local",
    currentInstallationId: randomUUID(),
    displayName: "Local",
    platform: "darwin",
    arch: "arm64",
    clientVersion: "test",
  });
  await client.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: `local-${randomUUID().slice(0, 8)}`,
    displayName: "Local Agent",
    runtimeProvider: "codex",
  });
  await client.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `local-app-${randomUUID().slice(0, 8)}`,
    externalBotId: "unit-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: new Date(),
  });
  await client.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "unit-channel",
    conversationKind: "channel",
    kind: "channel",
  });
  await client.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  await client.database.insert(imMessages).values({
    id: messageId,
    imBindingId: bindingId,
    channelId: "unit-channel",
    externalMessageId: `ext-${messageId.slice(0, 8)}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "unit-user",
    content: { version: 1, fallbackText: "hello", blocks: [], truncated: false },
    providerContext: { provider: "feishu" },
    occurredAt: new Date(),
  });
  await client.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    state: "pending",
    placementGeneration: 1,
    expiresAt: new Date(Date.now() - 6 * 60 * 60 * 1_000),
  });
  return { accountId, computerId, agentId, bindingId, sessionId, deliveryId };
}

async function agedPendingDelivery(sessionId: string) {
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const [binding] = await client.database.select().from(imBindings).limit(1);
  if (!binding) throw new Error("fixture binding missing");
  await client.database.insert(imMessages).values({
    id: messageId,
    imBindingId: binding.id,
    channelId: "unit-channel",
    externalMessageId: `ext-${messageId.slice(0, 8)}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "unit-user",
    content: { version: 1, fallbackText: "hello cloud", blocks: [], truncated: false },
    providerContext: { provider: "feishu" },
    occurredAt: new Date(),
  });
  await client.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    state: "pending",
    placementGeneration: 1,
    expiresAt: new Date(Date.now() - 6 * 60 * 60 * 1_000),
  });
  return { deliveryId, messageId };
}

function makeOwner() {
  const hub = new RunnerHub();
  const fence = new CloudRuntimeFence();
  const custody = new PostgresRuntimeCustodyStore(client.database);
  const grants = new CloudModelGrantService("unit-test-jwt-secret-at-least-32-characters", {
    allowedModels: [MODEL],
    maxStreamsPerToken: 2,
    ttlSeconds: 600,
  });
  const owner = new CloudDeliveryOwner({
    custody,
    database: client.database,
    fence,
    hub,
    modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
    modelGrants: grants,
  });
  return { hub, fence, custody, grants, owner };
}

function makeWorker(owner: CloudDeliveryOwner) {
  return new ImDeliveryWorker({
    assembler: new EffectiveRuntimeSnapshotAssembler(client.database),
    database: client.database,
    domain: {} as never,
    registry: new ConnectionRegistry(),
    cloudDelivery: owner,
    cloudAllocation: {
      ensureSandbox: async () => {
        throw new Error("fixture port does not create Sandbox rows");
      },
      ensureEnvironmentAllocated: async () => "ready",
    },
    intervalMs: 60_000,
  });
}

function deliveryRequest(input: {
  deliveryId: string;
  messageId: string;
  sessionId: string;
  agentId: string;
}): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: input.deliveryId,
    imMessageId: input.messageId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "feishu",
        teamBrand: "feishu",
        appId: "unit-app",
        botOpenId: "unit-bot",
        chatId: "unit-channel",
        messageId: "ext-1",
      },
    },
    runtime: {
      agentId: input.agentId,
      contextTreeRepository: null,
      instructions: { agent: "Agent.", platform: "Platform." },
      provider: "pi",
      model: MODEL,
      revision: {
        agent: { id: randomUUID(), sequence: 1 },
        session: { id: randomUUID(), sequence: 1 },
      },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: randomUUID(), mode: "empty_on_create", sharing: "agent" },
    },
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

describe("E4 Cloud dispatch custody on real PostgreSQL", () => {
  it("expires aged undispatched Cloud input at its bounded deadline and keeps a dispatched attempt durable", async () => {
    const cloud = await cloudScope();
    const local = await localScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    hub.attach(cloud.scope, socket);
    hub.markReady(cloud.scope, READINESS, socket);
    fence.attach({ computerId: cloud.cloud.computerId, installationId: randomUUID(), scope: cloud.scope, socket });
    const { deliveryId } = await agedPendingDelivery(cloud.scope.sessionId);
    const janitorOptions = {
      clock: () => new Date(),
      expiryBatchSize: 100,
      retentionBatchSize: 100,
      imMessagesRetentionMs: 90 * 24 * 60 * 60 * 1_000,
      imMessageDeliveriesRetentionMs: 90 * 24 * 60 * 60 * 1_000,
      slackWebhookReceiptsRetentionMs: 30 * 24 * 60 * 60 * 1_000,
      feishuInboundReceiptsRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    };

    // The bounded ingress deadline is terminal for an input that never reached a Runner, exactly
    // like Local; accepted-unreported custody is the only Cloud state exempt from it.
    await runImDeliveryExpiry(client.database, janitorOptions);
    const [cloudRow] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    expect(cloudRow).toMatchObject({ state: "expired", reason: "ttl", dispatchRequestId: null });
    const [localRow] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, local.deliveryId));
    expect(localRow).toMatchObject({ state: "expired", reason: "ttl", dispatchRequestId: null });

    // The worker never dispatches a past-deadline undispatched Cloud row.
    const worker = makeWorker(owner);
    await worker.runOnce();
    expect(sent.filter((frame) => frame.type === "delivery:run")).toHaveLength(0);

    // A DISPATCHED Cloud attempt is owned by its frozen execution window, not the ingress TTL:
    // the janitor leaves it, and the worker releases the stale attempt once that window passed.
    const dispatched = await agedPendingDelivery(cloud.scope.sessionId);
    await client.database
      .update(imMessageDeliveries)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(imMessageDeliveries.id, dispatched.deliveryId));
    const request = deliveryRequest({
      deliveryId: dispatched.deliveryId,
      messageId: dispatched.messageId,
      sessionId: cloud.scope.sessionId,
      agentId: cloud.agent.id,
    });
    await owner.dispatchDelivery({
      computerId: cloud.cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: randomUUID(),
      request,
    });
    await client.database
      .update(imMessageDeliveries)
      .set({ expiresAt: new Date(Date.now() - 6 * 60 * 60 * 1_000) })
      .where(eq(imMessageDeliveries.id, dispatched.deliveryId));
    await runImDeliveryExpiry(client.database, janitorOptions);
    const [dispatchedRow] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, dispatched.deliveryId));
    expect(dispatchedRow).toMatchObject({ state: "pending", dispatchRequestId: request.requestId });

    const persisted = dispatchedRow?.dispatchPayload as DirectImMessageDeliveryRequest;
    const expiredPayload = { ...persisted, deadlineAt: new Date(Date.now() - 60_000).toISOString() };
    await client.database
      .update(imMessageDeliveries)
      .set({
        dispatchPayload: expiredPayload,
        dispatchInputHash: computeDirectInputHash(expiredPayload),
        nextAttemptAt: new Date(Date.now() - 1_000),
      })
      .where(eq(imMessageDeliveries.id, dispatched.deliveryId));
    await worker.runOnce();
    const [released] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, dispatched.deliveryId));
    expect(released).toMatchObject({ state: "pending", dispatchRequestId: null });
    expect(released?.lastErrorCode).toBe("IM_DELIVERY_CLOUD_DISPATCH_EXPIRED");

    // With the dispatch released, the bounded ingress deadline applies again.
    await runImDeliveryExpiry(client.database, janitorOptions);
    const [bounded] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, dispatched.deliveryId));
    expect(bounded).toMatchObject({ state: "expired", reason: "ttl" });
    grants.close();
  });

  it("preserves a fresh Server's recovery over a live allocation and rejects a superseded generation", async () => {
    const cloud = await cloudScope();
    const first = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    first.hub.attach(cloud.scope, socket);
    first.hub.markReady(cloud.scope, READINESS, socket);
    const connection = first.fence.attach({
      computerId: cloud.cloud.computerId,
      installationId: randomUUID(),
      scope: cloud.scope,
      socket,
    });
    const { deliveryId, messageId } = await agedPendingDelivery(cloud.scope.sessionId);
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: cloud.scope.sessionId,
      agentId: cloud.agent.id,
    });
    await first.owner.dispatchDelivery({
      computerId: cloud.cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    const turnId = randomUUID();
    await first.owner.handleDeliveryReceived(connection, {
      deliveryId,
      requestId: request.requestId,
      turnId,
    });

    // Server restart: the persisted allocation still owns the accepted turn, so recovery waits for
    // the replayed report instead of writing a terminal unknown.
    const restarted = makeOwner();
    expect(await restarted.owner.recoverAccepted(deliveryId)).toBe("pending");
    const [preserved] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    expect(preserved?.reportedAt).toBeNull();
    expect(preserved?.turnReport).toBeNull();

    // A superseded generation cannot obtain execution permission for the old accepted turn.
    const nextScope = { ...cloud.scope, environmentGeneration: 2, resourceName: `${cloud.scope.resourceName}-new` };
    await client.database
      .update(sandboxes)
      .set({
        environmentGeneration: 2,
        currentResourceName: nextScope.resourceName,
        currentResourceUid: "replacement-fixture-uid",
      })
      .where(eq(sandboxes.id, cloud.scope.sandboxId));
    const nextSent: RunnerServerFrame[] = [];
    const nextSocket = fakeSocket(nextSent);
    restarted.hub.attach(nextScope, nextSocket);
    restarted.hub.markReady(nextScope, READINESS, nextSocket);
    const next = restarted.fence.attach({
      computerId: cloud.cloud.computerId,
      installationId: randomUUID(),
      scope: nextScope,
      socket: nextSocket,
    });
    await restarted.owner.handleDeliveryReceived(next, { deliveryId, requestId: request.requestId, turnId });
    const verified = nextSent.filter((frame) => frame.type === "delivery:verified");
    expect(verified).toHaveLength(1);
    expect((verified[0] as { status: string }).status).toBe("rejected");
    first.grants.close();
    restarted.grants.close();
  });

  it("settles an accepted turn exactly once when the allocation was durably stopped", async () => {
    const cloud = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    hub.attach(cloud.scope, socket);
    hub.markReady(cloud.scope, READINESS, socket);
    const connection = fence.attach({
      computerId: cloud.cloud.computerId,
      installationId: randomUUID(),
      scope: cloud.scope,
      socket,
    });
    const { deliveryId, messageId } = await agedPendingDelivery(cloud.scope.sessionId);
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: cloud.scope.sessionId,
      agentId: cloud.agent.id,
    });
    await owner.dispatchDelivery({
      computerId: cloud.cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId: randomUUID() });
    // A completed release removes the resource reference: no Runner can ever report this turn.
    await client.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", currentResourceName: null, currentResourceUid: null })
      .where(eq(sandboxes.id, cloud.scope.sandboxId));
    expect(await owner.recoverAccepted(deliveryId)).toBe("resolved");
    const [settled] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    expect(settled?.turnReport).toMatchObject({ outcome: "unknown", errorReason: "turn_state_unknown" });
    expect(await owner.recoverAccepted(deliveryId)).toBe("noop");
    grants.close();
  });

  it("pauses accepted Cloud work under reauthorization and cancels it only after a definitive stop", async () => {
    const cloud = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const worker = makeWorker(owner);
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    hub.attach(cloud.scope, socket);
    hub.markReady(cloud.scope, READINESS, socket);
    const connection = fence.attach({
      computerId: cloud.cloud.computerId,
      installationId: randomUUID(),
      scope: cloud.scope,
      socket,
    });
    const { deliveryId, messageId } = await agedPendingDelivery(cloud.scope.sessionId);
    await client.database
      .update(imMessageDeliveries)
      .set({ expiresAt: new Date(Date.now() + 3_600_000), nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: cloud.scope.sessionId,
      agentId: cloud.agent.id,
    });
    await owner.dispatchDelivery({
      computerId: cloud.cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    const turnId = randomUUID();
    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "received" }));
      }
    };

    // Transient reauthorization: the real worker/janitor must not reject or cancel the turn.
    await client.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, cloud.bindingId));
    await client.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    await worker.runJanitorOnce();
    expect(sent.some((frame) => frame.type === "delivery:cancel")).toBe(false);
    const [paused] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    expect(paused).toMatchObject({ state: "accepted", reportedAt: null, turnReport: null });

    // Restoration: the normal recovery path re-verifies the still-received turn with a fresh grant.
    await client.database.update(imBindings).set({ status: "active" }).where(eq(imBindings.id, cloud.bindingId));
    await client.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    const verifiedBefore = sent.filter(
      (frame) => frame.type === "delivery:verified" && frame.status === "verified",
    ).length;
    await worker.runOnce();
    expect(sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "verified").length).toBe(
      verifiedBefore + 1,
    );

    // A definitive stop cancels the still-unreported turn truthfully.
    await client.database
      .update(imBindings)
      .set({
        status: "disabled",
        disabledAt: new Date(),
        encryptedCredential: null,
        encryptedSetupContext: null,
        setupOwnerInstanceId: null,
        connectionOwnerInstanceId: null,
        connectionLeaseExpiresAt: null,
      })
      .where(eq(imBindings.id, cloud.bindingId));
    await client.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    await worker.runJanitorOnce();
    expect(sent.some((frame) => frame.type === "delivery:cancel")).toBe(true);
    grants.close();
  });
});
