import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  SessionMessageDeliveryRequest,
  SessionMessageDeliveryResult,
  SessionReconcileRequest,
  SessionReconcileResult,
} from "@opentag/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import {
  agents,
  computerCredentials,
  computers,
  imBindings,
  sessionMessages,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { type RuntimeDispatchAdmission, RuntimeDomainRequestError } from "../../runtime/runtime-domain-owner.js";
import { AgentService } from "../../services/agents/index.js";
import { disableImBindingInTransaction } from "../../services/im-bindings/index.js";
import { SessionCliProofService, SessionCollaborationService, SessionService } from "../../services/sessions/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

let container: StartedPostgreSqlContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  databaseUrl = container.getConnectionUri();
}, 120_000);

afterAll(async () => container.stop());

beforeEach(async () => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("drop schema if exists public cascade");
    await sql.unsafe("drop schema if exists drizzle cascade");
    await sql.unsafe("create schema public");
  } finally {
    await sql.end();
  }
});

describe("Session collaboration authority", () => {
  it("creates the internal Session, placement, and initial durable fact atomically and idempotently", async () => {
    const fixture = await createFixture();
    try {
      const creator = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "channel" },
        "channel",
      );
      const messageId = randomUUID();
      const input = {
        creatorSessionId: creator.session.id,
        creatorInstallationId: fixture.installationId,
        creatorConnectionInstanceId: fixture.connectionInstanceId,
        creatorComputerId: fixture.computerId,
        creatorPlacementGeneration: creator.placement.generation,
        messageId,
        initialMessage: "Investigate the deployment failure",
        overrides: { model: "gpt-5.6-codex", reasoningEffort: "high", maxDurationMs: 60_000 },
      };
      const created = await fixture.sessions.createInternalSessionWithMessage(input);
      expect(created).toMatchObject({
        attemptCount: 1,
        deduplicated: false,
        session: {
          kind: "internal",
          createdBySessionId: creator.session.id,
          channelId: "C1",
          runtimeModel: "gpt-5.6-codex",
          runtimeReasoningEffort: "high",
          runtimeMaxDurationMs: 60_000,
        },
        placement: { computerId: fixture.computerId, generation: 1 },
        message: { id: messageId, lastOutcome: "unknown", attemptCount: 1 },
      });
      const recovered = await new SessionService(fixture.database).createInternalSessionWithMessage(input);
      expect(recovered.session.id).toBe(created.session.id);
      expect(recovered.attemptCount).toBe(2);
      expect(await fixture.sessions.recordMessageOutcome({ messageId, attemptCount: 1, outcome: "accepted" })).toBe(
        false,
      );
      expect(await fixture.sessions.recordMessageOutcome({ messageId, attemptCount: 2, outcome: "accepted" })).toBe(
        true,
      );

      const retried = await new SessionService(fixture.database).createInternalSessionWithMessage(input);
      expect(retried.session.id).toBe(created.session.id);
      expect(retried).toMatchObject({ attemptCount: null, deduplicated: true, message: { lastOutcome: "accepted" } });
      expect(await fixture.database.select().from(sessionMessages)).toHaveLength(1);
      expect((await fixture.database.select().from(sessions)).filter(({ kind }) => kind === "internal")).toHaveLength(
        1,
      );
      const placements = await fixture.database.select().from(sessionPlacements);
      expect(placements.every((row) => row.computerId === fixture.computerId)).toBe(true);
      expect(placements.map((row) => row.computerId)).toEqual([fixture.computerId, fixture.computerId]);

      await expect(
        fixture.sessions.createInternalSessionWithMessage({ ...input, initialMessage: "Conflicting task" }),
      ).rejects.toMatchObject({ code: "SESSION_MESSAGE_CONFLICT" });
      await expect(
        fixture.sessions.createInternalSessionWithMessage({
          ...input,
          overrides: { ...input.overrides, maxDurationMs: 120_000 },
        }),
      ).rejects.toMatchObject({ code: "SESSION_MESSAGE_CONFLICT" });
    } finally {
      await fixture.sql.end();
    }
  });

  it("lists direct and recursive internal Sessions with bounded cursor pages", async () => {
    const fixture = await createFixture();
    try {
      const creator = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "dm" },
        "channel",
      );
      const children = [];
      for (const task of ["one", "two", "three"]) {
        children.push(
          await fixture.sessions.createInternalSessionWithMessage({
            creatorSessionId: creator.session.id,
            creatorInstallationId: fixture.installationId,
            creatorConnectionInstanceId: fixture.connectionInstanceId,
            creatorComputerId: fixture.computerId,
            creatorPlacementGeneration: 1,
            messageId: randomUUID(),
            initialMessage: task,
          }),
        );
      }
      const grandchild = await fixture.sessions.createInternalSessionWithMessage({
        creatorSessionId: children[0]?.session.id as string,
        creatorInstallationId: fixture.installationId,
        creatorConnectionInstanceId: fixture.connectionInstanceId,
        creatorComputerId: fixture.computerId,
        creatorPlacementGeneration: 1,
        messageId: randomUUID(),
        initialMessage: "nested",
      });
      const first = await fixture.sessions.listInternalSessions(creator.session.id, {
        recursive: false,
        limit: 2,
      });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();
      const omitted = children.find(({ session }) => !first.items.some(({ sessionId }) => sessionId === session.id));
      if (!omitted) throw new Error("Expected one direct child after the first page");
      const omittedBefore = (
        await fixture.sessions.listInternalSessions(creator.session.id, { recursive: false, limit: 20 })
      ).items.find(({ sessionId }) => sessionId === omitted.session.id);
      expect(
        await fixture.sessions.recordMessageOutcome({
          messageId: omitted.message.id,
          attemptCount: omitted.attemptCount as number,
          outcome: "accepted",
        }),
      ).toBe(true);
      const second = await fixture.sessions.listInternalSessions(creator.session.id, {
        recursive: false,
        limit: 2,
        cursor: first.nextCursor,
      });
      const pagedIds = [...first.items, ...second.items].map(({ sessionId }) => sessionId);
      expect(pagedIds).toHaveLength(3);
      expect(new Set(pagedIds)).toHaveLength(3);
      expect(second.items.find(({ sessionId }) => sessionId === omitted.session.id)).toMatchObject({
        lastMessageAt: omittedBefore?.lastMessageAt,
        lastDeliveryOutcome: "accepted",
      });
      const recursive = await fixture.sessions.listInternalSessions(creator.session.id, {
        recursive: true,
        limit: 20,
      });
      expect(recursive.items.map(({ sessionId }) => sessionId)).toContain(grandchild.session.id);
      await expect(
        fixture.sessions.listInternalSessions(creator.session.id, {
          recursive: false,
          limit: 20,
          cursor: "invalid",
        }),
      ).rejects.toMatchObject({ code: "SESSION_CURSOR_INVALID" });
    } finally {
      await fixture.sql.end();
    }
  });

  it("uses bounded indexes for recursive pages and descendant activity writes", async () => {
    const fixture = await createFixture();
    try {
      const root = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "dm" },
        "channel",
      );
      let parent = root;
      let lastMessageId: string | undefined;
      for (let index = 0; index < 120; index += 1) {
        const created = await fixture.sessions.createInternalSessionWithMessage({
          creatorSessionId: parent.session.id,
          creatorInstallationId: fixture.installationId,
          creatorConnectionInstanceId: fixture.connectionInstanceId,
          creatorComputerId: fixture.computerId,
          creatorPlacementGeneration: 1,
          messageId: randomUUID(),
          initialMessage: `nested-${index}`,
        });
        parent = created;
        lastMessageId = created.message.id;
      }
      if (!lastMessageId) throw new Error("Expected a nested Session message");

      const page = await fixture.sessions.listInternalSessions(root.session.id, { recursive: true, limit: 10 });
      expect(page.items).toHaveLength(10);
      expect(page.nextCursor).toBeDefined();

      await fixture.sql.unsafe("set enable_seqscan = off");
      const plan = await fixture.sql`
        explain (format json)
        select descendant_session_id
        from session_descendants
        where ancestor_session_id = ${root.session.id}::uuid
        order by last_message_created_at desc, last_message_id desc, descendant_session_id desc
        limit 11
      `;
      expect(JSON.stringify(plan)).toContain("session_descendants_ancestor_activity_idx");

      const ancestorCopyPlan = await fixture.sql`
        explain (format json)
        select ancestor_session_id
        from session_descendants
        where descendant_session_id = ${parent.session.id}::uuid
      `;
      expect(JSON.stringify(ancestorCopyPlan)).toContain("session_descendants_descendant_ancestor_idx");

      const activityUpdatePlan = await fixture.sql`
        explain (format json)
        update session_descendants
        set last_delivery_outcome = last_delivery_outcome
        where descendant_session_id = ${parent.session.id}::uuid
      `;
      expect(JSON.stringify(activityUpdatePlan)).toContain("session_descendants_descendant_ancestor_idx");

      const outcomeUpdatePlan = await fixture.sql`
        explain (format json)
        update session_descendants
        set last_delivery_outcome = last_delivery_outcome
        where last_message_id = ${lastMessageId}::uuid
      `;
      expect(JSON.stringify(outcomeUpdatePlan)).toContain("session_descendants_last_message_idx");
    } finally {
      await fixture.sql.end();
    }
  }, 15_000);

  it("retries only explicit unknown or unreachable attempts and fences stale outcome writers", async () => {
    const fixture = await createFixture();
    try {
      const creator = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "dm" },
        "channel",
      );
      const child = await fixture.sessions.createInternalSessionWithMessage({
        creatorSessionId: creator.session.id,
        creatorInstallationId: fixture.installationId,
        creatorConnectionInstanceId: fixture.connectionInstanceId,
        creatorComputerId: fixture.computerId,
        creatorPlacementGeneration: 1,
        messageId: randomUUID(),
        initialMessage: "Start",
      });
      const messageId = randomUUID();
      const input = {
        messageId,
        sourceSessionId: child.session.id,
        sourceInstallationId: fixture.installationId,
        sourceConnectionInstanceId: fixture.connectionInstanceId,
        sourceComputerId: fixture.computerId,
        sourcePlacementGeneration: 1,
        targetSessionId: creator.session.id,
        content: "Progress",
      };
      const first = await fixture.sessions.authorizeAndRecordMessage(input);
      expect(first.attemptCount).toBe(1);
      expect(
        await fixture.sessions.recordMessageOutcome({
          messageId,
          attemptCount: 1,
          outcome: "unreachable",
          errorCode: "runtime_unavailable",
        }),
      ).toBe(true);
      const second = await new SessionService(fixture.database).authorizeAndRecordMessage(input);
      expect(second.attemptCount).toBe(2);
      expect(await fixture.sessions.recordMessageOutcome({ messageId, attemptCount: 1, outcome: "accepted" })).toBe(
        false,
      );
      expect(await fixture.sessions.recordMessageOutcome({ messageId, attemptCount: 2, outcome: "accepted" })).toBe(
        true,
      );
      const deduplicated = await fixture.sessions.authorizeAndRecordMessage(input);
      expect(deduplicated).toMatchObject({
        attemptCount: null,
        deduplicated: true,
        message: { lastOutcome: "accepted" },
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("rejects stale, ended, and cross-scope requests before recording a business message", async () => {
    const fixture = await createFixture();
    try {
      const source = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "channel" },
        "channel",
      );
      const otherScope = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C2", conversationKind: "channel" },
        "channel",
      );
      const staleId = randomUUID();
      await expect(
        fixture.sessions.authorizeAndRecordMessage({
          messageId: staleId,
          sourceSessionId: source.session.id,
          sourceInstallationId: fixture.installationId,
          sourceConnectionInstanceId: fixture.connectionInstanceId,
          sourceComputerId: fixture.computerId,
          sourcePlacementGeneration: 2,
          targetSessionId: source.session.id,
          content: "stale",
        }),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_STALE" });
      const crossScopeId = randomUUID();
      await expect(
        fixture.sessions.authorizeAndRecordMessage({
          messageId: crossScopeId,
          sourceSessionId: source.session.id,
          sourceInstallationId: fixture.installationId,
          sourceConnectionInstanceId: fixture.connectionInstanceId,
          sourceComputerId: fixture.computerId,
          sourcePlacementGeneration: 1,
          targetSessionId: otherScope.session.id,
          content: "cross scope",
        }),
      ).rejects.toMatchObject({ code: "SESSION_SCOPE_MISMATCH" });
      await fixture.database
        .update(sessions)
        .set({ endedAt: new Date() })
        .where(eq(sessions.id, otherScope.session.id));
      const endedId = randomUUID();
      await expect(
        fixture.sessions.authorizeAndRecordMessage({
          messageId: endedId,
          sourceSessionId: source.session.id,
          sourceInstallationId: fixture.installationId,
          sourceConnectionInstanceId: fixture.connectionInstanceId,
          sourceComputerId: fixture.computerId,
          sourcePlacementGeneration: 1,
          targetSessionId: otherScope.session.id,
          content: "ended",
        }),
      ).rejects.toMatchObject({ code: "SESSION_TARGET_UNAVAILABLE" });
      const [otherOwner] = await fixture.database
        .insert(users)
        .values({ displayName: "Other", email: `other-${randomUUID()}@example.com` })
        .returning();
      if (!otherOwner) throw new Error("Other Account fixture was not created");
      await fixture.database
        .update(computers)
        .set({ ownerAccountId: otherOwner.id })
        .where(eq(computers.id, fixture.computerId));
      const ownerMismatchId = randomUUID();
      await expect(
        fixture.sessions.authorizeAndRecordMessage({
          messageId: ownerMismatchId,
          sourceSessionId: source.session.id,
          sourceInstallationId: fixture.installationId,
          sourceConnectionInstanceId: fixture.connectionInstanceId,
          sourceComputerId: fixture.computerId,
          sourcePlacementGeneration: 1,
          targetSessionId: source.session.id,
          content: "owner mismatch",
        }),
      ).rejects.toMatchObject({ code: "SESSION_SOURCE_UNAVAILABLE" });
      for (const messageId of [staleId, crossScopeId, endedId, ownerMismatchId]) {
        expect(await fixture.database.select().from(sessionMessages).where(eq(sessionMessages.id, messageId))).toEqual(
          [],
        );
      }
    } finally {
      await fixture.sql.end();
    }
  });

  it("inherits a Thread scope through nested internal Sessions", async () => {
    const fixture = await createFixture();
    try {
      const thread = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "channel" },
        "thread",
        "root-1",
      );
      const child = await fixture.sessions.createInternalSessionWithMessage({
        creatorSessionId: thread.session.id,
        creatorInstallationId: fixture.installationId,
        creatorConnectionInstanceId: fixture.connectionInstanceId,
        creatorComputerId: fixture.computerId,
        creatorPlacementGeneration: 1,
        messageId: randomUUID(),
        initialMessage: "Child",
      });
      const grandchild = await fixture.sessions.createInternalSessionWithMessage({
        creatorSessionId: child.session.id,
        creatorInstallationId: fixture.installationId,
        creatorConnectionInstanceId: fixture.connectionInstanceId,
        creatorComputerId: fixture.computerId,
        creatorPlacementGeneration: 1,
        messageId: randomUUID(),
        initialMessage: "Grandchild",
      });
      expect(child.session).toMatchObject({ channelId: "C1", conversationKind: "channel", threadKey: "root-1" });
      expect(grandchild.session).toMatchObject({
        createdBySessionId: child.session.id,
        channelId: "C1",
        conversationKind: "channel",
        threadKey: "root-1",
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("keeps proofs stable across busy, lost-response, retry, and concurrent reconciles", async () => {
    const fixture = await createFixture();
    try {
      const source = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "dm" },
        "channel",
      );
      let currentInstanceId = randomUUID();
      await fixture.database.update(computers).set({ currentInstanceId }).where(eq(computers.id, fixture.computerId));
      const registry = {
        currentInstanceId: (computerId: string) => (computerId === fixture.computerId ? currentInstanceId : undefined),
        supportsCapability: (computerId: string, instanceId: string) =>
          computerId === fixture.computerId && instanceId === currentInstanceId,
      };
      const proofs = new SessionCliProofService(fixture.database, registry, new Uint8Array(32).fill(7));
      const input = {
        sessionId: source.session.id,
        computerId: fixture.computerId,
        placementGeneration: 1,
        connectionInstanceId: currentInstanceId,
      };

      const [first, retried, concurrent] = await Promise.all([
        proofs.mint(input),
        proofs.mint(input),
        proofs.mint(input),
      ]);
      expect(retried).toEqual(first);
      expect(concurrent).toEqual(first);
      await expect(proofs.authenticate(first.token)).resolves.toMatchObject({ sessionId: source.session.id });

      const busyReconcile = await proofs.prepareReconcile(fixture.computerId, currentInstanceId, {
        type: "session:reconcile",
        requestId: randomUUID(),
        installationId: fixture.installationId,
        sessionId: source.session.id,
        agentId: fixture.agentId,
        placementGeneration: 1,
        desired: "ready",
        runtime: runtimeSnapshot(fixture.agentId),
      });
      expect(busyReconcile.sessionCliProof).toEqual(first);
      await expect(proofs.authenticate(first.token)).resolves.toMatchObject({ sessionId: source.session.id });

      const replacementInstanceId = randomUUID();
      currentInstanceId = replacementInstanceId;
      await fixture.database
        .update(computers)
        .set({ currentInstanceId: replacementInstanceId })
        .where(eq(computers.id, fixture.computerId));
      await expect(proofs.authenticate(first.token)).rejects.toMatchObject({ code: "invalid_proof" });
      const replacement = await proofs.mint({ ...input, connectionInstanceId: replacementInstanceId });
      expect(replacement).not.toEqual(first);
      await expect(proofs.authenticate(replacement.token)).resolves.toMatchObject({ sessionId: source.session.id });

      const moved = await fixture.sessions.movePlacement(source.session.id, fixture.computerId);
      expect(moved.generation).toBe(2);
      const [movedRow] = await fixture.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, source.session.id));
      expect(movedRow).toMatchObject({ computerId: fixture.computerId, generation: 2 });
      const current = await proofs.mint({
        ...input,
        placementGeneration: 2,
        connectionInstanceId: replacementInstanceId,
      });
      await expect(
        proofs.prepareReconcile(fixture.computerId, replacementInstanceId, {
          type: "session:reconcile",
          requestId: randomUUID(),
          installationId: fixture.installationId,
          sessionId: source.session.id,
          agentId: fixture.agentId,
          placementGeneration: 1,
          desired: "ready",
          runtime: runtimeSnapshot(fixture.agentId),
        }),
      ).rejects.toMatchObject({ code: "runtime_unavailable" });
      await expect(proofs.authenticate(current.token)).resolves.toMatchObject({ placementGeneration: 2 });

      await proofs.prepareReconcile(fixture.computerId, replacementInstanceId, {
        type: "session:reconcile",
        requestId: randomUUID(),
        installationId: fixture.installationId,
        sessionId: source.session.id,
        agentId: fixture.agentId,
        placementGeneration: 1,
        desired: "stopped",
      });
      await expect(proofs.authenticate(current.token)).resolves.toMatchObject({ placementGeneration: 2 });
    } finally {
      await fixture.sql.end();
    }
  });

  it("invalidates proofs on wrong Computer, stale generation, inactive Agent, or inactive IM binding", async () => {
    const fixture = await createFixture();
    try {
      const source = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "dm" },
        "channel",
      );
      const connectionInstanceId = randomUUID();
      await fixture.database
        .update(computers)
        .set({ currentInstanceId: connectionInstanceId })
        .where(eq(computers.id, fixture.computerId));
      const registry = {
        currentInstanceId: () => connectionInstanceId,
        supportsCapability: () => true,
      };
      const proofs = new SessionCliProofService(fixture.database, registry, new Uint8Array(32).fill(9));
      const mint = () =>
        proofs.mint({
          sessionId: source.session.id,
          computerId: fixture.computerId,
          placementGeneration: 1,
          connectionInstanceId,
        });

      let proof = await mint();
      await fixture.database
        .update(sessionPlacements)
        .set({ generation: 2 })
        .where(eq(sessionPlacements.sessionId, source.session.id));
      await expect(proofs.authenticate(proof.token)).rejects.toMatchObject({ code: "invalid_proof" });
      await fixture.database
        .update(sessionPlacements)
        .set({ generation: 1 })
        .where(eq(sessionPlacements.sessionId, source.session.id));

      proof = await mint();
      await fixture.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
      await expect(proofs.authenticate(proof.token)).rejects.toMatchObject({ code: "invalid_proof" });
      await fixture.database.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.agentId));

      proof = await mint();
      await fixture.database.update(imBindings).set({ status: "error" }).where(eq(imBindings.id, fixture.imBindingId));
      await expect(proofs.authenticate(proof.token)).rejects.toMatchObject({ code: "invalid_proof" });
      await fixture.database.update(imBindings).set({ status: "active" }).where(eq(imBindings.id, fixture.imBindingId));

      const [otherComputer] = await fixture.database
        .insert(computers)
        .values({
          ownerAccountId: fixture.userId,
          currentInstallationId: randomUUID(),
          displayName: "other-workstation",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.2",
          currentInstanceId: connectionInstanceId,
        })
        .returning({ id: computers.id });
      if (!otherComputer) throw new Error("Second Computer fixture was not created");
      await fixture.database.insert(computerCredentials).values({
        computerId: otherComputer.id,
        secretHash: `integration-collaboration-other-${otherComputer.id}`,
        issuedByUserId: fixture.userId,
      });
      proof = await mint();
      await fixture.database
        .update(sessionPlacements)
        .set({ computerId: otherComputer.id })
        .where(eq(sessionPlacements.sessionId, source.session.id));
      await expect(proofs.authenticate(proof.token)).rejects.toMatchObject({ code: "invalid_proof" });
    } finally {
      await fixture.sql.end();
    }
  });

  it("does not dispatch collaboration frames when suspension wins before ready admission", async () => {
    const fixture = await createFixture();
    try {
      const assemblyStarted = deferred<void>();
      const continueAssembly = deferred<void>();
      const collaboration = await createCollaborationFixture(fixture, {
        assemble: async () => {
          assemblyStarted.resolve();
          await continueAssembly.promise;
          return runtimeSnapshot(fixture.agentId);
        },
      });
      const sending = collaboration.service.send(
        { messageId: randomUUID(), targetSessionId: collaboration.targetSessionId, message: "late work" },
        collaboration.source,
      );
      await assemblyStarted.promise;

      await new AgentService(fixture.database, {
        stopSessions: async () => {
          collaboration.frames.push("stopped");
        },
      }).suspendById(fixture.userId, fixture.agentId);
      continueAssembly.resolve();

      await expect(sending).resolves.toMatchObject({ status: "unreachable", code: "runtime_not_ready" });
      expect(collaboration.frames).toEqual(["stopped"]);
    } finally {
      await fixture.sql.end();
    }
  });

  it("admits ready before suspension but fences the later SessionMessage frame", async () => {
    const fixture = await createFixture();
    try {
      const reconcileDispatched = deferred<void>();
      const continueReconcile = deferred<void>();
      const collaboration = await createCollaborationFixture(fixture, {
        onReconcileDispatched: () => reconcileDispatched.resolve(),
        beforeReconcileResult: () => continueReconcile.promise,
      });
      const sending = collaboration.service.send(
        { messageId: randomUUID(), targetSessionId: collaboration.targetSessionId, message: "race suspension" },
        collaboration.source,
      );
      await reconcileDispatched.promise;

      await new AgentService(fixture.database, {
        stopSessions: async () => {
          collaboration.frames.push("stopped");
        },
      }).suspendById(fixture.userId, fixture.agentId);
      continueReconcile.resolve();

      await expect(sending).resolves.toMatchObject({ status: "unreachable", code: "runtime_unavailable" });
      expect(collaboration.frames).toEqual(["ready", "stopped"]);
    } finally {
      await fixture.sql.end();
    }
  });

  it("does not deliver to an ended target when IM binding disable commits between frames", async () => {
    const fixture = await createFixture();
    try {
      const deliveryRequested = deferred<void>();
      const continueDeliveryAdmission = deferred<void>();
      const collaboration = await createCollaborationFixture(fixture, {
        onDeliveryRequested: () => deliveryRequested.resolve(),
        beforeDeliveryAdmission: () => continueDeliveryAdmission.promise,
      });
      const sending = collaboration.service.send(
        { messageId: randomUUID(), targetSessionId: collaboration.targetSessionId, message: "race disable" },
        collaboration.source,
      );
      await deliveryRequested.promise;

      await fixture.database.transaction((transaction) =>
        disableImBindingInTransaction(transaction, fixture.imBindingId, new Date()),
      );
      continueDeliveryAdmission.resolve();

      await expect(sending).resolves.toMatchObject({ status: "unreachable", code: "runtime_unavailable" });
      expect(collaboration.frames).toEqual(["ready"]);
      const [target] = await fixture.database
        .select({ endedAt: sessions.endedAt })
        .from(sessions)
        .where(eq(sessions.id, collaboration.targetSessionId))
        .limit(1);
      expect(target?.endedAt).toBeInstanceOf(Date);
    } finally {
      await fixture.sql.end();
    }
  });

  it("does not dispatch ready after the source placement generation advances", async () => {
    const fixture = await createFixture();
    try {
      const assemblyStarted = deferred<void>();
      const continueAssembly = deferred<void>();
      const collaboration = await createCollaborationFixture(fixture, {
        assemble: async () => {
          assemblyStarted.resolve();
          await continueAssembly.promise;
          return runtimeSnapshot(fixture.agentId);
        },
      });
      const sending = collaboration.service.send(
        { messageId: randomUUID(), targetSessionId: collaboration.targetSessionId, message: "stale source placement" },
        collaboration.source,
      );
      await assemblyStarted.promise;

      await fixture.sessions.movePlacement(collaboration.source.sessionId, fixture.computerId);
      continueAssembly.resolve();

      await expect(sending).resolves.toMatchObject({ status: "unreachable", code: "runtime_not_ready" });
      expect(collaboration.frames).toEqual([]);
    } finally {
      await fixture.sql.end();
    }
  });

  it("does not dispatch ready after the source connection is replaced", async () => {
    const fixture = await createFixture();
    try {
      const assemblyStarted = deferred<void>();
      const continueAssembly = deferred<void>();
      const collaboration = await createCollaborationFixture(fixture, {
        assemble: async () => {
          assemblyStarted.resolve();
          await continueAssembly.promise;
          return runtimeSnapshot(fixture.agentId);
        },
      });
      const sending = collaboration.service.send(
        { messageId: randomUUID(), targetSessionId: collaboration.targetSessionId, message: "stale source connection" },
        collaboration.source,
      );
      await assemblyStarted.promise;

      await fixture.database
        .update(computers)
        .set({ currentInstanceId: randomUUID() })
        .where(eq(computers.id, fixture.computerId));
      continueAssembly.resolve();

      await expect(sending).resolves.toMatchObject({ status: "unreachable", code: "runtime_not_ready" });
      expect(collaboration.frames).toEqual([]);
    } finally {
      await fixture.sql.end();
    }
  });

  it("does not deliver a SessionMessage after the source placement advances between frames", async () => {
    const fixture = await createFixture();
    try {
      const deliveryRequested = deferred<void>();
      const continueDeliveryAdmission = deferred<void>();
      const collaboration = await createCollaborationFixture(fixture, {
        onDeliveryRequested: () => deliveryRequested.resolve(),
        beforeDeliveryAdmission: () => continueDeliveryAdmission.promise,
      });
      const sending = collaboration.service.send(
        { messageId: randomUUID(), targetSessionId: collaboration.targetSessionId, message: "move between frames" },
        collaboration.source,
      );
      await deliveryRequested.promise;

      await fixture.sessions.movePlacement(collaboration.source.sessionId, fixture.computerId);
      continueDeliveryAdmission.resolve();

      await expect(sending).resolves.toMatchObject({ status: "unreachable", code: "runtime_unavailable" });
      expect(collaboration.frames).toEqual(["ready"]);
    } finally {
      await fixture.sql.end();
    }
  });

  it("does not deliver a SessionMessage after the source connection is replaced between frames", async () => {
    const fixture = await createFixture();
    try {
      const deliveryRequested = deferred<void>();
      const continueDeliveryAdmission = deferred<void>();
      const collaboration = await createCollaborationFixture(fixture, {
        onDeliveryRequested: () => deliveryRequested.resolve(),
        beforeDeliveryAdmission: () => continueDeliveryAdmission.promise,
      });
      const sending = collaboration.service.send(
        {
          messageId: randomUUID(),
          targetSessionId: collaboration.targetSessionId,
          message: "replace connection between frames",
        },
        collaboration.source,
      );
      await deliveryRequested.promise;

      await fixture.database
        .update(computers)
        .set({ currentInstanceId: randomUUID() })
        .where(eq(computers.id, fixture.computerId));
      continueDeliveryAdmission.resolve();

      await expect(sending).resolves.toMatchObject({ status: "unreachable", code: "runtime_unavailable" });
      expect(collaboration.frames).toEqual(["ready"]);
    } finally {
      await fixture.sql.end();
    }
  });
});

async function createFixture() {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
  });
  const installationId = randomUUID();
  const connectionInstanceId = randomUUID();
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: installationId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
      currentInstanceId: connectionInstanceId,
    })
    .returning({ id: computers.id });
  if (!computer) throw new Error("Computer fixture was not created");
  await client.database.insert(computerCredentials).values({
    computerId: computer.id,
    secretHash: `integration-collaboration-${computer.id}`,
    issuedByUserId: bootstrap.userId,
  });
  const agent = await new AgentService(client.database).createForAccount(bootstrap.userId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const [binding] = await client.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "cli_fixture",
      externalBotId: "ou_fixture",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "test-only",
      activatedAt: new Date(),
    })
    .returning({ id: imBindings.id });
  if (!binding) throw new Error("Binding fixture was not created");
  return {
    ...client,
    agentId: agent.id,
    computerId: computer.id,
    connectionInstanceId,
    installationId,
    userId: bootstrap.userId,
    imBindingId: binding.id,
    sessions: new SessionService(client.database),
  };
}

function runtimeSnapshot(agentId: string) {
  return {
    revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
    agentId,
    provider: "codex" as const,
    instructions: { platform: "platform", agent: "agent" },
    execution: { approvalPolicy: "never" as const, networkAccess: true },
    workspace: { workspaceId: agentId, mode: "empty_on_create" as const, sharing: "agent" as const },
  };
}

interface CollaborationRuntimeOptions {
  assemble?: () => Promise<ReturnType<typeof runtimeSnapshot>>;
  beforeDeliveryAdmission?: () => Promise<void>;
  beforeReconcileResult?: () => Promise<void>;
  onDeliveryRequested?: () => void;
  onReconcileDispatched?: () => void;
}

async function createCollaborationFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  options: CollaborationRuntimeOptions = {},
) {
  const source = await fixture.sessions.ensureChatSession(
    { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "dm" },
    "channel",
  );
  const target = await fixture.sessions.createInternalSessionWithMessage({
    creatorSessionId: source.session.id,
    creatorInstallationId: fixture.installationId,
    creatorConnectionInstanceId: fixture.connectionInstanceId,
    creatorComputerId: fixture.computerId,
    creatorPlacementGeneration: source.placement.generation,
    messageId: randomUUID(),
    initialMessage: "initial task",
  });
  const frames: string[] = [];
  const instanceId = fixture.connectionInstanceId;
  const domain = {
    requestReconcile: async (
      _computerId: string,
      _instanceId: string,
      request: SessionReconcileRequest,
      onDispatched?: () => void,
      admission?: RuntimeDispatchAdmission<SessionReconcileResult>,
    ): Promise<SessionReconcileResult> =>
      withAdmission(admission, async (admissionDispatched) => {
        frames.push("ready");
        admissionDispatched();
        onDispatched?.();
        options.onReconcileDispatched?.();
        await options.beforeReconcileResult?.();
        return {
          type: "session:reconcile:result",
          requestId: request.requestId,
          sessionId: request.sessionId,
          placementGeneration: request.placementGeneration,
          status: "ready",
        };
      }),
    requestSessionMessageDelivery: async (
      _computerId: string,
      _instanceId: string,
      request: SessionMessageDeliveryRequest,
      onDispatched?: () => void,
      admission?: RuntimeDispatchAdmission<SessionMessageDeliveryResult>,
    ): Promise<SessionMessageDeliveryResult> => {
      options.onDeliveryRequested?.();
      await options.beforeDeliveryAdmission?.();
      return withAdmission(admission, async (admissionDispatched) => {
        frames.push("message");
        admissionDispatched();
        onDispatched?.();
        return {
          type: "session:message:deliver:result",
          requestId: request.requestId,
          messageId: request.messageId,
          targetSessionId: request.targetSessionId,
          placementGeneration: request.placementGeneration,
          status: "accepted",
        };
      });
    },
  };
  return {
    frames,
    service: new SessionCollaborationService({
      assembler: { assembleForSession: options.assemble ?? (async () => runtimeSnapshot(fixture.agentId)) },
      domain,
      registry: {
        capabilityVersion: () => 2,
        currentInstanceId: () => instanceId,
        supportsCapability: () => true,
      },
      sessions: fixture.sessions,
    }),
    source: {
      agentId: fixture.agentId,
      computerId: fixture.computerId,
      connectionInstanceId: instanceId,
      installationId: fixture.installationId,
      placementGeneration: source.placement.generation,
      sessionId: source.session.id,
      sessionKind: source.session.kind,
    },
    targetSessionId: target.session.id,
  };
}

async function withAdmission<T>(
  admission: RuntimeDispatchAdmission<T> | undefined,
  operation: (onDispatched: () => void) => Promise<T>,
): Promise<T> {
  if (!admission) return operation(() => undefined);
  const admitted = await admission(operation);
  if (!admitted.admitted) {
    throw new RuntimeDomainRequestError("authority_unavailable", "Runtime dispatch authority is unavailable");
  }
  return admitted.result;
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
