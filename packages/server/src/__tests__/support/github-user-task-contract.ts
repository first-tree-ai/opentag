import { createHash, randomUUID } from "node:crypto";
import { GitHubConnectionStatusSchema, type RuntimeExecutionSource } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessions,
  users,
} from "../../db/schema/index.js";
import type { GitHubManagementService } from "../../services/github/github-management-service.js";
import { GitHubRuntimePolicy } from "../../services/github-proxy/runtime-policy.js";

/** Reused against embedded PostgreSQL and real PostgreSQL; no query-builder mocks. */
export function githubUserTaskContract(database: () => DatabaseClient) {
  async function fixture(origin: "local" | "cloud") {
    const db = database();
    const [account] = await db
      .insert(users)
      .values({ displayName: "Owner", email: `${randomUUID()}@example.com` })
      .returning();
    if (!account) throw new Error("Account fixture missing");
    const [agent] = await db
      .insert(agents)
      .values({ createdByUserId: account.id, name: "worker", displayName: "Worker", runtimeProvider: "codex" })
      .returning();
    if (!agent) throw new Error("Agent fixture missing");
    const [binding] = await db.insert(imBindings).values({ agentId: agent.id, provider: "feishu" }).returning();
    if (!binding) throw new Error("Binding fixture missing");
    const [session] = await db
      .insert(sessions)
      .values({ imBindingId: binding.id, channelId: "channel", conversationKind: "channel", kind: "channel" })
      .returning();
    const [target] = await db
      .insert(sessions)
      .values({ imBindingId: binding.id, channelId: "target", conversationKind: "channel", kind: "channel" })
      .returning();
    if (!session || !target) throw new Error("Session fixture missing");
    const [message] = await db
      .insert(imMessages)
      .values({
        imBindingId: binding.id,
        channelId: "channel",
        externalMessageId: randomUUID(),
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "human",
        providerContext: { provider: "feishu", chatType: "group" },
        content: { version: 1, fallbackText: "task", blocks: [{ type: "text", text: "task" }], truncated: false },
        occurredAt: new Date(),
      })
      .returning();
    if (!message) throw new Error("Message fixture missing");
    const [delivery] = await db
      .insert(imMessageDeliveries)
      .values({
        messageId: message.id,
        sessionId: session.id,
        attention: "direct",
        state: "accepted",
        placementGeneration: 1,
        executionOrigin: origin,
        inputHash: "a".repeat(64),
        turnId: randomUUID(),
        reportOwnerInstanceId: randomUUID(),
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })
      .returning();
    if (!delivery?.turnId) throw new Error("Delivery fixture missing");
    const source: RuntimeExecutionSource = { kind: "delivery", deliveryId: delivery.id, turnId: delivery.turnId };
    const connection = GitHubConnectionStatusSchema.parse({
      id: randomUUID(),
      accountId: account.id,
      githubHost: "github.com",
      appId: "88",
      githubUserId: "42",
      githubLogin: "owner",
      status: "active",
      authorizationVersion: "7",
      credentialGeneration: "3",
      accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
      refreshExpiresAt: null,
      recheckRequired: false,
      nextRecheckAt: null,
      lastVerifiedAt: null,
      lastErrorCode: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const policy = new GitHubRuntimePolicy({
      database: db,
      management: { getOverview: vi.fn(async () => ({ connection })) } as unknown as GitHubManagementService,
      execution: { get: () => undefined },
    });
    const admit = (
      sessionId = session.id,
      taskSource: RuntimeExecutionSource = source,
      accountId = account.id,
      agentId = agent.id,
    ) => policy.admit({ accountId, agentId, sessionId, source: taskSource });
    const sourceSessionId = session.id,
      targetSessionId = target.id;
    async function collaboration(provenance: boolean, scheduled = false) {
      const id = randomUUID();
      await db.insert(sessionMessages).values({
        id,
        sourceSessionId: scheduled ? null : sourceSessionId,
        targetSessionId,
        content: "task",
        contentHash: createHash("sha256").update("task").digest("hex"),
        lastOutcome: "accepted",
        userTaskSource: provenance ? { sessionId: sourceSessionId, source } : null,
        scheduledOrigin: scheduled
          ? {
              scheduleId: randomUUID(),
              scheduledFor: new Date().toISOString(),
              timezone: "UTC",
              name: "User schedule",
            }
          : null,
      });
      return { kind: "session-message" as const, messageId: id };
    }
    return { db, policy, source, account, agent, message, delivery, session, target, admit, collaboration };
  }

  describe.each(["local", "cloud"] as const)("%s GitHub user-task SQL authority", (origin) => {
    it("admits accepted human ingress and refuses bot, account, Agent, Session and source substitutions", async () => {
      const f = await fixture(origin);
      expect(await f.admit()).toBeDefined();
      expect(await f.admit(f.target.id)).toBeUndefined();
      expect(await f.admit(f.session.id, f.source, randomUUID())).toBeUndefined();
      expect(await f.admit(f.session.id, f.source, f.account.id, randomUUID())).toBeUndefined();
      expect(await f.admit(f.session.id, { ...f.source, turnId: randomUUID() })).toBeUndefined();
      await f.db.update(imMessages).set({ authorKind: "bot" }).where(eq(imMessages.id, f.message.id));
      expect(await f.admit()).toBeUndefined();
    });
    it("requires exact recorded user provenance for collaboration and accepted Server-scheduled origins", async () => {
      const f = await fixture(origin);
      expect(await f.admit(f.target.id, await f.collaboration(false))).toBeUndefined();
      const traced = await f.collaboration(true);
      expect(await f.admit(f.target.id, traced)).toBeDefined();
      const scheduled = await f.collaboration(false, true);
      expect(await f.admit(f.target.id, scheduled)).toBeDefined();
      await f.db
        .update(sessionMessages)
        .set({ lastOutcome: "rejected" })
        .where(eq(sessionMessages.id, scheduled.messageId));
      expect(await f.admit(f.target.id, scheduled)).toBeUndefined();
    });
    it("refuses a forged cross-Session provenance link and a root that was never accepted", async () => {
      const f = await fixture(origin);
      const traced = await f.collaboration(true);
      await f.db
        .update(sessionMessages)
        .set({ userTaskSource: { sessionId: f.target.id, source: f.source } })
        .where(eq(sessionMessages.id, traced.messageId));
      expect(await f.admit(f.target.id, traced)).toBeUndefined();
      await f.db
        .update(imMessageDeliveries)
        .set({ state: "pending", inputHash: null, turnId: null, reportOwnerInstanceId: null, acceptedAt: null })
        .where(eq(imMessageDeliveries.id, f.delivery.id));
      expect(await f.admit()).toBeUndefined();
    });
  });
}
