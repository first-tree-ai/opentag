import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RunnerAuthFrameSchema, RunnerClientFrameSchema, RunnerServerFrameSchema } from "../cloud-runner.js";
import { ClientRuntimeBusinessFrameSchema, ServerRuntimeBusinessFrameSchema } from "../runtime-domain.js";
import { RUNTIME_CAPABILITY, RUNTIME_SERVER_CAPABILITY_OFFERS, RUNTIME_V0_CAPABILITIES } from "../runtime-protocol.js";
import { TurnActivityRequestSchema } from "../turn-activity.js";

const frame = {
  type: "turn:activity",
  requestId: randomUUID(),
  deliveryId: randomUUID(),
  sessionId: randomUUID(),
  agentId: randomUUID(),
  turnId: randomUUID(),
  placementGeneration: 1,
  sequence: 1,
  phase: "running",
};
describe("optional execution liveness contract", () => {
  it("shares the same request and ACK across Local and Cloud transports", () => {
    expect(ClientRuntimeBusinessFrameSchema.parse(frame)).toEqual(RunnerClientFrameSchema.parse(frame));
    const ack = {
      type: "turn:activity:result",
      requestId: frame.requestId,
      turnId: frame.turnId,
      sequence: 1,
      status: "recorded",
    };
    expect(ServerRuntimeBusinessFrameSchema.parse(ack)).toEqual(RunnerServerFrameSchema.parse(ack));
  });
  it("adds an optional capability without changing the frozen legacy vocabulary", () => {
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.turnActivity]).toEqual({ min: 1, max: 1 });
    expect(RUNTIME_V0_CAPABILITIES).not.toHaveProperty("turnActivity");
    expect(RunnerAuthFrameSchema.parse({ type: "auth", token: "token" })).not.toHaveProperty("turnActivityVersion");
    expect(
      RunnerAuthFrameSchema.parse({ type: "auth", token: "token", turnActivityVersion: 1 }).turnActivityVersion,
    ).toBe(1);
    expect(RunnerAuthFrameSchema.safeParse({ type: "auth", token: "token", turnActivityVersion: 2 }).success).toBe(
      false,
    );
  });
  it.each([
    { sequence: 0 },
    { sequence: -1 },
    { phase: "accepted" },
    { phase: "queued" },
    { status: "is working" },
    { secret: "token" },
  ])("rejects invalid or unrelated activity data %j", (change) => {
    expect(TurnActivityRequestSchema.safeParse({ ...frame, ...change }).success).toBe(false);
  });
});
