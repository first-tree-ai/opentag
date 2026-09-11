import { randomUUID } from "node:crypto";
import type {
  DirectImMessageDeliveryRequest,
  EffectiveRuntimeSnapshot,
  RuntimeImSteerRequest,
  RuntimeImSteerResult,
} from "@opentag/shared";
import { computeTurnResultHash } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { CustodyResult, SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionBindingConflictError } from "../runtime/session-binding-store.js";
import type { SessionReconciler } from "../runtime/session-reconciler.js";
import { TurnCustodyOwner } from "../runtime/turn-custody-owner.js";

/**
 * Deterministic doubles for the durable binding store and the reconciler. The
 * integration behaviour of the real store is covered in admission-custody tests;
 * these tests force each custody outcome directly so every branch of the owner is
 * observable without a filesystem.
 */
function fakeReconciler(overrides: Partial<Record<keyof SessionReconciler, unknown>> = {}) {
  const reconciler = {
    withAgentLock: vi.fn(async (_agentId: string, task: () => Promise<unknown>) => task()),
    checkDelivery: vi.fn(() => undefined),
    setActivity: vi.fn(),
    clearActivity: vi.fn(() => true),
    ...overrides,
  };
  return reconciler as unknown as SessionReconciler & typeof reconciler;
}

function committed(request: DirectImMessageDeliveryRequest, inputHash: string, turnId: string): CustodyResult {
  return {
    status: "committed",
    binding: {} as never,
    unresolvedTurn: {
      requestId: request.requestId,
      deliveryId: request.deliveryId,
      inputHash,
      turnId,
      phase: "accepted",
    },
  };
}

function fakeStore(overrides: Partial<Record<keyof SessionBindingStore, unknown>> = {}) {
  const store = {
    recordAccepted: vi.fn(committed),
    getAbsorbedReceipt: vi.fn(async () => undefined),
    updateUnresolved: vi.fn(async () => undefined),
    recordResult: vi.fn(async () => undefined),
    ...overrides,
  };
  return store as unknown as SessionBindingStore & typeof store;
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

function providerRef(messageTs: string) {
  return {
    provider: "slack" as const,
    appId: "app-1",
    teamId: "workspace-1",
    botUserId: "bot-1",
    channelId: "channel-1",
    messageTs,
  };
}

function delivery(
  deliveryId: string,
  overrides: Partial<DirectImMessageDeliveryRequest> = {},
): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId,
    imMessageId: `message-${deliveryId}`,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "hello", providerRef: providerRef(`message-${deliveryId}`) },
    runtime: snapshot(),
    ...overrides,
  };
}

function steerRequest(deliveryId: string, overrides: Partial<RuntimeImSteerRequest> = {}): RuntimeImSteerRequest {
  return {
    type: "im:steer",
    requestId: randomUUID(),
    deliveryId,
    imMessageId: `message-${deliveryId}`,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    rootDeliveryId: "delivery-root",
    expectedTurnId: "turn-root",
    attention: "direct",
    content: { kind: "text", text: "steer", providerRef: providerRef(`message-${deliveryId}`) },
    ...overrides,
  };
}

function steered(request: RuntimeImSteerRequest): RuntimeImSteerResult {
  return {
    type: "im:steer:result",
    requestId: request.requestId,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    rootDeliveryId: request.rootDeliveryId,
    expectedTurnId: request.expectedTurnId,
    status: "steered",
  };
}

function retrying(request: RuntimeImSteerRequest): RuntimeImSteerResult {
  return { ...steered(request), status: "retry", reason: "turn_starting" } as RuntimeImSteerResult;
}

function report(overrides: Record<string, unknown> = {}) {
  const body = {
    deliveryId: "delivery-1",
    turnId: "turn-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "done",
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
    ...overrides,
  };
  return { type: "turn:report" as const, requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}

describe("TurnCustodyOwner construction", () => {
  it("rejects a non-positive or non-integer remembered request limit", () => {
    for (const maxRememberedRequests of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new TurnCustodyOwner({ bindingStore: fakeStore(), reconciler: fakeReconciler(), maxRememberedRequests }),
      ).toThrow("maxRememberedRequests must be a positive safe integer");
    }
  });

  it("treats observer deliveries and steers as unsupported when no version negotiation is wired", async () => {
    const steer = vi.fn(async (request: RuntimeImSteerRequest) => steered(request));
    const owner = new TurnCustodyOwner({ bindingStore: fakeStore(), reconciler: fakeReconciler(), steer });
    await expect(owner.accept(delivery("delivery-1", { replyRole: "observer" }))).resolves.toMatchObject({
      result: { status: "rejected", reason: "session_not_ready" },
    });
    await expect(owner.acceptSteer(steerRequest("delivery-2", { replyRole: "observer" }))).resolves.toMatchObject({
      status: "deferred",
      reason: "steer_unsupported",
    });
    expect(steer).not.toHaveBeenCalled();
    expect(owner.liveTurnCount).toBe(0);
  });
});

describe("TurnCustodyOwner.accept custody outcomes", () => {
  it("returns the previously recorded Turn when the store already holds the identical input", async () => {
    const store = fakeStore({
      recordAccepted: vi.fn(async (request: DirectImMessageDeliveryRequest, inputHash: string) => ({
        status: "recorded",
        binding: {},
        recorded: { kind: "turn", deliveryId: request.deliveryId, inputHash, turnId: "turn-earlier" },
      })),
    });
    const owner = new TurnCustodyOwner({ bindingStore: store, id: () => "turn-new", reconciler: fakeReconciler() });
    const decision = await owner.accept(delivery("delivery-1"));
    expect(decision.result).toMatchObject({ status: "accepted", turnId: "turn-earlier" });
    expect(decision.onAcceptedSent).toBeUndefined();
    expect(owner.getTurn("turn-new")).toBeUndefined();
    expect(owner.liveTurnCount).toBe(0);
    expect(owner.admission.snapshot().client).toBe(0);
  });

  it("returns absorbed when the store recorded the delivery as a steer", async () => {
    const store = fakeStore({
      recordAccepted: vi.fn(async () => ({
        status: "absorbed",
        binding: {},
        recorded: { kind: "steer", deliveryId: "delivery-1", inputHash: "h", rootDeliveryId: "root", turnId: "t-root" },
      })),
    });
    const owner = new TurnCustodyOwner({ bindingStore: store, reconciler: fakeReconciler() });
    await expect(owner.accept(delivery("delivery-1"))).resolves.toMatchObject({
      result: { status: "absorbed", rootDeliveryId: "root", turnId: "t-root" },
    });
    expect(owner.liveTurnCount).toBe(0);
  });

  it("requires recovery when another unresolved Turn owns the Session", async () => {
    const store = fakeStore({
      recordAccepted: vi.fn(async (request: DirectImMessageDeliveryRequest, inputHash: string) => ({
        status: "existing",
        binding: {},
        unresolvedTurn: {
          requestId: "r",
          deliveryId: request.deliveryId,
          inputHash,
          turnId: "turn-other",
          phase: "accepted",
        },
      })),
    });
    const owner = new TurnCustodyOwner({ bindingStore: store, id: () => "turn-1", reconciler: fakeReconciler() });
    await expect(owner.accept(delivery("delivery-1"))).resolves.toMatchObject({
      result: { status: "rejected", reason: "session_recovery_required" },
    });
    expect(owner.admission.snapshot().client).toBe(0);
  });

  it("keeps custody when the existing unresolved Turn is its own", async () => {
    const store = fakeStore({
      recordAccepted: vi.fn(async (request: DirectImMessageDeliveryRequest, inputHash: string, turnId: string) => ({
        status: "existing",
        binding: {},
        unresolvedTurn: { requestId: "r", deliveryId: request.deliveryId, inputHash, turnId, phase: "accepted" },
      })),
    });
    const reconciler = fakeReconciler();
    const owner = new TurnCustodyOwner({ bindingStore: store, id: () => "turn-1", reconciler });
    const decision = await owner.accept(delivery("delivery-1"));
    expect(decision.result).toMatchObject({ status: "accepted", turnId: "turn-1" });
    expect(reconciler.setActivity).toHaveBeenCalledWith("session-1", {
      phase: "running",
      deliveryId: "delivery-1",
      turnId: "turn-1",
    });
    expect(owner.getTurn("turn-1")).toMatchObject({ turnId: "turn-1" });
    expect(owner.liveTurnCount).toBe(1);
  });

  it.each([
    ["recovery_required", "session_recovery_required"],
    ["stale", "stale_configuration"],
    ["conflict", "session_binding_conflict"],
  ] as const)("maps a %s binding conflict to %s and rolls back", async (code, reason) => {
    const store = fakeStore({
      recordAccepted: vi.fn(async () => {
        throw new SessionBindingConflictError(code, "boom");
      }),
    });
    const owner = new TurnCustodyOwner({ bindingStore: store, id: () => "turn-1", reconciler: fakeReconciler() });
    await expect(owner.accept(delivery("delivery-1"))).resolves.toMatchObject({
      result: { status: "rejected", reason },
    });
    expect(owner.liveTurnCount).toBe(0);
    expect(owner.admission.snapshot().client).toBe(0);
  });

  it("reports the provider as unavailable for unexpected storage failures", async () => {
    const store = fakeStore({
      recordAccepted: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const owner = new TurnCustodyOwner({ bindingStore: store, reconciler: fakeReconciler() });
    await expect(owner.accept(delivery("delivery-1"))).resolves.toMatchObject({
      result: { status: "rejected", reason: "provider_unavailable" },
    });
  });

  it("rejects with the reconciler's delivery verdict before touching storage", async () => {
    const store = fakeStore();
    const owner = new TurnCustodyOwner({
      bindingStore: store,
      reconciler: fakeReconciler({ checkDelivery: vi.fn(() => "stale_generation") }),
    });
    await expect(owner.accept(delivery("delivery-1"))).resolves.toMatchObject({
      result: { status: "rejected", reason: "stale_generation" },
    });
    expect(store.recordAccepted).not.toHaveBeenCalled();
  });
});

describe("TurnCustodyOwner.accept admission refusals", () => {
  it("rejects with the admission reason when no absorbed receipt exists", async () => {
    const store = fakeStore();
    const owner = new TurnCustodyOwner({ bindingStore: store, reconciler: fakeReconciler() });
    const held = owner.admission.reserve("session-1", "agent-1");
    expect(held.accepted).toBe(true);
    await expect(owner.accept(delivery("delivery-1"))).resolves.toMatchObject({
      result: { status: "rejected", reason: "session_busy" },
    });
    expect(store.getAbsorbedReceipt).toHaveBeenCalledOnce();
  });

  it("converges a refused redelivery onto its absorbed receipt", async () => {
    const store = fakeStore({
      getAbsorbedReceipt: vi.fn(async () => ({
        kind: "steer",
        deliveryId: "delivery-1",
        inputHash: "h",
        rootDeliveryId: "delivery-root",
        turnId: "turn-root",
      })),
    });
    const owner = new TurnCustodyOwner({ bindingStore: store, reconciler: fakeReconciler() });
    owner.admission.reserve("session-1", "agent-1");
    await expect(owner.accept(delivery("delivery-1"))).resolves.toMatchObject({
      result: { status: "absorbed", rootDeliveryId: "delivery-root", turnId: "turn-root" },
    });
  });

  it("reports an input conflict when the absorbed receipt carries different input", async () => {
    const store = fakeStore({
      getAbsorbedReceipt: vi.fn(async () => {
        throw new SessionBindingConflictError("conflict", "different input");
      }),
    });
    const owner = new TurnCustodyOwner({ bindingStore: store, reconciler: fakeReconciler() });
    owner.admission.reserve("session-1", "agent-1");
    await expect(owner.accept(delivery("delivery-1"))).resolves.toMatchObject({
      result: { status: "rejected", reason: "input_conflict" },
    });
  });

  it("falls back to the admission reason for other receipt lookup failures", async () => {
    for (const error of [new SessionBindingConflictError("stale", "stale"), new Error("io")]) {
      const store = fakeStore({
        getAbsorbedReceipt: vi.fn(async () => {
          throw error;
        }),
      });
      const owner = new TurnCustodyOwner({ bindingStore: store, reconciler: fakeReconciler() });
      owner.admission.reserve("session-1", "agent-1");
      await expect(owner.accept(delivery("delivery-1"))).resolves.toMatchObject({
        result: { status: "rejected", reason: "session_busy" },
      });
    }
  });
});

describe("TurnCustodyOwner request memory", () => {
  it("forgets the oldest request IDs beyond the configured limit", async () => {
    let turn = 0;
    const owner = new TurnCustodyOwner({
      bindingStore: fakeStore(),
      id: () => `turn-${++turn}`,
      maxRememberedRequests: 1,
      reconciler: fakeReconciler(),
    });
    const first = delivery("delivery-1");
    await expect(owner.accept(first)).resolves.toMatchObject({ result: { turnId: "turn-1" } });
    await owner.recordResult("turn-1", "b".repeat(64));
    expect(owner.liveTurnCount).toBe(0);
    // Still remembered: the identical request replays the original decision.
    await expect(owner.accept(structuredClone(first))).resolves.toMatchObject({ result: { turnId: "turn-1" } });

    await expect(owner.accept(delivery("delivery-2", { sessionId: "session-2" }))).resolves.toMatchObject({
      result: { turnId: "turn-2" },
    });
    // Evicted: the same request now starts a fresh Turn.
    await expect(owner.accept(structuredClone(first))).resolves.toMatchObject({ result: { turnId: "turn-3" } });
  });

  it("rejects a remembered request ID that arrives with different input", async () => {
    const owner = new TurnCustodyOwner({ bindingStore: fakeStore(), reconciler: fakeReconciler() });
    const request = delivery("delivery-1");
    await owner.accept(request);
    await expect(owner.accept({ ...request, content: { ...request.content, text: "changed" } })).resolves.toMatchObject(
      { result: { status: "rejected", reason: "input_conflict" } },
    );
  });
});

describe("TurnCustodyOwner reporting", () => {
  it("throws for an unknown live Turn", async () => {
    const owner = new TurnCustodyOwner({ bindingStore: fakeStore(), reconciler: fakeReconciler() });
    await expect(owner.markReporting("turn-missing", report())).rejects.toThrow("The live Turn owner does not exist");
    await expect(owner.recordResult("turn-missing", "a".repeat(64))).rejects.toThrow(
      "The live Turn owner does not exist",
    );
  });

  it.each([
    ["turnId", { turnId: "turn-other" }],
    ["deliveryId", { deliveryId: "delivery-other" }],
    ["sessionId", { sessionId: "session-other" }],
    ["agentId", { agentId: "agent-other" }],
    ["placementGeneration", { placementGeneration: 2 }],
  ])("rejects a report whose %s does not match the live owner", async (_field, mismatch) => {
    const store = fakeStore();
    const owner = new TurnCustodyOwner({ bindingStore: store, id: () => "turn-1", reconciler: fakeReconciler() });
    await owner.accept(delivery("delivery-1"));
    await expect(owner.markReporting("turn-1", report(mismatch))).rejects.toThrow(
      "The Turn Report does not match its live custody owner",
    );
    expect(store.updateUnresolved).not.toHaveBeenCalled();
  });

  it("records reporting without touching a reservation that never became active", async () => {
    const store = fakeStore();
    const reconciler = fakeReconciler();
    const owner = new TurnCustodyOwner({ bindingStore: store, id: () => "turn-1", reconciler });
    await owner.accept(delivery("delivery-1"));
    expect(owner.admission.get("session-1")?.phase).toBe("provisional");
    await owner.markReporting("turn-1", report());
    expect(owner.admission.get("session-1")?.phase).toBe("provisional");
    expect(store.updateUnresolved).toHaveBeenCalledWith(
      "agent-1",
      "session-1",
      "turn-1",
      "reporting",
      expect.objectContaining({ resultHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    );
    expect(reconciler.setActivity).toHaveBeenLastCalledWith("session-1", {
      phase: "reporting",
      deliveryId: "delivery-1",
      turnId: "turn-1",
    });
  });

  it("releases custody and clears activity when the result is recorded", async () => {
    const store = fakeStore();
    const reconciler = fakeReconciler();
    const owner = new TurnCustodyOwner({ bindingStore: store, id: () => "turn-1", reconciler });
    const decision = await owner.accept(delivery("delivery-1"));
    await decision.onAcceptedSent?.();
    expect(owner.admission.get("session-1")?.phase).toBe("active");
    await owner.recordResult("turn-1", "c".repeat(64));
    expect(store.recordResult).toHaveBeenCalledWith("agent-1", "session-1", "turn-1", "c".repeat(64));
    expect(reconciler.clearActivity).toHaveBeenCalledWith("session-1", "turn-1");
    expect(owner.getTurn("turn-1")).toBeUndefined();
    expect(owner.liveTurnCount).toBe(0);
    expect(owner.admission.snapshot().client).toBe(0);
  });
});

describe("TurnCustodyOwner.acceptSteer", () => {
  it("correlates a redelivered steer with a new request ID onto the in-flight decision", async () => {
    const steer = vi.fn(async (request: RuntimeImSteerRequest) => steered(request));
    const owner = new TurnCustodyOwner({ bindingStore: fakeStore(), reconciler: fakeReconciler(), steer });
    const first = steerRequest("delivery-2");
    await expect(owner.acceptSteer(first)).resolves.toMatchObject({ status: "steered", requestId: first.requestId });
    const retry = { ...first, requestId: randomUUID() };
    await expect(owner.acceptSteer(retry)).resolves.toMatchObject({ status: "steered", requestId: retry.requestId });
    expect(steer).toHaveBeenCalledOnce();
  });

  it("rejects a redelivered steer whose input changed", async () => {
    const steer = vi.fn(async (request: RuntimeImSteerRequest) => steered(request));
    const owner = new TurnCustodyOwner({ bindingStore: fakeStore(), reconciler: fakeReconciler(), steer });
    const first = steerRequest("delivery-2");
    await owner.acceptSteer(first);
    const changed = { ...first, requestId: randomUUID(), content: { ...first.content, text: "other" } };
    await expect(owner.acceptSteer(changed)).resolves.toMatchObject({ status: "rejected", reason: "input_conflict" });
    await expect(owner.acceptSteer({ ...first, content: { ...first.content, text: "third" } })).resolves.toMatchObject({
      status: "rejected",
      reason: "input_conflict",
    });
    expect(steer).toHaveBeenCalledOnce();
  });

  it("rejects an expired steer as invalid input without calling the provider", async () => {
    const steer = vi.fn(async (request: RuntimeImSteerRequest) => steered(request));
    const owner = new TurnCustodyOwner({
      bindingStore: fakeStore(),
      now: () => Date.parse("2026-08-18T01:00:00.000Z"),
      reconciler: fakeReconciler(),
      steer,
    });
    await expect(
      owner.acceptSteer(steerRequest("delivery-2", { deadlineAt: "2026-08-18T00:59:59.000Z" })),
    ).resolves.toMatchObject({ status: "rejected", reason: "invalid_input" });
    expect(steer).not.toHaveBeenCalled();
    await expect(
      owner.acceptSteer(steerRequest("delivery-3", { deadlineAt: "2026-08-18T01:00:01.000Z" })),
    ).resolves.toMatchObject({ status: "steered" });
  });

  it("defers steers when no steer handler is wired", async () => {
    const owner = new TurnCustodyOwner({ bindingStore: fakeStore(), reconciler: fakeReconciler() });
    await expect(owner.acceptSteer(steerRequest("delivery-2"))).resolves.toMatchObject({
      status: "deferred",
      reason: "steer_unsupported",
    });
  });

  it("forgets a retryable steer so the next delivery reaches the provider again", async () => {
    const steer = vi
      .fn(async (request: RuntimeImSteerRequest) => steered(request))
      .mockImplementationOnce(async (request: RuntimeImSteerRequest) => retrying(request));
    const owner = new TurnCustodyOwner({ bindingStore: fakeStore(), reconciler: fakeReconciler(), steer });
    const first = steerRequest("delivery-2");
    await expect(owner.acceptSteer(first)).resolves.toMatchObject({ status: "retry" });
    await expect(owner.acceptSteer({ ...first, requestId: randomUUID() })).resolves.toMatchObject({
      status: "steered",
    });
    expect(steer).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest steer memory beyond the configured limit", async () => {
    const steer = vi.fn(async (request: RuntimeImSteerRequest) => steered(request));
    const owner = new TurnCustodyOwner({
      bindingStore: fakeStore(),
      maxRememberedRequests: 1,
      reconciler: fakeReconciler(),
      steer,
    });
    const first = steerRequest("delivery-2");
    await owner.acceptSteer(first);
    await owner.acceptSteer(steerRequest("delivery-3"));
    // The first delivery is no longer remembered, so the provider is asked again.
    await expect(owner.acceptSteer({ ...first, requestId: randomUUID() })).resolves.toMatchObject({
      status: "steered",
    });
    expect(steer).toHaveBeenCalledTimes(3);
  });
});
