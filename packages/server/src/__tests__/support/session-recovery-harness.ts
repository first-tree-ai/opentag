import { randomUUID } from "node:crypto";
import { computeDirectInputHash, type SessionReconcileRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DatabaseClient } from "../../db/client.js";
import { computers, imMessageDeliveries, sessionPlacements, sessions } from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { SessionRecoveryService } from "../../runtime/session-recovery.js";
import { createFixture } from "../integration/im-recovery-locks-fixture.js";

/** An accepted, unreported IM Turn whose Client then restarted under a new connection instance. */
export async function restartedTurn(database: DatabaseClient, capable = { current: true }) {
  const f = await createFixture(database);
  const custody = new PostgresRuntimeCustodyStore(database);
  const inputHash = computeDirectInputHash(f.rootRequest);
  expect(await custody.beginDeliveryDispatch(f.rootRequest, inputHash, f.dispatchContext)).toBe("dispatched");
  expect(await custody.acceptDelivery(f.rootRequest, inputHash, f.rootTurnId, f.context)).toBe("accepted");
  const instanceId = randomUUID();
  await database.update(computers).set({ currentInstanceId: instanceId }).where(eq(computers.id, f.context.computerId));
  const context = { ...f.context, instanceId };
  const requestReconcile = vi.fn(
    async (_computerId: string, _instanceId: string, request: SessionReconcileRequest, _admission?: unknown) => ({
      type: "session:reconcile:result" as const,
      requestId: request.requestId,
      sessionId: request.sessionId,
      placementGeneration: request.placementGeneration,
      status: "ready" as const,
    }),
  );
  const assembler = { assembleForSession: vi.fn(async () => f.runtime) };
  const service = new SessionRecoveryService({
    assembler,
    database,
    registry: { canReceiveSnapshot: () => true, supportsCapability: () => capable.current },
    requestReconcile,
  });
  const frame = {
    type: "session:recover" as const,
    requestId: randomUUID(),
    sessionId: f.sessionId,
    agentId: f.agentId,
    placementGeneration: 1,
    deliveryId: f.rootDeliveryId,
    turnId: f.rootTurnId,
  };
  const owner = async () => {
    const [row] = await database
      .select({ owner: imMessageDeliveries.reportOwnerInstanceId })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, f.rootDeliveryId));
    return row?.owner;
  };
  return { database, custody, f, context, service, frame, requestReconcile, assembler, owner };
}

/** A second accepted Turn of the same Agent, in its own Session, frozen on another Agent revision (newer by default). */
export async function acceptNewerTurn(h: Awaited<ReturnType<typeof restartedTurn>>, agentRevision = 2) {
  const sessionId = randomUUID();
  await h.database.insert(sessions).values({
    id: sessionId,
    imBindingId: h.f.bindingId,
    channelId: "channel-newer",
    conversationKind: "channel",
    kind: "channel",
  });
  await h.database.insert(sessionPlacements).values({ sessionId, computerId: h.context.computerId, generation: 1 });
  const [follow] = h.f.steerRequests;
  await h.database.update(imMessageDeliveries).set({ sessionId }).where(eq(imMessageDeliveries.id, follow.deliveryId));
  const request = {
    ...h.f.rootRequest,
    requestId: randomUUID(),
    deliveryId: follow.deliveryId,
    imMessageId: follow.imMessageId,
    sessionId,
    runtime: {
      ...h.f.runtime,
      revision: { ...h.f.runtime.revision, agent: { sequence: agentRevision, id: `agent-revision-${agentRevision}` } },
    },
  };
  const hash = computeDirectInputHash(request);
  expect(await h.custody.beginDeliveryDispatch(request, hash, h.f.dispatchContext)).toBe("dispatched");
  expect(await h.custody.acceptDelivery(request, hash, "turn-newer", h.f.context)).toBe("accepted");
  return {
    ...h.frame,
    requestId: randomUUID(),
    sessionId,
    deliveryId: follow.deliveryId,
    turnId: "turn-newer",
  };
}
