import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ServerRuntimeDurabilityStore } from "../runtime/server-runtime-durability-store.js";

describe("ServerRuntimeDurabilityStore", () => {
  it("maps the existing persistence seam to the authenticated Server API", async () => {
    const record = {
      acceptedAt: 1,
      attempts: 0,
      key: "turn",
      kind: "turn-report" as const,
      payload: {
        type: "turn:report" as const,
        requestId: randomUUID(),
        deliveryId: "delivery",
        turnId: "turn",
        sessionId: "session",
        agentId: "agent",
        placementGeneration: 1,
        outcome: "completed" as const,
        executionEffects: "completed" as const,
        traceSummary: { lastSequence: 0, droppedEvents: 0 },
        resultHash: "a".repeat(64),
      },
      status: "accepted" as const,
      updatedAt: 1,
    };
    const api = {
      listRuntimeDurableWork: vi.fn().mockResolvedValue([record]),
      writeRuntimeDurableWork: vi.fn().mockResolvedValue(undefined),
    };
    let clockReads = 0;
    const store = new ServerRuntimeDurabilityStore({
      api,
      machineToken: "machine-token",
      now: () => {
        clockReads += 1;
        return 123;
      },
    });

    await expect(store.list("turn-report")).resolves.toEqual([record]);
    await store.write(record);
    expect(api.listRuntimeDurableWork).toHaveBeenCalledWith("machine-token", "turn-report");
    expect(api.writeRuntimeDurableWork).toHaveBeenCalledWith("machine-token", record);
    expect(clockReads).toBe(1);
  });
});
