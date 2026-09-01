import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { NormalizedInboundImEvent, SessionReconcileRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionDescendants,
  sessionPlacements,
  sessions,
  users,
} from "../db/schema/index.js";
import { RuntimeDomainRequestError } from "../runtime/runtime-domain-owner.js";
import { AgentService } from "../services/agents/index.js";
import {
  classifyImInboundPersistenceError,
  ImInboundPersistenceError,
  ImMessageInbox,
} from "../services/im/im-message-inbox.js";
import { ImResourceService } from "../services/im/im-resource-service.js";
import type { ImProviderAdapter } from "../services/im-bindings/index.js";
import { ProviderAdapterResolutionError } from "../services/im-bindings/provider-adapter-resolver.js";
import { SessionCliProofService } from "../services/sessions/session-cli-proof-service.js";
import { SessionCollaborationService } from "../services/sessions/session-collaboration-service.js";
import {
  type SessionMessageAttempt,
  SessionService,
  SessionServiceError,
} from "../services/sessions/session-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

describe("SessionService with the unit database", () => {
  let db: UnitDatabase;
  let fixture: Awaited<ReturnType<typeof seedFixture>>;

  beforeAll(async () => {
    db = await createUnitDatabase();
  }, 60_000);
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.reset();
    fixture = await seedFixture(db);
  });

  it("validates chat scope and converges an existing session and placement", async () => {
    const service = new SessionService(db.database, { now: () => fixture.now });
    await expect(
      service.ensureChatSessionInTransaction(db.database as never, {
        imBindingId: fixture.bindingId,
        channelId: "C1",
        conversationKind: "channel",
        kind: "channel",
        threadKey: "bad",
        computerId: fixture.computerId,
        now: fixture.now,
      }),
    ).rejects.toMatchObject({ code: "SESSION_SCOPE_INVALID" });
    await expect(
      service.ensureChatSessionInTransaction(db.database as never, {
        imBindingId: fixture.bindingId,
        channelId: "C1",
        conversationKind: "channel",
        kind: "thread",
        computerId: fixture.computerId,
        now: fixture.now,
      }),
    ).rejects.toMatchObject({ code: "SESSION_SCOPE_INVALID" });

    const first = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "channel" },
      "channel",
    );
    const second = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "channel" },
      "channel",
    );
    expect(second).toEqual(first);
    expect(await db.database.select().from(sessions)).toHaveLength(1);
    expect(await db.database.select().from(sessionPlacements)).toHaveLength(1);
    const thread = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "channel" },
      "thread",
      "thread-1",
    );
    expect(thread.session.threadKey).toBe("thread-1");
  });

  it("rejects inactive binding and agent while resolving a chat placement", async () => {
    const service = new SessionService(db.database);
    await db.database
      .update(imBindings)
      .set({ status: "disabled", disabledAt: fixture.now, encryptedCredential: null, activatedAt: null })
      .where(eq(imBindings.id, fixture.bindingId));
    await expect(
      service.ensureChatSession({ imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" }, "channel"),
    ).rejects.toMatchObject({ code: "IM_BINDING_NOT_ACTIVE" });
    await db.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
    await expect(
      service.ensureChatSession({ imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" }, "channel"),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ACTIVE" });
  });

  it("creates internal sessions, descendants, retries, and fences conflicting IDs", async () => {
    const service = new SessionService(db.database, { now: () => fixture.now });
    const source = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const messageId = randomUUID();
    const input = {
      creatorSessionId: source.session.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId,
      initialMessage: `${"é".repeat(200)} task`,
      overrides: { model: "gpt", reasoningEffort: "high", maxDurationMs: 1000 },
    } as const;
    const created = await service.createInternalSessionWithMessage(input);
    expect(created).toMatchObject({
      deduplicated: false,
      attemptCount: 1,
      session: { kind: "internal", runtimeModel: "gpt" },
    });
    expect(await db.database.select().from(sessionDescendants)).toHaveLength(1);
    const retry = await service.createInternalSessionWithMessage(input);
    expect(retry).toMatchObject({ deduplicated: false, attemptCount: 2, session: { id: created.session.id } });
    expect(await service.recordMessageOutcome({ messageId, attemptCount: 2, outcome: "accepted" })).toBe(true);
    const dedup = await service.createInternalSessionWithMessage(input);
    expect(dedup).toMatchObject({ deduplicated: true, attemptCount: null, message: { lastOutcome: "accepted" } });
    await expect(
      service.createInternalSessionWithMessage({ ...input, initialMessage: "different" }),
    ).rejects.toMatchObject({ code: "SESSION_MESSAGE_CONFLICT" });
    await expect(
      service.createInternalSessionWithMessage({ ...input, overrides: { ...input.overrides, model: "other" } }),
    ).rejects.toMatchObject({ code: "SESSION_MESSAGE_CONFLICT" });
  });

  it("authorizes messages and rejects stale, unavailable, and mismatched authorities", async () => {
    const service = new SessionService(db.database, { now: () => fixture.now });
    const source = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const target = await service.createInternalSessionWithMessage({
      creatorSessionId: source.session.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId: randomUUID(),
      initialMessage: "initial",
    });
    const otherUserId = randomUUID();
    const otherComputerId = randomUUID();
    await db.database
      .insert(users)
      .values({ id: otherUserId, email: "target-owner@example.com", displayName: "Target Owner" });
    await db.database.insert(computers).values({
      id: otherComputerId,
      ownerAccountId: otherUserId,
      currentInstallationId: randomUUID(),
      displayName: "other",
      platform: "linux",
      arch: "x64",
      clientVersion: "1",
    });
    await db.database
      .update(sessionPlacements)
      .set({ computerId: otherComputerId })
      .where(eq(sessionPlacements.sessionId, target.session.id));
    await expect(
      service.authorizeAndRecordMessage({
        messageId: randomUUID(),
        sourceSessionId: source.session.id,
        sourceInstallationId: fixture.installationId,
        sourceConnectionInstanceId: fixture.instanceId,
        sourceComputerId: fixture.computerId,
        sourcePlacementGeneration: 1,
        targetSessionId: target.session.id,
        content: "owner mismatch",
      }),
    ).rejects.toMatchObject({ code: "SESSION_TARGET_UNAVAILABLE" });
    await db.database
      .update(sessionPlacements)
      .set({ computerId: fixture.computerId })
      .where(eq(sessionPlacements.sessionId, target.session.id));
    await db.database
      .update(computers)
      .set({ ownerAccountId: otherUserId })
      .where(eq(computers.id, fixture.computerId));
    await expect(
      service.authorizeAndRecordMessage({
        messageId: randomUUID(),
        sourceSessionId: source.session.id,
        sourceInstallationId: fixture.installationId,
        sourceConnectionInstanceId: fixture.instanceId,
        sourceComputerId: fixture.computerId,
        sourcePlacementGeneration: 1,
        targetSessionId: target.session.id,
        content: "source owner mismatch",
      }),
    ).rejects.toMatchObject({ code: "SESSION_SOURCE_UNAVAILABLE" });
    await db.database
      .update(computers)
      .set({ ownerAccountId: fixture.userId })
      .where(eq(computers.id, fixture.computerId));
    const args = {
      messageId: randomUUID(),
      sourceSessionId: source.session.id,
      sourceInstallationId: fixture.installationId,
      sourceConnectionInstanceId: fixture.instanceId,
      sourceComputerId: fixture.computerId,
      sourcePlacementGeneration: 1,
      targetSessionId: target.session.id,
      content: "hello",
    };
    const first = await service.authorizeAndRecordMessage(args);
    expect(first).toMatchObject({ attemptCount: 1, deduplicated: false });
    const second = await service.authorizeAndRecordMessage(args);
    expect(second).toMatchObject({ attemptCount: 2, deduplicated: false });
    await expect(service.authorizeAndRecordMessage({ ...args, content: "changed" })).rejects.toMatchObject({
      code: "SESSION_MESSAGE_CONFLICT",
    });
    await expect(service.authorizeAndRecordMessage({ ...args, sourcePlacementGeneration: 99 })).rejects.toMatchObject({
      code: "SESSION_PLACEMENT_STALE",
    });
    await db.database.update(sessions).set({ endedAt: fixture.now }).where(eq(sessions.id, target.session.id));
    await expect(service.authorizeAndRecordMessage({ ...args, messageId: randomUUID() })).rejects.toMatchObject({
      code: "SESSION_TARGET_UNAVAILABLE",
    });
    await db.database.update(sessions).set({ endedAt: null }).where(eq(sessions.id, target.session.id));
    const other = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C2", conversationKind: "dm" },
      "channel",
    );
    await expect(
      service.authorizeAndRecordMessage({ ...args, targetSessionId: other.session.id, messageId: randomUUID() }),
    ).rejects.toMatchObject({ code: "SESSION_SCOPE_MISMATCH" });
    await expect(
      service.authorizeAndRecordMessage({ ...args, sourceSessionId: randomUUID(), messageId: randomUUID() }),
    ).rejects.toMatchObject({ code: "SESSION_SOURCE_UNAVAILABLE" });
    expect(await service.recordMessageOutcome({ messageId: randomUUID(), attemptCount: 1, outcome: "rejected" })).toBe(
      false,
    );
  });

  it("admits only valid collaboration authorities and releases admission on dispatch", async () => {
    const service = new SessionService(db.database);
    const source = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const target = await service.createInternalSessionWithMessage({
      creatorSessionId: source.session.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId: randomUUID(),
      initialMessage: "initial",
    });
    const route = {
      agentId: fixture.agentId,
      imBindingId: fixture.bindingId,
      sourceSessionId: source.session.id,
      sourceConnectionInstanceId: fixture.instanceId,
      sourcePlacementGeneration: 1,
      sourceComputerId: fixture.computerId,
      targetSessionId: target.session.id,
      targetInstallationId: fixture.installationId,
      targetComputerId: fixture.computerId,
      targetPlacementGeneration: 1,
      targetSessionKind: "internal" as const,
      targetCreatorSessionId: source.session.id,
    };
    const operation = vi.fn(async (dispatched: () => void) => {
      dispatched();
      return "ok";
    });
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toMatchObject({
      admitted: true,
      result: Promise.resolve("ok"),
    });
    const admitted = await service.withCollaborationDispatchAdmission(route, operation);
    if (!admitted.admitted) throw new Error("dispatch was not admitted");
    expect(await admitted.result).toBe("ok");
    const otherUserId = randomUUID();
    await db.database
      .insert(users)
      .values({ id: otherUserId, email: "admission-owner@example.com", displayName: "Admission Owner" });
    await db.database
      .update(computers)
      .set({ ownerAccountId: otherUserId })
      .where(eq(computers.id, fixture.computerId));
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toEqual({ admitted: false });
    await db.database
      .update(computers)
      .set({ ownerAccountId: fixture.userId })
      .where(eq(computers.id, fixture.computerId));
    await expect(
      service.withCollaborationDispatchAdmission(route, () => {
        throw new Error("dispatch failed");
      }),
    ).rejects.toThrow("dispatch failed");
    const rejected = await service.withCollaborationDispatchAdmission(route, () =>
      Promise.reject(new Error("async dispatch failed")),
    );
    if (!rejected.admitted) throw new Error("rejected dispatch was not admitted");
    await expect(rejected.result).rejects.toThrow("async dispatch failed");
    await db.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toEqual({ admitted: false });
    await db.database.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.agentId));
    await db.database.update(imBindings).set({ status: "error" }).where(eq(imBindings.id, fixture.bindingId));
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toEqual({ admitted: false });
    await db.database.update(imBindings).set({ status: "active" }).where(eq(imBindings.id, fixture.bindingId));
    await db.database
      .update(sessionPlacements)
      .set({ generation: 2 })
      .where(eq(sessionPlacements.sessionId, target.session.id));
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toEqual({ admitted: false });
    await db.database
      .update(sessionPlacements)
      .set({ generation: 1 })
      .where(eq(sessionPlacements.sessionId, target.session.id));
    await db.database.update(sessions).set({ endedAt: fixture.now }).where(eq(sessions.id, target.session.id));
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toEqual({ admitted: false });
  });

  it("moves and asserts placements while fencing uncertain custody", async () => {
    const service = new SessionService(db.database, { now: () => fixture.now });
    const session = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const otherComputer = randomUUID();
    await db.database.insert(computers).values({
      id: otherComputer,
      ownerAccountId: fixture.userId,
      currentInstallationId: randomUUID(),
      displayName: "other",
      platform: "linux",
      arch: "x64",
      clientVersion: "1",
    });
    await expect(service.assertPlacement(session.session.id, fixture.computerId, 1)).resolves.toBeUndefined();
    await expect(service.assertPlacement(session.session.id, fixture.computerId, 2)).rejects.toMatchObject({
      code: "SESSION_PLACEMENT_STALE",
    });
    const inbox = new ImMessageInbox(db.database, { now: () => fixture.now });
    const persisted = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({ conversationKind: "dm", providerEventId: "custody", externalMessageId: "custody" }),
    );
    const delivery = (
      await db.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.messageId, persisted.messageId as string))
    )[0];
    if (!delivery) throw new Error("delivery missing");
    await db.database
      .update(imMessageDeliveries)
      .set({ dispatchRequestId: randomUUID(), dispatchInputHash: "hash", dispatchPayload: {} as never })
      .where(eq(imMessageDeliveries.id, delivery.id));
    await expect(service.movePlacement(delivery.sessionId, otherComputer)).rejects.toMatchObject({
      code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN",
    });
    await db.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: "input",
        turnId: "turn",
        reportOwnerInstanceId: fixture.instanceId,
        acceptedAt: fixture.now,
      })
      .where(eq(imMessageDeliveries.id, delivery.id));
    await expect(service.movePlacement(delivery.sessionId, otherComputer)).rejects.toMatchObject({
      code: "SESSION_PLACEMENT_CUSTODY_PENDING",
    });
    await db.database
      .update(imMessageDeliveries)
      .set({ reportedAt: fixture.now, turnReport: {} as never, resultHash: "result" })
      .where(eq(imMessageDeliveries.id, delivery.id));
    const afterLock = vi.fn();
    const moving = new SessionService(db.database, { now: () => fixture.now, afterPlacementLock: afterLock });
    await expect(moving.movePlacement(delivery.sessionId, otherComputer)).resolves.toMatchObject({
      generation: 2,
      computerId: otherComputer,
    });
    expect(afterLock).toHaveBeenCalled();
    await expect(service.movePlacement(randomUUID(), otherComputer)).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("lists direct and recursive descendants with cursor validation and UTF-8 previews", async () => {
    const service = new SessionService(db.database, { now: () => fixture.now });
    const root = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const child = await service.createInternalSessionWithMessage({
      creatorSessionId: root.session.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId: randomUUID(),
      initialMessage: "one",
    });
    await service.createInternalSessionWithMessage({
      creatorSessionId: root.session.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId: randomUUID(),
      initialMessage: "two",
    });
    await service.createInternalSessionWithMessage({
      creatorSessionId: child.session.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId: randomUUID(),
      initialMessage: "nested",
    });
    const page = await service.listInternalSessions(root.session.id, { recursive: false, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const next = await service.listInternalSessions(root.session.id, {
      recursive: false,
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(next.items).toHaveLength(1);
    const recursive = await service.listInternalSessions(root.session.id, {
      recursive: true,
      limit: 10,
      since: fixture.now.toISOString(),
    });
    expect(recursive.items).toHaveLength(3);
    await expect(
      service.listInternalSessions(root.session.id, { recursive: false, limit: 1, cursor: "bad" }),
    ).rejects.toMatchObject({ code: "SESSION_CURSOR_INVALID" });
    const malformed = Buffer.from(JSON.stringify({ v: 1 }), "utf8").toString("base64url");
    await expect(
      service.listInternalSessions(root.session.id, { recursive: false, limit: 1, cursor: malformed }),
    ).rejects.toMatchObject({ code: "SESSION_CURSOR_INVALID" });
  });
});

describe("SessionCliProofService with the unit database", () => {
  let db: UnitDatabase;
  let fixture: Awaited<ReturnType<typeof seedFixture>>;
  beforeAll(async () => {
    db = await createUnitDatabase();
  }, 60_000);
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.reset();
    fixture = await seedFixture(db);
  });

  it("validates keys, mints, prepares, revokes, and authenticates proofs", async () => {
    expect(
      () =>
        new SessionCliProofService(
          db.database,
          { currentInstanceId: vi.fn(), supportsCapability: vi.fn() },
          new Uint8Array(31),
        ),
    ).toThrow();
    const registry = {
      currentInstanceId: vi.fn().mockReturnValue(fixture.instanceId),
      supportsCapability: vi.fn().mockReturnValue(true),
    };
    const service = new SessionCliProofService(db.database, registry, new Uint8Array(32).fill(3), {
      now: () => fixture.now,
    });
    const session = await new SessionService(db.database, { now: () => fixture.now }).ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const input = {
      sessionId: session.session.id,
      computerId: fixture.computerId,
      placementGeneration: 1,
      connectionInstanceId: fixture.instanceId,
    };
    const minted = await service.mint(input);
    expect(minted.token).toBeTruthy();
    await expect(service.mint({ ...input, placementGeneration: 2 })).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(await service.mint(input)).toEqual(minted);
    await expect(service.authenticate(minted.token)).resolves.toMatchObject({
      sessionId: session.session.id,
      agentId: fixture.agentId,
    });
    await expect(service.authenticate("")).rejects.toMatchObject({ code: "invalid_proof" });
    await expect(service.authenticate("x".repeat(5000))).rejects.toMatchObject({ code: "invalid_proof" });
    const reconcile = {
      type: "session:reconcile",
      requestId: randomUUID(),
      installationId: fixture.installationId,
      sessionId: session.session.id,
      agentId: fixture.agentId,
      placementGeneration: 1,
      desired: "ready",
      runtime: {},
    } as SessionReconcileRequest;
    expect(
      (await service.prepareReconcile(fixture.computerId, fixture.instanceId, reconcile)).sessionCliProof,
    ).toBeDefined();
    const stopped = { ...reconcile, desired: "stopped" as const };
    await expect(service.prepareReconcile(fixture.computerId, fixture.instanceId, stopped)).resolves.toBe(stopped);
    await expect(service.revoke({ ...input, placementGeneration: 99 })).resolves.toBeUndefined();
    await expect(service.revoke({ ...input, connectionInstanceId: randomUUID() })).resolves.toBeUndefined();
    registry.supportsCapability.mockReturnValue(false);
    await expect(service.prepareReconcile(fixture.computerId, fixture.instanceId, reconcile)).resolves.toBe(reconcile);
    await expect(service.mint(input)).rejects.toMatchObject({ code: "runtime_unavailable" });
    registry.supportsCapability.mockReturnValue(true);
    await expect(service.revoke(input)).resolves.toBeUndefined();
  });

  it("invalidates proofs when placement, runtime, agent, or binding state changes", async () => {
    const registry = {
      currentInstanceId: vi.fn().mockReturnValue(fixture.instanceId),
      supportsCapability: vi.fn().mockReturnValue(true),
    };
    const service = new SessionCliProofService(db.database, registry, new Uint8Array(32).fill(4));
    const session = await new SessionService(db.database).ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const input = {
      sessionId: session.session.id,
      computerId: fixture.computerId,
      placementGeneration: 1,
      connectionInstanceId: fixture.instanceId,
    };
    const { token } = await service.mint(input);
    await db.database
      .update(sessionPlacements)
      .set({ generation: 2 })
      .where(eq(sessionPlacements.sessionId, session.session.id));
    await expect(service.authenticate(token)).rejects.toMatchObject({ code: "invalid_proof" });
    await db.database
      .update(sessionPlacements)
      .set({ generation: 1 })
      .where(eq(sessionPlacements.sessionId, session.session.id));
    registry.currentInstanceId.mockReturnValue(randomUUID());
    await expect(service.authenticate(token)).rejects.toMatchObject({ code: "invalid_proof" });
    registry.currentInstanceId.mockReturnValue(fixture.instanceId);
    await db.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
    await expect(service.authenticate(token)).rejects.toMatchObject({ code: "invalid_proof" });
  });
});

describe("ImMessageInbox with the unit database", () => {
  let db: UnitDatabase;
  let fixture: Awaited<ReturnType<typeof seedFixture>>;
  beforeAll(async () => {
    db = await createUnitDatabase();
  }, 60_000);
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.reset();
    fixture = await seedFixture(db);
  });

  it("classifies persistence errors and rejects stale bindings and fences", async () => {
    expect(classifyImInboundPersistenceError(new ImInboundPersistenceError("IM_INBOUND_FENCE_STALE", "x"))).toBe(
      "IM_INBOUND_FENCE_STALE",
    );
    expect(classifyImInboundPersistenceError(new Error("x"))).toBe("IM_INBOUND_DATABASE_FAILED");
    const inbox = new ImMessageInbox(db.database, { now: () => fixture.now });
    await expect(inbox.ingest(randomUUID(), 1, inboundEvent())).rejects.toMatchObject({
      code: "IM_INBOUND_BINDING_STALE",
    });
    const staleEvent = inboundEvent();
    await expect(inbox.ingest(fixture.bindingId, 2, staleEvent)).rejects.toMatchObject({
      code: "IM_INBOUND_BINDING_STALE",
    });
    await db.database
      .update(imBindings)
      .set({
        connectionOwnerInstanceId: fixture.instanceId,
        connectionFencingEpoch: 2,
        connectionLeaseExpiresAt: new Date(fixture.now.getTime() - 1),
      })
      .where(eq(imBindings.id, fixture.bindingId));
    await expect(
      inbox.ingest(fixture.bindingId, 1, staleEvent, {
        provider: "feishu",
        holderInstanceId: fixture.instanceId,
        fencingEpoch: 2,
      }),
    ).rejects.toMatchObject({ code: "IM_INBOUND_FENCE_STALE" });
    await db.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, fixture.agentId));
    await expect(inbox.ingest(fixture.bindingId, 1, inboundEvent())).rejects.toMatchObject({
      code: "IM_INBOUND_BINDING_STALE",
    });
    await db.reset();
    fixture = await seedFixture(db);
    const afterFence = vi.fn().mockResolvedValue(undefined);
    const fencedInbox = new ImMessageInbox(db.database, { now: () => fixture.now, afterAdmissionFence: afterFence });
    await db.database
      .update(imBindings)
      .set({
        connectionOwnerInstanceId: fixture.instanceId,
        connectionFencingEpoch: 7,
        connectionLeaseExpiresAt: new Date(fixture.now.getTime() + 1000),
      })
      .where(eq(imBindings.id, fixture.bindingId));
    await expect(
      fencedInbox.ingest(fixture.bindingId, 1, inboundEvent({ providerEventId: "fenced" }), {
        provider: "feishu",
        holderInstanceId: fixture.instanceId,
        fencingEpoch: 7,
      }),
    ).resolves.toMatchObject({ duplicate: false });
    expect(afterFence).toHaveBeenCalled();
    const botSelf = inboundEvent({ providerEventId: "bot", externalMessageId: "bot", conversationKind: "dm" });
    botSelf.message.author = { externalId: "bot", kind: "bot", displayName: "Bot" };
    await expect(fencedInbox.ingest(fixture.bindingId, 1, botSelf)).resolves.toEqual({
      duplicate: false,
      deliveryIds: [],
    });
  });

  it("requests a title once after the first persisted inbound Task message", async () => {
    const onTaskCreated = vi.fn().mockResolvedValue(undefined);
    const inbox = new ImMessageInbox(db.database, {
      now: () => fixture.now,
      onTaskCreated,
    });
    const event = inboundEvent({ providerEventId: "title-seam", externalMessageId: "title-message" });

    await expect(inbox.ingest(fixture.bindingId, 1, event)).resolves.toMatchObject({ duplicate: false });
    await vi.waitFor(() => expect(onTaskCreated).toHaveBeenCalledTimes(1));
    expect(onTaskCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        sourceText: "hello",
        signal: expect.any(AbortSignal),
      }),
    );
    const request = onTaskCreated.mock.calls[0]?.[0];
    expect(request?.signal?.aborted).toBe(false);

    await expect(inbox.ingest(fixture.bindingId, 1, event)).resolves.toMatchObject({ duplicate: true });
    expect(onTaskCreated).toHaveBeenCalledTimes(1);
  });

  it("handles identity, self-message, inactive, and rebind outcomes", async () => {
    const inbox = new ImMessageInbox(db.database, { now: () => fixture.now });
    const event = inboundEvent({ conversationKind: "dm" });
    await expect(inbox.ingest(fixture.bindingId, 1, { ...event, externalAppId: "wrong" })).rejects.toMatchObject({
      code: "IM_INBOUND_IDENTITY_MISMATCH",
    });
    await inbox.ingest(fixture.bindingId, 1, { ...event, providerEventId: "identity-baseline" });
    await expect(inbox.ingest(fixture.bindingId, 1, { ...event, externalTeamId: "other" })).rejects.toMatchObject({
      code: "IM_INBOUND_IDENTITY_MISMATCH",
    });
    const self = await inbox.ingest(fixture.bindingId, 1, {
      ...event,
      providerEventId: "self",
      message: { ...event.message, externalId: "self-msg", author: { ...event.message.author, isSelf: true } },
    });
    expect(self).toEqual({ duplicate: false, deliveryIds: [] });
    await db.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
    const inactive = await inbox.ingest(fixture.bindingId, 1, {
      ...event,
      providerEventId: "inactive",
      message: { ...event.message, externalId: "inactive-msg" },
    });
    expect(inactive.deliveryIds).toEqual([]);
    await db.database.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.agentId));
    const otherUserId = randomUUID();
    await db.database.insert(users).values({ id: otherUserId, email: "other@example.com", displayName: "Other" });
    await db.database
      .update(computers)
      .set({ ownerAccountId: otherUserId })
      .where(eq(computers.id, fixture.computerId));
    const rebind = await inbox.ingest(fixture.bindingId, 1, {
      ...event,
      providerEventId: "rebind",
      message: { ...event.message, externalId: "rebind-msg" },
    });
    expect(rebind.deliveryIds).toEqual([]);
  });

  it("persists direct and ambient channel and thread deliveries", async () => {
    const inbox = new ImMessageInbox(db.database, { now: () => fixture.now });
    await db.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, fixture.agentId));
    const dm = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({ providerEventId: "dm", conversationKind: "dm" }),
    );
    expect(dm.deliveryIds).toHaveLength(1);
    const channel = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "channel",
        conversationKind: "channel",
        externalMessageId: "channel-msg",
        mentions: [{ externalId: "nobody", displayName: null }],
      }),
    );
    expect(channel.deliveryIds).toHaveLength(0);
    const mention = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "mention",
        conversationKind: "channel",
        externalMessageId: "mention-msg",
        mentions: [{ externalId: "bot", displayName: null }],
      }),
    );
    expect(mention.deliveryIds).toHaveLength(1);
    const thread = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "thread",
        conversationKind: "channel",
        externalMessageId: "thread-msg",
        threadKey: "root",
        providerContext: { provider: "feishu", rootId: "root" },
      }),
    );
    expect(thread.deliveryIds).toHaveLength(0);
    await db.database.update(agents).set({ receiveMode: "all_message" }).where(eq(agents.id, fixture.agentId));
    const ambient = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "ambient",
        conversationKind: "channel",
        externalMessageId: "ambient-msg",
        mentions: [],
      }),
    );
    expect(ambient.deliveryIds.length).toBeGreaterThan(0);
    expect(await db.database.select().from(imMessageDeliveries)).toHaveLength(3);
  });

  it("deduplicates events, keeps stale revisions, and inherits unknown thread scope", async () => {
    const inbox = new ImMessageInbox(db.database, { now: () => fixture.now });
    const first = inboundEvent({ providerEventId: "event-1", conversationKind: "dm", externalMessageId: "same" });
    const created = await inbox.ingest(fixture.bindingId, 1, first);
    const duplicate = await inbox.ingest(fixture.bindingId, 1, first);
    expect(duplicate).toMatchObject({ duplicate: true, messageId: created.messageId });
    const newer = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({ providerEventId: "event-2", conversationKind: "dm", externalMessageId: "same", revisionKey: "2" }),
    );
    expect(newer.duplicate).toBe(false);
    const old = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "event-3",
        conversationKind: "dm",
        externalMessageId: "same",
        revisionKey: "0",
        occurredAt: new Date(fixture.now.getTime() - 2 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(old.deliveryIds).toEqual([]);
    const unknown = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "event-4",
        conversationKind: "unknown",
        externalMessageId: "unknown",
        revisionKey: "1",
      }),
    );
    expect(unknown.deliveryIds.length).toBeGreaterThanOrEqual(0);
    const inherited = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "event-5",
        conversationKind: "unknown",
        externalMessageId: "same",
        revisionKey: "3",
      }),
    );
    expect(inherited.deliveryIds.length).toBeGreaterThan(0);
    await db.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, fixture.agentId));
    const rootLookup = new ImMessageInbox(db.database, {
      now: () => fixture.now,
      beforeReliableThreadRootLookup: vi.fn(),
    });
    const noRoot = await rootLookup.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "no-root",
        conversationKind: "channel",
        externalMessageId: "no-root",
        threadKey: "no-root",
        providerContext: { provider: "feishu" },
      }),
    );
    expect(noRoot.deliveryIds).toEqual([]);
  });

  it("upgrades pending thread deliveries when a direct root arrives", async () => {
    const inbox = new ImMessageInbox(db.database, { now: () => fixture.now });
    await db.database.update(agents).set({ receiveMode: "all_message" }).where(eq(agents.id, fixture.agentId));
    await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "thread-ambient",
        conversationKind: "channel",
        externalMessageId: "reply",
        threadKey: "thread",
        providerContext: { provider: "feishu", rootId: "root" },
      }),
    );
    await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "thread-other",
        conversationKind: "channel",
        externalMessageId: "other-reply",
        threadKey: "other-thread",
        providerContext: { provider: "feishu", rootId: "other-root" },
      }),
    );
    const ambientDelivery = (await db.database.select().from(imMessageDeliveries))[0];
    if (ambientDelivery)
      await db.database
        .update(imMessageDeliveries)
        .set({ state: "expired", reason: "test" })
        .where(eq(imMessageDeliveries.id, ambientDelivery.id));
    const root = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "root-direct",
        conversationKind: "channel",
        externalMessageId: "root",
        mentions: [{ externalId: "bot", displayName: null }],
      }),
    );
    expect(root.deliveryIds.length).toBeGreaterThan(0);
    const deliveries = await db.database.select().from(imMessageDeliveries);
    expect(deliveries.some((delivery) => delivery.attention === "direct")).toBe(true);
    await db.reset();
    fixture = await seedFixture(db);
    await db.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, fixture.agentId));
    const directThread = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "direct-thread",
        conversationKind: "channel",
        externalMessageId: "direct-thread",
        threadKey: "same",
        mentions: [{ externalId: "bot", displayName: null }],
        providerContext: { provider: "feishu", rootId: "root" },
      }),
    );
    expect(directThread.deliveryIds).toHaveLength(1);
    const continuous = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        providerEventId: "continuous-thread",
        conversationKind: "channel",
        externalMessageId: "continuous-thread",
        threadKey: "same",
        providerContext: { provider: "feishu", rootId: "root" },
      }),
    );
    expect(continuous.deliveryIds).toHaveLength(1);
  });
});

describe("ImResourceService with the unit database", () => {
  let db: UnitDatabase;
  let fixture: Awaited<ReturnType<typeof seedFixture>>;
  beforeAll(async () => {
    db = await createUnitDatabase();
  }, 60_000);
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.reset();
    fixture = await seedFixture(db);
  });

  it("authorizes resources, applies descriptor fallbacks, and enforces limits", async () => {
    const inbox = new ImMessageInbox(db.database, { now: () => fixture.now });
    const event = inboundEvent({
      conversationKind: "dm",
      resources: [
        {
          providerResourceKey: "r1",
          kind: "image",
          filename: "fallback.png",
          mediaType: "image/png",
          sizeBytes: 2,
          ordinal: 0,
        },
      ],
    });
    const persisted = await inbox.ingest(fixture.bindingId, 1, event);
    if (!persisted.messageId) throw new Error("message missing");
    const session = (await db.database.select().from(sessions))[0];
    if (!session) throw new Error("session missing");
    const adapter = {
      fetchResource: vi.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from("ok")]),
        filename: null,
        mediaType: null,
        sizeBytes: 2,
      }),
    } as unknown as ImProviderAdapter<unknown>;
    const service = new ImResourceService(db.database, async () => adapter);
    const auth = {
      credentialId: randomUUID(),
      computerId: fixture.computerId,
      installationId: fixture.installationId,
    };
    const opened = await service.open(
      auth,
      { sessionId: session.id, instanceId: fixture.instanceId, placementGeneration: 1 },
      persisted.messageId,
      0,
    );
    expect(opened).toMatchObject({ kind: "image", filename: "fallback.png", mediaType: "image/png" });
    await expect(
      service.open(
        auth,
        { sessionId: session.id, instanceId: fixture.instanceId, placementGeneration: 1 },
        persisted.messageId,
        9,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.open(
        auth,
        { sessionId: session.id, instanceId: randomUUID(), placementGeneration: 1 },
        persisted.messageId,
        0,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await db.database
      .update(imMessages)
      .set({
        content: {
          version: 1,
          fallbackText: "x",
          blocks: [],
          truncated: false,
          resources: [
            {
              providerResourceKey: "r2",
              kind: "file",
              filename: null,
              mediaType: null,
              sizeBytes: 26 * 1024 * 1024,
              ordinal: 0,
              availability: "too_large",
            },
          ],
        },
      })
      .where(eq(imMessages.id, persisted.messageId));
    await expect(
      service.open(
        auth,
        { sessionId: session.id, instanceId: fixture.instanceId, placementGeneration: 1 },
        persisted.messageId,
        0,
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
    await db.database
      .update(imMessages)
      .set({
        content: {
          version: 1,
          fallbackText: "x",
          blocks: [],
          truncated: false,
          resources: [
            {
              providerResourceKey: "r3",
              kind: "file",
              filename: null,
              mediaType: null,
              sizeBytes: null,
              ordinal: 0,
              availability: "unavailable",
            },
          ],
        },
      })
      .where(eq(imMessages.id, persisted.messageId));
    await expect(
      service.open(
        auth,
        { sessionId: session.id, instanceId: fixture.instanceId, placementGeneration: 1 },
        persisted.messageId,
        0,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await db.database
      .update(imMessages)
      .set({
        content: {
          version: 1,
          fallbackText: "x",
          blocks: [],
          truncated: false,
          resources: [
            { providerResourceKey: "r1", kind: "file", filename: null, mediaType: null, sizeBytes: null, ordinal: 0 },
          ],
        },
      })
      .where(eq(imMessages.id, persisted.messageId));
  });

  it("maps adapter failures and stream overflow", async () => {
    const inbox = new ImMessageInbox(db.database, { now: () => fixture.now });
    const persisted = await inbox.ingest(
      fixture.bindingId,
      1,
      inboundEvent({
        conversationKind: "dm",
        resources: [
          { providerResourceKey: "r1", kind: "file", filename: null, mediaType: null, sizeBytes: 1, ordinal: 0 },
        ],
      }),
    );
    if (!persisted.messageId) throw new Error("message missing");
    const session = (await db.database.select().from(sessions))[0];
    if (!session) throw new Error("session missing");
    const auth = {
      credentialId: randomUUID(),
      computerId: fixture.computerId,
      installationId: fixture.installationId,
    };
    const stale = new ImResourceService(db.database, async () => {
      throw new ProviderAdapterResolutionError("IM_BINDING_GENERATION_STALE");
    });
    await expect(
      stale.open(
        auth,
        { sessionId: session.id, instanceId: fixture.instanceId, placementGeneration: 1 },
        persisted.messageId as string,
        0,
      ),
    ).rejects.toMatchObject({ code: "IM_BINDING_GENERATION_STALE" });
    const unavailable = new ImResourceService(db.database, async () => {
      throw new Error("offline");
    });
    await expect(
      unavailable.open(
        auth,
        { sessionId: session.id, instanceId: fixture.instanceId, placementGeneration: 1 },
        persisted.messageId as string,
        0,
      ),
    ).rejects.toMatchObject({ code: "IM_BINDING_TEMPORARILY_UNAVAILABLE" });
    const huge = {
      fetchResource: vi
        .fn()
        .mockResolvedValue({ stream: Readable.from([Buffer.alloc(25 * 1024 * 1024 + 1)]), sizeBytes: undefined }),
    } as unknown as ImProviderAdapter<unknown>;
    const streamService = new ImResourceService(db.database, async () => huge);
    const opened = await streamService.open(
      auth,
      { sessionId: session.id, instanceId: fixture.instanceId, placementGeneration: 1 },
      persisted.messageId as string,
      0,
    );
    await expect(
      new Promise((resolve, reject) => {
        opened.stream.on("error", reject);
        opened.stream.on("end", resolve);
        opened.stream.resume();
      }),
    ).rejects.toThrow("IM_RESOURCE_TOO_LARGE");
    const declaredHuge = {
      fetchResource: vi
        .fn()
        .mockResolvedValue({ stream: Readable.from([Buffer.from("x")]), sizeBytes: 25 * 1024 * 1024 + 1 }),
    } as unknown as ImProviderAdapter<unknown>;
    const declaredService = new ImResourceService(db.database, async () => declaredHuge);
    await expect(
      declaredService.open(
        auth,
        { sessionId: session.id, instanceId: fixture.instanceId, placementGeneration: 1 },
        persisted.messageId as string,
        0,
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
  });
});

describe("SessionCollaborationService response mapping", () => {
  const source = {
    agentId: "agent",
    computerId: "computer",
    connectionInstanceId: "instance",
    installationId: "installation",
    placementGeneration: 1,
    sessionId: "source",
    sessionKind: "channel" as const,
  };
  function fixture() {
    const attempt: SessionMessageAttempt = {
      route: {
        agentId: "agent",
        imBindingId: "binding",
        sourceSessionId: "source",
        sourceConnectionInstanceId: "instance",
        sourcePlacementGeneration: 1,
        sourceComputerId: "computer",
        targetSessionId: "target",
        targetInstallationId: "installation",
        targetComputerId: "computer",
        targetPlacementGeneration: 1,
        targetSessionKind: "internal" as const,
        targetCreatorSessionId: "source",
      },
      message: {
        id: "message",
        sourceSessionId: "source",
        targetSessionId: "target",
        content: "hello",
        contentHash: "a".repeat(64),
        lastOutcome: "unknown",
        lastErrorCode: null,
        attemptCount: 1,
        lastAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      deduplicated: false,
      attemptCount: 1,
    };
    const sessions = {
      createInternalSessionWithMessage: vi.fn().mockResolvedValue({ ...attempt, session: { id: "target" } }),
      authorizeAndRecordMessage: vi.fn().mockResolvedValue(attempt),
      recordMessageOutcome: vi.fn().mockResolvedValue(true),
      withCollaborationDispatchAdmission: vi.fn(),
    };
    const domain = {
      requestReconcile: vi.fn().mockResolvedValue({
        type: "session:reconcile:result",
        requestId: "r",
        sessionId: "target",
        placementGeneration: 1,
        status: "ready",
      }),
      requestSessionMessageDelivery: vi.fn().mockResolvedValue({
        type: "session:message:deliver:result",
        requestId: "r",
        messageId: "message",
        targetSessionId: "target",
        placementGeneration: 1,
        status: "accepted",
      }),
    };
    const registry = {
      currentInstanceId: vi.fn().mockReturnValue("instance"),
      supportsCapability: vi.fn().mockReturnValue(true),
      capabilityVersion: vi.fn().mockReturnValue(2),
    };
    const assembler = { assembleForSession: vi.fn().mockResolvedValue({}) };
    return {
      attempt,
      assembler,
      domain,
      registry,
      sessions,
      service: new SessionCollaborationService({ assembler, domain, registry, sessions: sessions as never }),
    };
  }

  it("maps runtime readiness, capacity, rejection, and timeout branches", async () => {
    const value = fixture();
    value.assembler.assembleForSession.mockRejectedValue(new Error("not ready"));
    await expect(
      value.service.send({ messageId: "message-0", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ code: "runtime_not_ready" });
    value.assembler.assembleForSession.mockResolvedValue({});
    value.registry.currentInstanceId.mockReturnValueOnce(null);
    await expect(
      value.service.send({ messageId: "message", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ code: "runtime_unavailable" });
    value.registry.currentInstanceId.mockReturnValue("instance");
    value.registry.supportsCapability.mockReturnValue(false);
    await expect(
      value.service.send({ messageId: "message-2", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ code: "runtime_unavailable" });
    value.registry.supportsCapability.mockReturnValue(true);
    value.attempt.route.targetSessionKind = "channel";
    await expect(
      value.service.send({ messageId: "message-channel", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ status: "accepted" });
    value.registry.capabilityVersion.mockReturnValue(1);
    await expect(
      value.service.send({ messageId: "message-3", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ code: "outbox_unavailable" });
    value.attempt.route.targetSessionKind = "internal";
    value.attempt.route.targetCreatorSessionId = null;
    await expect(
      value.service.send({ messageId: "message-creator", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ status: "accepted" });
    value.domain.requestReconcile.mockResolvedValue({
      type: "session:reconcile:result",
      requestId: "r",
      sessionId: "target",
      placementGeneration: 1,
      status: "failed",
    });
    await expect(
      value.service.send({ messageId: "message-4", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ code: "runtime_not_ready" });
    value.domain.requestReconcile.mockResolvedValue({
      type: "session:reconcile:result",
      requestId: "r",
      sessionId: "target",
      placementGeneration: 1,
      status: "ready",
    });
    value.domain.requestSessionMessageDelivery.mockResolvedValue({
      type: "session:message:deliver:result",
      requestId: "r",
      messageId: "message",
      targetSessionId: "target",
      placementGeneration: 1,
      status: "rejected",
      reason: "stale_generation",
    });
    await expect(
      value.service.send({ messageId: "message-5", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ code: "runtime_not_ready" });
    value.domain.requestSessionMessageDelivery.mockResolvedValue({
      type: "session:message:deliver:result",
      requestId: "r",
      messageId: "message",
      targetSessionId: "target",
      placementGeneration: 1,
      status: "rejected",
      reason: "other",
    });
    await expect(
      value.service.send({ messageId: "message-6", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ status: "rejected", code: "other" });
    value.domain.requestSessionMessageDelivery.mockRejectedValue(new RuntimeDomainRequestError("timeout", "lost"));
    await expect(
      value.service.send({ messageId: "message-7", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ status: "unknown", code: "delivery_timeout" });
  });

  it("maps creation failures, outcome write failures, and deduplicated responses", async () => {
    const value = fixture();
    value.sessions.createInternalSessionWithMessage.mockRejectedValue(
      new SessionServiceError("SESSION_SCOPE_MISMATCH", "no"),
    );
    await expect(value.service.create({ messageId: "m", message: "x" }, source)).resolves.toMatchObject({
      status: "rejected",
      code: "scope_mismatch",
    });
    value.sessions.createInternalSessionWithMessage.mockResolvedValue({
      ...value.attempt,
      session: { id: "target" },
      attemptCount: null,
      message: { ...value.attempt.message, lastOutcome: "accepted", lastErrorCode: null },
    });
    await expect(value.service.create({ messageId: "m2", message: "x" }, source)).resolves.toMatchObject({
      status: "accepted",
      sessionId: "target",
    });
    value.sessions.authorizeAndRecordMessage.mockRejectedValue(new Error("db"));
    await expect(
      value.service.send({ messageId: "m3", targetSessionId: "target", message: "x" }, source),
    ).resolves.toMatchObject({ status: "unreachable", code: "runtime_unavailable" });
    value.sessions.authorizeAndRecordMessage.mockResolvedValue(value.attempt);
    value.sessions.recordMessageOutcome.mockResolvedValue(false);
    await expect(
      value.service.send({ messageId: "m4", targetSessionId: "target", message: "x" }, source),
    ).resolves.toMatchObject({ code: "outcome_write_failed" });
    value.sessions.recordMessageOutcome.mockRejectedValue(new Error("write failed"));
    await expect(
      value.service.send({ messageId: "m5", targetSessionId: "target", message: "x" }, source),
    ).resolves.toMatchObject({ code: "outcome_write_failed" });
  });

  it("falls back to the source Session when an internal target has no creator", async () => {
    const value = fixture();
    value.attempt.route.targetCreatorSessionId = null;
    const result = await value.service.send(
      { messageId: "fallback-creator", targetSessionId: "target", message: "hello" },
      source,
    );
    expect(result).toMatchObject({ status: "accepted", sessionId: "target" });
    expect(value.domain.requestReconcile).toHaveBeenCalledWith(
      "computer",
      "instance",
      expect.objectContaining({ creatorSessionId: "source", sessionKind: "internal" }),
      undefined,
      expect.any(Function),
    );
  });
});

function inboundEvent(
  options: {
    providerEventId?: string;
    externalMessageId?: string;
    revisionKey?: string;
    conversationKind?: "channel" | "dm" | "group_dm" | "unknown";
    threadKey?: string | null;
    providerContext?: { provider: "feishu"; rootId?: string };
    mentions?: Array<{ externalId: string; displayName: string | null }>;
    occurredAt?: Date;
    resources?: Array<{
      providerResourceKey: string;
      kind: "image" | "file" | "audio" | "video";
      filename: string | null;
      mediaType: string | null;
      sizeBytes: number | null;
      ordinal?: number;
    }>;
  } = {},
): NormalizedInboundImEvent {
  const externalMessageId = options.externalMessageId ?? randomUUID();
  return {
    providerEventId: options.providerEventId ?? randomUUID(),
    externalAppId: "app",
    externalTeamId: "team",
    providerContext: options.providerContext ?? { provider: "feishu" },
    conversation: { externalId: "channel-1", kind: options.conversationKind ?? "dm", displayName: null },
    message: {
      externalId: externalMessageId,
      revisionKey: options.revisionKey ?? "1",
      operation: "created",
      threadKey: options.threadKey,
      author: { externalId: "human", kind: "human", displayName: "Human" },
      occurredAt: options.occurredAt ?? new Date("2025-12-31T23:59:00.000Z"),
      content: {
        version: 1,
        fallbackText: "hello",
        blocks: [{ type: "text", text: "hello" }],
        truncated: false,
      },
      resources: options.resources ?? [],
    },
    mentions: options.mentions ?? [],
  };
}

async function seedFixture(db: UnitDatabase) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const bootstrap = await bootstrapTestAccount(db.database, { displayName: "Admin", email: "admin@example.com" }, now);
  const installationId = randomUUID();
  const instanceId = randomUUID();
  const [computer] = await db.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: installationId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "1",
      currentInstanceId: instanceId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: computers.id });
  if (!computer) throw new Error("Computer fixture missing");
  const agent = await new AgentService(db.database).createForAccount(bootstrap.userId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const [binding] = await db.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "app",
      externalBotId: "bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "test",
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: imBindings.id });
  if (!binding) throw new Error("binding fixture missing");
  return {
    agentId: agent.id,
    bindingId: binding.id,
    computerId: computer.id,
    instanceId,
    installationId,
    now,
    userId: bootstrap.userId,
  };
}
