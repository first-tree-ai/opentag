import { describe, expect, it } from "vitest";
import {
  AuthV1FrameSchema,
  AuthV2FrameSchema,
  ClientRuntimeFrameSchema,
  missingRuntimeCapabilities,
  negotiateRuntimeCapabilities,
  RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_V1,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_REQUIRED_CLIENT_CAPABILITIES,
  RUNTIME_REQUIRED_SERVER_CAPABILITIES,
  RUNTIME_SERVER_CAPABILITY_OFFERS,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
  runtimeFrameByteLength,
  ServerRuntimeFrameSchema,
} from "../runtime-protocol.js";

describe("runtime protocol", () => {
  it("keeps the v1 handshake strict after the credential-grant capability replacement", () => {
    expect(
      ServerRuntimeFrameSchema.parse({
        type: "server:welcome",
        protocolVersion: RUNTIME_PROTOCOL_V1,
        capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imCredentialGrant: 1 },
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 90_000,
      }),
    ).toMatchObject({ type: "server:welcome", protocolVersion: RUNTIME_PROTOCOL_V1 });
    expect(() =>
      AuthV1FrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V1,
        machineToken: "machine",
        supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
      }),
    ).toThrow();

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
    expect(ClientRuntimeFrameSchema.parse(register)).toEqual({
      ...register,
      capabilities: { imCredentialGrant: 0 },
    });
    expect(
      ClientRuntimeFrameSchema.parse({
        ...register,
        capabilities: { imCredentialGrant: 1 },
        providerReadiness: [{ provider: "codex", status: "ready" }],
      }),
    ).toMatchObject({
      capabilities: { imCredentialGrant: 1 },
      providerReadiness: [{ provider: "codex", status: "ready" }],
    });
    expect(() =>
      ClientRuntimeFrameSchema.parse({
        ...register,
        providerReadiness: [
          { provider: "claude-code", status: "ready" },
          { provider: "codex", status: "ready" },
        ],
      }),
    ).toThrow();
    expect(
      ServerRuntimeFrameSchema.parse({
        type: "server:welcome",
        protocolVersion: RUNTIME_PROTOCOL_V1,
        capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imCredentialGrant: 1 },
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 90_000,
        providerReadiness: { version: 1, providers: ["codex"] },
      }),
    ).toMatchObject({ providerReadiness: { version: 1, providers: ["codex"] } });
    expect(() => ClientRuntimeFrameSchema.parse({ ...register, workspaceId: crypto.randomUUID() })).toThrow();
  });

  it("validates extensible v2 offers while keeping security fields strict", () => {
    const welcome = ServerRuntimeFrameSchema.parse({
      type: "server:welcome",
      protocolVersion: RUNTIME_PROTOCOL_V2,
      supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
      supportedCapabilities: {
        ...RUNTIME_SERVER_CAPABILITY_OFFERS,
        "future.optionalFeature": { min: 1, max: 3 },
      },
      requiredClientCapabilities: [],
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 90_000,
      futureAdvisory: "ignored",
    });
    expect(welcome).toMatchObject({
      protocolVersion: RUNTIME_PROTOCOL_V2,
      futureAdvisory: "ignored",
    });
    expect(
      AuthV2FrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
        machineToken: "machine",
      }),
    ).toMatchObject({ protocolVersion: RUNTIME_PROTOCOL_V2 });
    expect(() =>
      AuthV2FrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
        accessToken: "access",
        futureAuthField: true,
      }),
    ).toThrow();
  });

  it("selects the highest capability intersection and detects missing requirements", () => {
    const negotiated = negotiateRuntimeCapabilities(
      {
        ...RUNTIME_CLIENT_CAPABILITY_OFFERS,
        "future.optionalFeature": { min: 2, max: 5 },
      },
      {
        ...RUNTIME_SERVER_CAPABILITY_OFFERS,
        "future.optionalFeature": { min: 1, max: 3 },
        "server.unknownFeature": { min: 1, max: 1 },
      },
    );
    expect(negotiated["future.optionalFeature"]).toBe(3);
    expect(negotiated["server.unknownFeature"]).toBeUndefined();
    expect(missingRuntimeCapabilities(["runtime.imDelivery"], negotiated)).toEqual([]);
    expect(missingRuntimeCapabilities(["future.requiredFeature"], negotiated)).toEqual(["future.requiredFeature"]);
    expect(negotiated[RUNTIME_CAPABILITY.sessionCollaboration]).toBe(2);
    expect(RUNTIME_REQUIRED_CLIENT_CAPABILITIES).not.toContain(RUNTIME_CAPABILITY.sessionCollaboration);
    expect(RUNTIME_REQUIRED_SERVER_CAPABILITIES).not.toContain(RUNTIME_CAPABILITY.sessionCollaboration);
  });

  it("rejects invalid ranges, unknown protocol versions, and oversized fields", () => {
    expect(() =>
      AuthV2FrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        supportedProtocolVersions: { min: 3, max: 2 },
        accessToken: "access",
      }),
    ).toThrow();
    expect(() =>
      ClientRuntimeFrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        protocolVersion: 3,
        accessToken: "access",
      }),
    ).toThrow();
    expect(() =>
      ClientRuntimeFrameSchema.parse({
        type: "auth",
        requestId: crypto.randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
        accessToken: "x".repeat(4097),
      }),
    ).toThrow();
    expect(runtimeFrameByteLength("你")).toBe(3);
    expect(runtimeFrameByteLength("x".repeat(RUNTIME_MAX_FRAME_BYTES))).toBe(RUNTIME_MAX_FRAME_BYTES);
  });
});
