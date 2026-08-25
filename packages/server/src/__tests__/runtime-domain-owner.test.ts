import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type SessionMessageDeliveryRequest,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  type TurnReportRequest,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import type {
  AcceptedDeliveryRecord,
  DeliveryDispatchStatus,
  RecordedTurnRecord,
  RuntimeCustodyStore,
} from "../runtime/runtime-custody-store.js";
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
    await waitForDeliveryFrame(fixture.frames, request.requestId);
    await fixture.owner.handle(acceptedResult(request), fixture.context);
    await expect(first).resolves.toMatchObject({ status: "accepted", turnId: "turn-1" });

    const retry = structuredClone(request);
    const retried = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, retry);
    await fixture.owner.handle(acceptedResult(retry), fixture.context);
    await expect(retried).resolves.toMatchObject({ status: "accepted", turnId: "turn-1" });
    expect(await fixture.owner.getDelivery("delivery-1")).toMatchObject({ turnId: "turn-1" });
    const conflictRequest = {
      ...request,
      content: { ...request.content, text: "different" },
    };
    expect(() => fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, conflictRequest)).toThrow(
      RuntimeDomainConflictError,
    );
  });

  it("B-21 records a report only after acceptance and makes equal duplicates idempotent", async () => {
    const fixture = await ownerFixture();
    const request = deliveryRequest();
    const report = turnReport();

    await expect(fixture.owner.handle(report, fixture.context)).resolves.toBeUndefined();
    const reconcile = reconcileRequest(fixture.computerId);
    const reconciled = fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, reconcile);
    await fixture.owner.handle(
      {
        type: "session:reconcile:result",
        requestId: reconcile.requestId,
        sessionId: reconcile.sessionId,
        placementGeneration: reconcile.placementGeneration,
        status: "ready",
      },
      fixture.context,
    );
    await reconciled;
    await expect(fixture.owner.handle(report, fixture.context)).resolves.toBeUndefined();
    const delivery = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, request);
    await waitForDeliveryFrame(fixture.frames, request.requestId);
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
    expect((await fixture.owner.getTurn("turn-1"))?.report.finalText).toBe("done");
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
      await waitForDeliveryFrame(fixture.frames, request.requestId);
      await vi.advanceTimersByTimeAsync(10);
      await expect(timedOut).resolves.toBeInstanceOf(Error);

      await fixture.owner.handle(acceptedResult(request), fixture.context);
      expect(await fixture.owner.getDelivery(request.deliveryId)).toMatchObject({ turnId: "turn-1" });
      await expect(fixture.owner.handle(turnReport(), fixture.context)).resolves.toMatchObject({ status: "recorded" });
    } finally {
      fixture.owner.close();
      vi.useRealTimers();
    }
  });

  it("uses a report to promote an expired delivery attempt without an external redelivery", async () => {
    vi.useFakeTimers();
    const fixture = await ownerFixture(10);
    try {
      const request = deliveryRequest();
      const timedOut = fixture.owner
        .requestDelivery(fixture.computerId, fixture.instanceId, request)
        .catch((error: unknown) => error);
      await waitForDeliveryFrame(fixture.frames, request.requestId);
      await vi.advanceTimersByTimeAsync(10);
      await expect(timedOut).resolves.toBeInstanceOf(Error);

      const report = turnReport();
      await expect(fixture.owner.handle(report, fixture.context)).resolves.toMatchObject({ status: "recorded" });
      expect(await fixture.owner.getDelivery(request.deliveryId)).toMatchObject({ turnId: report.turnId });
    } finally {
      fixture.owner.close();
      vi.useRealTimers();
    }
  });

  it("uses a matching report to recover an accepted result dropped by scheduler overload", async () => {
    const fixture = await ownerFixture();
    const request = deliveryRequest();
    const report = turnReport();
    const pending = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, request);
    await waitForDeliveryFrame(fixture.frames, request.requestId);

    const business = fixture.owner.businessOptions();
    expect(business.failureResult(report as never)).toBeUndefined();
    expect(business.overloadResult(report as never)).toBeUndefined();
    expect(business.laneKey(acceptedResult(request) as never)).toBe(`delivery:${request.deliveryId}`);
    expect(business.laneKey(report as never)).toBe(`delivery:${request.deliveryId}`);

    await expect(fixture.owner.handle(report, fixture.context)).resolves.toMatchObject({ status: "recorded" });
    await expect(pending).resolves.toMatchObject({ status: "accepted", turnId: report.turnId });
    expect(await fixture.owner.getDelivery(request.deliveryId)).toMatchObject({ turnId: report.turnId });
  });

  it("accepts a durable reporting recovery claimed by reconciliation", async () => {
    const fixture = await ownerFixture();
    const request = reconcileRequest(fixture.computerId);
    const report = turnReport();
    const deliveryFrame = deliveryRequest();
    const delivery = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, deliveryFrame);
    await waitForDeliveryFrame(fixture.frames, deliveryFrame.requestId);
    await fixture.owner.handle(acceptedResult(deliveryFrame), fixture.context);
    await delivery;
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
        retainedReports: [
          {
            dispatchRequestId: deliveryFrame.requestId,
            deliveryId: report.deliveryId,
            inputHash: computeDirectInputHash(deliveryFrame),
            turnId: report.turnId,
            placementGeneration: report.placementGeneration,
            resultHash: report.resultHash,
          },
        ],
      },
      fixture.context,
    );
    await expect(pending).resolves.toMatchObject({ status: "recovery_required" });
    const conflictingBody = { ...report, finalText: "different recovered result" };
    const conflicting = {
      ...conflictingBody,
      requestId: randomUUID(),
      resultHash: computeTurnResultHash(conflictingBody),
    };
    await expect(fixture.owner.handle(conflicting, fixture.context)).resolves.toMatchObject({ status: "conflict" });
    expect(await fixture.owner.getTurn(report.turnId)).toBeUndefined();
    await expect(fixture.owner.handle(report, fixture.context)).resolves.toMatchObject({ status: "recorded" });
  });

  it("transfers an exact recorded Turn claim to a replacement daemon", async () => {
    const fixture = await ownerFixture();
    const deliveryRequestFrame = deliveryRequest();
    const delivery = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, deliveryRequestFrame);
    await waitForDeliveryFrame(fixture.frames, deliveryRequestFrame.requestId);
    await fixture.owner.handle(acceptedResult(deliveryRequestFrame), fixture.context);
    await delivery;
    const report = turnReport();
    await expect(fixture.owner.handle(report, fixture.context)).resolves.toMatchObject({ status: "recorded" });

    const replacement = await replaceRuntimeInstance(fixture);
    await expect(
      fixture.owner.handle({ ...report, requestId: randomUUID() }, replacement.context),
    ).resolves.toMatchObject({ status: "already_recorded" });
    await establishRetainedClaim(fixture, replacement.instanceId, replacement.context, report);
    await expect(
      fixture.owner.handle({ ...report, requestId: randomUUID() }, replacement.context),
    ).resolves.toMatchObject({ status: "already_recorded" });
    expect((await fixture.owner.getTurn(report.turnId))?.instanceId).toBe(replacement.instanceId);

    const conflictingBody = { ...report, finalText: "replacement tried a different result" };
    const conflicting = {
      ...conflictingBody,
      requestId: randomUUID(),
      resultHash: computeTurnResultHash(conflictingBody),
    };
    await expect(fixture.owner.handle(conflicting, replacement.context)).resolves.toMatchObject({
      status: "conflict",
    });
  });

  it("prefers an exact replacement claim over a surviving old-instance delivery", async () => {
    const fixture = await ownerFixture();
    const deliveryRequestFrame = deliveryRequest();
    const delivery = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, deliveryRequestFrame);
    await waitForDeliveryFrame(fixture.frames, deliveryRequestFrame.requestId);
    await fixture.owner.handle(acceptedResult(deliveryRequestFrame), fixture.context);
    await delivery;

    const report = turnReport();
    const replacement = await replaceRuntimeInstance(fixture);
    const forgedBody = { ...report, turnId: "turn-forged" };
    const forged = {
      ...forgedBody,
      requestId: randomUUID(),
      resultHash: computeTurnResultHash(forgedBody),
    };
    await establishRetainedClaim(fixture, replacement.instanceId, replacement.context, forged);
    await expect(fixture.owner.handle(forged, replacement.context)).resolves.toMatchObject({ status: "conflict" });

    await establishRetainedClaim(fixture, replacement.instanceId, replacement.context, report);
    await expect(fixture.owner.handle(report, replacement.context)).resolves.toMatchObject({ status: "recorded" });
    expect((await fixture.owner.getTurn(report.turnId))?.instanceId).toBe(replacement.instanceId);
  });

  it("keeps an exact old-instance delivery retriable until the replacement manifest is processed", async () => {
    const fixture = await ownerFixture();
    const deliveryRequestFrame = deliveryRequest();
    const delivery = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, deliveryRequestFrame);
    await waitForDeliveryFrame(fixture.frames, deliveryRequestFrame.requestId);
    await fixture.owner.handle(acceptedResult(deliveryRequestFrame), fixture.context);
    await delivery;

    const report = turnReport();
    const replacement = await replaceRuntimeInstance(fixture);
    await expect(fixture.owner.handle(report, replacement.context)).resolves.toBeUndefined();

    await establishReconciliationWithoutRetainedClaim(fixture, replacement.instanceId, replacement.context);
    await expect(fixture.owner.handle(report, replacement.context)).resolves.toBeUndefined();

    await establishRetainedClaim(fixture, replacement.instanceId, replacement.context, report);
    await expect(fixture.owner.handle(report, replacement.context)).resolves.toMatchObject({ status: "recorded" });
  });

  it("moves an identical recovered claim from the old daemon to its replacement", async () => {
    const fixture = await ownerFixture();
    const report = turnReport();
    const deliveryFrame = deliveryRequest();
    const delivery = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, deliveryFrame);
    await waitForDeliveryFrame(fixture.frames, deliveryFrame.requestId);
    await fixture.owner.handle(acceptedResult(deliveryFrame), fixture.context);
    await delivery;
    await establishRetainedClaim(fixture, fixture.instanceId, fixture.context, report);

    const replacement = await replaceRuntimeInstance(fixture);
    await expect(fixture.owner.handle(report, replacement.context)).resolves.toBeUndefined();
    await establishRetainedClaim(fixture, replacement.instanceId, replacement.context, report);
    await expect(fixture.owner.handle(report, replacement.context)).resolves.toMatchObject({ status: "recorded" });
    expect((await fixture.owner.getTurn(report.turnId))?.instanceId).toBe(replacement.instanceId);
  });

  it("correlates remote SessionMessage delivery and delegates unmatched local acknowledgements", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const instanceId = randomUUID();
    const userId = randomUUID();
    const frames: unknown[] = [];
    await registry.register(
      { computerId, instanceId, lastHeartbeatAt: 1, socket: socketFixture(frames), userId },
      async () => undefined,
    );
    const onLocal = vi.fn().mockResolvedValue({
      type: "session:collaboration:result",
      requestId: randomUUID(),
      messageId: randomUUID(),
      status: "accepted",
    });
    const owner = new RuntimeDomainOwner(registry, new MemoryRuntimeCustodyStore(), {
      onLocalSessionMessageDeliveryResult: onLocal,
    });
    const context = { computerId, instanceId, signal: new AbortController().signal, userId };
    const delivery = sessionMessageDelivery();
    const pending = owner.requestSessionMessageDelivery(computerId, instanceId, delivery);
    await vi.waitFor(() => expect(frames).toContainEqual(delivery));
    const accepted = {
      type: "session:message:deliver:result" as const,
      requestId: delivery.requestId,
      messageId: delivery.messageId,
      targetSessionId: delivery.targetSessionId,
      placementGeneration: delivery.placementGeneration,
      status: "accepted" as const,
    };
    await expect(owner.handle(accepted, context)).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual(accepted);
    expect(onLocal).not.toHaveBeenCalled();

    const unmatched = { ...accepted, requestId: randomUUID() };
    await expect(owner.handle(unmatched, context)).resolves.toMatchObject({ status: "accepted" });
    expect(onLocal).toHaveBeenCalledWith(unmatched, context);
  });
});

async function waitForDeliveryFrame(frames: unknown[], requestId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(frames).toEqual(expect.arrayContaining([expect.objectContaining({ requestId, type: "im:deliver" })]));
  });
}

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
  const owner = new RuntimeDomainOwner(registry, new MemoryRuntimeCustodyStore(), { requestTimeoutMs });
  const context: RuntimeBusinessContext = {
    computerId,
    instanceId,
    signal: new AbortController().signal,
    userId,
  };
  return { computerId, context, frames, instanceId, owner, registry };
}

async function replaceRuntimeInstance(fixture: Awaited<ReturnType<typeof ownerFixture>>) {
  const instanceId = randomUUID();
  const frames: unknown[] = [];
  await fixture.registry.register(
    {
      computerId: fixture.computerId,
      instanceId,
      lastHeartbeatAt: 2,
      socket: socketFixture(frames),
      userId: fixture.context.userId,
    },
    async () => undefined,
  );
  return {
    context: { ...fixture.context, instanceId },
    frames,
    instanceId,
  };
}

async function establishRetainedClaim(
  fixture: Awaited<ReturnType<typeof ownerFixture>>,
  instanceId: string,
  context: RuntimeBusinessContext,
  report: TurnReportRequest,
): Promise<void> {
  const request = reconcileRequest(fixture.computerId);
  const pending = fixture.owner.requestReconcile(fixture.computerId, instanceId, request);
  await fixture.owner.handle(
    {
      type: "session:reconcile:result",
      requestId: request.requestId,
      sessionId: request.sessionId,
      placementGeneration: request.placementGeneration,
      status: "recovery_required",
      reason: "unresolved_turn",
      turn: { deliveryId: report.deliveryId, turnId: report.turnId },
      retainedReports: [retainedClaim(report)],
    },
    context,
  );
  await pending;
}

async function establishReconciliationWithoutRetainedClaim(
  fixture: Awaited<ReturnType<typeof ownerFixture>>,
  instanceId: string,
  context: RuntimeBusinessContext,
): Promise<void> {
  const request = reconcileRequest(fixture.computerId);
  const pending = fixture.owner.requestReconcile(fixture.computerId, instanceId, request);
  await fixture.owner.handle(
    {
      type: "session:reconcile:result",
      requestId: request.requestId,
      sessionId: request.sessionId,
      placementGeneration: request.placementGeneration,
      status: "ready",
    },
    context,
  );
  await pending;
}

function retainedClaim(report: TurnReportRequest) {
  const request = deliveryRequest();
  return {
    dispatchRequestId: request.requestId,
    deliveryId: report.deliveryId,
    inputHash: computeDirectInputHash(request),
    turnId: report.turnId,
    placementGeneration: report.placementGeneration,
    resultHash: report.resultHash,
  };
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
    requestId: "11111111-1111-4111-8111-111111111111",
    deliveryId: "delivery-1",
    imMessageId: "message-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "team-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
    },
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

function sessionMessageDelivery(): SessionMessageDeliveryRequest {
  const agentId = randomUUID();
  return {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    content: { kind: "text", text: "hello" },
    runtime: { ...snapshot(), agentId, workspace: { ...snapshot().workspace, workspaceId: agentId } },
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

class MemoryRuntimeCustodyStore implements RuntimeCustodyStore {
  readonly #deliveries = new Map<string, AcceptedDeliveryRecord>();
  readonly #dispatches = new Map<string, { inputHash: string; requestId: string }>();
  readonly #expectedResultHashes = new Map<string, string>();
  readonly #turns = new Map<string, RecordedTurnRecord>();

  async beginDeliveryDispatch(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
  ): Promise<DeliveryDispatchStatus> {
    const current = this.#dispatches.get(request.deliveryId);
    if (current) {
      return current.requestId === request.requestId && current.inputHash === inputHash
        ? "already_dispatched"
        : "conflict";
    }
    this.#dispatches.set(request.deliveryId, { inputHash, requestId: request.requestId });
    return "dispatched";
  }

  async acceptDelivery(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
    turnId: string,
    context: RuntimeBusinessContext,
  ) {
    const current = this.#deliveries.get(request.deliveryId);
    if (current) {
      return current.inputHash === inputHash && current.turnId === turnId ? "already_accepted" : "conflict";
    }
    this.#deliveries.set(request.deliveryId, {
      agentId: request.agentId,
      computerId: context.computerId,
      deliveryId: request.deliveryId,
      inputHash,
      instanceId: context.instanceId,
      placementGeneration: request.placementGeneration,
      sessionId: request.sessionId,
      turnId,
    });
    return "accepted";
  }

  async claimRetainedReports(
    request: SessionReconcileRequest,
    claims: NonNullable<SessionReconcileResult["retainedReports"]>,
    context: RuntimeBusinessContext,
  ): Promise<void> {
    for (const claim of claims) {
      const delivery = this.#deliveries.get(claim.deliveryId);
      if (
        !delivery ||
        delivery.agentId !== request.agentId ||
        delivery.sessionId !== request.sessionId ||
        delivery.turnId !== claim.turnId ||
        delivery.placementGeneration !== claim.placementGeneration
      ) {
        continue;
      }
      this.#deliveries.set(claim.deliveryId, {
        ...delivery,
        computerId: context.computerId,
        instanceId: context.instanceId,
      });
      const turn = this.#turns.get(claim.turnId);
      if (turn && turn.resultHash === claim.resultHash) {
        this.#turns.set(claim.turnId, {
          ...turn,
          computerId: context.computerId,
          instanceId: context.instanceId,
        });
      }
      this.#expectedResultHashes.set(claim.turnId, claim.resultHash);
    }
  }

  async getDelivery(deliveryId: string): Promise<AcceptedDeliveryRecord | undefined> {
    return this.#deliveries.get(deliveryId);
  }

  async getDeliveryByTurn(turnId: string): Promise<AcceptedDeliveryRecord | undefined> {
    return [...this.#deliveries.values()].find((delivery) => delivery.turnId === turnId);
  }

  async getTurn(turnId: string): Promise<RecordedTurnRecord | undefined> {
    return this.#turns.get(turnId);
  }

  async recordTurn(report: TurnReportRequest, context: RuntimeBusinessContext) {
    const existing = this.#turns.get(report.turnId);
    if (existing) {
      return existing.report.deliveryId === report.deliveryId && existing.resultHash === report.resultHash
        ? "already_recorded"
        : "conflict";
    }
    const delivery = this.#deliveries.get(report.deliveryId);
    if (!delivery) return undefined;
    if (
      delivery.turnId !== report.turnId ||
      delivery.sessionId !== report.sessionId ||
      delivery.agentId !== report.agentId
    ) {
      return "conflict";
    }
    if (delivery.placementGeneration !== report.placementGeneration) return "stale_generation";
    if (delivery.computerId !== context.computerId || delivery.instanceId !== context.instanceId) return undefined;
    const expectedHash = this.#expectedResultHashes.get(report.turnId);
    if (expectedHash && expectedHash !== report.resultHash) return "conflict";
    this.#turns.set(report.turnId, {
      computerId: context.computerId,
      instanceId: context.instanceId,
      report,
      resultHash: report.resultHash,
    });
    return "recorded";
  }
}
