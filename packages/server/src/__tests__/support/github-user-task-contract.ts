import { createHash, randomUUID } from "node:crypto";
import { GitHubConnectionStatusSchema, type RuntimeExecutionSource, type RuntimeUserTaskSource } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../db/client.js";
import {
  agentSchedules,
  agents,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessions,
  users,
} from "../../db/schema/index.js";
import type { RuntimeProxyAuthorization } from "../../runtime-credentials/credential-broker.js";
import { RuntimeExecutionRegistry } from "../../runtime-credentials/execution-registry.js";
import type { ProviderProxyRequest } from "../../runtime-credentials/provider-proxy-adapter.js";
import { DatabaseAgentOwnerResolver } from "../../services/agents/agent-self-service.js";
import type { GitHubManagementService } from "../../services/github/github-management-service.js";
import { GitHubProviderAdapter } from "../../services/github-proxy/github-provider-adapter.js";
import { GitHubRuntimePolicy } from "../../services/github-proxy/runtime-policy.js";
import { ScheduleScheduler } from "../../services/schedules/scheduler.js";
import { ScheduleService } from "../../services/schedules/service.js";
import { body } from "./github-proxy-fixture.js";

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
    const [binding] = await db
      .insert(imBindings)
      .values({
        agentId: agent.id,
        provider: "feishu",
        status: "active",
        externalAppId: `app_${randomUUID()}`,
        externalBotId: "ou_bot",
        credentialSchemaVersion: 1,
        credentialGeneration: 1,
        encryptedCredential: "test-only",
        activatedAt: new Date(),
      })
      .returning();
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
    return { db, policy, source, account, agent, message, delivery, session, target, admit, collaboration, connection };
  }

  async function executeAsUser(
    f: Awaited<ReturnType<typeof fixture>>,
    origin: "local" | "cloud",
    sessionId: string,
    source: RuntimeExecutionSource,
    userId: string,
    denied = false,
    statusRead = false,
  ) {
    f.connection.githubUserId = userId;
    const management = {
      getExecutionUserCredential: vi.fn(async () => ({
        accessToken: `ghu_parent_${userId}`,
        githubUserId: userId,
        credentialGeneration: 3n,
        accessExpiresAt: new Date(Date.now() + 60000),
      })),
    };
    const executions = new RuntimeExecutionRegistry();
    const record = executions.open({
      runId: randomUUID(),
      accountId: f.account.id,
      agentId: f.agent.id,
      agentRevision: 1,
      sessionId,
      computerId: randomUUID(),
      instanceId: randomUUID(),
      connectionId: randomUUID(),
      placementGeneration: 1,
      source,
      purpose: "execution",
      computerKind: origin,
      providers: new Map(),
    });
    const policy = new GitHubRuntimePolicy({
      database: f.db,
      management: {
        getOverview: async () => ({ connection: f.connection }),
        resolveRepository: async () => ({
          repositoryId: "123",
          installationId: "456",
          fullName: "owner/repository",
          defaultBranch: "main",
          authorizationVersion: 7n,
          credentialGeneration: 3n,
        }),
      } as unknown as GitHubManagementService,
    });
    const authorization: RuntimeProxyAuthorization = {
      executionId: record.executionId,
      sessionId,
      accountId: f.account.id,
      agentId: f.agent.id,
      bindingId: f.connection.id,
      provider: "github",
      purpose: "execution",
      scopeHash: "a".repeat(64),
      authorizationRevision: "github:7",
      credentialGeneration: "3",
      cli: { provider: "github", connectionId: f.connection.id, authority: "user-task" },
      recheck: async () => {
        if (!(await policy.admit({ ...record, source })))
          throw Object.assign(new Error("Task no longer admitted"), { code: "scope_denied" });
      },
      resolveMaterial: async () => {
        throw new Error("No raw material goes to runtime");
      },
    };
    const upstream = vi.fn(async (input: { token: string }) => {
      expect(input.token).toBe(`ghu_parent_${userId}`);
      return { status: 200, headers: {}, body: body(JSON.stringify({ id: 123, full_name: "owner/repository" })) };
    });
    const adapter = new GitHubProviderAdapter({ management, transport: { request: upstream } });
    const request: ProviderProxyRequest = {
      executionId: record.executionId,
      sessionId,
      provider: "github",
      bindingId: f.connection.id,
      method: "GET",
      path: statusRead ? "/repos/owner/repository/commits/main/status" : "/repos/owner/repository",
      headers: { "x-opentag-provider-origin": "api.github.com" },
      body: body(),
      capability: "fixture-capability",
      capabilityTtlSeconds: 60,
      signal: new AbortController().signal,
    };
    try {
      if (denied) {
        await expect(adapter.handle(request, authorization)).rejects.toMatchObject({ code: "scope_denied" });
        expect(upstream).not.toHaveBeenCalled();
        return;
      }
      const response = await adapter.handle(request, authorization);
      for await (const _chunk of response.body) {
        /* consume the bounded response */
      }
      expect(response.status).toBe(200);
      expect(management.getExecutionUserCredential).toHaveBeenCalledWith({
        accountId: f.account.id,
        connectionId: f.connection.id,
        authorizationRevision: "github:7",
      });
      expect(upstream).toHaveBeenCalled();
    } finally {
      executions.close(record.executionId, "execution_closed");
    }
  }

  async function collaborationPeer(f: Awaited<ReturnType<typeof fixture>>) {
    const [agent] = await f.db
      .insert(agents)
      .values({ createdByUserId: f.account.id, name: "peer", displayName: "Peer", runtimeProvider: "codex" })
      .returning();
    if (!agent) throw new Error("Peer missing");
    const [binding] = await f.db
      .insert(imBindings)
      .values({
        agentId: agent.id,
        provider: "feishu",
        status: "active",
        externalAppId: `app_${randomUUID()}`,
        externalBotId: "ou_peer",
        credentialSchemaVersion: 1,
        credentialGeneration: 1,
        encryptedCredential: "fixture",
        activatedAt: new Date(),
      })
      .returning();
    if (!binding) throw new Error("Peer binding missing");
    const [session] = await f.db
      .insert(sessions)
      .values({ imBindingId: binding.id, channelId: "peer", conversationKind: "channel", kind: "channel" })
      .returning();
    if (!session) throw new Error("Peer Session missing");
    const source = await f.collaboration(true);
    await f.db
      .update(sessionMessages)
      .set({ targetSessionId: session.id })
      .where(eq(sessionMessages.id, source.messageId));
    return { agent, session, source };
  }

  async function schedules(f: Awaited<ReturnType<typeof fixture>>, userTaskSource?: RuntimeUserTaskSource) {
    let now = new Date();
    const executionId = randomUUID();
    const authenticate = vi.fn(async (_proof: string, id?: string) => ({
      agentId: f.agent.id,
      computerId: randomUUID(),
      connectionInstanceId: randomUUID(),
      installationId: randomUUID(),
      placementGeneration: 1,
      sessionId: userTaskSource?.sessionId ?? f.session.id,
      sessionKind: "channel" as const,
      ...(id === executionId && userTaskSource ? { userTaskSource } : {}),
    }));
    const service = new ScheduleService({
      database: f.db,
      owners: new DatabaseAgentOwnerResolver(f.db),
      proofs: { authenticate },
      publicUrl: "https://opentag.example",
      clock: { now: async () => now },
    });
    const scope = await service.authenticate("proof", executionId);
    expect(authenticate).toHaveBeenCalledWith("proof", executionId);
    const legacyScope = await service.authenticate("proof");
    const scheduler = new ScheduleScheduler({
      database: f.db,
      publicUrl: "https://opentag.example",
      clock: { now: async () => now },
      dispatch: { dispatchScheduledMessage: vi.fn() },
      sessions: { resolveScheduledMessageRoute: async () => ({ kind: "ready" }) } as never,
    });
    const create = () =>
      service.createForAgent(scope, {
        name: "task",
        prompt: "check GitHub",
        schedule: { kind: "every", intervalSeconds: 120 },
        timezone: "UTC",
      });
    async function dispatch(id: string) {
      const [row] = await f.db.select().from(agentSchedules).where(eq(agentSchedules.id, id));
      if (!row?.nextTriggerAt) throw new Error("Schedule not due");
      now = new Date(row.nextTriggerAt);
      const result = await scheduler.claimOccurrence(id, { allowDispatch: true });
      if (result.kind !== "claimed") throw new Error(`Unexpected claim: ${result.kind}`);
      await f.db
        .update(sessionMessages)
        .set({ lastOutcome: "accepted" })
        .where(eq(sessionMessages.id, result.snapshot.messageId));
      return {
        sessionId: row.targetSessionId,
        source: { kind: "session-message" as const, messageId: result.snapshot.messageId },
      };
    }
    return { service, scope, legacyScope, create, dispatch };
  }

  describe.each(["local", "cloud"] as const)("%s GitHub user-task SQL authority", (origin) => {
    it.each(["im", "schedule", "collaboration"] as const)(
      "executes %s through each owning user's token on one shared installation",
      async (kind) => {
        for (const userId of ["42", "43"]) {
          const f = await fixture(origin);
          let acting = f;
          let sessionId = f.session.id;
          let source: RuntimeExecutionSource = f.source;
          if (kind === "collaboration") {
            const peer = await collaborationPeer(f);
            source = peer.source;
            sessionId = peer.session.id;
            acting = { ...f, agent: peer.agent };
          }
          if (kind === "schedule") {
            const h = await schedules(f, { sessionId: f.session.id, source: f.source });
            const created = await h.create();
            const task = await h.dispatch(created.id);
            sessionId = task.sessionId;
            source = task.source;
          }
          await executeAsUser(acting, origin, sessionId, source, userId);
          await executeAsUser(acting, origin, sessionId, source, userId, false, true);
        }
      },
    );
    it.each(["bot", "autonomous schedule", "cross-account collaboration"] as const)(
      "does not mint a user token for %s",
      async (kind) => {
        const f = await fixture(origin);
        let acting = f;
        let sessionId = f.session.id;
        let source: RuntimeExecutionSource = f.source;
        if (kind === "bot")
          await f.db.update(imMessages).set({ authorKind: "bot" }).where(eq(imMessages.id, f.message.id));
        if (kind === "autonomous schedule") {
          const h = await schedules(f);
          const created = await h.create();
          const task = await h.dispatch(created.id);
          sessionId = task.sessionId;
          source = task.source;
        }
        if (kind === "cross-account collaboration") {
          const other = await fixture(origin);
          source = await f.collaboration(true);
          acting = other;
          sessionId = other.session.id;
          await f.db
            .update(sessionMessages)
            .set({ targetSessionId: sessionId })
            .where(eq(sessionMessages.id, source.messageId));
        }
        await executeAsUser(acting, origin, sessionId, source, "42", true);
        await executeAsUser(acting, origin, sessionId, source, "42", true, true);
      },
    );
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
      expect(await f.admit(f.target.id, await f.collaboration(false, true))).toBeUndefined();
      const scheduled = await f.collaboration(true, true);
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

    it.each(["legacy", "bot", "untraceable"] as const)(
      "does not launder %s authority through actual schedule creation and dispatch",
      async (kind) => {
        const f = await fixture(origin);
        let provenance: RuntimeUserTaskSource | undefined;
        if (kind === "bot") {
          await f.db.update(imMessages).set({ authorKind: "bot" }).where(eq(imMessages.id, f.message.id));
          provenance = { sessionId: f.session.id, source: f.source };
        } else if (kind === "untraceable") {
          provenance = { sessionId: f.target.id, source: await f.collaboration(false) };
        }
        const h = await schedules(f, provenance);
        const schedule = await h.create();
        expect(schedule).not.toHaveProperty("userTaskSource");
        const task = await h.dispatch(schedule.id);
        expect(await f.admit(task.sessionId, task.source)).toBeUndefined();
        const paused = await h.service.pauseForAgent(h.scope, schedule.id, schedule.revision);
        await h.service.resumeForAccount(f.account.id, f.agent.id, schedule.id, paused.revision);
        const resumed = await h.dispatch(schedule.id);
        expect(await f.admit(resumed.sessionId, resumed.source)).toBeUndefined();
      },
    );

    it("freezes schedule provenance and drops it on unproven edits/resume without changing dispatched work", async () => {
      const f = await fixture(origin);
      const h = await schedules(f, { sessionId: f.session.id, source: f.source });
      const created = await h.create();
      const admitted = await h.dispatch(created.id);
      expect(await f.admit(admitted.sessionId, admitted.source)).toBeDefined();
      let edited = await h.service.updateForAgent(h.legacyScope, created.id, {
        expectedRevision: created.revision,
        prompt: "autonomous change",
      });
      const denied = await h.dispatch(created.id);
      expect(await f.admit(denied.sessionId, denied.source)).toBeUndefined();
      // An old dispatch is independent of the mutable schedule's new content/source.
      expect(await f.admit(admitted.sessionId, admitted.source)).toBeDefined();
      edited = await h.service.updateForAgent(h.scope, created.id, {
        expectedRevision: edited.revision,
        prompt: "new user task",
      });
      const paused = await h.service.pauseForAgent(h.scope, created.id, edited.revision);
      const resumed = await h.service.resumeForAgent(h.legacyScope, created.id, paused.revision);
      const deniedResume = await h.dispatch(created.id);
      expect(await f.admit(deniedResume.sessionId, deniedResume.source)).toBeUndefined();
      await h.service.deleteForAgent(h.scope, created.id, resumed.revision);
      expect(await f.admit(admitted.sessionId, admitted.source)).toBeDefined();
    });
  });
}
