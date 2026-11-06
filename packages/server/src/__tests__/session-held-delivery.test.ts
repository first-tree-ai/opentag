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
  const created = await collaboration.create({ messageId: randomUUID(), message: "start" } as never, source);
  const targetSessionId = created.sessionId as string;
  frames.length = 0;
  const send = (message: string, messageId = randomUUID()) =>
    collaboration.send({ messageId, targetSessionId, message }, source).then((result) => ({ ...result, messageId }));
  const row = async (id: string) => {
    const [found] = await db.database.select().from(sessionMessages).where(eq(sessionMessages.id, id));
    return found;
  };
  return { collaboration, computerId, frames, row, send, senderSessionId, state, targetSessionId, worker };
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
