import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import {
  type NormalizedInboundImEvent,
  SESSION_RUN_OUTCOME_NOTICE_HEADER,
  type SessionReconcileRequest,
  type SessionReconcileResult,
} from "@opentag/shared";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import {
  agentSchedules,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionDescendants,
  sessionMessages,
  sessionPlacements,
  sessions,
  users,
} from "../db/schema/index.js";
import {
  withAgentSessionStopAuthority,
  withEndedSessionStopAuthority,
} from "../runtime/agent-session-stop-authority.js";
import { RuntimeDomainRequestError } from "../runtime/runtime-domain-owner.js";
import { AgentService, type AgentSessionStopTarget } from "../services/agents/index.js";
import type { ExternalCallPolicy } from "../services/im/external-call-policy.js";
import {
  classifyImInboundPersistenceError,
  ImInboundPersistenceError,
  ImMessageInbox,
} from "../services/im/im-message-inbox.js";
import { ImResourceService } from "../services/im/im-resource-service.js";
import { disableImBindingInTransaction } from "../services/im-bindings/disable-im-binding.js";
import type { ImProviderAdapter } from "../services/im-bindings/index.js";
import { ProviderAdapterResolutionError } from "../services/im-bindings/provider-adapter-resolver.js";
import { SessionCliProofService } from "../services/sessions/session-cli-proof-service.js";
import { SessionCollaborationService } from "../services/sessions/session-collaboration-service.js";
import { renderRunOutcomeNotice, runOutcomeNoticeMessageId } from "../services/sessions/session-run-outcome-notice.js";
import {
  type SessionMessageAttempt,
  SessionService,
  SessionServiceError,
} from "../services/sessions/session-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const AVATAR_URL = "https://tenant-cdn.example.test/avatar.png";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fakeAvatarPolicy(fetch: ReturnType<typeof vi.fn>): ExternalCallPolicy {
  return { fetch } as unknown as ExternalCallPolicy;
}

function avatarResponse(
  options: {
    status?: number;
    contentType?: string;
    contentLength?: string;
    contentEncoding?: string;
    body?: Uint8Array;
    chunks?: Uint8Array[];
    close?: boolean;
    cancel?: () => void;
  } = {},
): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = options.cancel ?? vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of options.chunks ?? [options.body ?? Buffer.from("avatar")]) controller.enqueue(chunk);
      if (options.close ?? true) controller.close();
    },
    cancel,
  });
  const headers = new Headers({ "content-type": options.contentType ?? "image/png" });
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  if (options.contentEncoding !== undefined) headers.set("content-encoding", options.contentEncoding);
  return {
    response: new Response(stream, { status: options.status ?? 200, headers }),
    cancel: cancel as ReturnType<typeof vi.fn>,
  };
}

async function readNodeStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function setAvatarUrl(db: UnitDatabase, bindingId: string, providerUrl = AVATAR_URL): Promise<void> {
  await db.database.update(imBindings).set({ botAvatarUrl: providerUrl }).where(eq(imBindings.id, bindingId));
}

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

  async function suspendedTarget() {
    await new SessionService(db.database).ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "channel" },
      "channel",
    );
    const stopSessions = vi.fn(async (_targets: AgentSessionStopTarget[]) => undefined);
    await new AgentService(db.database, { stopSessions }).suspendById(fixture.userId, fixture.agentId);
    const target = stopSessions.mock.calls[0]?.[0][0];
    if (!target) throw new Error("Suspension must capture its Session stop target");
    return target;
  }

  it.each(["current", "reactivated", "newer revision", "other Session", "newer placement", "other Computer"])(
    "admits only the captured lifecycle stop authority: %s",
    async (change) => {
      const target = await suspendedTarget();
      if (change === "reactivated")
        await db.database.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.agentId));
      if (change === "newer revision")
        await db.database
          .update(agents)
          .set({ revision: target.agentRevision + 1 })
          .where(eq(agents.id, fixture.agentId));
      if (change === "other Session") target.sessionId = randomUUID();
      if (change === "newer placement")
        await db.database
          .update(sessionPlacements)
          .set({ generation: target.placementGeneration + 1 })
          .where(eq(sessionPlacements.sessionId, target.sessionId));
      if (change === "other Computer") target.computerId = randomUUID();
      const enqueue = vi.fn(async () => "enqueued");
      const result = await withAgentSessionStopAuthority(db.database, target, enqueue);
      expect(result).toBe(change === "current" ? "enqueued" : undefined);
      expect(enqueue).toHaveBeenCalledTimes(change === "current" ? 1 : 0);
    },
  );

  it("rolls back work on the final stop executor when enqueue fails", async () => {
    const target = await suspendedTarget();
    const failure = new Error("Stop enqueue failed");
    await expect(
      withAgentSessionStopAuthority(db.database, target, async (transaction) => {
        await transaction.update(agents).set({ displayName: "Uncommitted" }).where(eq(agents.id, fixture.agentId));
        throw failure;
      }),
    ).rejects.toBe(failure);
    const [agent] = await db.database.select().from(agents).where(eq(agents.id, fixture.agentId));
    expect(agent?.displayName).toBe("Assistant");
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

  describe("stopping an internal Session", () => {
    async function tree() {
      const service = new SessionService(db.database);
      const root = await service.ensureChatSession(
        { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
        "channel",
      );
      const authority = (sessionId: string) => ({
        sourceSessionId: sessionId,
        sourceInstallationId: fixture.installationId,
        sourceConnectionInstanceId: fixture.instanceId,
        sourceComputerId: fixture.computerId,
        sourcePlacementGeneration: 1,
      });
      const create = (creatorSessionId: string) =>
        service.createInternalSessionWithMessage({
          creatorSessionId,
          creatorInstallationId: fixture.installationId,
          creatorConnectionInstanceId: fixture.instanceId,
          creatorComputerId: fixture.computerId,
          creatorPlacementGeneration: 1,
          messageId: randomUUID(),
          initialMessage: "task",
        });
      const child = await create(root.session.id);
      const grandchild = await create(child.session.id);
      return {
        service,
        root: root.session.id,
        child: child.session.id,
        grandchild: grandchild.session.id,
        authority,
        create,
      };
    }

    it("stops the schedules of the target and its whole tree with them, and nobody else's", async () => {
      const { service, root, child, grandchild, authority, create } = await tree();
      const greatGrandchild = (await create(grandchild)).session.id;
      const sibling = (await create(root)).session.id;
      const insert = (targetSessionId: string) =>
        db.database
          .insert(agentSchedules)
          .values({
            agentId: fixture.agentId,
            targetSessionId,
            name: "check",
            prompt: "check",
            schedule: { kind: "every", intervalSeconds: 3600, anchorAt: "2026-11-07T00:00:00.000Z" },
            timezone: "UTC",
            nextTriggerAt: new Date("2026-11-07T01:00:00.000Z"),
          })
          .returning({ id: agentSchedules.id })
          .then(([row]) => row?.id as string);
      const ofChild = await insert(child);
      const ofGrandchild = await insert(grandchild);
      const ofGreatGrandchild = await insert(greatGrandchild);
      const ofRoot = await insert(root);
      const ofSibling = await insert(sibling);
      await service.stopInternalSession({ ...authority(root), targetSessionId: child });
      const rows = await db.database.select().from(agentSchedules);
      const row = (id: string) => rows.find((candidate) => candidate.id === id);
      expect(row(ofChild)).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });
      expect(row(ofGrandchild)).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });
      expect(row(ofGreatGrandchild)).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });
      expect(row(ofRoot)).toMatchObject({ enabled: true, revision: 1 });
      expect(row(ofSibling)).toMatchObject({ enabled: true, revision: 1 });
      // A repeated stop finds nothing left to change.
      await service.stopInternalSession({ ...authority(root), targetSessionId: child });
      const again = await db.database
        .select()
        .from(agentSchedules)
        .where(inArray(agentSchedules.id, [ofChild, ofGrandchild, ofGreatGrandchild]));
      expect(again.map(({ revision }) => revision)).toEqual([2, 2, 2]);
    });

    it("ends the target and its whole tree for good, leaves the rest alone, and repeats harmlessly", async () => {
      const { service, root, child, grandchild, authority, create } = await tree();
      const greatGrandchild = (await create(grandchild)).session.id;
      const sibling = (await create(root)).session.id;
      const nephew = (await create(sibling)).session.id;

      const stopped = await service.stopInternalSession({ ...authority(root), targetSessionId: child });

      expect(stopped).toMatchObject({
        alreadyStopped: false,
        descendantCount: 2,
        stoppedDescendantCount: 2,
        target: { sessionId: child, creatorSessionId: root, computerKind: "local", computerId: fixture.computerId },
      });
      const stoppedTree = [child, grandchild, greatGrandchild];
      expect(stopped.targets.map(({ sessionId }) => sessionId).sort()).toEqual([...stoppedTree].sort());
      const rows = await db.database
        .select({ id: sessions.id, endedAt: sessions.endedAt })
        .from(sessions)
        .where(inArray(sessions.id, [...stoppedTree, root, sibling, nephew]));
      const endedAt = new Map(rows.map(({ id, endedAt: at }) => [id, at]));
      for (const id of stoppedTree) expect(endedAt.get(id)).toBeInstanceOf(Date);
      for (const id of [root, sibling, nephew]) expect(endedAt.get(id)).toBeNull();

      // The closure agrees for every row naming them, including rows of ancestors above the target.
      const links = await db.database
        .select({ descendant: sessionDescendants.descendantSessionId, active: sessionDescendants.descendantActive })
        .from(sessionDescendants)
        .where(inArray(sessionDescendants.descendantSessionId, [...stoppedTree, sibling, nephew]));
      for (const { descendant, active } of links) expect(active).toBe(!stoppedTree.includes(descendant));
      expect(links.filter(({ descendant }) => descendant === greatGrandchild)).toHaveLength(3);

      const active = await service.listInternalSessions(root, { recursive: true, limit: 10 });
      expect(active.items.map((item) => item.sessionId).sort()).toEqual([sibling, nephew].sort());
      const all = await service.listInternalSessions(root, { recursive: true, limit: 10, includeStopped: true });
      expect(all.items.find((item) => item.sessionId === greatGrandchild)?.stoppedAt).toBe(
        endedAt.get(greatGrandchild)?.toISOString(),
      );

      await expect(service.stopInternalSession({ ...authority(root), targetSessionId: child })).resolves.toMatchObject({
        alreadyStopped: true,
        descendantCount: 2,
        stoppedDescendantCount: 0,
      });
      const [unchanged] = await db.database.select().from(sessions).where(eq(sessions.id, greatGrandchild));
      expect(unchanged?.endedAt).toEqual(endedAt.get(greatGrandchild));
    });

    it("finishes a tree whose target ended before the descendants did", async () => {
      const { service, root, child, grandchild, authority } = await tree();
      await db.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, child));

      const repeated = await service.stopInternalSession({ ...authority(root), targetSessionId: child });

      expect(repeated).toMatchObject({ alreadyStopped: true, descendantCount: 1, stoppedDescendantCount: 1 });
      const [row] = await db.database.select().from(sessions).where(eq(sessions.id, grandchild));
      expect(row?.endedAt).toBeInstanceOf(Date);
    });

    it("stops only below the target when an inner Session stops its own child", async () => {
      const { service, root, child, grandchild, authority } = await tree();
      await expect(
        service.stopInternalSession({ ...authority(child), targetSessionId: grandchild }),
      ).resolves.toMatchObject({ descendantCount: 0, stoppedDescendantCount: 0 });
      const rows = await db.database
        .select()
        .from(sessions)
        .where(inArray(sessions.id, [root, child]));
      expect(rows.map(({ endedAt }) => endedAt)).toEqual([null, null]);
    });

    it("does not stop children because their parent is idle or ended its Run", async () => {
      const { service, root, child, grandchild } = await tree();
      // Nothing about a Run reaches `sessions`: the only way a parent affects a child is a stop.
      await service.listInternalSessions(root, { recursive: true, limit: 10 });
      const rows = await db.database
        .select()
        .from(sessions)
        .where(inArray(sessions.id, [root, child, grandchild]));
      expect(rows.every(({ endedAt }) => endedAt === null)).toBe(true);
      const links = await db.database
        .select({ active: sessionDescendants.descendantActive })
        .from(sessionDescendants)
        .where(eq(sessionDescendants.ancestorSessionId, root));
      expect(links.every(({ active }) => active)).toBe(true);
    });

    it("refuses anyone but an ancestor, and a source without authority", async () => {
      const { service, root, child, grandchild, authority } = await tree();
      for (const [source, targetSessionId] of [
        [child, child],
        [child, root],
        [grandchild, child],
        [root, root],
        [root, randomUUID()],
      ] as const) {
        await expect(service.stopInternalSession({ ...authority(source), targetSessionId })).rejects.toMatchObject({
          code: "SESSION_STOP_NOT_ANCESTOR",
        });
      }
      await expect(
        service.stopInternalSession({ ...authority(root), sourcePlacementGeneration: 9, targetSessionId: child }),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_STALE" });
      await service.stopInternalSession({ ...authority(root), targetSessionId: child });
      await expect(
        service.stopInternalSession({ ...authority(child), targetSessionId: grandchild }),
      ).rejects.toMatchObject({ code: "SESSION_SOURCE_UNAVAILABLE" });
    });

    it("finds recently ended internal Sessions of one Computer only", async () => {
      const { service, root, child, grandchild, authority } = await tree();
      await service.stopInternalSession({ ...authority(root), targetSessionId: grandchild });
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await expect(service.recentlyEndedInternalSessions(fixture.computerId, hourAgo, 10)).resolves.toEqual([
        expect.objectContaining({ sessionId: grandchild, creatorSessionId: child }),
      ]);
      await expect(service.recentlyEndedInternalSessions(randomUUID(), hourAgo, 10)).resolves.toEqual([]);
      await expect(
        service.recentlyEndedInternalSessions(fixture.computerId, new Date(Date.now() + 60_000), 10),
      ).resolves.toEqual([]);
    });

    it("admits a stop frame only for an ended Session on its captured placement", async () => {
      const { service, root, child, grandchild, authority } = await tree();
      const { target } = await service.stopInternalSession({ ...authority(root), targetSessionId: grandchild });
      const enqueue = vi.fn(async () => "enqueued");
      await expect(withEndedSessionStopAuthority(db.database, target, enqueue)).resolves.toBe("enqueued");
      await expect(
        withEndedSessionStopAuthority(db.database, { ...target, sessionId: child }, enqueue),
      ).resolves.toBeUndefined();
      await expect(
        withEndedSessionStopAuthority(db.database, { ...target, placementGeneration: 9 }, enqueue),
      ).resolves.toBeUndefined();
      expect(enqueue).toHaveBeenCalledOnce();
    });
  });

  it("lists the Agent's live Sessions in every conversation, newest first, in pages", async () => {
    let tick = 0;
    const service = new SessionService(db.database, { now: () => new Date(fixture.now.getTime() + tick++ * 1000) });
    const open = async (channelId: string, conversationKind: "dm" | "channel") =>
      (await service.ensureChatSession({ imBindingId: fixture.bindingId, channelId, conversationKind }, "channel"))
        .session;
    const dm = await open("LD1", "dm");
    const group = await open("LG1", "channel");
    const ended = await open("LD2", "dm");
    const child = await service.createInternalSessionWithMessage({
      creatorSessionId: group.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId: randomUUID(),
      initialMessage: "task",
    });
    await db.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, ended.id));

    const { items } = await service.listAgentSessions(dm.id, { limit: 100 });
    const byId = new Map(items.map((item) => [item.sessionId, item]));
    expect(byId.has(ended.id)).toBe(false);
    expect(byId.get(dm.id)).toMatchObject({ current: true, sessionKind: "channel", conversationKind: "dm" });
    expect(byId.get(group.id)).toMatchObject({ sessionKind: "channel", channelId: "LG1" });
    expect(byId.get(group.id)).not.toHaveProperty("current");
    expect(byId.get(child.session.id)).toMatchObject({
      sessionKind: "internal",
      channelId: "LG1",
      parentSessionId: group.id,
      taskPreview: "task",
    });
    const visible = await service.listAgentSessions(dm.id, { limit: 100, visibleOnly: true });
    expect(visible.items.map((item) => item.sessionKind)).not.toContain("internal");
    const first = await service.listAgentSessions(dm.id, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await service.listAgentSessions(dm.id, { limit: 100, cursor: first.nextCursor as string });
    expect(second.items.map((item) => item.sessionId)).not.toContain(first.items[0]?.sessionId);
    expect(second.items).toHaveLength(items.length - 1);
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
    expect(
      await service.recordMessageOutcome({
        messageId,
        attemptCount: 1,
        outcome: "unreachable",
        errorCode: "cloud_capacity_exceeded",
      }),
    ).toBe(true);
    const retry = await service.createInternalSessionWithMessage(input);
    expect(retry).toMatchObject({ deduplicated: false, attemptCount: 2, session: { id: created.session.id } });
    expect(await db.database.select().from(sessionDescendants)).toHaveLength(1);
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

  it("resolves Run outcome notices for an active target's own messages, to their sender", async () => {
    const service = new SessionService(db.database, { now: () => fixture.now });
    const creator = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const taskId = randomUUID();
    const child = await service.createInternalSessionWithMessage({
      creatorSessionId: creator.session.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId: taskId,
      initialMessage: "task",
    });
    await expect(
      service.resolveRunOutcomeNotice({ childSessionId: child.session.id, messageId: taskId }),
    ).resolves.toEqual({ recipientSessionId: creator.session.id, installationId: fixture.installationId });
    // A message addressed to another Session or an unknown message is not eligible.
    await expect(
      service.resolveRunOutcomeNotice({ childSessionId: creator.session.id, messageId: taskId }),
    ).resolves.toBeUndefined();
    await expect(
      service.resolveRunOutcomeNotice({ childSessionId: child.session.id, messageId: randomUUID() }),
    ).resolves.toBeUndefined();

    // The notice is an ordinary child-to-creator message under the child's live authority.
    const noticeId = randomUUID();
    const notice = await service.authorizeAndRecordMessage({
      messageId: noticeId,
      sourceSessionId: child.session.id,
      sourceInstallationId: fixture.installationId,
      sourceComputerId: fixture.computerId,
      sourceConnectionInstanceId: fixture.instanceId,
      sourcePlacementGeneration: child.placement.generation,
      targetSessionId: creator.session.id,
      content: "notice",
    });
    expect(notice.route).toMatchObject({ sourceSessionId: child.session.id, targetSessionId: creator.session.id });

    const send = (
      source: { session: { id: string }; placement: { generation: number } },
      targetSessionId: string,
      content: string,
    ) =>
      service.authorizeAndRecordMessage({
        messageId: randomUUID(),
        sourceSessionId: source.session.id,
        sourceInstallationId: fixture.installationId,
        sourceComputerId: fixture.computerId,
        sourceConnectionInstanceId: fixture.instanceId,
        sourcePlacementGeneration: source.placement.generation,
        targetSessionId,
        content,
      });
    const resolve = (childSessionId: string, messageId: string) =>
      service.resolveRunOutcomeNotice({ childSessionId, messageId });
    const toRecipient = (recipientSessionId: string) => ({
      recipientSessionId,
      installationId: fixture.installationId,
    });

    // A visible target: its sender hears about it.
    const callback = await send(child, creator.session.id, "callback");
    await expect(resolve(creator.session.id, callback.message.id)).resolves.toEqual(toRecipient(child.session.id));

    // A sender that is not the target's creator: only the sender hears about it.
    const sibling = await service.createInternalSessionWithMessage({
      creatorSessionId: creator.session.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId: randomUUID(),
      initialMessage: "sibling task",
    });
    const fromSibling = await send(sibling, child.session.id, "from a sibling");
    await expect(resolve(child.session.id, fromSibling.message.id)).resolves.toEqual(toRecipient(sibling.session.id));

    // A failed notice climbs to the creator, never back to the Session the notice was about.
    const noticeFrom = async (source: typeof sibling, targetSessionId: string, reported: string) => {
      const content = renderRunOutcomeNotice({
        childSessionId: source.session.id,
        messageId: reported,
        outcome: "failed",
        reason: "provider_failed",
      });
      return (
        await service.authorizeAndRecordMessage({
          messageId: runOutcomeNoticeMessageId(source.session.id, reported),
          sourceSessionId: source.session.id,
          sourceInstallationId: fixture.installationId,
          sourceComputerId: fixture.computerId,
          sourceConnectionInstanceId: fixture.instanceId,
          sourcePlacementGeneration: source.placement.generation,
          targetSessionId,
          content,
          serverDerivedId: true,
        })
      ).message;
    };
    const failedNotice = await noticeFrom(sibling, child.session.id, randomUUID());
    await expect(resolve(child.session.id, failedNotice.id)).resolves.toEqual(toRecipient(creator.session.id));
    // At a visible target it stops.
    const failedAtTop = await noticeFrom(child, creator.session.id, randomUUID());
    await expect(resolve(creator.session.id, failedAtTop.id)).resolves.toBeUndefined();

    // Ordinary content that looks like a notice keeps its sender: the header proves nothing, whether it
    // is a bare prefix or a whole quoted notice under the message's own id.
    const bareHeader = await send(sibling, child.session.id, `${SESSION_RUN_OUTCOME_NOTICE_HEADER}\nplease look`);
    await expect(resolve(child.session.id, bareHeader.message.id)).resolves.toEqual(toRecipient(sibling.session.id));
    const quoted = await send(sibling, child.session.id, failedNotice.content);
    await expect(resolve(child.session.id, quoted.message.id)).resolves.toEqual(toRecipient(sibling.session.id));
    const quotedAtTop = await send(child, creator.session.id, failedAtTop.content);
    await expect(resolve(creator.session.id, quotedAtTop.message.id)).resolves.toEqual(toRecipient(child.session.id));
    // An id that matches the Session the content names does not pass when another Session sent it.
    const reported = randomUUID();
    const borrowed = await service.authorizeAndRecordMessage({
      messageId: runOutcomeNoticeMessageId(child.session.id, reported),
      sourceSessionId: sibling.session.id,
      sourceInstallationId: fixture.installationId,
      sourceComputerId: fixture.computerId,
      sourceConnectionInstanceId: fixture.instanceId,
      sourcePlacementGeneration: sibling.placement.generation,
      targetSessionId: child.session.id,
      content: renderRunOutcomeNotice({
        childSessionId: child.session.id,
        messageId: reported,
        outcome: "failed",
        reason: "provider_failed",
      }),
      // A row like this can only predate the reserved ID space.
      serverDerivedId: true,
    });
    await expect(resolve(child.session.id, borrowed.message.id)).resolves.toEqual(toRecipient(sibling.session.id));

    // No sender but the target itself, or none at all (scheduled): its creator, or nobody at a visible target.
    const toItself = await send(child, child.session.id, "to itself").catch(() => undefined);
    if (toItself) {
      await expect(resolve(child.session.id, toItself.message.id)).resolves.toEqual(toRecipient(creator.session.id));
    }
    const withoutSender = async (targetSessionId: string) => {
      const scheduledId = randomUUID();
      await db.database.insert(sessionMessages).values({
        id: scheduledId,
        sourceSessionId: null,
        scheduledOrigin: {
          scheduleId: randomUUID(),
          scheduledFor: fixture.now.toISOString(),
          timezone: "UTC",
          name: "schedule",
        },
        targetSessionId,
        content: "scheduled",
        contentHash: "a".repeat(64),
        createdAt: fixture.now,
        updatedAt: fixture.now,
      } as never);
      return resolve(targetSessionId, scheduledId);
    };
    await expect(withoutSender(child.session.id)).resolves.toEqual(toRecipient(creator.session.id));
    await expect(withoutSender(creator.session.id)).resolves.toBeUndefined();

    // An ended child is never notified about.
    await db.database.update(sessions).set({ endedAt: fixture.now }).where(eq(sessions.id, child.session.id));
    await expect(
      service.resolveRunOutcomeNotice({ childSessionId: child.session.id, messageId: taskId }),
    ).resolves.toBeUndefined();
  });

  it("sends a notice whose recipient has ended to the nearest active Session up its creation chain", async () => {
    const service = new SessionService(db.database, { now: () => fixture.now });
    const root = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const create = (creator: { session: { id: string }; placement?: { generation: number } }, initialMessage: string) =>
      service.createInternalSessionWithMessage({
        creatorSessionId: creator.session.id,
        creatorInstallationId: fixture.installationId,
        creatorConnectionInstanceId: fixture.instanceId,
        creatorComputerId: fixture.computerId,
        creatorPlacementGeneration: creator.placement?.generation ?? 1,
        messageId: randomUUID(),
        initialMessage,
      });
    const send = (
      source: { session: { id: string }; placement: { generation: number } },
      targetSessionId: string,
      content: string,
    ) =>
      service.authorizeAndRecordMessage({
        messageId: randomUUID(),
        sourceSessionId: source.session.id,
        sourceInstallationId: fixture.installationId,
        sourceComputerId: fixture.computerId,
        sourceConnectionInstanceId: fixture.instanceId,
        sourcePlacementGeneration: source.placement.generation,
        targetSessionId,
        content,
      });
    const end = (sessionId: string) =>
      db.database.update(sessions).set({ endedAt: fixture.now }).where(eq(sessions.id, sessionId));
    const resolve = (childSessionId: string, messageId: string) =>
      service.resolveRunOutcomeNotice({ childSessionId, messageId });
    const toRecipient = (recipientSessionId: string) => ({
      recipientSessionId,
      installationId: fixture.installationId,
    });

    // root -> manager -> worker, and a separate target the worker writes to.
    const manager = await create(root, "manage");
    const worker = await create(manager, "work");
    const target = await create(root, "target");
    const fromWorker = await send(worker, target.session.id, "from the worker");
    await expect(resolve(target.session.id, fromWorker.message.id)).resolves.toEqual(toRecipient(worker.session.id));

    await end(worker.session.id);
    await expect(resolve(target.session.id, fromWorker.message.id)).resolves.toEqual(toRecipient(manager.session.id));
    await end(manager.session.id);
    await expect(resolve(target.session.id, fromWorker.message.id)).resolves.toEqual(toRecipient(root.session.id));
    await end(root.session.id);
    await expect(resolve(target.session.id, fromWorker.message.id)).resolves.toBeUndefined();
    // A corrupt chain that loops gives up at the depth bound instead of spinning.
    await db.database
      .update(sessions)
      .set({ createdBySessionId: worker.session.id })
      .where(eq(sessions.id, manager.session.id));
    await expect(resolve(target.session.id, fromWorker.message.id)).resolves.toBeUndefined();

    // A chain that leads back to the reporting Session stops there: it would only notify itself.
    const owner = await create(
      await service.ensureChatSession(
        { imBindingId: fixture.bindingId, channelId: "C2", conversationKind: "dm" },
        "channel",
      ),
      "owner",
    );
    const helper = await create(owner, "help");
    const fromHelper = await send(helper, owner.session.id, "from the helper");
    await end(helper.session.id);
    await expect(resolve(owner.session.id, fromHelper.message.id)).resolves.toBeUndefined();
  });

  it("keeps a future notice's ID out of ordinary ingress, so another sender's notice is delivered", async () => {
    const service = new SessionService(db.database, { now: () => fixture.now });
    const creator = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const internal = (initialMessage: string) =>
      service.createInternalSessionWithMessage({
        creatorSessionId: creator.session.id,
        creatorInstallationId: fixture.installationId,
        creatorConnectionInstanceId: fixture.instanceId,
        creatorComputerId: fixture.computerId,
        creatorPlacementGeneration: 1,
        messageId: randomUUID(),
        initialMessage,
      });
    const [target, sender, other] = [await internal("target"), await internal("sender"), await internal("other")];
    const record = (source: typeof sender, messageId: string, targetSessionId: string, content: string) =>
      service.authorizeAndRecordMessage({
        messageId,
        sourceSessionId: source.session.id,
        sourceInstallationId: fixture.installationId,
        sourceComputerId: fixture.computerId,
        sourceConnectionInstanceId: fixture.instanceId,
        sourcePlacementGeneration: source.placement.generation,
        targetSessionId,
        content,
      });
    const reported = await record(sender, randomUUID(), target.session.id, "the message that fails");
    const noticeId = runOutcomeNoticeMessageId(target.session.id, reported.message.id);

    const collaboration = new SessionCollaborationService({
      assembler: { assembleForSession: vi.fn().mockResolvedValue({}) } as never,
      domain: {
        requestReconcile: vi.fn().mockResolvedValue({ status: "ready" }),
        requestSessionMessageDelivery: vi.fn(
          async (_computer: string, _instance: string, frame: { messageId: string }) => ({
            status: "accepted",
            messageId: frame.messageId,
          }),
        ),
      } as never,
      registry: {
        capabilityVersion: vi.fn().mockReturnValue(4),
        currentInstanceId: vi.fn().mockReturnValue(fixture.instanceId),
        supportsCapability: vi.fn().mockReturnValue(true),
      } as never,
      sessions: service,
    });
    const notify = (messageId: string, childSessionId = target.session.id) =>
      collaboration.notifyRunOutcome({
        childSessionId,
        messageId,
        outcome: "failed",
        reason: "provider_failed",
        source: {
          computerId: fixture.computerId,
          connectionInstanceId: fixture.instanceId,
          placementGeneration: target.placement.generation,
        },
      });
    const ordinary = {
      sessionId: other.session.id,
      installationId: fixture.installationId,
      computerId: fixture.computerId,
      connectionInstanceId: fixture.instanceId,
      placementGeneration: other.placement.generation,
    } as never;
    const sentCount = async () => (await db.database.select().from(sessionMessages)).length;

    // The other Session computes the public ID and tries to take it through ordinary send and create.
    const before = await sentCount();
    await expect(
      collaboration.send({ messageId: noticeId, targetSessionId: target.session.id, message: "preclaim" }, ordinary),
    ).resolves.toMatchObject({ status: "rejected", code: "message_id_reserved" });
    await expect(collaboration.create({ messageId: noticeId, message: "preclaim" }, ordinary)).resolves.toMatchObject({
      status: "rejected",
      code: "message_id_reserved",
    });
    expect(await sentCount()).toBe(before);

    await expect(notify(reported.message.id)).resolves.toBe("notified");
    const [notice] = await db.database.select().from(sessionMessages).where(eq(sessionMessages.id, noticeId));
    expect(notice).toMatchObject({ sourceSessionId: target.session.id, targetSessionId: sender.session.id });
    expect(notice?.content.startsWith(SESSION_RUN_OUTCOME_NOTICE_HEADER)).toBe(true);

    // Why the rule is needed: a row already under that ID, recorded before it, still blocks that one notice.
    const blocked = await record(sender, randomUUID(), target.session.id, "another message that fails");
    const older = await record(other, randomUUID(), target.session.id, "older row");
    await db.database
      .update(sessionMessages)
      .set({ id: runOutcomeNoticeMessageId(target.session.id, blocked.message.id) })
      .where(eq(sessionMessages.id, older.message.id));
    await expect(notify(blocked.message.id)).resolves.toBe("ignored");

    // A caller with an ordinary version 5 row from before the rule can still resolve an uncertain write.
    const legacySendId = "5f3c2b1a-9d8e-5c7b-8a6f-1e2d3c4b5a69";
    const legacySend = await record(other, randomUUID(), target.session.id, "sent before the upgrade");
    await db.database
      .update(sessionMessages)
      .set({ id: legacySendId })
      .where(eq(sessionMessages.id, legacySend.message.id));
    const sent = await collaboration.send(
      { messageId: legacySendId, targetSessionId: target.session.id, message: "sent before the upgrade" },
      ordinary,
    );
    expect(sent).toMatchObject({ messageId: legacySendId, status: "accepted" });
    await expect(
      collaboration.send(
        { messageId: legacySendId, targetSessionId: target.session.id, message: "different text" },
        ordinary,
      ),
    ).resolves.toMatchObject({ status: "rejected", code: "message_conflict" });
    // Another Session cannot use that retry to reach the row.
    await expect(
      collaboration.send(
        { messageId: legacySendId, targetSessionId: target.session.id, message: "sent before the upgrade" },
        {
          ...(ordinary as object),
          sessionId: sender.session.id,
          placementGeneration: sender.placement.generation,
        } as never,
      ),
    ).resolves.toMatchObject({ status: "rejected", code: "message_conflict" });

    const creatorSource = {
      sessionId: creator.session.id,
      installationId: fixture.installationId,
      computerId: fixture.computerId,
      connectionInstanceId: fixture.instanceId,
      placementGeneration: creator.placement.generation,
    } as never;
    const legacyCreateId = "6a1f0c2e-3b4d-5e6f-9a0b-1c2d3e4f5a6b";
    const legacyCreated = await internal("created before the upgrade");
    await db.database
      .update(sessionMessages)
      .set({ id: legacyCreateId })
      .where(eq(sessionMessages.targetSessionId, legacyCreated.session.id));
    await expect(
      collaboration.create({ messageId: legacyCreateId, message: "created before the upgrade" }, creatorSource),
    ).resolves.toMatchObject({ messageId: legacyCreateId, status: "accepted", sessionId: legacyCreated.session.id });
    await expect(
      collaboration.create({ messageId: legacyCreateId, message: "different text" }, creatorSource),
    ).resolves.toMatchObject({ status: "rejected", code: "message_conflict" });
  });

  it("sends a background-work notice to the message's sender, including from a visible target", async () => {
    const service = new SessionService(db.database, { now: () => fixture.now });
    const visible = await service.ensureChatSession(
      { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const child = await service.createInternalSessionWithMessage({
      creatorSessionId: visible.session.id,
      creatorInstallationId: fixture.installationId,
      creatorConnectionInstanceId: fixture.instanceId,
      creatorComputerId: fixture.computerId,
      creatorPlacementGeneration: 1,
      messageId: randomUUID(),
      initialMessage: "task",
    });
    const callback = await service.authorizeAndRecordMessage({
      messageId: randomUUID(),
      sourceSessionId: child.session.id,
      sourceInstallationId: fixture.installationId,
      sourceComputerId: fixture.computerId,
      sourceConnectionInstanceId: fixture.instanceId,
      sourcePlacementGeneration: child.placement.generation,
      targetSessionId: visible.session.id,
      content: "callback",
    });
    const collaboration = new SessionCollaborationService({
      assembler: { assembleForSession: vi.fn().mockResolvedValue({}) } as never,
      domain: {
        requestReconcile: vi.fn().mockResolvedValue({ status: "ready" }),
        requestSessionMessageDelivery: vi.fn(
          async (_computer: string, _instance: string, frame: { messageId: string }) => ({
            status: "accepted",
            messageId: frame.messageId,
          }),
        ),
      } as never,
      registry: {
        capabilityVersion: vi.fn().mockReturnValue(4),
        currentInstanceId: vi.fn().mockReturnValue(fixture.instanceId),
        supportsCapability: vi.fn().mockReturnValue(true),
      } as never,
      sessions: service,
    });
    await expect(
      collaboration.notifyRunOutcome({
        childSessionId: visible.session.id,
        messageId: callback.message.id,
        outcome: "unknown",
        reason: "background_work_possibly_stopped",
        source: {
          computerId: fixture.computerId,
          connectionInstanceId: fixture.instanceId,
          placementGeneration: visible.placement.generation,
        },
      }),
    ).resolves.toBe("notified");
    const [notice] = await db.database
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.id, runOutcomeNoticeMessageId(visible.session.id, callback.message.id)));
    expect(notice).toMatchObject({ sourceSessionId: visible.session.id, targetSessionId: child.session.id });
    expect(notice?.content).toContain("Outcome: unknown (reason: background_work_possibly_stopped)");
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
    // Another conversation of the same Agent is reachable.
    const crossed = await service.authorizeAndRecordMessage({
      ...args,
      targetSessionId: other.session.id,
      messageId: randomUUID(),
    });
    expect(crossed.route.targetSessionId).toBe(other.session.id);
    await expect(service.resolveMessageProvenance(crossed.message)).resolves.toMatchObject({
      source: { sessionKind: "channel", conversationKind: "dm" },
      target: { sessionId: other.session.id, sessionKind: "channel", conversationKind: "dm", channelId: "C2" },
    });
    await expect(
      service.authorizeAndRecordMessage({ ...args, sourceSessionId: randomUUID(), messageId: randomUUID() }),
    ).rejects.toMatchObject({ code: "SESSION_SOURCE_UNAVAILABLE" });
    expect(await service.recordMessageOutcome({ messageId: randomUUID(), attemptCount: 1, outcome: "rejected" })).toBe(
      false,
    );
  });

  it("admits only valid collaboration authorities and releases admission on dispatch", async () => {
    const logger = { info: vi.fn() };
    const service = new SessionService(db.database, { logger });
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
      targetComputerKind: "local" as const,
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
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentId: route.agentId,
        code: "SESSION_COLLABORATION_ADMISSION_COMPUTER_OWNERSHIP_INVALID",
        imBindingId: route.imBindingId,
        sourceComputerId: route.sourceComputerId,
        sourceSessionId: route.sourceSessionId,
        targetComputerId: route.targetComputerId,
        targetComputerKind: "local" as const,
        targetSessionId: route.targetSessionId,
      }),
      "Session collaboration dispatch admission rejected",
    );
    await db.database
      .update(computers)
      .set({ ownerAccountId: fixture.userId })
      .where(eq(computers.id, fixture.computerId));
    await db.database
      .update(computers)
      .set({ currentInstanceId: randomUUID() })
      .where(eq(computers.id, fixture.computerId));
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toEqual({ admitted: false });
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "SESSION_COLLABORATION_ADMISSION_SOURCE_INSTANCE_STALE" }),
      "Session collaboration dispatch admission rejected",
    );
    await db.database
      .update(computers)
      .set({ currentInstanceId: fixture.instanceId })
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
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "SESSION_COLLABORATION_ADMISSION_AGENT_INACTIVE" }),
      "Session collaboration dispatch admission rejected",
    );
    await db.database.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.agentId));
    await db.database.update(imBindings).set({ status: "error" }).where(eq(imBindings.id, fixture.bindingId));
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toEqual({ admitted: false });
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "SESSION_COLLABORATION_ADMISSION_BINDING_INVALID" }),
      "Session collaboration dispatch admission rejected",
    );
    await db.database.update(imBindings).set({ status: "active" }).where(eq(imBindings.id, fixture.bindingId));
    await db.database
      .update(sessionPlacements)
      .set({ generation: 2 })
      .where(eq(sessionPlacements.sessionId, target.session.id));
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toEqual({ admitted: false });
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "SESSION_COLLABORATION_ADMISSION_PLACEMENT_INVALID" }),
      "Session collaboration dispatch admission rejected",
    );
    await db.database
      .update(sessionPlacements)
      .set({ generation: 1 })
      .where(eq(sessionPlacements.sessionId, target.session.id));
    await db.database.update(sessions).set({ endedAt: fixture.now }).where(eq(sessions.id, target.session.id));
    await expect(service.withCollaborationDispatchAdmission(route, operation)).resolves.toEqual({ admitted: false });
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "SESSION_COLLABORATION_ADMISSION_AUTHORITY_SESSION_INVALID" }),
      "Session collaboration dispatch admission rejected",
    );
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
      (await service.prepareReconcile(fixture.computerId, fixture.instanceId, reconcile)).request.sessionCliProof,
    ).toBeDefined();
    const stopped = { ...reconcile, desired: "stopped" as const };
    expect((await service.prepareReconcile(fixture.computerId, fixture.instanceId, stopped)).request).toBe(stopped);
    await expect(service.revoke({ ...input, placementGeneration: 99 })).resolves.toBeUndefined();
    await expect(service.revoke({ ...input, connectionInstanceId: randomUUID() })).resolves.toBeUndefined();
    registry.supportsCapability.mockReturnValue(false);
    await expect(service.prepareReconcile(fixture.computerId, fixture.instanceId, reconcile)).resolves.toEqual({
      request: reconcile,
    });
    await expect(service.mint(input)).rejects.toMatchObject({ code: "runtime_unavailable" });
    registry.supportsCapability.mockReturnValue(true);
    await expect(service.revoke(input)).resolves.toBeUndefined();
  });

  it.each([false, true])(
    "preserves busy proof and fences a stopped result after newer ready=%s",
    async (newerReady) => {
      const service = new SessionCliProofService(
        db.database,
        {
          currentInstanceId: () => fixture.instanceId,
          supportsCapability: () => true,
        },
        new Uint8Array(32).fill(3),
        { now: () => fixture.now },
      );
      const session = await new SessionService(db.database).ensureChatSession(
        { imBindingId: fixture.bindingId, channelId: "C1", conversationKind: "dm" },
        "channel",
      );
      const ready: SessionReconcileRequest = {
        type: "session:reconcile",
        requestId: randomUUID(),
        installationId: fixture.installationId,
        sessionId: session.session.id,
        agentId: fixture.agentId,
        placementGeneration: 1,
        desired: "ready",
      };
      const initial = await service.prepareReconcile(fixture.computerId, fixture.instanceId, ready);
      const proof = initial.request.sessionCliProof;
      if (!proof) throw new Error("The ready reconcile must provide a proof");
      const stopped = await service.prepareReconcile(fixture.computerId, fixture.instanceId, {
        ...ready,
        desired: "stopped",
      });
      const result: SessionReconcileResult = {
        type: "session:reconcile:result",
        requestId: ready.requestId,
        sessionId: ready.sessionId,
        placementGeneration: 1,
        status: "busy",
        reason: "active_turn",
      };
      await stopped.onResult?.(result);
      await expect(service.authenticate(proof.token)).resolves.toHaveProperty("sessionId", ready.sessionId);
      if (newerReady) {
        // Fixed clock and reused proofId must still supersede the pending stop.
        expect(
          (await service.prepareReconcile(fixture.computerId, fixture.instanceId, ready)).request.sessionCliProof,
        ).toEqual(proof);
      }
      await stopped.onResult?.({ ...result, status: "stopped", reason: undefined });
      if (newerReady) {
        await expect(service.authenticate(proof.token)).resolves.toHaveProperty("sessionId", ready.sessionId);
      } else {
        await expect(service.authenticate(proof.token)).rejects.toMatchObject({ code: "invalid_proof" });
      }
    },
  );

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
        text: "hello from an addressed channel message",
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

  it("opens an owning Agent avatar and passes the bounded unauthenticated request policy", async () => {
    await setAvatarUrl(db, fixture.bindingId);
    const avatar = avatarResponse({ contentType: "image/png; charset=binary", contentLength: "6" });
    const fetch = vi.fn().mockResolvedValue(avatar.response);
    const service = new ImResourceService(db.database, vi.fn(), fakeAvatarPolicy(fetch));

    const opened = await service.openAvatar(fixture.userId, fixture.agentId);

    expect(opened.mediaType).toBe("image/png");
    expect(opened.sizeBytes).toBe(6);
    await expect(readNodeStream(opened.stream)).resolves.toEqual(Buffer.from("avatar"));
    expect(fetch).toHaveBeenCalledWith(
      AVATAR_URL,
      { headers: { accept: "image/*" } },
      {
        allowAnyHttpsHost: true,
        circuitKey: `im-avatar:${fixture.agentId}`,
        maxAttempts: 1,
        timeoutMs: 10_000,
        transport: expect.any(Function),
      },
    );
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init).not.toHaveProperty("credentials");
    expect(init).not.toHaveProperty("authorization");
  });

  it.each(["missing binding", "disabled binding", "other account", "deleted Agent"])(
    "rejects an avatar request for %s",
    async (variant) => {
      if (variant !== "missing binding") await setAvatarUrl(db, fixture.bindingId);
      if (variant === "disabled binding") {
        await db.database.transaction(async (transaction) => {
          await disableImBindingInTransaction(transaction, fixture.bindingId, fixture.now);
        });
      }
      if (variant === "deleted Agent") {
        await db.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, fixture.agentId));
      }
      const fetch = vi.fn();
      const service = new ImResourceService(db.database, vi.fn(), fakeAvatarPolicy(fetch));
      const callerUserId = variant === "other account" ? randomUUID() : fixture.userId;

      await expect(service.openAvatar(callerUserId, fixture.agentId)).rejects.toMatchObject({
        code: "IM_BINDING_NOT_FOUND",
        statusCode: 404,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("maps fetch failures to a transient 503", async () => {
    await setAvatarUrl(db, fixture.bindingId);
    const fetch = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const service = new ImResourceService(db.database, vi.fn(), fakeAvatarPolicy(fetch));

    await expect(service.openAvatar(fixture.userId, fixture.agentId)).rejects.toMatchObject({
      code: "IM_BINDING_TEMPORARILY_UNAVAILABLE",
      statusCode: 503,
      category: "transient",
    });
  });

  it.each(["non-OK response", "empty response body"])("maps an %s to a transient 503", async (variant) => {
    await setAvatarUrl(db, fixture.bindingId);
    const avatar = variant === "non-OK response" ? avatarResponse({ status: 503 }) : undefined;
    const response = avatar?.response ?? new Response(null, { status: 200, headers: { "content-type": "image/png" } });
    const fetch = vi.fn().mockResolvedValue(response);
    const service = new ImResourceService(db.database, vi.fn(), fakeAvatarPolicy(fetch));

    await expect(service.openAvatar(fixture.userId, fixture.agentId)).rejects.toMatchObject({
      code: "IM_BINDING_TEMPORARILY_UNAVAILABLE",
      statusCode: 503,
      category: "transient",
    });
    if (avatar) expect(avatar.cancel).toHaveBeenCalledOnce();
  });

  it("cancels and rejects a disallowed avatar media type", async () => {
    await setAvatarUrl(db, fixture.bindingId);
    const avatar = avatarResponse({ contentType: "text/html" });
    const fetch = vi.fn().mockResolvedValue(avatar.response);
    const service = new ImResourceService(db.database, vi.fn(), fakeAvatarPolicy(fetch));

    await expect(service.openAvatar(fixture.userId, fixture.agentId)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 415,
    });
    expect(avatar.cancel).toHaveBeenCalledOnce();
  });

  it("uses decoded bytes instead of compressed response headers for sizeBytes", async () => {
    await setAvatarUrl(db, fixture.bindingId);
    const encoded = gzipSync(PNG_BYTES);
    const avatar = avatarResponse({
      body: PNG_BYTES,
      contentEncoding: "gzip",
      contentLength: String(encoded.byteLength),
    });
    const fetch = vi.fn().mockResolvedValue(avatar.response);
    const service = new ImResourceService(db.database, vi.fn(), fakeAvatarPolicy(fetch));

    const opened = await service.openAvatar(fixture.userId, fixture.agentId);

    expect(opened.sizeBytes).toBe(PNG_BYTES.byteLength);
    await expect(readNodeStream(opened.stream)).resolves.toEqual(PNG_BYTES);
  });

  it("rejects a compressed response whose decoded body exceeds 5 MiB", async () => {
    await setAvatarUrl(db, fixture.bindingId);
    const decoded = Buffer.alloc(MAX_AVATAR_BYTES + 1, 0x61);
    const encoded = gzipSync(decoded);
    const avatar = avatarResponse({
      body: decoded,
      contentEncoding: "gzip",
      contentLength: String(encoded.byteLength),
    });
    const fetch = vi.fn().mockResolvedValue(avatar.response);
    const service = new ImResourceService(db.database, vi.fn(), fakeAvatarPolicy(fetch));

    await expect(service.openAvatar(fixture.userId, fixture.agentId)).rejects.toMatchObject({
      code: "IM_AVATAR_TOO_LARGE",
      statusCode: 413,
    });
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
    proofId: crypto.randomUUID(),
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
        targetComputerKind: "local" as const,
        targetPlacementGeneration: 1,
        targetSessionKind: "internal" as const,
        targetCreatorSessionId: "source",
      },
      message: {
        id: "message",
        sourceSessionId: "source",
        scheduledOrigin: null,
        userTaskSource: null,
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
      heldHasRoom: vi.fn().mockResolvedValue(true),
      hasOlderHeldMessage: vi.fn().mockResolvedValue(false),
      recordMessageOutcome: vi.fn().mockResolvedValue(true),
      resolveMessageProvenance: vi.fn(async (message: { sourceSessionId: string | null; targetSessionId: string }) => ({
        source: {
          sessionId: message.sourceSessionId ?? randomUUID(),
          sessionKind: "channel" as const,
          conversationKind: "channel" as const,
          channelId: "C-same",
        },
        target: {
          sessionId: message.targetSessionId,
          sessionKind: "internal" as const,
          conversationKind: "channel" as const,
          channelId: "C-same",
        },
      })),
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
      supportsCapability: vi.fn(
        (_computerId: string, _instanceId: string, capability: string) => capability !== "runtime.sessionRecovery",
      ),
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
    value.registry.currentInstanceId.mockReturnValue(null);
    await expect(
      value.service.send({ messageId: "message", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(value.sessions.recordMessageOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "unknown", errorCode: "delivery_held" }),
    );
    value.registry.currentInstanceId.mockReturnValue("instance");
    value.registry.supportsCapability.mockReturnValue(false);
    await expect(
      value.service.send({ messageId: "message-2", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ code: "runtime_unavailable" });
    value.registry.supportsCapability.mockImplementation(
      (_computerId: string, _instanceId: string, capability: string) => capability !== "runtime.sessionRecovery",
    );
    value.attempt.route.targetSessionKind = "channel";
    await expect(
      value.service.send({ messageId: "message-channel", targetSessionId: "target", message: "hello" }, source),
    ).resolves.toMatchObject({ status: "accepted" });
    value.registry.capabilityVersion.mockImplementation((_computer, _instance, capability) =>
      capability === "runtime.imCredentialGrant" ? 1 : undefined,
    );
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
      undefined,
      { joinSettlement: false },
    );
  });
});

function inboundEvent(
  options: {
    providerEventId?: string;
    text?: string;
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
        fallbackText: options.text ?? "hello",
        blocks: [{ type: "text", text: options.text ?? "hello" }],
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
