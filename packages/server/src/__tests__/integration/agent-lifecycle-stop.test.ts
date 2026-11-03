import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type SessionReconcileRequest, type SessionReconcileResult } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import WebSocket from "ws";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imBindings, sessionCliProofs, sessionPlacements, sessions, users } from "../../db/schema/index.js";
import { stopAgentSessions } from "../../runtime/agent-session-stopper.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ProviderCliReconcileOwner } from "../../runtime/provider-cli-reconcile-owner.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { SessionCliProofService } from "../../services/sessions/session-cli-proof-service.js";
import { deferred } from "../support/deferred.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
const domains: RuntimeDomainOwner[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => {
  await pg.reset();
});
afterEach(async () => {
  for (const domain of domains.splice(0)) domain.close();
  await Promise.all(clients.splice(0).map((client) => client.sql.end()));
});
afterAll(async () => {
  await pg?.stop();
});
async function fixture(onSend?: (frame: { type: string }, done: () => void) => void) {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(client);
  const [account] = await client.database
    .insert(users)
    .values({ email: "lifecycle@example.test", displayName: "Lifecycle" })
    .returning();
  assert(account);
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: account.id,
      currentInstanceId: randomUUID(),
      currentInstallationId: randomUUID(),
      displayName: "Lifecycle",
      platform: "linux",
      arch: "arm64",
      clientVersion: "0.1.2",
    })
    .returning();
  assert(computer?.currentInstallationId && computer.currentInstanceId);
  const agents = new AgentService(client.database);
  const agent = await agents.createForAccount(account.id, {
    name: "lifecycle",
    displayName: "Lifecycle",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const [binding] = await client.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: randomUUID(),
      externalBotId: "fixture",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "fixture",
      activatedAt: new Date(),
    })
    .returning();
  assert(binding);
  const [session] = await client.database
    .insert(sessions)
    .values({ imBindingId: binding.id, channelId: "C", conversationKind: "channel", kind: "channel" })
    .returning();
  assert(session);
  await client.database
    .insert(sessionPlacements)
    .values({ sessionId: session.id, computerId: computer.id, generation: 1 });
  const registry = new ConnectionRegistry(),
    frames: SessionReconcileRequest[] = [],
    sent = deferred();
  const socket = {
    readyState: WebSocket.OPEN,
    send: (text: string, callback?: () => void) => {
      const frame = JSON.parse(text) as { type: string };
      if (frame.type === "session:reconcile") {
        frames.push(frame as SessionReconcileRequest);
        sent.resolve();
      }
      if (onSend) onSend(frame, () => callback?.());
      else callback?.();
    },
  } as unknown as WebSocket;
  await registry.register(
    {
      computerId: computer.id,
      installationId: computer.currentInstallationId,
      instanceId: computer.currentInstanceId,
      lastHeartbeatAt: Date.now(),
      socket,
      active: true,
      negotiatedCapabilities: {
        [RUNTIME_CAPABILITY.sessionCollaboration]: 1,
        [RUNTIME_CAPABILITY.providerCliReconcile]: 1,
      },
    },
    async () => undefined,
  );
  const proofs = new SessionCliProofService(client.database, registry, randomBytes(32));
  const mint = () =>
    proofs.mint({
      sessionId: session.id,
      computerId: computer.id,
      placementGeneration: 1,
      connectionInstanceId: computer.currentInstanceId as string,
    });
  await mint();
  const domain = new RuntimeDomainOwner(registry, new PostgresRuntimeCustodyStore(client.database), {
    requestTimeoutMs: 2000,
    prepareReconcile: (...args) => proofs.prepareReconcile(...args),
  });
  domains.push(domain);
  const dependencies = {
    currentInstanceId: (id: string) => registry.currentInstanceId(id),
    requestReconcile: domain.requestReconcile.bind(domain),
  };
  const respond = async () => {
    const frame = frames.at(-1);
    assert(frame);
    const result: SessionReconcileResult = {
      type: "session:reconcile:result",
      requestId: frame.requestId,
      sessionId: frame.sessionId,
      placementGeneration: frame.placementGeneration,
      status: "stopped",
    };
    await domain.businessOptions().handle(result, {
      computerId: computer.id,
      instanceId: computer.currentInstanceId as string,
      installationId: computer.currentInstallationId as string,
      signal: new AbortController().signal,
    });
  };
  return {
    client,
    account,
    computer,
    agent,
    agents,
    binding,
    session,
    registry,
    proofs,
    mint,
    domain,
    dependencies,
    respond,
    sent,
    frames,
  };
}

it.each(["reactivate", "second suspension", "delete"])(
  "skips an old suspend callback after %s without a stop frame",
  async (change) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred();
    const service = new AgentService(f.client.database, {
      onProviderCliPlacementChanged: async () => {
        entered.resolve();
        await release.promise;
      },
      stopSessions: (targets) => stopAgentSessions(f.client.database, targets, f.dependencies),
    });
    const stopping = service.suspendById(f.account.id, f.agent.id);
    try {
      await entered.promise;
      await f.agents.reactivateById(f.account.id, f.agent.id);
      const proof = await f.mint();
      if (change !== "reactivate") await f.agents.suspendById(f.account.id, f.agent.id);
      if (change === "delete") await f.agents.deleteById(f.account.id, f.agent.id);
      release.resolve();
      await stopping;
      expect(f.frames).toHaveLength(0);
      if (change === "reactivate")
        await expect(f.proofs.authenticate(proof.token)).resolves.toMatchObject({ agentId: f.agent.id });
    } finally {
      release.resolve();
      await stopping;
    }
  },
);

it("releases final admission before a stopped result and preserves a later reused proof", async () => {
  const f = await fixture();
  const service = new AgentService(f.client.database, {
    stopSessions: (targets) => stopAgentSessions(f.client.database, targets, f.dependencies),
  });
  const stopping = service.suspendById(f.account.id, f.agent.id);
  await f.sent.promise;
  await f.agents.reactivateById(f.account.id, f.agent.id);
  const proof = await f.mint();
  await expect(f.client.sql`select 1 as healthy`).resolves.toHaveLength(1);
  await f.respond();
  await stopping;
  expect(f.frames).toHaveLength(1);
  await expect(f.proofs.authenticate(proof.token)).resolves.toMatchObject({ agentId: f.agent.id });
});

it("finishes a confirmed stop while provider cancel and socket callbacks remain pending", async () => {
  const release = deferred(),
    cancelSent = deferred();
  let respond: (() => Promise<void>) | undefined;
  const f = await fixture((frame, done) => {
    if (frame.type === "provider-cli:cancel") {
      cancelSent.resolve();
      void release.promise.then(done);
    } else if (frame.type === "session:reconcile") {
      void release.promise.then(done);
      queueMicrotask(() => {
        void respond?.();
      });
    } else done();
  });
  respond = f.respond;
  const owner = new ProviderCliReconcileOwner(f.registry, {
    listActiveProviderCliRequirements: async () => [
      {
        agentId: f.agent.id,
        integrationId: randomUUID(),
        provider: "slack",
        credentialGeneration: 1,
        expectedIdentity: { provider: "slack", teamId: "T", botUserId: "U", botId: "B" },
      },
    ],
    issueIntegrationCliValidationGrant: async () => undefined,
  });
  await owner.onActiveBindingChanged({ agentId: f.agent.id, computerId: f.computer.id });
  const service = new AgentService(f.client.database, {
    onProviderCliPlacementChanged: (input) => owner.onAgentPlacementChanged(input),
    stopSessions: (targets) => stopAgentSessions(f.client.database, targets, f.dependencies),
  });
  try {
    const stopping = service.suspendById(f.account.id, f.agent.id);
    await cancelSent.promise;
    expect((await stopping).status).toBe("suspended");
    expect(f.frames).toHaveLength(1);
    expect(
      await f.client.database.select().from(sessionCliProofs).where(eq(sessionCliProofs.sessionId, f.session.id)),
    ).toHaveLength(0);
    await expect(f.client.sql`select 1 as healthy`).resolves.toHaveLength(1);
  } finally {
    release.resolve();
    owner.close();
  }
});
