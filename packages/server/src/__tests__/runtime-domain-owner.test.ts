import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  RUNTIME_CAPABILITY,
  type RuntimeImSteerRequest,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryResult,
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
import {
  RuntimeDomainConflictError,
  RuntimeDomainOwner,
  type RuntimeDomainOwnerOptions,
} from "../runtime/runtime-domain-owner.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";

describe("RuntimeDomainOwner", () => {
  it("rejects invalid capacity and timeout configuration", async () => {
    const registry = new ConnectionRegistry();
    const custody = new MemoryRuntimeCustodyStore();
    expect(() => new RuntimeDomainOwner(registry, custody, { maxPendingRequests: 0 })).toThrow(
      "maxPendingRequests must be a positive safe integer",
    );
    expect(() => new RuntimeDomainOwner(registry, custody, { requestTimeoutMs: 0 })).toThrow(
      "requestTimeoutMs must be a positive safe integer",
    );
    expect(() => new RuntimeDomainOwner(registry, custody, { maxPendingRequests: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("deduplicates prepared reconciles and evicts the oldest preparation", async () => {
    const preparationResolvers: Array<(request: SessionReconcileRequest) => void> = [];
    const prepareReconcile = vi.fn(
      () =>
        new Promise<SessionReconcileRequest>((resolve) => {
          preparationResolvers.push(resolve);
        }),
    );
    const fixture = await ownerFixture(1_000, { prepareReconcile, maxPendingRequests: 1 });
    const firstRequest = reconcileRequest(fixture.computerId);
    const first = fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, firstRequest);
    const duplicateDispatched = vi.fn();
    const duplicate = fixture.owner.requestReconcile(
      fixture.computerId,
      fixture.instanceId,
      structuredClone(firstRequest),
      duplicateDispatched,
    );
    expect(duplicate).toBe(first);
    expect(duplicateDispatched).toHaveBeenCalledOnce();
    expect(() =>
      fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, {
        ...firstRequest,
        sessionId: "different-session",
      }),
    ).toThrow(RuntimeDomainConflictError);

    const secondRequest = reconcileRequest(fixture.computerId);
    const second = fixture.owner
      .requestReconcile(fixture.computerId, fixture.instanceId, secondRequest)
      .catch((error: unknown) => error);
    preparationResolvers[0]?.(firstRequest);
    await vi.waitFor(() =>
      expect(fixture.frames).toContainEqual(expect.objectContaining({ requestId: firstRequest.requestId })),
    );
    preparationResolvers[1]?.(secondRequest);
    await fixture.owner.handle(
      {
        type: "session:reconcile:result",
        requestId: firstRequest.requestId,
        sessionId: firstRequest.sessionId,
        placementGeneration: 1,
        status: "ready",
      },
      fixture.context,
    );
    await expect(first).resolves.toMatchObject({ status: "ready" });
    await expect(second).resolves.toMatchObject({ code: "capacity" });
  });

  it("maps custody and resend failures to request errors", async () => {
    const fixture = await ownerFixture();
    await expect(fixture.owner.resend(randomUUID())).rejects.toMatchObject({ code: "not_pending" });

    const staleCustody = new MemoryRuntimeCustodyStore();
    vi.spyOn(staleCustody, "beginDeliveryDispatch").mockResolvedValue("stale_generation");
    const staleOwner = new RuntimeDomainOwner(fixture.registry, staleCustody);
    await expect(
      staleOwner.requestDelivery(fixture.computerId, fixture.instanceId, deliveryRequest()),
    ).rejects.toMatchObject({
      code: "stale_placement",
    });

    const pendingRequest = reconcileRequest(fixture.computerId);
    const pending = fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, pendingRequest);
    await expect(fixture.owner.resend(pendingRequest.requestId)).resolves.toBeUndefined();
    await fixture.owner.handle(
      {
        type: "session:reconcile:result",
        requestId: pendingRequest.requestId,
        sessionId: pendingRequest.sessionId,
        placementGeneration: 1,
        status: "ready",
      },
      fixture.context,
    );
    await expect(pending).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects conflicting in-flight deliveries and stale steer dispatches", async () => {
    const fixture = await ownerFixture();
    const custody = new MemoryRuntimeCustodyStore();
    let releaseDispatch: (() => void) | undefined;
    const dispatchReady = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    vi.spyOn(custody, "beginDeliveryDispatch").mockImplementation(async () => {
      await dispatchReady;
      return "dispatched";
    });
    const owner = new RuntimeDomainOwner(fixture.registry, custody);
    const request = deliveryRequest();
    const first = owner.requestDelivery(fixture.computerId, fixture.instanceId, request);
    const duplicate = owner.requestDelivery(fixture.computerId, fixture.instanceId, structuredClone(request));
    expect(duplicate).toBe(first);
    expect(() =>
      owner.requestDelivery(fixture.computerId, fixture.instanceId, {
        ...request,
        content: { ...request.content, text: "different" },
      }),
    ).toThrow(RuntimeDomainConflictError);
    releaseDispatch?.();
    await vi.waitFor(() => expect(fixture.frames).toContainEqual(expect.objectContaining({ type: "im:deliver" })));
    await owner.handle(acceptedResult(request), fixture.context);
    await expect(first).resolves.toMatchObject({ status: "accepted" });

    const steerCustody = new MemoryRuntimeCustodyStore();
    vi.spyOn(steerCustody, "beginSteerDispatch").mockResolvedValue("stale_generation");
    const steerOwner = new RuntimeDomainOwner(fixture.registry, steerCustody);
    await expect(
      steerOwner.requestSteer(fixture.computerId, fixture.instanceId, steerRequest(request)),
    ).rejects.toMatchObject({
      code: "stale_placement",
    });
  });

  it("releases pending steer custody when stopped", async () => {
    const fixture = await ownerFixture();
    const custody = new MemoryRuntimeCustodyStore();
    const release = vi.spyOn(custody, "releaseSteerDispatch");
    const owner = new RuntimeDomainOwner(fixture.registry, custody);
    const request = steerRequest(deliveryRequest());
    const pending = owner.requestSteer(fixture.computerId, fixture.instanceId, request);
    await vi.waitFor(() => expect(fixture.frames).toContainEqual(expect.objectContaining({ type: "im:steer" })));
    owner.close();
    await expect(pending).rejects.toMatchObject({ code: "stopped" });
    expect(release).toHaveBeenCalledWith(request, expect.any(String), "deferred");
  });

  it("releases delivery custody when the runtime send fails synchronously", async () => {
    const fixture = await ownerFixture();
    const custody = new MemoryRuntimeCustodyStore();
    const release = vi.spyOn(custody, "releaseDeliveryDispatch");
    const failingSocket = socketFixture([], new Error("send failed"));
    await fixture.registry.register(
      {
        computerId: fixture.computerId,
        installationId: fixture.context.installationId,
        instanceId: fixture.instanceId,
        lastHeartbeatAt: 1,
        socket: failingSocket,
      },
      async () => undefined,
    );
    const owner = new RuntimeDomainOwner(fixture.registry, custody, { requestTimeoutMs: 1_000 });
    const request = deliveryRequest();
    await expect(owner.requestDelivery(fixture.computerId, fixture.instanceId, request)).rejects.toMatchObject({
      code: "unavailable",
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(request, expect.any(String), "retry"));
    expect(custody.hasDispatch(request.deliveryId)).toBe(false);
  });

  it("compensates a dispatch marker when registry send throws synchronously", async () => {
    const fixture = await ownerFixture();
    const custody = new MemoryRuntimeCustodyStore();
    const release = vi.spyOn(custody, "releaseDeliveryDispatch");
    const owner = new RuntimeDomainOwner(
      {
        send: vi.fn(() => {
          throw new Error("sync send failed");
        }),
      } as never,
      custody,
    );
    const request = deliveryRequest();

    await expect(owner.requestDelivery(fixture.computerId, fixture.instanceId, request)).rejects.toThrow(
      "sync send failed",
    );
    expect(release).toHaveBeenCalledWith(request, expect.any(String), "retry");
    expect(custody.hasDispatch(request.deliveryId)).toBe(false);
  });

  it("releases delivery custody when a dispatch times out", async () => {
    const fixture = await ownerFixture(5);
    const custody = new MemoryRuntimeCustodyStore();
    const release = vi.spyOn(custody, "releaseDeliveryDispatch");
    const owner = new RuntimeDomainOwner(fixture.registry, custody, { requestTimeoutMs: 5 });
    const request = deliveryRequest();
    const pending = owner.requestDelivery(fixture.computerId, fixture.instanceId, request);
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(request, expect.any(String), "deferred"));
    expect(custody.hasDispatch(request.deliveryId)).toBe(true);
  });

  it("releases steer custody when admission capacity rejects after begin", async () => {
    const fixture = await ownerFixture();
    const custody = new MemoryRuntimeCustodyStore();
    const release = vi.spyOn(custody, "releaseSteerDispatch");
    const owner = new RuntimeDomainOwner(fixture.registry, custody, { maxPendingRequests: 1 });
    const reconcile = reconcileRequest(fixture.computerId);
    owner.requestReconcile(fixture.computerId, fixture.instanceId, reconcile);
    const request = steerRequest(deliveryRequest());
    await expect(owner.requestSteer(fixture.computerId, fixture.instanceId, request)).rejects.toMatchObject({
      code: "capacity",
    });
    expect(release).toHaveBeenCalledWith(request, expect.any(String), "deferred");
  });
  it("passes the negotiated credential grant version to the authority callback", async () => {
    const onImCredentialGrant = vi.fn(async (request) => ({
      type: "im:credential:result" as const,
      requestId: request.requestId,
      status: "rejected" as const,
      code: "binding_inactive" as const,
    }));
    const fixture = await ownerFixture(1_000, { onImCredentialGrant });
    const request = {
      type: "im:credential" as const,
      requestId: randomUUID(),
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
    };

    await expect(fixture.owner.handle(request, fixture.context)).resolves.toMatchObject({
      type: "im:credential:result",
      requestId: request.requestId,
    });
    expect(onImCredentialGrant).toHaveBeenCalledWith(request, expect.objectContaining({ imCredentialGrantVersion: 2 }));
  });

  it("returns explicit stale results and bounded credential failures", async () => {
    const fixture = await ownerFixture();
    const staleContext = { ...fixture.context, instanceId: randomUUID() };
    const report = turnReport();
    await expect(fixture.owner.handle(report, staleContext)).resolves.toMatchObject({
      status: "stale_generation",
      requestId: report.requestId,
    });
    const credential = {
      type: "im:credential" as const,
      requestId: randomUUID(),
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
    };
    await expect(fixture.owner.handle(credential, staleContext)).resolves.toMatchObject({
      status: "rejected",
      code: "placement_stale",
    });

    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const loggingOwner = new RuntimeDomainOwner(fixture.registry, new MemoryRuntimeCustodyStore(), { logger });
    await expect(loggingOwner.handle(credential, staleContext)).resolves.toMatchObject({
      status: "rejected",
      code: "placement_stale",
    });
    expect(warn).toHaveBeenCalledWith(
      {
        code: "placement_stale",
        computerId: fixture.computerId,
        instanceId: staleContext.instanceId,
        requestId: credential.requestId,
        sessionId: credential.sessionId,
        agentId: credential.agentId,
      },
      "Runtime credential grant rejected",
    );

    const noCallback = await ownerFixture();
    await expect(noCallback.owner.handle(credential, noCallback.context)).resolves.toMatchObject({
      status: "rejected",
      code: "credential_stale",
    });
    await expect(loggingOwner.handle(credential, fixture.context)).resolves.toMatchObject({
      status: "rejected",
      code: "credential_stale",
    });
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        code: "credential_stale",
        reason: "grant_callback_missing",
        requestId: credential.requestId,
      }),
      "Runtime credential grant rejected",
    );
    const unsupportedRegistry = new ConnectionRegistry();
    const unsupportedSocket = socketFixture([]);
    await unsupportedRegistry.register(
      {
        computerId: fixture.computerId,
        installationId: fixture.context.installationId,
        instanceId: fixture.instanceId,
        lastHeartbeatAt: 1,
        socket: unsupportedSocket,
      },
      async () => undefined,
    );
    const unsupportedOwner = new RuntimeDomainOwner(unsupportedRegistry, new MemoryRuntimeCustodyStore(), {
      logger,
      onImCredentialGrant: async () => ({
        type: "im:credential:result",
        requestId: credential.requestId,
        status: "rejected",
        code: "binding_inactive",
      }),
    });
    await expect(unsupportedOwner.handle(credential, fixture.context)).resolves.toMatchObject({
      status: "rejected",
      code: "credential_stale",
    });
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        code: "credential_stale",
        reason: "capability_version_unsupported",
        requestId: credential.requestId,
      }),
      "Runtime credential grant rejected",
    );
  });

  it("forwards only matching trace batches to the trace callback", async () => {
    const fixture = await ownerFixture();
    const custody = new MemoryRuntimeCustodyStore();
    vi.spyOn(custody, "getDeliveryByTurn").mockResolvedValue({
      agentId: "agent-1",
      computerId: fixture.context.computerId,
      deliveryId: "delivery-1",
      inputHash: "input",
      instanceId: fixture.instanceId,
      placementGeneration: 1,
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const onTrace = vi.fn();
    const owner = new RuntimeDomainOwner(fixture.registry, custody, { onTrace });
    const trace = {
      type: "agent:trace" as const,
      batchId: randomUUID(),
      sessionId: "session-1",
      turnId: "turn-1",
      placementGeneration: 1,
      events: [{ kind: "turn_started" as const, sequence: 1, at: new Date().toISOString() }],
    };
    await owner.handle(trace, fixture.context);
    expect(onTrace).toHaveBeenCalledWith(trace, fixture.context);
    await owner.handle({ ...trace, placementGeneration: 2 }, fixture.context);
    expect(onTrace).toHaveBeenCalledOnce();
  });

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

  it("rejects a reissued delivery whose expired request belongs to a different Computer", async () => {
    const fixture = await ownerFixture(25);
    const request = deliveryRequest();
    await expect(fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, request)).rejects.toMatchObject({
      code: "timeout",
    });

    expect(() => fixture.owner.requestDelivery(randomUUID(), fixture.instanceId, structuredClone(request))).toThrow(
      RuntimeDomainConflictError,
    );

    const retried = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, structuredClone(request));
    await vi.waitFor(() => expect(fixture.frames).toContainEqual(request));
    await fixture.owner.handle(
      {
        type: "im:deliver:result",
        requestId: request.requestId,
        deliveryId: request.deliveryId,
        sessionId: request.sessionId,
        placementGeneration: 1,
        status: "accepted",
        turnId: "turn-1",
      } as never,
      fixture.context,
    );
    await expect(retried).resolves.toMatchObject({ status: "accepted" });
  });

  it("applies reconcile admission after preparation and before the Runtime frame", async () => {
    const prepareReconcile = vi.fn(
      async (_computerId: string, _instanceId: string, request: SessionReconcileRequest) => ({
        ...request,
        sessionCliProof: { proofId: randomUUID(), token: "runtime-proof" },
      }),
    );
    const fixture = await ownerFixture(1_000, { prepareReconcile });
    const request = reconcileRequest(fixture.computerId);
    const admission = vi.fn(async () => ({ admitted: false as const }));

    await expect(
      fixture.owner.requestReconcile(fixture.computerId, fixture.instanceId, request, undefined, admission),
    ).rejects.toMatchObject({ code: "authority_unavailable" });
    expect(prepareReconcile).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledOnce();
    expect(fixture.frames).toEqual([]);
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

  it("fences accepted and absorbed delivery results by custody status", async () => {
    const fixture = await ownerFixture();
    const staleCustody = new MemoryRuntimeCustodyStore();
    vi.spyOn(staleCustody, "acceptDelivery").mockResolvedValue("stale_generation" as never);
    const staleOwner = new RuntimeDomainOwner(fixture.registry, staleCustody);
    const staleRequest = deliveryRequest();
    const stalePending = staleOwner.requestDelivery(fixture.computerId, fixture.instanceId, staleRequest);
    await waitForDeliveryFrame(fixture.frames, staleRequest.requestId);
    await staleOwner.handle(acceptedResult(staleRequest), fixture.context);
    await expect(stalePending).resolves.toMatchObject({ status: "rejected", reason: "target_mismatch" });

    const conflictCustody = new MemoryRuntimeCustodyStore();
    vi.spyOn(conflictCustody, "acceptDelivery").mockResolvedValue("conflict");
    const conflictOwner = new RuntimeDomainOwner(fixture.registry, conflictCustody);
    const conflictRequest = { ...deliveryRequest(), requestId: randomUUID(), deliveryId: "delivery-conflict" };
    const conflictPending = conflictOwner.requestDelivery(fixture.computerId, fixture.instanceId, conflictRequest);
    await waitForDeliveryFrame(fixture.frames, conflictRequest.requestId);
    await expect(conflictOwner.handle(acceptedResult(conflictRequest), fixture.context)).rejects.toBeInstanceOf(
      RuntimeDomainConflictError,
    );
    conflictOwner.close();
    await expect(conflictPending).rejects.toMatchObject({ code: "stopped" });

    const absorbedCustody = new MemoryRuntimeCustodyStore();
    vi.spyOn(absorbedCustody, "recordAbsorbed").mockResolvedValue("stale_generation" as never);
    const absorbedOwner = new RuntimeDomainOwner(fixture.registry, absorbedCustody);
    const absorbedRequest = { ...deliveryRequest(), requestId: randomUUID(), deliveryId: "delivery-absorbed" };
    const absorbedPending = absorbedOwner.requestDelivery(fixture.computerId, fixture.instanceId, absorbedRequest);
    await waitForDeliveryFrame(fixture.frames, absorbedRequest.requestId);
    await absorbedOwner.handle(
      {
        type: "im:deliver:result",
        requestId: absorbedRequest.requestId,
        deliveryId: absorbedRequest.deliveryId,
        sessionId: absorbedRequest.sessionId,
        placementGeneration: absorbedRequest.placementGeneration,
        status: "absorbed",
        rootDeliveryId: "root-delivery",
        turnId: "root-turn",
      },
      fixture.context,
    );
    absorbedOwner.close();
    await expect(absorbedPending).rejects.toMatchObject({ code: "stopped" });
  });

  it("records one steered disposition and returns the completed result on request retry", async () => {
    const fixture = await ownerFixture();
    const root = deliveryRequest();
    const accepted = fixture.owner.requestDelivery(fixture.computerId, fixture.instanceId, root);
    await waitForDeliveryFrame(fixture.frames, root.requestId);
    await fixture.owner.handle(acceptedResult(root), fixture.context);
    await accepted;

    const request = steerRequest(root);
    const first = fixture.owner.requestSteer(fixture.computerId, fixture.instanceId, request);
    await vi.waitFor(() =>
      expect(fixture.frames).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "im:steer", requestId: request.requestId })]),
      ),
    );
    const result = {
      type: "im:steer:result" as const,
      requestId: request.requestId,
      deliveryId: request.deliveryId,
      sessionId: request.sessionId,
      placementGeneration: request.placementGeneration,
      rootDeliveryId: request.rootDeliveryId,
      expectedTurnId: request.expectedTurnId,
      status: "steered" as const,
    };
    await fixture.owner.handle(result, fixture.context);
    await expect(first).resolves.toEqual(result);
    const frameCount = fixture.frames.length;
    await expect(
      fixture.owner.requestSteer(fixture.computerId, fixture.instanceId, structuredClone(request)),
    ).resolves.toEqual(result);
    expect(fixture.frames).toHaveLength(frameCount);
    expect(fixture.owner.businessOptions().laneKey(result as never)).toBe(`delivery:${root.deliveryId}`);
    expect(fixture.owner.businessOptions().parse({ invalid: true })).toBeUndefined();
    const sessionMessageResult = {
      type: "session:message:deliver:result",
      targetSessionId: randomUUID(),
      messageId: randomUUID(),
    };
    expect(fixture.owner.businessOptions().laneKey(sessionMessageResult as never)).toContain("session-message:");
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
        installationId: fixture.context.installationId,
        instanceId: nextInstanceId,
        lastHeartbeatAt: 2,
        socket: nextSocket,
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

  it("correlates SessionMessage delivery results and ignores unmatched results", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const instanceId = randomUUID();
    const frames: unknown[] = [];
    await registry.register(
      {
        computerId,
        installationId: computerId,
        instanceId,
        lastHeartbeatAt: 1,
        socket: socketFixture(frames),
      },
      async () => undefined,
    );
    const owner = new RuntimeDomainOwner(registry, new MemoryRuntimeCustodyStore());
    const context = {
      computerId,
      installationId: computerId,
      instanceId,
      signal: new AbortController().signal,
    };
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
    const unmatched = { ...accepted, requestId: randomUUID() };
    await expect(owner.handle(unmatched, context)).resolves.toBeUndefined();
  });

  it("dispatches SessionMessage frames only through an admitted onDispatched boundary", async () => {
    const fixture = await ownerFixture();
    const rejected = sessionMessageDelivery();
    const rejectedDispatched = vi.fn();
    await expect(
      fixture.owner.requestSessionMessageDelivery(
        fixture.computerId,
        fixture.instanceId,
        rejected,
        rejectedDispatched,
        async () => ({ admitted: false }),
      ),
    ).rejects.toMatchObject({ code: "authority_unavailable" });
    expect(rejectedDispatched).not.toHaveBeenCalled();
    expect(fixture.frames).not.toContainEqual(rejected);

    const admitted = sessionMessageDelivery();
    const admittedDispatched = vi.fn();
    const admission = vi.fn(async (operation: (onDispatched: () => void) => Promise<SessionMessageDeliveryResult>) => {
      let markDispatched: () => void = () => undefined;
      const dispatched = new Promise<void>((resolve) => {
        markDispatched = resolve;
      });
      const result = operation(markDispatched);
      await dispatched;
      expect(fixture.frames).toContainEqual(admitted);
      return { admitted: true as const, result };
    });
    const pending = fixture.owner.requestSessionMessageDelivery(
      fixture.computerId,
      fixture.instanceId,
      admitted,
      admittedDispatched,
      admission,
    );
    await vi.waitFor(() => expect(fixture.frames).toContainEqual(admitted));
    const result = {
      type: "session:message:deliver:result" as const,
      requestId: admitted.requestId,
      messageId: admitted.messageId,
      targetSessionId: admitted.targetSessionId,
      placementGeneration: admitted.placementGeneration,
      status: "accepted" as const,
    };
    await fixture.owner.handle(result, fixture.context);
    await expect(pending).resolves.toEqual(result);
    expect(admittedDispatched).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledOnce();
  });
});

async function waitForDeliveryFrame(frames: unknown[], requestId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(frames).toEqual(expect.arrayContaining([expect.objectContaining({ requestId, type: "im:deliver" })]));
  });
}

async function ownerFixture(requestTimeoutMs = 1_000, options: Partial<RuntimeDomainOwnerOptions> = {}) {
  const registry = new ConnectionRegistry();
  const computerId = randomUUID();
  const instanceId = randomUUID();
  const frames: unknown[] = [];
  await registry.register(
    {
      computerId,
      installationId: computerId,
      instanceId,
      lastHeartbeatAt: 1,
      negotiatedCapabilities: { [RUNTIME_CAPABILITY.imCredentialGrant]: 2 },
      socket: socketFixture(frames),
    },
    async () => undefined,
  );
  const owner = new RuntimeDomainOwner(registry, new MemoryRuntimeCustodyStore(), { requestTimeoutMs, ...options });
  const context: RuntimeBusinessContext = {
    computerId,
    installationId: computerId,
    instanceId,
    signal: new AbortController().signal,
  };
  return { computerId, context, frames, instanceId, owner, registry };
}

async function replaceRuntimeInstance(fixture: Awaited<ReturnType<typeof ownerFixture>>) {
  const instanceId = randomUUID();
  const frames: unknown[] = [];
  await fixture.registry.register(
    {
      computerId: fixture.computerId,
      installationId: fixture.context.installationId,
      instanceId,
      lastHeartbeatAt: 2,
      socket: socketFixture(frames),
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

function socketFixture(frames: unknown[], sendError?: Error): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn((serialized: string, callback: (error?: Error) => void) => {
      frames.push(JSON.parse(serialized));
      callback(sendError);
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
    installationId: computerId,
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
        teamId: "workspace-1",
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

function steerRequest(root: DirectImMessageDeliveryRequest): RuntimeImSteerRequest {
  return {
    type: "im:steer",
    requestId: randomUUID(),
    deliveryId: "delivery-steer",
    imMessageId: "message-steer",
    sessionId: root.sessionId,
    agentId: root.agentId,
    placementGeneration: root.placementGeneration,
    rootDeliveryId: root.deliveryId,
    expectedTurnId: "turn-1",
    attention: "ambient",
    content: {
      kind: "text",
      text: "new direction",
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "workspace-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000002",
      },
    },
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

  async beginSteerDispatch(request: RuntimeImSteerRequest, inputHash: string): Promise<DeliveryDispatchStatus> {
    const current = this.#dispatches.get(request.deliveryId);
    if (current) {
      return current.requestId === request.requestId && current.inputHash === inputHash
        ? "already_dispatched"
        : "conflict";
    }
    this.#dispatches.set(request.deliveryId, { inputHash, requestId: request.requestId });
    return "dispatched";
  }

  async releaseDeliveryDispatch(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
    disposition: "retry" | "deferred",
  ): Promise<"released" | "already_released" | "conflict"> {
    const current = this.#dispatches.get(request.deliveryId);
    if (!current) return "already_released";
    if (current.requestId !== request.requestId || current.inputHash !== inputHash) return "conflict";
    if (disposition === "retry") this.#dispatches.delete(request.deliveryId);
    return "released";
  }

  hasDispatch(deliveryId: string): boolean {
    return this.#dispatches.has(deliveryId);
  }

  async recordSteered(): Promise<"steered"> {
    return "steered";
  }

  async recordAbsorbed(): Promise<"steered"> {
    return "steered";
  }

  async releaseSteerDispatch(): Promise<"released"> {
    return "released";
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
    if (delivery.computerId !== context.computerId || delivery.instanceId !== context.instanceId) {
      return undefined;
    }
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
