import { randomUUID } from "node:crypto";
import {
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type SessionReconcileRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { RuntimeDomainConflictError, RuntimeDomainOwner } from "../runtime/runtime-domain-owner.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";

describe("RuntimeDomainOwner", () => {
  it("B-19 joins identical requests and rejects a reused request ID with different payload", async () => {
    const fixture = await ownerFixture();
    const request = reconcileRequest(fixture.computerId);
    const first = fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, request);
    const duplicate = fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, structuredClone(request));
    expect(duplicate).toBe(first);
    expect(fixture.frames).toEqual([request]);

    expect(() =>
      fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, {
        ...request,
        sessionId: "session-conflict",
      }),
    ).toThrow(RuntimeDomainConflictError);
    await fixture.owner.handle(
      {
        type: "session:reconcile:result",
        requestId: request.requestId,
        sessionId: request.sessionId,
        placementGeneration: 1,
        status: "ready",
      },
      fixture.context,
    );
    await expect(first).resolves.toMatchObject({ status: "ready" });
    await expect(
      fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, structuredClone(request)),
    ).resolves.toMatchObject({ status: "ready" });
    expect(fixture.frames).toEqual([request]);
    expect(() =>
      fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, {
        ...request,
        sessionId: "session-conflict-after-completion",
      }),
    ).toThrow(RuntimeDomainConflictError);
  });

  it("B-20 records one stable accepted delivery across an explicit retry", async () => {
    const fixture = await ownerFixture();
    const request = deliveryRequest();
    const first = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, request);
    await fixture.owner.handle(acceptedResult(request), fixture.context);
    await expect(first).resolves.toMatchObject({ status: "accepted", turnId: "turn-1" });

    const retry = { ...request, requestId: randomUUID() };
    const retried = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, retry);
    await fixture.owner.handle(acceptedResult(retry), fixture.context);
    await expect(retried).resolves.toMatchObject({ status: "accepted", turnId: "turn-1" });
    expect(fixture.owner.getDelivery("delivery-1")).toMatchObject({ turnId: "turn-1" });
    expect(() =>
      fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, {
        ...request,
        requestId: randomUUID(),
        content: { kind: "text", text: "different" },
      }),
    ).toThrow(RuntimeDomainConflictError);
  });

  it("B-21 records a report only after acceptance and makes equal duplicates idempotent", async () => {
    const fixture = await ownerFixture();
    const request = deliveryRequest();
    const report = turnReport();

    await expect(fixture.owner.handle(report, fixture.context)).resolves.toMatchObject({ status: "conflict" });
    const delivery = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, request);
    await fixture.owner.handle(acceptedResult(request), fixture.context);
    await delivery;
    await expect(fixture.owner.handle(report, fixture.context)).resolves.toMatchObject({ status: "recorded" });
    await expect(fixture.owner.handle({ ...report, requestId: randomUUID() }, fixture.context)).resolves.toMatchObject({
      status: "already_recorded",
    });

    const conflictingBody = { ...report, finalText: "different" };
    const conflicting = {
      ...conflictingBody,
      requestId: randomUUID(),
      resultHash: computeTurnResultHash(conflictingBody),
    };
    await expect(fixture.owner.handle(conflicting, fixture.context)).resolves.toMatchObject({ status: "conflict" });
    expect(fixture.owner.getTurn("turn-1")?.report.finalText).toBe("done");
  });

  it("B-22 ignores frames from a replaced instance and accepts the current instance", async () => {
    const fixture = await ownerFixture();
    const oldRequest = reconcileRequest(fixture.computerId);
    const oldPending = fixture.owner
      .requestReconcile(fixture.computerId, fixture.instanceId, oldRequest)
      .catch((error: unknown) => error);
    const nextInstanceId = randomUUID();
    const nextSocket = socketFixture([]);
    await fixture.registry.register(
      {
        computerId: fixture.computerId,
        instanceId: nextInstanceId,
        lastHeartbeatAt: 2,
        socket: nextSocket,
        userId: fixture.context.userId,
      },
      async () => undefined,
    );

    await fixture.owner.handle(
      {
        type: "session:reconcile:result",
        requestId: oldRequest.requestId,
        sessionId: oldRequest.sessionId,
        placementGeneration: 1,
        status: "ready",
      },
      fixture.context,
    );
    const nextContext = { ...fixture.context, instanceId: nextInstanceId };
    const nextRequest = { ...oldRequest, requestId: randomUUID() };
    const current = fixture.owner.requestReconcile(fixture.computerId, nextInstanceId, nextRequest);
    await fixture.owner.handle(
      {
        type: "session:reconcile:result",
        requestId: nextRequest.requestId,
        sessionId: nextRequest.sessionId,
        placementGeneration: 1,
        status: "ready",
      },
      nextContext,
    );
    await expect(current).resolves.toMatchObject({ status: "ready" });
    fixture.owner.close();
    await expect(oldPending).resolves.toBeInstanceOf(Error);
  });

  it("keeps a timed-out delivery correlation long enough to accept a late custody result", async () => {
    vi.useFakeTimers();
    const fixture = await ownerFixture(10);
    try {
      const request = deliveryRequest();
      const timedOut = fixture.owner
        .requestDelivery(fixture.computerId, fixture.instanceId, request)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      await expect(timedOut).resolves.toBeInstanceOf(Error);

      await fixture.owner.handle(acceptedResult(request), fixture.context);
      expect(fixture.owner.getDelivery(request.deliveryId)).toMatchObject({ turnId: "turn-1" });
      await expect(fixture.owner.handle(turnReport(), fixture.context)).resolves.toMatchObject({ status: "recorded" });
    } finally {
      fixture.owner.close();
      vi.useRealTimers();
    }
  });

  it("drops transient scheduler failures and serializes acceptance with its report by delivery", async () => {
    const fixture = await ownerFixture();
    const request = deliveryRequest();
    const report = turnReport();
    const pending = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, request);
    await expect(fixture.owner.handle(report, fixture.context)).resolves.toBeUndefined();

    const business = fixture.owner.businessOptions();
    expect(business.failureResult(report as never)).toBeUndefined();
    expect(business.overloadResult(report as never)).toBeUndefined();
    expect(business.laneKey(acceptedResult(request) as never)).toBe(`delivery:${request.deliveryId}`);
    expect(business.laneKey(report as never)).toBe(`delivery:${request.deliveryId}`);

    await fixture.owner.handle(acceptedResult(request), fixture.context);
    await pending;
    await expect(fixture.owner.handle(report, fixture.context)).resolves.toMatchObject({ status: "recorded" });
  });

  it("accepts a durable reporting recovery claimed by reconciliation", async () => {
    const fixture = await ownerFixture();
    const request = reconcileRequest(fixture.computerId);
    const pending = fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, request);
    await fixture.owner.handle(
      {
        type: "session:reconcile:result",
        requestId: request.requestId,
        sessionId: request.sessionId,
        placementGeneration: request.placementGeneration,
        status: "recovery_required",
        reason: "unresolved_turn",
        turn: { deliveryId: "delivery-1", turnId: "turn-1" },
      },
      fixture.context,
    );
    await expect(pending).resolves.toMatchObject({ status: "recovery_required" });
    await expect(fixture.owner.handle(turnReport(), fixture.context)).resolves.toMatchObject({ status: "recorded" });
  });
});

async function ownerFixture(requestTimeoutMs = 1_000) {
  const registry = new ConnectionRegistry();
  const computerId = randomUUID();
  const instanceId = randomUUID();
  const userId = randomUUID();
  const frames: unknown[] = [];
  await registry.register(
    {
      computerId,
      instanceId,
      lastHeartbeatAt: 1,
      socket: socketFixture(frames),
      userId,
    },
    async () => undefined,
  );
  const owner = new RuntimeDomainOwner(registry, { requestTimeoutMs });
  const context: RuntimeBusinessContext = {
    computerId,
    instanceId,
    signal: new AbortController().signal,
    userId,
  };
  return { computerId, context, frames, instanceId, owner, registry };
}

function socketFixture(frames: unknown[]): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn((serialized: string, callback: (error?: Error) => void) => {
      frames.push(JSON.parse(serialized));
      callback();
    }),
  } as unknown as WebSocket;
}

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-1",
    provider: "codex",
    instructions: { platform: "platform", agent: "agent", session: "session" },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

function reconcileRequest(computerId: string): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime: snapshot(),
  };
}

function deliveryRequest(): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: "delivery-1",
    imMessageId: "message-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "hello" },
    runtime: snapshot(),
  };
}

function acceptedResult(request: DirectImMessageDeliveryRequest) {
  return {
    type: "im:deliver:result" as const,
    requestId: request.requestId,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    status: "accepted" as const,
    turnId: "turn-1",
  };
}

function turnReport(): TurnReportRequest {
  const body = {
    deliveryId: "delivery-1",
    turnId: "turn-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "done",
    usage: { inputTokens: 1, outputTokens: 1 },
    traceSummary: { lastSequence: 2, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
