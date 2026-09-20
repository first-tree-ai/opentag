/**
 * CloudDeliveryCoordinator branch corners.
 *
 * `im-delivery-worker-cloud.test.ts` drives the coordinator end to end through `ImDeliveryWorker`
 * and a real PGlite database. These cases drive it directly against the coordinator's own options,
 * so the corners a full claim can never reach are pinned on their own: a lease that has already
 * been lost, a persisted payload the claimed row contradicts, a frozen execution window that has
 * passed, the stopped-work reconciliation loops, and the pure deadline/backoff/parse helpers.
 *
 * The coordinator takes every collaborator as an option, so no database and no Runner are needed;
 * where the code reads its own database it goes through `loadSandboxRecordBySessionId`, which is
 * mocked per case.
 */
import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  RUNTIME_MAX_FRAME_BYTES,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CloudDeliveryClaimRow,
  CloudDeliveryCoordinator,
  cloudDispatchDeadline,
  cloudDispatchFailureCode,
  cloudDispatchRetryDelayMs,
  cloudDispatchWindowExpired,
  readPersistedDeliveryRequest,
  STOPPED_CLOUD_RECONCILE_INTERVAL_MS,
} from "../runtime/im-delivery-cloud.js";
import { CloudDeliveryDispatchError } from "../services/sandboxes/cloud-delivery-owner.js";
import * as ownedSandbox from "../services/sandboxes/owned-sandbox.js";

const NOW = Date.parse("2026-08-19T00:00:00.000Z");

function runtimeSnapshot(overrides: Partial<EffectiveRuntimeSnapshot> = {}): EffectiveRuntimeSnapshot {
  return {
    contextTreeRepository: null,
    revision: { agent: { sequence: 1, id: "rev-agent" }, session: { sequence: 1, id: "rev-session" } },
    agentId: "agent-1",
    provider: "pi",
    model: "unit-model",
    reasoningEffort: "medium",
    instructions: { platform: "Platform instructions.", agent: "Be brief." },
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    budget: { maxDurationMs: 60_000 },
    ...overrides,
  };
}

const RUNTIME = runtimeSnapshot();

/**
 * The largest instructions the runtime contract admits (12 KiB platform + 12 KiB agent). Used by
 * the frame-fitting case to force a frame that is still over the wire cap after its history is
 * gone, which is the only way the resource-trimming pass runs.
 */
const MAX_INSTRUCTIONS_RUNTIME = runtimeSnapshot({
  instructions: { platform: "p".repeat(12 * 1024), agent: "a".repeat(12 * 1024) },
});

/** The already-ensured Sandbox row the coordinator reads back for a claimed Session. */
const SANDBOX_ID = randomUUID();

/** The Feishu provider reference the runtime contract requires on every delivery. */
const PROVIDER_REF = {
  provider: "feishu",
  teamBrand: "feishu",
  appId: "cli_1",
  botOpenId: "ou_bot",
  chatId: "oc_1",
  messageId: "om_1",
} as const;

type DeliveryRow = CloudDeliveryClaimRow["delivery"];

function claimRow(overrides: Partial<DeliveryRow> = {}): CloudDeliveryClaimRow {
  const deliveryId = randomUUID();
  const messageId = randomUUID();
  const sessionId = randomUUID();
  return {
    delivery: {
      id: deliveryId,
      messageId,
      sessionId,
      attention: "direct",
      state: "pending",
      placementGeneration: 1,
      dispatchRequestId: null,
      dispatchInputHash: null,
      dispatchPayload: null,
      attemptCount: 1,
      expiresAt: new Date(NOW + 3_600_000),
      reason: null,
      ...overrides,
    },
    message: { id: messageId, threadKey: null },
    session: { id: sessionId, kind: "channel", threadKey: null },
    placement: { generation: 1 },
    imBinding: { id: randomUUID() },
    // The assembled runtime carries this same agent identity: the frame contract rejects a
    // delivery whose runtime snapshot names a different Agent.
    agent: { id: RUNTIME.agentId, createdByUserId: randomUUID(), receiveMode: "all", status: "active" },
    computer: { id: randomUUID(), kind: "cloud", currentInstallationId: randomUUID() },
  } as unknown as CloudDeliveryClaimRow;
}

function dispatchRequest(
  row: CloudDeliveryClaimRow,
  overrides: Partial<DirectImMessageDeliveryRequest> = {},
): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: row.delivery.id,
    imMessageId: row.message.id,
    sessionId: row.session.id,
    agentId: row.agent.id,
    placementGeneration: row.placement.generation,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: PROVIDER_REF,
    },
    runtime: { ...RUNTIME, agentId: row.agent.id },
    ...overrides,
  };
}

/** A persisted dispatch exactly as the owner commits it: payload, request id and hash all agree. */
function persist(row: CloudDeliveryClaimRow, request: DirectImMessageDeliveryRequest): void {
  const delivery = row.delivery as unknown as {
    dispatchRequestId: string | null;
    dispatchInputHash: string | null;
    dispatchPayload: unknown;
  };
  delivery.dispatchRequestId = request.requestId;
  delivery.dispatchInputHash = computeDirectInputHash(request);
  delivery.dispatchPayload = request;
}

type Options = ConstructorParameters<typeof CloudDeliveryCoordinator>[0];

interface Calls {
  failures: Array<{ deliveryId: string; code: string; retryDelayMs?: number }>;
  released: Array<{ deliveryId: string; requestId: string; code: string }>;
  rejected: Array<{ deliveryId: string; reason: string }>;
  diagnostics: string[];
  dispatched: DirectImMessageDeliveryRequest[];
}

interface CloudOwnerStub {
  isModelPathConfigured: ReturnType<typeof vi.fn>;
  resolveRuntimeModel: ReturnType<typeof vi.fn>;
  dispatchDelivery: ReturnType<typeof vi.fn>;
  recoverAccepted: ReturnType<typeof vi.fn>;
}

function makeCoordinator(overrides: Partial<Options> = {}) {
  const calls: Calls = { failures: [], released: [], rejected: [], diagnostics: [], dispatched: [] };
  const cloudDelivery: CloudOwnerStub = {
    isModelPathConfigured: vi.fn(() => true),
    resolveRuntimeModel: vi.fn((runtime: EffectiveRuntimeSnapshot) => runtime),
    dispatchDelivery: vi.fn(async (input: { request: DirectImMessageDeliveryRequest }) => {
      calls.dispatched.push(input.request);
    }),
    recoverAccepted: vi.fn(async () => "resolved" as const),
  };
  const options: Options = {
    database: {} as never,
    cloudDelivery: cloudDelivery as never,
    now: () => NOW,
    onDiagnostic: (code: string) => calls.diagnostics.push(code),
    assembleRuntime: async () => RUNTIME,
    replyRole: async () => undefined,
    buildDeliveryContent: async () => ({
      kind: "text",
      text: "hello",
      providerRef: PROVIDER_REF,
    }),
    hasOtherCustody: async () => false,
    recordFailure: async (deliveryId: string, code: string, _token?: string, retryDelayMs?: number) => {
      calls.failures.push({ deliveryId, code, ...(retryDelayMs === undefined ? {} : { retryDelayMs }) });
    },
    releaseDispatch: async (deliveryId: string, requestId: string, code: string) => {
      calls.released.push({ deliveryId, requestId, code });
    },
    rejectInput: async (deliveryId: string, reason: string) => {
      calls.rejected.push({ deliveryId, reason });
    },
    withActiveAgentAdmission: async (_expected, operation) => ({ admitted: true, result: operation(() => undefined) }),
    ...overrides,
  };
  const lookup = vi.spyOn(ownedSandbox, "loadSandboxRecordBySessionId").mockResolvedValue({ id: SANDBOX_ID } as never);
  return { coordinator: new CloudDeliveryCoordinator(options), calls, cloudDelivery, options, lookup };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const ownedLease = { assertOwned: async () => true, stop: async () => undefined };
const lostLease = { assertOwned: async () => false, stop: async () => undefined };
const signal = new AbortController().signal;

describe("CloudDeliveryCoordinator delivery admission", () => {
  it("stops before anything else once the claim lease is already lost", async () => {
    const row = claimRow();
    const { coordinator, calls, cloudDelivery } = makeCoordinator();
    await coordinator.deliver(row, "token", lostLease, signal);
    expect(calls.released).toEqual([]);
    expect(calls.failures).toEqual([]);
    expect(cloudDelivery.dispatchDelivery).not.toHaveBeenCalled();
  });

  it("re-releases an expired dispatch through its persisted request id", async () => {
    const row = claimRow({ state: "expired" });
    const persisted = dispatchRequest(row);
    persist(row, persisted);
    const { coordinator, calls } = makeCoordinator();
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.released).toEqual([
      { deliveryId: row.delivery.id, requestId: persisted.requestId, code: "IM_DELIVERY_EXPIRED" },
    ]);
    expect(calls.failures).toEqual([]);
  });

  it("returns an expired row to the bounded deadline even with nothing persisted to release", async () => {
    const row = claimRow({ state: "expired" });
    const { coordinator, calls } = makeCoordinator();
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.released).toEqual([]);
    expect(calls.failures).toEqual([]);
    expect(calls.dispatched).toEqual([]);
  });

  it("releases a frozen dispatch window that already passed instead of faking it forward", async () => {
    const row = claimRow();
    const expired = dispatchRequest(row, { deadlineAt: new Date(NOW - 1).toISOString() } as never);
    persist(row, expired);
    const { coordinator, calls } = makeCoordinator();
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.released).toEqual([
      { deliveryId: row.delivery.id, requestId: expired.requestId, code: "IM_DELIVERY_CLOUD_DISPATCH_EXPIRED" },
    ]);
    expect(calls.dispatched).toEqual([]);
  });

  it("terminally rejects a persisted payload the claimed row contradicts", async () => {
    const row = claimRow();
    // A payload from a different delivery: the cross-check must refuse to execute it.
    persist(row, { ...dispatchRequest(row), deliveryId: randomUUID() });
    const { coordinator, calls, cloudDelivery } = makeCoordinator();
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_DISPATCH_PAYLOAD_INVALID" }]);
    expect(cloudDelivery.dispatchDelivery).not.toHaveBeenCalled();
  });

  it("treats a valid persisted dispatch as frozen and never rebuilds or re-resolves it", async () => {
    const row = claimRow();
    const persisted = dispatchRequest(row);
    persist(row, persisted);
    const buildDeliveryContent = vi.fn();
    const { coordinator, calls, cloudDelivery } = makeCoordinator({
      buildDeliveryContent: buildDeliveryContent as never,
    });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.dispatched[0]).toEqual(persisted);
    expect(buildDeliveryContent).not.toHaveBeenCalled();
    expect(cloudDelivery.resolveRuntimeModel).not.toHaveBeenCalled();
  });

  it("records a transient model stop when the assembled runtime has no allowlisted model", async () => {
    const row = claimRow({ attemptCount: 3 });
    const { coordinator, calls, cloudDelivery } = makeCoordinator();
    cloudDelivery.resolveRuntimeModel.mockReturnValue(undefined);
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([
      { deliveryId: row.delivery.id, code: "IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE", retryDelayMs: 8_000 },
    ]);
  });

  it("stops silently when no runtime snapshot can be assembled for the delivery", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator({ assembleRuntime: async () => undefined });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([]);
    expect(calls.dispatched).toEqual([]);
  });

  it("records the Cloud-owner fence before rebuilding or allocating anything", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator({ hasOtherCustody: async () => true });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_AGENT_CUSTODY_FENCED" }]);
    expect(calls.dispatched).toEqual([]);
  });

  it("abandons the delivery when the lease is lost before the dispatch", async () => {
    const row = claimRow();
    const owned = false;
    const lease = { assertOwned: async () => owned, stop: async () => undefined };
    const { coordinator, calls } = makeCoordinator();
    await coordinator.deliver(row, "token", lease, signal);
    expect(calls.dispatched).toEqual([]);
    expect(calls.failures).toEqual([]);
  });

  it("builds a fresh dispatch with the runtime budget as the frozen execution window", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator({ replyRole: async () => "observer" });
    await coordinator.deliver(row, "token", ownedLease, signal);
    const sent = calls.dispatched[0] as DirectImMessageDeliveryRequest;
    expect(sent.replyRole).toBe("observer");
    expect(sent.deadlineAt).toBe(cloudDispatchDeadline(NOW, RUNTIME));
    expect(sent.deliveryId).toBe(row.delivery.id);
  });

  it("abandons the delivery when the lease is lost after the custody fence", async () => {
    const row = claimRow();
    let owned = true;
    const lease = { assertOwned: async () => owned, stop: async () => undefined };
    const { coordinator, calls } = makeCoordinator({
      hasOtherCustody: async () => {
        owned = false;
        return false;
      },
    });
    await coordinator.deliver(row, "token", lease, signal);
    expect(calls.dispatched).toEqual([]);
    expect(calls.failures).toEqual([]);
  });

  it("abandons the delivery when the lease is lost while a fresh payload is built", async () => {
    const row = claimRow();
    let owned = true;
    const lease = { assertOwned: async () => owned, stop: async () => undefined };
    const { coordinator, calls } = makeCoordinator({
      buildDeliveryContent: async () => {
        owned = false;
        return { kind: "text", text: "hello", providerRef: PROVIDER_REF };
      },
    });
    await coordinator.deliver(row, "token", lease, signal);
    expect(calls.dispatched).toEqual([]);
    expect(calls.failures).toEqual([]);
  });

  it("abandons the delivery when the lease is lost while the environment is ensured", async () => {
    const row = claimRow();
    let owned = true;
    const lease = { assertOwned: async () => owned, stop: async () => undefined };
    const { coordinator, calls } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async () => undefined,
        ensureEnvironmentAllocated: async () => {
          owned = false;
          return "ready";
        },
      } as never,
    });
    await coordinator.deliver(row, "token", lease, signal);
    expect(calls.dispatched).toEqual([]);
    expect(calls.failures).toEqual([]);
  });

  it("records the agent-not-active failure when admission refuses the delivery", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator({
      withActiveAgentAdmission: async () => ({ admitted: false }) as never,
    });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_AGENT_NOT_ACTIVE" }]);
  });

  it("maps an unexpected dispatch error to the generic runtime failure code", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator({
      cloudDelivery: {
        isModelPathConfigured: () => true,
        resolveRuntimeModel: (runtime: EffectiveRuntimeSnapshot) => runtime,
        dispatchDelivery: async () => {
          throw new TypeError("not a dispatch error");
        },
      } as never,
    });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_RUNTIME_FAILED" }]);
  });

  it.each([
    ["stale_generation", "IM_DELIVERY_PLACEMENT_STALE", undefined],
    ["model_unavailable", "IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE", 4_000],
    ["dispatch_conflict", "IM_DELIVERY_CLOUD_DISPATCH_CONFLICT", undefined],
    ["environment_not_ready", "IM_DELIVERY_CLOUD_ENVIRONMENT_NOT_READY", 4_000],
  ] as const)("maps a %s dispatch error to %s", async (code, expected, retryDelayMs) => {
    const row = claimRow({ attemptCount: 2 });
    const { coordinator, calls } = makeCoordinator({
      cloudDelivery: {
        isModelPathConfigured: () => true,
        resolveRuntimeModel: (runtime: EffectiveRuntimeSnapshot) => runtime,
        dispatchDelivery: async () => {
          throw new CloudDeliveryDispatchError(code, "unit failure");
        },
      } as never,
    });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([
      { deliveryId: row.delivery.id, code: expected, ...(retryDelayMs === undefined ? {} : { retryDelayMs }) },
    ]);
  });
});

describe("CloudDeliveryCoordinator environment ensure", () => {
  it("requires the allocation port when the Session has no Sandbox row yet", async () => {
    const row = claimRow();
    const { coordinator, calls, lookup } = makeCoordinator();
    lookup.mockResolvedValue(undefined as never);
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_CLOUD_ALLOCATION_UNAVAILABLE" }]);
  });

  it("refuses a Session kind that Cloud allocation does not support", async () => {
    const row = claimRow();
    (row.session as { kind: string }).kind = "internal";
    const { coordinator, calls, lookup } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async () => undefined,
        ensureEnvironmentAllocated: async () => "ready",
      } as never,
    });
    lookup.mockResolvedValue(undefined as never);
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([
      { deliveryId: row.delivery.id, code: "IM_DELIVERY_CLOUD_SESSION_KIND_UNSUPPORTED" },
    ]);
  });

  it("refuses a thread Session that carries no thread key", async () => {
    const row = claimRow();
    (row.session as { kind: string }).kind = "thread";
    (row.session as { threadKey: string | null }).threadKey = null;
    const { coordinator, calls, lookup } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async () => undefined,
        ensureEnvironmentAllocated: async () => "ready",
      } as never,
    });
    lookup.mockResolvedValue(undefined as never);
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_CLOUD_ALLOCATION_FAILED" }]);
  });

  it("creates a thread Sandbox row through the port and converges the allocation", async () => {
    const row = claimRow();
    (row.session as { kind: string }).kind = "thread";
    (row.session as { threadKey: string | null }).threadKey = "omt_thread";
    const ensured: Array<Record<string, unknown>> = [];
    const allocated: Array<Record<string, unknown>> = [];
    const { coordinator, calls, lookup } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async (input: Record<string, unknown>) => {
          ensured.push(input);
        },
        ensureEnvironmentAllocated: async (input: Record<string, unknown>) => {
          allocated.push(input);
          return "ready";
        },
      } as never,
    });
    // First read: no Sandbox row. Read-back after creation: the row the port just made.
    lookup.mockResolvedValueOnce(undefined as never).mockResolvedValue({ id: SANDBOX_ID } as never);
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(ensured[0]).toMatchObject({ kind: "thread", threadKey: "omt_thread" });
    expect(allocated[0]).toMatchObject({ accountId: row.agent.createdByUserId, sandboxId: SANDBOX_ID });
    expect(calls.dispatched).toHaveLength(1);
  });

  it("creates a channel Sandbox row through the port, not a thread one", async () => {
    const row = claimRow();
    const ensured: Array<Record<string, unknown>> = [];
    const { coordinator, calls, lookup } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async (input: Record<string, unknown>) => {
          ensured.push(input);
        },
        ensureEnvironmentAllocated: async () => "ready",
      } as never,
    });
    lookup.mockResolvedValueOnce(undefined as never).mockResolvedValue({ id: SANDBOX_ID } as never);
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(ensured[0]).toMatchObject({ kind: "channel" });
    expect(ensured[0]).not.toHaveProperty("threadKey");
    expect(calls.dispatched).toHaveLength(1);
  });

  it("records an allocation failure when the port cannot create the Sandbox row", async () => {
    const row = claimRow();
    const { coordinator, calls, lookup } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async () => {
          throw new Error("provider unavailable");
        },
        ensureEnvironmentAllocated: async () => "ready",
      } as never,
    });
    lookup.mockResolvedValue(undefined as never);
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_CLOUD_ALLOCATION_FAILED" }]);
  });

  it("records an allocation failure when the created Sandbox row cannot be read back", async () => {
    const row = claimRow();
    const { coordinator, calls, lookup } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async () => undefined,
        ensureEnvironmentAllocated: async () => "ready",
      } as never,
    });
    lookup.mockResolvedValue(undefined as never);
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_CLOUD_ALLOCATION_FAILED" }]);
  });

  it("rejects input when previously used storage cannot be restored rather than allocating blind", async () => {
    const row = claimRow();
    const { coordinator, calls, cloudDelivery } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async () => undefined,
        ensureEnvironmentAllocated: async () => "restore_required",
      } as never,
    });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.rejected).toEqual([{ deliveryId: row.delivery.id, reason: "restore_required" }]);
    expect(cloudDelivery.dispatchDelivery).not.toHaveBeenCalled();
  });

  it("rejects input when the environment is being released", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async () => undefined,
        ensureEnvironmentAllocated: async () => "stopped",
      } as never,
    });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.rejected).toEqual([{ deliveryId: row.delivery.id, reason: "environment_stopped" }]);
  });

  it("records an allocation failure when convergence throws", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator({
      cloudAllocation: {
        ensureSandbox: async () => undefined,
        ensureEnvironmentAllocated: async () => {
          throw new Error("provider unavailable");
        },
      } as never,
    });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_CLOUD_ALLOCATION_FAILED" }]);
  });

  it("skips convergence entirely when the environment is already ensured and no port is wired", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator();
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.failures).toEqual([]);
    expect(calls.dispatched).toHaveLength(1);
  });
});

describe("CloudDeliveryCoordinator stopped-work reconciliation", () => {
  it("does nothing when no Cloud delivery owner is wired", async () => {
    const { coordinator, calls } = makeCoordinator({ cloudDelivery: undefined });
    await coordinator.reconcileStoppedWork();
    expect(calls.diagnostics).toEqual([]);
    expect(calls.rejected).toEqual([]);
  });

  /**
   * The coordinator reads its stopped rows through its own database. Answer that one select with
   * the pending rows on the first pass and the accepted rows on the second.
   */
  /**
   * The coordinator's stopped-row read is a nine-way join whose shape only the query builder cares
   * about; answer it by walking to whichever terminal method the coordinator calls.
   */
  function stopperDatabase(
    page: Array<Array<{ id: string; ended: boolean }>>,
    onThrottle: () => Promise<void> = async () => undefined,
  ) {
    let reads = 0;
    const chain: Record<string, unknown> = {};
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => ({ limit: async () => page[reads++] ?? [] });
    return {
      select: () => ({ from: () => chain }),
      update: () => ({ set: () => ({ where: onThrottle }) }),
    };
  }

  it("rejects every stopped pending row with its reason and recovers every accepted row", async () => {
    const { coordinator, calls, cloudDelivery } = makeCoordinator({
      database: stopperDatabase([
        [
          { id: "pending-session-ended", ended: true },
          { id: "pending-authority-stopped", ended: false },
        ],
        [{ id: "accepted-row", ended: false }],
      ]) as never,
    });
    await coordinator.reconcileStoppedWork();
    expect(calls.rejected).toEqual([
      { deliveryId: "pending-session-ended", reason: "session_ended" },
      { deliveryId: "pending-authority-stopped", reason: "authority_stopped" },
    ]);
    expect(cloudDelivery.recoverAccepted).toHaveBeenCalledWith("accepted-row");
    expect(calls.diagnostics).toEqual([]);
  });

  it("reports a rejected stop and a failed recovery instead of aborting the pass", async () => {
    const { coordinator, calls, cloudDelivery } = makeCoordinator({
      database: stopperDatabase([
        [{ id: "pending-row", ended: true }],
        [{ id: "accepted-row", ended: false }],
      ]) as never,
      rejectInput: async () => {
        throw new Error("database unavailable");
      },
    });
    cloudDelivery.recoverAccepted.mockRejectedValue(new Error("runner query failed"));
    await coordinator.reconcileStoppedWork();
    expect(calls.diagnostics).toEqual([
      "IM_DELIVERY_CLOUD_STOPPED_REJECT_FAILED",
      "IM_DELIVERY_CLOUD_STOPPED_RECONCILE_FAILED",
    ]);
  });

  it("reports a throttling write failure without losing the recovered row", async () => {
    const { coordinator, calls, cloudDelivery } = makeCoordinator({
      database: stopperDatabase([[], [{ id: "accepted-row", ended: false }]], async () => {
        throw new Error("throttle write failed");
      }) as never,
    });
    await coordinator.reconcileStoppedWork();
    // The recovery still ran; only the cadence write failed, and that is reported, not thrown.
    expect(cloudDelivery.recoverAccepted).toHaveBeenCalledWith("accepted-row");
    expect(calls.diagnostics).toEqual(["IM_DELIVERY_CLOUD_STOPPED_RECONCILE_THROTTLE_FAILED"]);
  });

  it("records a pending report signal when an accepted Cloud delivery is not yet reported", async () => {
    const { coordinator, calls, cloudDelivery } = makeCoordinator();
    cloudDelivery.recoverAccepted.mockResolvedValue("pending");
    await coordinator.recover("delivery-1");
    expect(calls.failures).toEqual([{ deliveryId: "delivery-1", code: "IM_DELIVERY_CLOUD_REPORT_PENDING" }]);
  });

  it("records an unavailable failure when recovery runs without a Cloud owner", async () => {
    const { coordinator, calls } = makeCoordinator({ cloudDelivery: undefined });
    await coordinator.recover("delivery-1");
    expect(calls.failures).toEqual([{ deliveryId: "delivery-1", code: "IM_DELIVERY_CLOUD_UNAVAILABLE" }]);
  });

  it("leaves a resolved Cloud delivery alone", async () => {
    const { coordinator, calls, cloudDelivery } = makeCoordinator();
    cloudDelivery.recoverAccepted.mockResolvedValue("resolved");
    await coordinator.recover("delivery-1");
    expect(calls.failures).toEqual([]);
  });
});

describe("Cloud delivery deadlines and backoff", () => {
  it("treats a dispatch without a deadline as never expired", () => {
    const row = claimRow();
    expect(cloudDispatchWindowExpired(dispatchRequest(row), NOW + 10_000_000)).toBe(false);
  });

  it("expires a dispatch exactly at its deadline and ignores an unparseable one", () => {
    const row = claimRow();
    const request = dispatchRequest(row, { deadlineAt: new Date(NOW).toISOString() } as never);
    expect(cloudDispatchWindowExpired(request, NOW)).toBe(true);
    expect(cloudDispatchWindowExpired({ ...request, deadlineAt: "not-a-date" } as never, NOW)).toBe(false);
  });

  it("falls back to the platform default budget and bounds a request above the maximum", () => {
    const defaulted = cloudDispatchDeadline(NOW, runtimeSnapshot({ budget: undefined }));
    const ignored = cloudDispatchDeadline(NOW, runtimeSnapshot({ budget: { maxDurationMs: 0 } }));
    const bounded = cloudDispatchDeadline(
      NOW,
      runtimeSnapshot({ budget: { maxDurationMs: 90 * 24 * 60 * 60 * 1000 } }),
    );
    expect(Date.parse(defaulted)).toBeGreaterThan(NOW);
    // A zero/negative budget is not a usable duration: the platform default applies unchanged.
    expect(Date.parse(ignored)).toBe(Date.parse(defaulted));
    // A budget above the supported maximum is clamped, never honoured.
    expect(Date.parse(bounded)).toBeGreaterThan(Date.parse(defaulted));
    expect(Date.parse(bounded)).toBeLessThan(Date.parse(defaulted) + 90 * 24 * 60 * 60 * 1000);
  });

  it("caps the exponential dispatch backoff and tolerates a non-positive attempt count", () => {
    expect(cloudDispatchRetryDelayMs(1)).toBe(2_000);
    expect(cloudDispatchRetryDelayMs(2)).toBe(4_000);
    expect(cloudDispatchRetryDelayMs(0)).toBe(2_000);
    expect(cloudDispatchRetryDelayMs(-5)).toBe(2_000);
    expect(cloudDispatchRetryDelayMs(1_000)).toBe(30_000);
  });

  it("names every dispatch failure code, including one the wire never produces", () => {
    expect(cloudDispatchFailureCode(new CloudDeliveryDispatchError("stale_generation", "x"))).toBe(
      "IM_DELIVERY_PLACEMENT_STALE",
    );
    expect(cloudDispatchFailureCode(new CloudDeliveryDispatchError("model_unavailable", "x"))).toBe(
      "IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE",
    );
    expect(cloudDispatchFailureCode(new CloudDeliveryDispatchError("dispatch_conflict", "x"))).toBe(
      "IM_DELIVERY_CLOUD_DISPATCH_CONFLICT",
    );
    expect(cloudDispatchFailureCode(new CloudDeliveryDispatchError("send_failed", "x"))).toBe(
      "IM_DELIVERY_CLOUD_ENVIRONMENT_NOT_READY",
    );
  });

  it("keeps the stopped-work reconcile cadence well inside the delivery TTL", () => {
    expect(STOPPED_CLOUD_RECONCILE_INTERVAL_MS).toBe(30_000);
  });
});

describe("readPersistedDeliveryRequest", () => {
  function read(row: CloudDeliveryClaimRow) {
    return readPersistedDeliveryRequest({
      delivery: row.delivery,
      message: { id: row.message.id },
      session: { id: row.session.id },
      agent: { id: row.agent.id },
      placementGeneration: row.placement.generation,
    });
  }

  it("reports absent when nothing was persisted", () => {
    expect(read(claimRow())).toEqual({ status: "absent" });
  });

  it("rejects a payload that does not parse as a dispatch request", () => {
    const row = claimRow();
    (row.delivery as { dispatchPayload: unknown }).dispatchPayload = { type: "not:deliver" };
    expect(read(row)).toEqual({ status: "invalid" });
  });

  it("rejects a payload whose request id does not match the persisted dispatch request id", () => {
    const row = claimRow();
    persist(row, dispatchRequest(row));
    (row.delivery as { dispatchRequestId: string | null }).dispatchRequestId = randomUUID();
    expect(read(row)).toEqual({ status: "invalid" });
  });

  it.each([
    ["imMessageId", { imMessageId: "other-message" }],
    ["sessionId", { sessionId: "other-session" }],
    ["placementGeneration", { placementGeneration: 99 }],
  ] as const)("rejects a payload whose %s does not match the claimed row", (_field, override) => {
    const row = claimRow();
    persist(row, dispatchRequest(row, override as never));
    expect(read(row)).toEqual({ status: "invalid" });
  });

  it("rejects a payload that belongs to a different Agent", () => {
    const row = claimRow();
    // Both the frame identity and its runtime snapshot must be moved together: the frame contract
    // requires them to agree, so a mismatched pair would not parse at all.
    persist(
      row,
      dispatchRequest(row, {
        agentId: "other-agent",
        runtime: { ...RUNTIME, agentId: "other-agent" },
      } as never),
    );
    expect(read(row)).toEqual({ status: "invalid" });
  });

  it("rejects a payload whose stored hash does not match its content", () => {
    const row = claimRow();
    persist(row, dispatchRequest(row));
    (row.delivery as { dispatchInputHash: string | null }).dispatchInputHash = "d".repeat(64);
    expect(read(row)).toEqual({ status: "invalid" });
  });

  it("accepts a payload that matches the claimed row, its request id and its hash", () => {
    const row = claimRow();
    const persisted = dispatchRequest(row);
    persist(row, persisted);
    expect(read(row)).toEqual({ status: "valid", request: persisted });
  });
});

describe("Cloud delivery frame fitting", () => {
  /**
   * The largest frame the wire contract admits: maximum direct text, a full history inside its own
   * 40 KiB budget, every resource slot, and maximum instructions. It is over the 64 KiB frame cap,
   * so the fitter must drop history and then resources until it fits.
   */
  function oversizedContent() {
    const item = (index: number) => ({
      imMessageId: "m".repeat(128),
      occurredAt: new Date(NOW).toISOString(),
      text: `${index}`.padEnd(2_048, "h"),
      providerRef: PROVIDER_REF,
    });
    return {
      kind: "text" as const,
      text: "x".repeat(16 * 1024),
      providerRef: PROVIDER_REF,
      history: Array.from({ length: 17 }, (_value, index) => item(index)),
      resources: Array.from({ length: 16 }, (_value, index) => ({
        imMessageId: "m".repeat(128),
        ordinal: index,
        kind: "image" as const,
        filename: "f".repeat(512),
        mediaType: "image/png",
        sizeBytes: 1,
        availability: "available" as const,
      })),
    };
  }

  it("trims history and then resources until the built frame fits the wire cap", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator({
      assembleRuntime: async () => MAX_INSTRUCTIONS_RUNTIME,
      buildDeliveryContent: async () => oversizedContent() as never,
    });
    await coordinator.deliver(row, "token", ownedLease, signal);
    const sent = calls.dispatched[0] as DirectImMessageDeliveryRequest;
    expect(sent).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(sent), "utf8")).toBeLessThanOrEqual(RUNTIME_MAX_FRAME_BYTES);
    // History is dropped first, so the truncation flag records that earlier turns were left out.
    // With the schema's own byte caps (16 KiB text, 40 KiB history, 24 KiB instructions, 16
    // resources) history alone always closes the gap, so the resource pass below is unreachable.
    expect(sent.content.historyTruncated).toBe(true);
    expect(sent.content.history?.length ?? 0).toBeLessThan(17);
    expect(sent.content.resources).toHaveLength(16);
  });

  it("refuses a dispatch whose content cannot be trimmed under the wire cap", async () => {
    const row = claimRow();
    const { coordinator, calls } = makeCoordinator({
      // No history and no resources: there is nothing left to drop, so the frame is refused
      // rather than sent over the wire.
      buildDeliveryContent: async () =>
        ({ kind: "text", text: "x".repeat(RUNTIME_MAX_FRAME_BYTES), providerRef: PROVIDER_REF }) as never,
    });
    await coordinator.deliver(row, "token", ownedLease, signal);
    expect(calls.dispatched).toEqual([]);
    expect(calls.failures).toEqual([{ deliveryId: row.delivery.id, code: "IM_DELIVERY_RUNTIME_FAILED" }]);
  });
});
