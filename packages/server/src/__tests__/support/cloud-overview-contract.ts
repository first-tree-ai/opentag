import { randomUUID } from "node:crypto";
import { AgentCloudOverviewSchema } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  imBindings,
  imMessageDeliveries,
  imMessages,
  runtimeDurableWork,
  sandboxes,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { CloudOverviewService } from "../../services/sandboxes/cloud-overview-service.js";
import { SandboxService } from "../../services/sandboxes/index.js";
import { RunnerHub } from "../../services/sandboxes/runner-hub.js";
import { SessionService } from "../../services/sessions/index.js";

export function cloudOverviewContract(databaseForTest: () => DatabaseClient) {
  const RUNNER_VERSION = "0.0.5";
  const cloudIdentities = {
    enabled: true,
    runnerVersion: RUNNER_VERSION,
    storageBase: "gs://integration-cloud/sandboxes",
  };
  const unusedAccountResolver = {
    getActiveUserById: async () => {
      throw new Error("unused Account projection");
    },
  };

  let database: DatabaseClient;
  beforeEach(() => {
    database = databaseForTest();
  });

  async function fixture() {
    const accountId = randomUUID();
    await database
      .insert(users)
      .values({ id: accountId, email: `${accountId}@example.test`, displayName: "E9 overview" });
    const cloud = await new ComputerService(database, unusedAccountResolver, {
      cloudIdentities,
    }).ensureCloudComputerForAccount(accountId);
    const agent = await new AgentService(database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
      name: `e9-overview-${randomUUID().slice(0, 8)}`,
      displayName: "E9 overview",
      runtimeProvider: "pi",
      computerId: cloud.computerId,
    });
    const bindingId = randomUUID();
    await database.insert(imBindings).values({
      id: bindingId,
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: `it-app-${randomUUID().slice(0, 8)}`,
      externalBotId: "it-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "integration-only-unused",
      activatedAt: new Date(),
    });
    const sandbox = await new SandboxService(database, new SessionService(database), {
      cloudIdentities,
    }).ensureForAccount(accountId, {
      imBindingId: bindingId,
      channelId: "it-channel",
      conversationKind: "channel",
      kind: "channel",
    });
    return { accountId, sandbox, agent, cloud };
  }

  function service(hub = new RunnerHub(), controlsEnabled = true) {
    return new CloudOverviewService(database, { hub, accountLimit: 3, controlsEnabled });
  }

  describe("Cloud overview authority and database projection", () => {
    it("counts waiting Sessions once even with multiple queued inputs", async () => {
      const value = await fixture();
      const [session] = await database.select().from(sessions).where(eq(sessions.id, value.sandbox.sessionId));
      if (!session) throw new Error("missing Session");
      for (let index = 0; index < 2; index++) {
        const [message] = await database
          .insert(imMessages)
          .values({
            imBindingId: session.imBindingId,
            channelId: session.channelId,
            externalMessageId: randomUUID(),
            providerRevisionKey: "1",
            operation: "created",
            direction: "inbound",
            authorKind: "human",
            authorExternalId: "test-human",
            content: { version: 1, fallbackText: "test", blocks: [], truncated: false },
            providerContext: { provider: "feishu", chatType: "group" },
            occurredAt: new Date(),
          })
          .returning({ id: imMessages.id });
        if (!message) throw new Error("missing message");
        await database.insert(imMessageDeliveries).values({
          messageId: message.id,
          sessionId: session.id,
          attention: "direct",
          placementGeneration: 1,
          expiresAt: new Date(Date.now() + 60_000),
        });
      }
      const result = await service().read(value.accountId, value.agent.id, { limit: 20 });
      expect(result.counts).toEqual({ allocated: 0, running: 0, queued: 1, attention: 0 });
      expect(result.sessions[0]?.taskState).toBe("queued");
    });

    it("rejects other Accounts and preserves suspended/ended cleanup visibility", async () => {
      const value = await fixture();
      const foreign = await fixture();
      await expect(service().read(foreign.accountId, value.agent.id, { limit: 20 })).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
      await database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, value.sandbox.sessionId));
      await database
        .update(sandboxes)
        .set({
          lifecycle: "releasing",
          environmentGeneration: 1,
          currentResourceName: "projects/test/locations/test/instances/tracked",
          lastErrorCode: "workspace_save_failed",
          lastErrorAt: new Date(),
        })
        .where(eq(sandboxes.id, value.sandbox.sandboxId));
      const result = AgentCloudOverviewSchema.parse(
        await service().read(value.accountId, value.agent.id, { limit: 20 }),
      );
      expect(result.capacity.accountUsed).toBe(1);
      expect(result.counts).toEqual({ allocated: 1, queued: 0, running: 0, attention: 1 });
      expect(result.sessions[0]).toMatchObject({
        canRelease: true,
        canDiscard: true,
        taskState: "idle",
        lastErrorCode: "workspace_save_failed",
      });
      expect(JSON.stringify(result)).not.toContain("projects/test");
      expect(JSON.stringify(result)).not.toContain("gs://");
      const disabled = await service(new RunnerHub(), false).read(value.accountId, value.agent.id, { limit: 20 });
      expect(disabled.sessions[0]).toMatchObject({ canRelease: false, canDiscard: false });
    });

    it("includes internal Sessions, paginates without truncating totals, and scopes filters", async () => {
      const value = await fixture();
      const foreign = await fixture();
      const [parent] = await database.select().from(sessions).where(eq(sessions.id, value.sandbox.sessionId));
      if (!parent) throw new Error("missing parent");
      const childId = randomUUID();
      await database.insert(sessions).values({
        id: childId,
        imBindingId: parent.imBindingId,
        channelId: "internal-child",
        conversationKind: "channel",
        kind: "internal",
        createdBySessionId: parent.id,
      });
      await database
        .insert(sessionPlacements)
        .values({ sessionId: childId, computerId: value.cloud.computerId, generation: 1 });
      await database.insert(sandboxes).values({
        sessionId: childId,
        storageUri: `gs://test/${childId}`,
        lifecycle: "preparing",
        environmentGeneration: 1,
        currentResourceName: `projects/test/locations/test/instances/${childId}`,
        lastErrorCode: "cloud_create_pending",
        lastErrorAt: new Date(),
      });
      await database.insert(runtimeDurableWork).values({
        computerId: value.cloud.computerId,
        kind: "session-message",
        recordKey: `${childId}:${randomUUID()}`,
        payload: { type: "cloud-session-message-work" },
        status: "accepted",
        attempts: 0,
        acceptedAt: Date.now(),
        updatedAt: Date.now(),
      });
      const first = await service().read(value.accountId, value.agent.id, { limit: 1 });
      expect(first.counts).toEqual({ allocated: 1, queued: 0, running: 1, attention: 0 });
      expect(first.nextCursor).not.toBeNull();
      const next = await service().read(value.accountId, value.agent.id, {
        limit: 1,
        cursor: first.nextCursor as string,
      });
      expect(next.nextCursor).toBeNull();
      expect(next.counts).toEqual(first.counts);
      expect(new Set([...first.sessions, ...next.sessions].map((row) => row.sessionId)).size).toBe(2);
      const child = await service().read(value.accountId, value.agent.id, { limit: 20, sessionId: childId });
      expect(child.sessions[0]).toMatchObject({
        kind: "internal",
        taskState: "unknown",
        runnerConnected: false,
        lastErrorCode: null,
      });
      const filtered = await service().read(value.accountId, value.agent.id, {
        limit: 20,
        sessionId: foreign.sandbox.sessionId,
      });
      expect(filtered.sessions).toEqual([]);
      expect(filtered.counts).toEqual(first.counts);
    });

    it("keeps occupancy when lifecycle and resource facts disagree", async () => {
      const value = await fixture();
      await database
        .update(sandboxes)
        .set({
          lifecycle: "unallocated",
          currentResourceName: "projects/test/locations/test/instances/tracked",
        })
        .where(eq(sandboxes.id, value.sandbox.sandboxId));
      let result = await service().read(value.accountId, value.agent.id, { limit: 20 });
      expect(result.capacity.accountUsed).toBe(1);
      expect(result.counts.allocated).toBe(1);
      await database
        .update(sandboxes)
        .set({ lifecycle: "preparing", currentResourceName: null })
        .where(eq(sandboxes.id, value.sandbox.sandboxId));
      result = await service().read(value.accountId, value.agent.id, { limit: 20 });
      expect(result.capacity.accountUsed).toBe(1);
      expect(result.counts.allocated).toBe(1);
    });

    it("rejects stale Runner readiness and redacts unfamiliar diagnostics", async () => {
      const value = await fixture();
      const name = "projects/test/locations/test/instances/current";
      await database
        .update(sandboxes)
        .set({
          lifecycle: "ready",
          environmentGeneration: 2,
          currentResourceName: name,
          lastErrorCode: "private_diagnostic_detail",
          lastErrorAt: new Date(),
        })
        .where(eq(sandboxes.id, value.sandbox.sandboxId));
      const hub = new RunnerHub();
      const socket = { send() {}, close() {} };
      const scope = {
        sandboxId: value.sandbox.sandboxId,
        sessionId: value.sandbox.sessionId,
        environmentGeneration: 1,
        resourceName: name,
      };
      hub.attach(scope, socket);
      hub.markReady(
        scope,
        {
          sandboxName: "test",
          rootfs: "/root",
          nodeVersion: "24",
          piVersion: "1",
          runnerVersion: "1",
          reportedAt: new Date().toISOString(),
        },
        socket,
      );
      const result = await service(hub).read(value.accountId, value.agent.id, { limit: 20 });
      expect(result.sessions[0]).toMatchObject({
        runnerConnected: false,
        runnerReady: false,
        lastErrorCode: "environment_unavailable",
        canDiscard: false,
      });
      expect(result.counts.attention).toBe(1);
      const current = { ...scope, environmentGeneration: 2 };
      const newSocket = { send() {}, close() {} };
      hub.attach(current, newSocket);
      hub.markReady(
        current,
        {
          sandboxName: "test",
          rootfs: "/root",
          nodeVersion: "24",
          piVersion: "1",
          runnerVersion: "1",
          reportedAt: new Date().toISOString(),
        },
        newSocket,
      );
      expect((await service(hub).read(value.accountId, value.agent.id, { limit: 20 })).sessions[0]).toMatchObject({
        runnerConnected: true,
        runnerReady: true,
      });
      await database
        .update(sandboxes)
        .set({ idleReclaimAt: new Date(), currentResourceUid: randomUUID() })
        .where(eq(sandboxes.id, value.sandbox.sandboxId));
      expect((await service(hub).read(value.accountId, value.agent.id, { limit: 20 })).sessions[0]).toMatchObject({
        runnerConnected: true,
        runnerReady: false,
      });
    });
  });
}
