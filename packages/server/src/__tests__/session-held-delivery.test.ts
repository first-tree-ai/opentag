import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  SESSION_DELIVERY_FAILURE_NOTICE_HEADER,
  type SessionMessageDeliveryRequest,
} from "@opentag/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
import { SessionService } from "../services/sessions/session-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let db: UnitDatabase;

beforeAll(async () => {
  db = await createUnitDatabase();
}, 60_000);
afterAll(async () => db.close());
beforeEach(async () => db.reset());

type Answer = "accepted" | "client_busy" | "session_recovery_required" | "target_mismatch" | "throw" | "stall";

async function stack(options: { recovery?: boolean; now?: () => number; sendBudgetMs?: number } = {}) {
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
    capabilityVersion: vi.fn(() => 2),
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
  return { collaboration, computerId, createChild, frames, row, send, senderSessionId, state, targetSessionId, worker };
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
