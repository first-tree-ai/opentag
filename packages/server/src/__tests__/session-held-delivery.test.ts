import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  SESSION_DELIVERY_FAILURE_NOTICE_HEADER,
  type SessionMessageDeliveryRequest,
} from "@opentag/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentSchedules,
  agents,
  computers,
  imBindings,
  sessionMessages,
  sessionPlacements,
  sessions,
  users,
} from "../db/schema/index.js";
import type { RuntimeDispatchAdmission } from "../runtime/runtime-domain-owner.js";
import type { SessionCliSourceContext } from "../services/sessions/session-cli-proof-service.js";
import { SessionCollaborationService } from "../services/sessions/session-collaboration-service.js";
import {
  deliveryFailureNoticeMessageId,
  SESSION_MESSAGE_HELD_TTL_MS,
} from "../services/sessions/session-held-delivery.js";
import { SessionHeldDeliveryWorker } from "../services/sessions/session-held-delivery-worker.js";
import { runOutcomeNoticeMessageId } from "../services/sessions/session-run-outcome-notice.js";
import { SessionService } from "../services/sessions/session-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let db: UnitDatabase;

beforeAll(async () => {
  db = await createUnitDatabase();
}, 60_000);
afterAll(async () => db.close());
beforeEach(async () => db.reset());

type Answer = "accepted" | "client_busy" | "session_recovery_required" | "target_mismatch" | "throw" | "stall";

async function stack(
  options: {
    recovery?: boolean;
    collaborationVersion?: number;
    now?: () => number;
    sendBudgetMs?: number;
    heldLimits?: { perTarget: number; perComputer: number };
  } = {},
) {
  const accountId = randomUUID();
  const computerId = randomUUID();
  const installationId = randomUUID();
  const instanceId = randomUUID();
  await db.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "Owner" });
  await db.database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    kind: "local",
    currentInstallationId: installationId,
    currentInstanceId: instanceId,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const agentId = randomUUID();
  await db.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
  });
  const bindingId = randomUUID();
  await db.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `app-${randomUUID()}`,
    externalBotId: "ou_bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "test-only",
    activatedAt: new Date(),
  });
  const senderSessionId = randomUUID();
  await db.database.insert(sessions).values({
    id: senderSessionId,
    imBindingId: bindingId,
    channelId: "oc_channel",
    conversationKind: "dm",
    kind: "channel",
  });
  await db.database.insert(sessionPlacements).values({ sessionId: senderSessionId, computerId, generation: 1 });

  const frames: SessionMessageDeliveryRequest[] = [];
  const state = {
    answer: "accepted" as Answer | ((frame: SessionMessageDeliveryRequest) => Answer),
    connected: true as boolean,
    stalled: Promise.resolve() as Promise<unknown>,
    afterStall: "accepted" as "accepted" | "client_busy" | "target_mismatch",
  };
  const domain = {
    requestReconcile: vi.fn(
      async (_c: string, _i: string, request: { sessionId: string; placementGeneration: number }) => ({
        type: "session:reconcile:result" as const,
        requestId: randomUUID(),
        sessionId: request.sessionId,
        placementGeneration: request.placementGeneration,
        status: "ready" as const,
      }),
    ),
    requestSessionMessageDelivery: vi.fn(
      async (
        _c: string,
        _i: string,
        frame: SessionMessageDeliveryRequest,
        _onDispatched: undefined,
        admission: RuntimeDispatchAdmission<unknown>,
      ) => {
        const answer = typeof state.answer === "function" ? state.answer(frame) : state.answer;
        if (answer === "stall") await state.stalled;
        const admitted = await admission(async (onDispatched) => {
          onDispatched();
          return undefined;
        });
        if (!admitted.admitted) throw new Error("not admitted");
        if (answer === "throw") throw new Error("connection lost");
        const final = answer === "stall" ? state.afterStall : answer;
        frames.push(frame);
        return {
          type: "session:message:deliver:result" as const,
          requestId: frame.requestId,
          messageId: frame.messageId,
          targetSessionId: frame.targetSessionId,
          placementGeneration: frame.placementGeneration,
          ...(final === "accepted" ? { status: "accepted" as const } : { status: "rejected" as const, reason: final }),
        };
      },
    ),
  };
  const registry = {
    currentInstanceId: vi.fn(() => (state.connected ? instanceId : undefined)),
    // A current Client: session collaboration v5 understands provenance. Everything else answers 2.
    capabilityVersion: vi.fn((_c: string, _i: string, capability: string) =>
      capability === RUNTIME_CAPABILITY.sessionCollaboration ? (options.collaborationVersion ?? 5) : 2,
    ),
    supportsCapability: vi.fn(
      (_c: string, _i: string, capability: string) =>
        capability !== RUNTIME_CAPABILITY.sessionRecovery || options.recovery !== false,
    ),
  };
  const sessionService = new SessionService(db.database);
  const collaboration = new SessionCollaborationService({
    assembler: { assembleForSession: vi.fn(async () => ({})) } as never,
    domain: domain as never,
    registry: registry as never,
    sessions: sessionService,
    logger: { error: vi.fn() },
    ...(options.sendBudgetMs ? { sendBudgetMs: options.sendBudgetMs } : {}),
    ...(options.heldLimits ? { heldLimits: options.heldLimits } : {}),
  });
  const worker = new SessionHeldDeliveryWorker({
    collaboration,
    sessions: sessionService,
    registry,
    readyFollowUpsMs: [],
    ...(options.now ? { now: options.now } : {}),
  });
  collaboration.setHeldListener((id) => worker.markHeld(id));
  const source: SessionCliSourceContext = {
    sessionId: senderSessionId,
    installationId,
    connectionInstanceId: instanceId,
    computerId,
    placementGeneration: 1,
  } as SessionCliSourceContext;
  const createChild = async () => {
    const created = await collaboration.create({ messageId: randomUUID(), message: "start" } as never, source);
    return created.sessionId as string;
  };
  const targetSessionId = await createChild();
  frames.length = 0;
  const send = (message: string, messageId = randomUUID()) =>
    collaboration.send({ messageId, targetSessionId, message }, source).then((result) => ({ ...result, messageId }));
  const row = async (id: string) => {
    const [found] = await db.database.select().from(sessionMessages).where(eq(sessionMessages.id, id));
    return found;
  };
  return {
    collaboration,
    computerId,
    createChild,
    frames,
    row,
    send,
    senderSessionId,
    source,
    state,
    targetSessionId,
    worker,
  };
}

describe("Server-held Session message delivery", () => {
  it("answers a send inside the window as accepted without marking custody", async () => {
    const s = await stack();
    s.state.answer = "client_busy";

    const sent = await s.send("during the upgrade");

    expect(sent).toMatchObject({ status: "accepted", sessionId: s.targetSessionId });
    expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "unknown", lastErrorCode: "delivery_held" });
  });

  it("delivers held messages in order, once, when the Client recovers", async () => {
    const s = await stack();
    s.state.answer = "client_busy";
    const first = await s.send("first");
    s.frames.length = 0;
    const second = await s.send("second");
    const third = await s.send("third");
    // An older held message sends later ones straight to the queue: no frame can overtake it.
    expect(s.frames).toEqual([]);

    s.state.answer = "accepted";
    s.worker.notifyComputerReady(s.computerId);
    await s.worker.flush(s.computerId);

    expect(s.frames.map((frame) => frame.content.text)).toEqual(["first", "second", "third"]);
    for (const sent of [first, second, third]) {
      expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "accepted", lastErrorCode: null });
    }
    await s.worker.flush(s.computerId);
    expect(s.frames).toHaveLength(3);
  });

  it("stops a target's batch at the first refusal so nothing overtakes it", async () => {
    const s = await stack();
    s.state.answer = "client_busy";
    await s.send("first");
    const second = await s.send("second");
    s.frames.length = 0;

    await s.worker.flush(s.computerId);

    expect(s.frames.map((frame) => frame.content.text)).toEqual(["first"]);
    expect(await s.row(second.messageId)).toMatchObject({ lastErrorCode: "delivery_held" });
  });

  it("holds through a lost connection and redelivers a message the Client may have taken", async () => {
    const s = await stack();
    s.state.answer = "throw";
    const sent = await s.send("lost mid-flight");
    expect(sent.status).toBe("accepted");
    await s.worker.flush(s.computerId);
    expect(await s.row(sent.messageId)).toMatchObject({ lastErrorCode: "delivery_held" });

    s.state.answer = "accepted";
    await s.worker.flush(s.computerId);
    expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "accepted" });
  });

  it("holds while no Client is connected and does not send frames until one returns", async () => {
    const s = await stack();
    s.state.connected = false;
    const sent = await s.send("offline");
    expect(sent.status).toBe("accepted");
    await s.worker.flush(s.computerId);
    expect(s.frames).toEqual([]);

    s.state.connected = true;
    s.worker.notifyComputerReady(s.computerId);
    await s.worker.flush(s.computerId);
    expect(s.frames.map((frame) => frame.content.text)).toEqual(["offline"]);
  });

  it("delivers through recovery without a reconnect on the fallback pass", async () => {
    let now = Date.now();
    const s = await stack({ now: () => now });
    s.state.answer = "session_recovery_required";
    const sent = await s.send("waits for recovery");
    expect(await s.row(sent.messageId)).toMatchObject({ lastErrorCode: "delivery_held" });

    s.state.answer = "accepted";
    now += 60_000;
    await s.worker.flush(s.computerId);
    expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "accepted" });
  });

  it("delivers to a target even after the sender restarted on a new connection", async () => {
    const s = await stack();
    s.state.answer = "client_busy";
    const sent = await s.send("before the restart");
    await db.database.update(computers).set({ currentInstanceId: randomUUID() }).where(eq(computers.id, s.computerId));

    s.state.answer = "accepted";
    await s.worker.flush(s.computerId);
    expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "accepted" });
  });

  it("does not hold a refusal from a Client older than the replay fix", async () => {
    const s = await stack({ recovery: false });
    s.state.answer = "client_busy";

    const sent = await s.send("old Client");

    expect(sent).toMatchObject({ status: "unreachable", code: "client_busy" });
    expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "unreachable", lastErrorCode: "client_busy" });
  });

  it("answers a send quickly when the Client stalls, and keeps it held across a stop", async () => {
    const s = await stack({ sendBudgetMs: 20 });
    let release = () => {};
    s.state.stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.state.answer = "stall";

    const sent = await s.send("stalled");

    expect(sent).toMatchObject({ status: "accepted" });
    expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "unknown", lastErrorCode: "delivery_held" });
    release();
    await vi.waitFor(async () => expect((await s.row(sent.messageId))?.lastOutcome).toBe("accepted"));
  });

  it("tells the sender when a stalled hand-off is finally rejected", async () => {
    const s = await stack({ sendBudgetMs: 20 });
    let release = () => {};
    s.state.stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.state.answer = "stall";
    s.state.afterStall = "target_mismatch";

    const sent = await s.send("rejected late");
    expect(sent.status).toBe("accepted");
    release();

    const noticeId = deliveryFailureNoticeMessageId(sent.messageId);
    await vi.waitFor(async () => {
      expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "rejected", lastErrorCode: "target_mismatch" });
      expect(await s.row(noticeId)).toMatchObject({ targetSessionId: s.senderSessionId });
    });
  });

  it("keeps a stalled message held when the sender's connection changes after accepted", async () => {
    const s = await stack({ sendBudgetMs: 20 });
    let release = () => {};
    s.state.stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.state.answer = "stall";
    const sent = await s.send("sender moves on");
    expect(sent.status).toBe("accepted");

    await db.database.update(computers).set({ currentInstanceId: randomUUID() }).where(eq(computers.id, s.computerId));
    release();

    await vi.waitFor(async () => expect((await s.row(sent.messageId))?.lastOutcome).toBe("accepted"));
    await expect(s.row(deliveryFailureNoticeMessageId(sent.messageId))).resolves.toBeUndefined();
  });

  it("does not redeliver a message while its first hand-off is still running", async () => {
    const s = await stack({ sendBudgetMs: 20 });
    let release = () => {};
    s.state.stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.state.answer = "stall";
    const sent = await s.send("single owner");
    const before = await s.row(sent.messageId);

    s.worker.notifyComputerReady(s.computerId);
    await s.worker.flush(s.computerId);
    expect((await s.row(sent.messageId))?.attemptCount).toBe(before?.attemptCount);

    release();
    await vi.waitFor(async () => expect((await s.row(sent.messageId))?.lastOutcome).toBe("accepted"));
    expect(s.frames.filter((frame) => frame.messageId === sent.messageId)).toHaveLength(1);
  });

  it("delivers to other targets when one target stays blocked behind more than a page", async () => {
    const s = await stack();
    const blocked = s.targetSessionId;
    const other = await s.createChild();
    const held = (targetSessionId: string, n: number) => ({
      id: randomUUID(),
      sourceSessionId: s.senderSessionId,
      targetSessionId,
      content: `message ${n}`,
      contentHash: "a".repeat(64),
      lastOutcome: "unknown" as const,
      lastErrorCode: "delivery_held",
      attemptCount: 1,
      lastAttemptAt: new Date(),
      createdAt: new Date(Date.now() - 60_000 + n),
    });
    const [low, high] = [blocked, other].sort();
    if (!low || !high) throw new Error("expected two targets");
    await db.database.insert(sessionMessages).values(Array.from({ length: 205 }, (_, n) => held(low, n)));
    await db.database.insert(sessionMessages).values(held(high, 0));
    s.frames.length = 0;
    s.state.answer = (frame) => (frame.targetSessionId === low ? "client_busy" : "accepted");

    await s.worker.flush(s.computerId);

    expect(s.frames.filter((frame) => frame.targetSessionId === low)).toHaveLength(1);
    expect(s.frames.filter((frame) => frame.targetSessionId === high)).toHaveLength(1);
  });

  it("carries provenance on redelivery, and an older Client refuses a held message of unknown origin", async () => {
    const insertHeld = async (s: Awaited<ReturnType<typeof stack>>, initiatorSessionId: string | null) => {
      const id = randomUUID();
      await db.database.insert(sessionMessages).values({
        id,
        sourceSessionId: s.senderSessionId,
        targetSessionId: s.targetSessionId,
        initiatorSessionId,
        forwardCount: 2,
        content: "held",
        contentHash: "a".repeat(64),
        lastOutcome: "unknown",
        lastErrorCode: "delivery_held",
        attemptCount: 1,
        lastAttemptAt: new Date(),
        createdAt: new Date(Date.now() - 60_000),
      });
      return id;
    };
    const current = await stack();
    await insertHeld(current, current.senderSessionId);
    current.frames.length = 0;
    await current.worker.flush(current.computerId);
    expect(current.frames).toHaveLength(1);
    expect(current.frames[0]).toMatchObject({
      provenance: { initiatorSessionId: current.senderSessionId, forwards: 2 },
    });

    const older = await stack({ collaborationVersion: 4 });
    const unknown = await insertHeld(older, null);
    older.frames.length = 0;
    await older.worker.flush(older.computerId);
    expect(older.frames).toEqual([]);
    expect(await older.row(unknown)).toMatchObject({
      lastOutcome: "unreachable",
      lastErrorCode: "unsupported_cross_conversation",
    });
  });

  it("delivers a target's messages in order across more than one page", async () => {
    const s = await stack();
    const rows = Array.from({ length: 205 }, (_, n) => ({
      id: randomUUID(),
      sourceSessionId: s.senderSessionId,
      targetSessionId: s.targetSessionId,
      content: `message ${n}`,
      contentHash: "a".repeat(64),
      lastOutcome: "unknown" as const,
      lastErrorCode: "delivery_held",
      attemptCount: 1,
      lastAttemptAt: new Date(),
      createdAt: new Date(Date.now() - 60_000 + n),
    }));
    await db.database.insert(sessionMessages).values(rows);
    s.frames.length = 0;

    await s.worker.flush(s.computerId);

    expect(s.frames.map((frame) => frame.content.text)).toEqual(rows.map((row) => row.content));
  });

  it("keeps a committed accepted when expiry acts on a stale held snapshot", async () => {
    const s = await stack();
    s.state.answer = "client_busy";
    const sent = await s.send("receipt wins");
    const service = new SessionService(db.database);
    const [snapshot] = await service.sweepHeldMessages(null, 10);
    if (!snapshot) throw new Error("expected a held message");

    await service.recordMessageOutcome({
      messageId: sent.messageId,
      attemptCount: snapshot.attemptCount,
      outcome: "accepted",
    });
    await s.collaboration.expireHeld(snapshot);

    expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "accepted", lastErrorCode: null });
    await expect(s.row(deliveryFailureNoticeMessageId(sent.messageId))).resolves.toBeUndefined();
  });

  it("expires an unchanged held snapshot and sends its notice", async () => {
    const s = await stack();
    s.state.answer = "client_busy";
    const sent = await s.send("nothing answered");
    const [snapshot] = await new SessionService(db.database).sweepHeldMessages(null, 10);
    if (!snapshot) throw new Error("expected a held message");

    await s.collaboration.expireHeld(snapshot);

    expect(await s.row(sent.messageId)).toMatchObject({
      lastOutcome: "unreachable",
      lastErrorCode: "delivery_expired",
    });
    expect(await s.row(deliveryFailureNoticeMessageId(sent.messageId))).toBeDefined();
  });

  it("waits to expire a message whose latest attempt may still answer", async () => {
    let now = Date.now();
    const s = await stack({ now: () => now });
    s.state.answer = "client_busy";
    const sent = await s.send("attempted just now");
    await db.database
      .update(sessionMessages)
      .set({ createdAt: new Date(now - SESSION_MESSAGE_HELD_TTL_MS - 1_000), lastAttemptAt: new Date(now - 1_000) })
      .where(eq(sessionMessages.id, sent.messageId));

    await s.worker.sweep();
    expect(await s.row(sent.messageId)).toMatchObject({ lastErrorCode: "delivery_held" });

    now += 2 * 60_000;
    await s.worker.sweep();
    expect(await s.row(sent.messageId)).toMatchObject({ lastErrorCode: "delivery_expired" });
  });

  it("sweeps past a row it cannot settle and reads each page once", async () => {
    const now = Date.now();
    const row = (n: number) => ({
      id: `id-${n}`,
      createdAt: new Date(now - SESSION_MESSAGE_HELD_TTL_MS - 1_000 + n),
      lastAttemptAt: new Date(now - SESSION_MESSAGE_HELD_TTL_MS),
      computerId: "computer",
    });
    const pages = [Array.from({ length: 100 }, (_, n) => row(n)), [row(100)]];
    const sweepHeldMessages = vi.fn(async () => pages.shift() ?? []);
    const expireHeld = vi.fn(async () => undefined);
    const worker = new SessionHeldDeliveryWorker({
      collaboration: { expireHeld, redeliverHeld: vi.fn() } as never,
      sessions: { sweepHeldMessages, listHeldTargetsForComputer: vi.fn(async () => []) } as never,
      registry: { currentInstanceId: () => undefined },
      now: () => now,
    });

    await worker.sweep();

    expect(sweepHeldMessages).toHaveBeenCalledTimes(2);
    expect(sweepHeldMessages.mock.calls[0]).toEqual([null, 100]);
    expect(sweepHeldMessages.mock.calls[1]).toEqual([{ createdAt: row(99).createdAt, id: "id-99" }, 100]);
    expect(expireHeld).toHaveBeenCalledTimes(101);
  });

  it("does not spin on a held message whose answer loses its fence", async () => {
    const s = await stack();
    s.state.answer = "client_busy";
    const sent = await s.send("fenced");
    const redeliverHeld = vi.fn(async () => "settled" as const);
    const worker = new SessionHeldDeliveryWorker({
      collaboration: { expireHeld: vi.fn(), redeliverHeld } as never,
      sessions: new SessionService(db.database),
      registry: { currentInstanceId: () => "instance" },
    });

    await worker.flush(s.computerId);

    expect(redeliverHeld).toHaveBeenCalledTimes(1);
    expect((await s.row(sent.messageId))?.lastErrorCode).toBe("delivery_held");
  });

  it("holds a background Run outcome notice and answers notified once it is delivered", async () => {
    const s = await stack();
    const reported = await s.send("the Run that fails");
    const report = {
      childSessionId: s.targetSessionId,
      messageId: reported.messageId,
      outcome: "failed" as const,
      reason: "provider_error",
      source: {
        computerId: s.computerId,
        connectionInstanceId: s.source.connectionInstanceId,
        placementGeneration: 1,
      },
    };
    const noticeId = runOutcomeNoticeMessageId(s.targetSessionId, reported.messageId);
    s.state.answer = "client_busy";

    await expect(s.collaboration.notifyRunOutcomeInBackground(report)).resolves.toBe("retry");
    await vi.waitFor(async () => expect((await s.row(noticeId))?.lastErrorCode).toBe("delivery_held"));

    s.state.answer = "accepted";
    await vi.waitFor(async () => {
      await s.worker.flush(s.computerId);
      expect((await s.row(noticeId))?.lastOutcome).toBe("accepted");
    });
    await expect(s.collaboration.notifyRunOutcomeInBackground(report)).resolves.toBe("notified");
    await s.collaboration.close();
  });

  it("sends no delivery notice when a held Run outcome notice expires", async () => {
    const s = await stack();
    const reported = await s.send("the Run that fails");
    s.state.answer = "client_busy";
    await s.collaboration.notifyRunOutcome({
      childSessionId: s.targetSessionId,
      messageId: reported.messageId,
      outcome: "failed",
      reason: "provider_error",
      source: { computerId: s.computerId, connectionInstanceId: s.source.connectionInstanceId, placementGeneration: 1 },
    });
    const noticeId = runOutcomeNoticeMessageId(s.targetSessionId, reported.messageId);
    const [snapshot] = (await new SessionService(db.database).sweepHeldMessages(null, 10)).filter(
      (m) => m.id === noticeId,
    );
    if (!snapshot) throw new Error("expected the held notice");

    await s.collaboration.expireHeld(snapshot);

    expect(await s.row(noticeId)).toMatchObject({ lastOutcome: "unreachable", lastErrorCode: "delivery_expired" });
    await expect(s.row(deliveryFailureNoticeMessageId(noticeId))).resolves.toBeUndefined();
  });

  it("does not report a failed Run of a delivery notice back to the failed target", async () => {
    const s = await stack();
    s.state.answer = "client_busy";
    const sent = await s.send("never delivered");
    const service = new SessionService(db.database);
    const [snapshot] = await service.sweepHeldMessages(null, 10);
    if (!snapshot) throw new Error("expected a held message");
    await s.collaboration.expireHeld(snapshot);
    const noticeId = deliveryFailureNoticeMessageId(sent.messageId);
    expect(await s.row(noticeId)).toMatchObject({ targetSessionId: s.senderSessionId });

    await expect(
      service.resolveRunOutcomeNotice({ childSessionId: s.senderSessionId, messageId: noticeId }),
    ).resolves.toBeUndefined();
  });

  describe("when the target is stopped", () => {
    async function stoppable() {
      const s = await stack({ sendBudgetMs: 20 });
      const siblingId = await s.createChild();
      const fromSibling = { ...s.source, sessionId: siblingId } as SessionCliSourceContext;
      const sendFromSibling = (message: string) => {
        const messageId = randomUUID();
        return s.collaboration
          .send({ messageId, targetSessionId: s.targetSessionId, message }, fromSibling)
          .then((result) => ({ ...result, messageId }));
      };
      return { ...s, siblingId, sendFromSibling };
    }

    it("settles held messages at the stop and tells only the other senders", async () => {
      const s = await stoppable();
      s.state.answer = "client_busy";
      const own = await s.send("from the stopper");
      const other = await s.sendFromSibling("from a sibling");
      expect(other.status).toBe("accepted");

      await expect(s.collaboration.stop({ targetSessionId: s.targetSessionId }, s.source)).resolves.toMatchObject({
        status: "stopped",
      });

      for (const { messageId } of [own, other]) {
        expect(await s.row(messageId)).toMatchObject({ lastOutcome: "rejected", lastErrorCode: "target_stopped" });
      }
      await expect(s.row(deliveryFailureNoticeMessageId(own.messageId))).resolves.toBeUndefined();
      const notice = await s.row(deliveryFailureNoticeMessageId(other.messageId));
      expect(notice).toMatchObject({ targetSessionId: s.siblingId, sourceSessionId: s.targetSessionId });
      expect(notice?.content).toContain("do not send it again");
      expect(notice?.content).not.toContain("session send");
    });

    it("settles a stopped descendant's held messages and tells only senders outside the stop", async () => {
      const s = await stoppable();
      const childSource = { ...s.source, sessionId: s.targetSessionId } as SessionCliSourceContext;
      const created = await s.collaboration.create(
        { messageId: randomUUID(), message: "grandchild" } as never,
        childSource,
      );
      const grandchildId = created.sessionId as string;
      const sendTo = (source: SessionCliSourceContext) => {
        const messageId = randomUUID();
        return s.collaboration
          .send({ messageId, targetSessionId: grandchildId, message: "to the grandchild" }, source)
          .then((result) => ({ ...result, messageId }));
      };
      s.state.answer = "client_busy";
      const fromStopper = await sendTo(s.source);
      const fromStopped = await sendTo(childSource);
      const fromOutside = await sendTo({ ...s.source, sessionId: s.siblingId } as SessionCliSourceContext);

      await expect(s.collaboration.stop({ targetSessionId: s.targetSessionId }, s.source)).resolves.toMatchObject({
        status: "stopped",
        stoppedDescendantCount: 1,
      });

      for (const { messageId } of [fromStopper, fromStopped, fromOutside]) {
        expect(await s.row(messageId)).toMatchObject({ lastOutcome: "rejected", lastErrorCode: "target_stopped" });
      }
      await expect(s.row(deliveryFailureNoticeMessageId(fromStopper.messageId))).resolves.toBeUndefined();
      await expect(s.row(deliveryFailureNoticeMessageId(fromStopped.messageId))).resolves.toBeUndefined();
      expect(await s.row(deliveryFailureNoticeMessageId(fromOutside.messageId))).toMatchObject({
        sourceSessionId: grandchildId,
        targetSessionId: s.siblingId,
      });
    });

    it("delivers the notice to the other sender and leaves nothing to expire", async () => {
      const s = await stoppable();
      s.state.answer = "client_busy";
      const other = await s.sendFromSibling("from a sibling");
      await s.collaboration.stop({ targetSessionId: s.targetSessionId }, s.source);
      s.state.answer = "accepted";

      await s.worker.flush(s.computerId);

      await vi.waitFor(async () =>
        expect(await s.row(deliveryFailureNoticeMessageId(other.messageId))).toMatchObject({ lastOutcome: "accepted" }),
      );
      const held = await new SessionService(db.database).sweepHeldMessages(null, 10);
      expect(held).toEqual([]);
    });

    it("does not let a hand-off in flight overwrite the stop", async () => {
      const s = await stoppable();
      let release = () => {};
      s.state.stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      s.state.answer = "stall";
      const sent = await s.send("in flight");
      expect(sent.status).toBe("accepted");

      await s.collaboration.stop({ targetSessionId: s.targetSessionId }, s.source);
      release();

      // Its final admission now finds the target ended, so no frame leaves and its write loses the fence.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(s.frames.filter((frame) => frame.messageId === sent.messageId)).toEqual([]);
      expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "rejected", lastErrorCode: "target_stopped" });
    });

    it("turns off the Session's schedule and settles its held occurrence in one stop", async () => {
      const s = await stoppable();
      const scheduleId = randomUUID();
      const messageId = randomUUID();
      const scheduledFor = new Date().toISOString();
      const [target] = await db.database.select().from(sessions).where(eq(sessions.id, s.targetSessionId));
      if (!target?.imBindingId) throw new Error("expected a bound target");
      const [binding] = await db.database.select().from(imBindings).where(eq(imBindings.id, target.imBindingId));
      await db.database.insert(agentSchedules).values({
        id: scheduleId,
        agentId: binding?.agentId as string,
        targetSessionId: s.targetSessionId,
        name: "self check",
        prompt: "check",
        schedule: { kind: "every", intervalSeconds: 3600, anchorAt: scheduledFor },
        timezone: "UTC",
        enabled: true,
        nextTriggerAt: new Date(Date.now() + 3_600_000),
        revision: 1,
        lastDispatch: { scheduledFor, attemptedAt: scheduledFor, messageId, outcome: "unknown", code: "delivery_held" },
      });
      await db.database.insert(sessionMessages).values({
        id: messageId,
        scheduledOrigin: { scheduleId, scheduledFor, timezone: "UTC", name: "self check" },
        targetSessionId: s.targetSessionId,
        content: "check",
        contentHash: "a".repeat(64),
        lastOutcome: "unknown",
        lastErrorCode: "delivery_held",
        attemptCount: 1,
        lastAttemptAt: new Date(),
      });

      await s.collaboration.stop({ targetSessionId: s.targetSessionId }, s.source);

      expect(await s.row(messageId)).toMatchObject({ lastOutcome: "rejected", lastErrorCode: "target_stopped" });
      const [schedule] = await db.database.select().from(agentSchedules).where(eq(agentSchedules.id, scheduleId));
      expect(schedule).toMatchObject({ enabled: false, nextTriggerAt: null });
      expect(schedule?.lastDispatch).toMatchObject({ messageId, outcome: "rejected", code: "target_stopped" });
      await expect(s.row(deliveryFailureNoticeMessageId(messageId))).resolves.toBeUndefined();
    });

    it("sweeps a held message whose target ended without a stop", async () => {
      const s = await stoppable();
      s.state.answer = "client_busy";
      const sent = await s.send("target ended elsewhere");
      await db.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, s.targetSessionId));
      await db.database
        .update(sessionMessages)
        .set({ lastAttemptAt: new Date(Date.now() - 3 * 60_000) })
        .where(eq(sessionMessages.id, sent.messageId));

      await s.worker.sweep();

      expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "rejected", lastErrorCode: "target_stopped" });
      expect(await s.row(deliveryFailureNoticeMessageId(sent.messageId))).toBeDefined();
    });
  });

  describe("when the hold is full (D9)", () => {
    it("answers the sender directly once a target holds its limit", async () => {
      const s = await stack({ heldLimits: { perTarget: 2, perComputer: 10 } });
      s.state.answer = "client_busy";
      const first = await s.send("one");
      const second = await s.send("two");
      const third = await s.send("three");

      expect([first.status, second.status]).toEqual(["accepted", "accepted"]);
      expect(third).toMatchObject({ status: "unreachable", code: "delivery_held_full" });
      expect(await s.row(third.messageId)).toMatchObject({
        lastOutcome: "unreachable",
        lastErrorCode: "delivery_held_full",
      });
      await expect(s.row(deliveryFailureNoticeMessageId(third.messageId))).resolves.toBeUndefined();
    });

    it("applies the Computer limit across targets", async () => {
      const s = await stack({ heldLimits: { perTarget: 10, perComputer: 2 } });
      const other = await s.createChild();
      s.state.answer = "client_busy";
      await s.send("one");
      await s.send("two");
      const messageId = randomUUID();
      const third = await s.collaboration.send({ messageId, targetSessionId: other, message: "three" }, s.source);

      expect(third).toMatchObject({ status: "unreachable", code: "delivery_held_full" });
    });

    it("keeps a slow hand-off held when it holds the last place itself", async () => {
      const s = await stack({ sendBudgetMs: 20, heldLimits: { perTarget: 1, perComputer: 1 } });
      let release = () => {};
      s.state.stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      s.state.answer = "stall";
      s.state.afterStall = "client_busy";
      const sent = await s.send("only one");
      expect(sent.status).toBe("accepted");
      expect(await s.row(sent.messageId)).toMatchObject({ lastErrorCode: "delivery_held" });

      release();

      await vi.waitFor(() => expect(s.frames.some((frame) => frame.messageId === sent.messageId)).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "unknown", lastErrorCode: "delivery_held" });
      await expect(s.row(deliveryFailureNoticeMessageId(sent.messageId))).resolves.toBeUndefined();
    });

    it("tells the sender when a hand-off it was told was accepted finds the hold full", async () => {
      const s = await stack({ sendBudgetMs: 20, heldLimits: { perTarget: 1, perComputer: 10 } });
      let release = () => {};
      s.state.stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      s.state.answer = "stall";
      s.state.afterStall = "client_busy";
      const sent = await s.send("late");
      expect(sent.status).toBe("accepted");
      await db.database.insert(sessionMessages).values({
        id: randomUUID(),
        sourceSessionId: s.senderSessionId,
        targetSessionId: s.targetSessionId,
        content: "already held",
        contentHash: "a".repeat(64),
        lastOutcome: "unknown",
        lastErrorCode: "delivery_held",
        attemptCount: 1,
        lastAttemptAt: new Date(),
        createdAt: new Date(Date.now() - 1_000),
      });

      release();

      await vi.waitFor(async () => {
        expect(await s.row(sent.messageId)).toMatchObject({
          lastOutcome: "unreachable",
          lastErrorCode: "delivery_held_full",
        });
        expect(await s.row(deliveryFailureNoticeMessageId(sent.messageId))).toMatchObject({
          targetSessionId: s.senderSessionId,
        });
      });
    });
  });

  it("still answers a permanent rejection on the first attempt", async () => {
    const s = await stack();
    s.state.answer = "target_mismatch";
    await expect(s.send("rejected")).resolves.toMatchObject({ status: "rejected", code: "target_mismatch" });
  });

  it("expires a held message after the TTL and tells the sender with one notice", async () => {
    let now = Date.now();
    const s = await stack({ now: () => now });
    s.state.answer = "client_busy";
    const sent = await s.send("too late");
    s.frames.length = 0;

    now += SESSION_MESSAGE_HELD_TTL_MS + 1_000;
    await s.worker.sweep();
    await s.worker.sweep();

    expect(await s.row(sent.messageId)).toMatchObject({
      lastOutcome: "unreachable",
      lastErrorCode: "delivery_expired",
    });
    const noticeId = deliveryFailureNoticeMessageId(sent.messageId);
    expect(await s.row(noticeId)).toMatchObject({
      sourceSessionId: s.targetSessionId,
      targetSessionId: s.senderSessionId,
    });
    expect((await s.row(noticeId))?.content.startsWith(SESSION_DELIVERY_FAILURE_NOTICE_HEADER)).toBe(true);
    expect((await s.row(noticeId))?.content).toContain(sent.messageId);
    const toTarget = await db.database
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.targetSessionId, s.senderSessionId));
    expect(toTarget).toHaveLength(1);
  });

  it("delivers the failure notice to the sender and never answers a failed notice with another", async () => {
    let now = Date.now();
    const s = await stack({ now: () => now });
    s.state.answer = "client_busy";
    const sent = await s.send("too late");

    now += SESSION_MESSAGE_HELD_TTL_MS + 1_000;
    s.state.answer = (frame) => (frame.targetSessionId === s.senderSessionId ? "accepted" : "client_busy");
    await s.worker.sweep();
    // The notice is new, so back on the current clock it is well inside its own TTL.
    now = Date.now();
    const noticeId = deliveryFailureNoticeMessageId(sent.messageId);
    await vi.waitFor(async () => {
      await s.worker.flush(s.computerId);
      expect(await s.row(noticeId)).toMatchObject({ lastOutcome: "accepted" });
    });

    // A second failed message whose notice is itself refused for good stays one row.
    s.state.answer = "client_busy";
    const failed = await s.send("rejected on redelivery");
    s.state.answer = "target_mismatch";
    await s.worker.flush(s.computerId);
    const secondNotice = deliveryFailureNoticeMessageId(failed.messageId);
    expect(await s.row(failed.messageId)).toMatchObject({ lastOutcome: "rejected", lastErrorCode: "target_mismatch" });
    await vi.waitFor(async () => {
      await s.worker.flush(s.computerId);
      expect(await s.row(secondNotice)).toMatchObject({ lastOutcome: "rejected" });
    });
    const all = await db.database.select().from(sessionMessages).orderBy(asc(sessionMessages.createdAt));
    expect(all.filter((m) => m.content.startsWith(SESSION_DELIVERY_FAILURE_NOTICE_HEADER))).toHaveLength(2);
  });

  it("leaves a redelivery attempt held if the Server stops before writing its answer", async () => {
    const s = await stack();
    s.state.answer = "client_busy";
    const sent = await s.send("crash window");
    const service = new SessionService(db.database);
    const before = await s.row(sent.messageId);

    await expect(service.beginHeldAttempt(sent.messageId, before?.attemptCount ?? 0)).resolves.toBe(
      (before?.attemptCount ?? 0) + 1,
    );
    await expect(service.beginHeldAttempt(sent.messageId, before?.attemptCount ?? 0)).resolves.toBeUndefined();

    s.state.answer = "accepted";
    await s.worker.flush(s.computerId);
    expect(await s.row(sent.messageId)).toMatchObject({ lastOutcome: "accepted" });
  });

  it("reaches held messages after a Server restart through the sweep", async () => {
    const s = await stack();
    s.state.answer = "client_busy";
    const sent = await s.send("across a restart");
    const restarted = new SessionHeldDeliveryWorker({
      collaboration: s.collaboration,
      sessions: new SessionService(db.database),
      registry: { currentInstanceId: () => "instance" },
      fallbackIntervalMs: 60_000,
    });
    s.state.answer = "accepted";

    await restarted.sweep();
    await vi.waitFor(async () => expect((await s.row(sent.messageId))?.lastOutcome).toBe("accepted"));
    await restarted.stop();
  });
});
