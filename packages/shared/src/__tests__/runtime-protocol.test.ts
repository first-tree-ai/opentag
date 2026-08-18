import { describe, expect, it } from "vitest";
import { ClientRuntimeFrameSchema, RUNTIME_PROTOCOL_VERSION, ServerRuntimeFrameSchema } from "../runtime-protocol.js";

describe("runtime protocol", () => {
  it("validates the versioned welcome and strict register frame", () => {
    expect(
      ServerRuntimeFrameSchema.parse({
        type: "server:welcome",
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
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
  });

  it("rejects unknown versions and oversized fields", () => {
    expect(() =>
      ServerRuntimeFrameSchema.parse({
        type: "server:welcome",
        protocolVersion: 2,
        heartbeatIntervalMs: 1,
        heartbeatTimeoutMs: 2,
      }),
    ).toThrow();
    expect(() =>
      ClientRuntimeFrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        accessToken: "x".repeat(4097),
      }),
    ).toThrow();
  });
});
