import { describe, expect, it } from "vitest";
import {
  ClientRuntimeFrameSchema,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  runtimeFrameByteLength,
  ServerRuntimeFrameSchema,
} from "../runtime-protocol.js";

describe("runtime protocol", () => {
  it("validates the versioned welcome and strict register frame", () => {
    expect(
      ServerRuntimeFrameSchema.parse({
        type: "server:welcome",
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1 },
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 90_000,
      }),
    ).toMatchObject({ type: "server:welcome" });

    const register = {
      type: "computer:register",
      requestId: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      displayName: "host",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    };
    expect(ClientRuntimeFrameSchema.parse(register)).toEqual(register);
    expect(() => ClientRuntimeFrameSchema.parse({ ...register, teamId: crypto.randomUUID() })).toThrow();
    expect(
      ClientRuntimeFrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        accessToken: "access",
      }),
    ).toMatchObject({ type: "auth", protocolVersion: RUNTIME_PROTOCOL_VERSION });
  });

  it("rejects unknown versions and oversized fields", () => {
    expect(() =>
      ServerRuntimeFrameSchema.parse({
        type: "server:welcome",
        protocolVersion: 2,
        capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1 },
        heartbeatIntervalMs: 1,
        heartbeatTimeoutMs: 2,
      }),
    ).toThrow();
    expect(() =>
      ClientRuntimeFrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        accessToken: "x".repeat(4097),
      }),
    ).toThrow();
    expect(() =>
      ClientRuntimeFrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        protocolVersion: 2,
        accessToken: "access",
      }),
    ).toThrow();
    expect(() =>
      ServerRuntimeFrameSchema.parse({
        type: "server:welcome",
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1 },
        heartbeatIntervalMs: 1,
        heartbeatTimeoutMs: 90_000,
      }),
    ).toThrow();
    expect(runtimeFrameByteLength("你")).toBe(3);
    expect(runtimeFrameByteLength("x".repeat(RUNTIME_MAX_FRAME_BYTES))).toBe(RUNTIME_MAX_FRAME_BYTES);
  });
});
