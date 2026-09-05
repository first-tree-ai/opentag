import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OpenTagApi } from "../api.js";

describe("OpenTagApi durable Runtime pagination", () => {
  it("follows every server cursor while retaining the array return type", async () => {
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
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [record], nextCursor: "next" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ ...record, key: "turn-2" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const api = new OpenTagApi("https://opentag.example", fetchImpl);

    await expect(api.listRuntimeDurableWork("machine", "turn-report")).resolves.toEqual([
      record,
      { ...record, key: "turn-2" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("kind=turn-report");
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("cursor=");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("cursor=next");
  });
});
