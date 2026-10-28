import { randomUUID } from "node:crypto";
import type { RuntimeImSteerRequest } from "@opentag/shared";
import { expect, it, vi } from "vitest";
import type { RuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { CloudImSteering } from "../services/sandboxes/cloud-im-steering.js";
import { CloudRuntimeFence } from "../services/sandboxes/cloud-runtime-fence.js";

it.each(["dispatched", "already_dispatched"] as const)(
  "keeps execution evidence correct when capacity rejects a %s steer",
  async (lastStatus) => {
    const sessionId = randomUUID();
    const record = new CloudRuntimeFence().attach({
      computerId: randomUUID(),
      installationId: randomUUID(),
      imInputVersion: 1,
      scope: {
        sandboxId: randomUUID(),
        sessionId,
        environmentGeneration: 1,
        resourceName: "projects/p/locations/r/instances/test",
      },
    });
    const requests = Array.from({ length: 1025 }, () => ({
      type: "im:steer" as const,
      requestId: randomUUID(),
      deliveryId: randomUUID(),
      imMessageId: randomUUID(),
      sessionId,
      agentId: randomUUID(),
      placementGeneration: 1,
      rootDeliveryId: randomUUID(),
      expectedTurnId: randomUUID(),
      attention: "direct" as const,
      content: {
        kind: "text" as const,
        text: "synthetic input",
        providerRef: {
          provider: "feishu" as const,
          teamBrand: "feishu" as const,
          appId: "app",
          botOpenId: "bot",
          chatId: "chat",
          messageId: "source",
        },
      },
    }));
    const last = requests.at(-1);
    if (!last) throw new Error("missing request");
    const reserved = new Set<string>();
    const begin = vi.fn(async (request: RuntimeImSteerRequest) => {
      reserved.add(request.deliveryId);
      return request === last ? lastStatus : ("dispatched" as const);
    });
    const release = vi.fn(async (request: RuntimeImSteerRequest) => {
      reserved.delete(request.deliveryId);
      return "released" as const;
    });
    const context = {
      computerId: record.computerId,
      installationId: record.installationId,
      instanceId: record.instanceId,
      signal: new AbortController().signal,
    };
    const send = vi.fn(() => true);
    const steering = new CloudImSteering({
      database: {} as never,
      custody: { beginSteerDispatch: begin, releaseSteerDispatch: release } as unknown as RuntimeCustodyStore,
      connection: async () => ({ record, context, send }),
      current: () => true,
      validAllocation: async () => true,
      context: () => context,
      send,
    });
    const results = requests.map((request) => steering.request(request, () => {}).catch((error: unknown) => error));
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1024));
      expect(await results.at(-1)).toMatchObject({ message: "CLOUD_STEER_CAPACITY" });
      if (lastStatus === "dispatched") {
        expect(release).toHaveBeenCalledWith(last, expect.any(String), "retry");
        expect(reserved.has(last.deliveryId)).toBe(false);
      } else {
        expect(release).not.toHaveBeenCalled();
        expect(reserved.has(last.deliveryId)).toBe(true);
      }
    } finally {
      steering.detach(record.connectionId);
      await Promise.all(results);
    }
  },
);

it.each([
  { status: "steered", mismatch: "none", acknowledges: true },
  { status: "deferred", mismatch: "none", acknowledges: true },
  { status: "steered", mismatch: "result_session", acknowledges: false },
  { status: "steered", mismatch: "parent_session", acknowledges: false },
  { status: "steered", mismatch: "parent_turn", acknowledges: false },
  { status: "deferred", mismatch: "completed_parent", acknowledges: false },
  { status: "deferred", mismatch: "unreported_parent", acknowledges: false },
] as const)(
  "settles old $status receipts after Session recovery with $mismatch proof",
  async ({ status, mismatch, acknowledges }) => {
    const sessionId = randomUUID();
    const record = new CloudRuntimeFence().attach({
      computerId: randomUUID(),
      installationId: randomUUID(),
      imInputVersion: 1,
      executionEligible: false,
      scope: {
        sandboxId: randomUUID(),
        sessionId,
        environmentGeneration: 1,
        resourceName: "projects/p/locations/r/instances/test",
      },
    });
    const requestId = randomUUID();
    const turnId = randomUUID();
    const deliveryId = randomUUID();
    const moved = { id: deliveryId, sessionId: randomUUID(), dispatchPayload: null, dispatchInputHash: null };
    const original = { ...moved };
    const parent = {
      sessionId: mismatch === "parent_session" ? randomUUID() : sessionId,
      turnId: mismatch === "parent_turn" ? randomUUID() : turnId,
      reportedAt: mismatch === "unreported_parent" ? null : new Date(),
      turnReport: { outcome: mismatch === "completed_parent" ? "completed" : "failed" },
    };
    const rows = [[moved], [parent]];
    const send = vi.fn(() => true);
    const custody = { recordSteered: vi.fn(), releaseSteerDispatch: vi.fn() };
    const steering = new CloudImSteering({
      database: { select: () => ({ from: () => ({ where: async () => rows.shift() ?? [] }) }) } as never,
      custody: custody as unknown as RuntimeCustodyStore,
      connection: async () => undefined,
      current: () => true,
      validAllocation: async () => true,
      context: () => {
        throw new Error("obsolete receipt must not mutate custody");
      },
      send,
    });
    const result = {
      type: "im:steer:result" as const,
      requestId,
      deliveryId,
      sessionId: mismatch === "result_session" ? randomUUID() : sessionId,
      placementGeneration: 1,
      rootDeliveryId: randomUUID(),
      expectedTurnId: turnId,
      status,
      ...(status === "deferred" ? { reason: "steer_state_unknown" as const } : {}),
    } as import("@opentag/shared").RuntimeImSteerResult;
    await steering.handle(record, { type: "delivery:steer:result", requestId, inputHash: "a".repeat(64), result });
    expect(send).toHaveBeenCalledTimes(acknowledges ? 1 : 0);
    if (acknowledges)
      expect(send).toHaveBeenCalledWith(record, {
        type: "delivery:steer:ack",
        requestId,
        deliveryId,
        inputHash: "a".repeat(64),
        status: "conflict",
      });
    expect(custody.recordSteered).not.toHaveBeenCalled();
    expect(custody.releaseSteerDispatch).not.toHaveBeenCalled();
    expect(moved).toEqual(original);
  },
);
