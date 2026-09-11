import { describe, expect, it } from "vitest";
import {
  AuthResultFrameSchema,
  AuthV1FrameSchema,
  AuthV2FrameSchema,
  ClientRuntimeFrameSchema,
  ComputerRegisterResultV1FrameSchema,
  ComputerRegisterResultV2FrameSchema,
  HeartbeatResultV1FrameSchema,
  HeartbeatResultV2FrameSchema,
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
  RuntimeCapabilityNameSchema,
  RuntimeCapabilityRangeSchema,
  RuntimeImCliReadinessCollectionSchema,
  RuntimeProtocolRangeSchema,
  RuntimeProviderReadinessCollectionSchema,
  RuntimeProviderReadinessNegotiationSchema,
  runtimeFrameByteLength,
  runtimeNegotiatedCapabilitiesEqual,
  ServerRuntimeFrameSchema,
  ServerWelcomeV1FrameSchema,
  ServerWelcomeV2FrameSchema,
} from "../runtime-protocol.js";

describe("runtime protocol", () => {
  it("requires the Computer identity on a successful auth result and an error code on failure", () => {
    const ok = {
      type: "auth:result" as const,
      requestId: crypto.randomUUID(),
      ok: true,
      computerId: crypto.randomUUID(),
      installationId: crypto.randomUUID(),
    };
    expect(AuthResultFrameSchema.parse(ok)).toEqual(ok);
    expect(() => AuthResultFrameSchema.parse({ ...ok, computerId: undefined })).toThrow(
      "requires the Computer identity",
    );
    expect(() => AuthResultFrameSchema.parse({ ...ok, installationId: undefined })).toThrow(
      "requires the Computer identity",
    );
    const rejected = {
      type: "auth:result" as const,
      requestId: ok.requestId,
      ok: false,
      errorCode: "AUTH_INVALID_TOKEN" as const,
    };
    expect(AuthResultFrameSchema.parse(rejected)).toEqual(rejected);
    expect(() => AuthResultFrameSchema.parse({ type: "auth:result", requestId: ok.requestId, ok: false })).toThrow(
      "requires an error code",
    );
  });

  it("negotiates credential grants across v1 and v2", () => {
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.imCredentialGrant]).toEqual({ min: 1, max: 2 });
    expect(RUNTIME_CLIENT_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.imCredentialGrant]).toEqual({ min: 1, max: 2 });
    expect(
      negotiateRuntimeCapabilities(
        { [RUNTIME_CAPABILITY.imCredentialGrant]: { min: 1, max: 1 } },
        RUNTIME_SERVER_CAPABILITY_OFFERS,
      ),
    ).toEqual({ [RUNTIME_CAPABILITY.imCredentialGrant]: 1 });
  });

  it("negotiates observer-safe IM delivery and steer independently from owner-compatible v1", () => {
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.imDelivery]).toEqual({ min: 1, max: 2 });
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.imSteer]).toEqual({ min: 1, max: 2 });
    expect(
      negotiateRuntimeCapabilities(
        {
          [RUNTIME_CAPABILITY.imDelivery]: { min: 1, max: 1 },
          [RUNTIME_CAPABILITY.imSteer]: { min: 1, max: 1 },
        },
        RUNTIME_SERVER_CAPABILITY_OFFERS,
      ),
    ).toEqual({ [RUNTIME_CAPABILITY.imDelivery]: 1, [RUNTIME_CAPABILITY.imSteer]: 1 });
  });

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
      installationId: crypto.randomUUID(),
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
    expect(() => ClientRuntimeFrameSchema.parse({ ...register, accountId: crypto.randomUUID() })).toThrow();
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
    expect(negotiated[RUNTIME_CAPABILITY.imDelivery]).toBe(2);
    expect(negotiated[RUNTIME_CAPABILITY.imSteer]).toBe(2);
    expect(negotiated[RUNTIME_CAPABILITY.agentRuntimeTest]).toBe(1);
    expect(negotiated[RUNTIME_CAPABILITY.turnReport]).toBe(2);
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.agentRuntimeTest]).toEqual({ min: 1, max: 1 });
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.turnReport]).toEqual({ min: 1, max: 2 });
    expect(
      negotiateRuntimeCapabilities(
        { [RUNTIME_CAPABILITY.turnReport]: { min: 1, max: 1 } },
        RUNTIME_SERVER_CAPABILITY_OFFERS,
      ),
    ).toEqual({ [RUNTIME_CAPABILITY.turnReport]: 1 });
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

  it("advertises the channel target only on v2 heartbeat results with an exact SemVer", () => {
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.channelTarget]).toEqual({ min: 1, max: 1 });
    expect(RUNTIME_CLIENT_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.channelTarget]).toEqual({ min: 1, max: 1 });
    expect(RUNTIME_REQUIRED_CLIENT_CAPABILITIES).not.toContain(RUNTIME_CAPABILITY.channelTarget);
    expect(RUNTIME_REQUIRED_SERVER_CAPABILITIES).not.toContain(RUNTIME_CAPABILITY.channelTarget);

    const heartbeatResult = {
      type: "heartbeat:result",
      requestId: crypto.randomUUID(),
      ok: true,
      serverTime: new Date().toISOString(),
      protocolVersion: RUNTIME_PROTOCOL_V2,
      connectionId: crypto.randomUUID(),
    };
    const parsed = ServerRuntimeFrameSchema.parse({
      ...heartbeatResult,
      channelTarget: { channel: "staging", version: "0.0.3-staging.1.1" },
    });
    expect(parsed).toMatchObject({ channelTarget: { channel: "staging", version: "0.0.3-staging.1.1" } });
    expect(ServerRuntimeFrameSchema.parse(heartbeatResult)).toMatchObject({ ok: true });
    expect(() =>
      ServerRuntimeFrameSchema.parse({
        ...heartbeatResult,
        channelTarget: { channel: "staging", version: "latest" },
      }),
    ).toThrow();
    expect(() =>
      ServerRuntimeFrameSchema.parse({
        ...heartbeatResult,
        channelTarget: { channel: "production", version: "0.0.3" },
      }),
    ).toThrow();
    expect(() =>
      ServerRuntimeFrameSchema.parse({
        type: "heartbeat:result",
        requestId: crypto.randomUUID(),
        ok: true,
        serverTime: new Date().toISOString(),
        channelTarget: { channel: "staging", version: "0.0.3-staging.1.1" },
      }),
    ).toThrow();
  });
});

describe("runtime protocol refinements", () => {
  const v1Welcome = {
    type: "server:welcome",
    protocolVersion: RUNTIME_PROTOCOL_V1,
    capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imCredentialGrant: 1 },
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 90_000,
  };
  const v2Welcome = {
    type: "server:welcome",
    protocolVersion: RUNTIME_PROTOCOL_V2,
    supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
    supportedCapabilities: RUNTIME_SERVER_CAPABILITY_OFFERS,
    requiredClientCapabilities: [],
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 90_000,
  };

  it("rejects inverted protocol and capability ranges", () => {
    expect(RuntimeProtocolRangeSchema.parse({ min: 1, max: 1 })).toEqual({ min: 1, max: 1 });
    expect(() => RuntimeProtocolRangeSchema.parse({ min: 2, max: 1 })).toThrow(
      "Protocol range minimum exceeds maximum",
    );
    expect(RuntimeCapabilityRangeSchema.parse({ min: 1, max: 3 })).toEqual({ min: 1, max: 3 });
    expect(() => RuntimeCapabilityRangeSchema.parse({ min: 2, max: 1 })).toThrow(
      "Capability range minimum exceeds maximum",
    );
  });

  it("requires namespaced, unique capability names", () => {
    expect(RuntimeCapabilityNameSchema.parse("runtime.imDelivery")).toBe("runtime.imDelivery");
    expect(() => RuntimeCapabilityNameSchema.parse("imDelivery")).toThrow("namespaced identifiers");
    expect(() => RuntimeCapabilityNameSchema.parse("Runtime.imDelivery")).toThrow("namespaced identifiers");
    expect(
      ServerWelcomeV2FrameSchema.parse({
        ...v2Welcome,
        requiredClientCapabilities: [RUNTIME_CAPABILITY.imDelivery, RUNTIME_CAPABILITY.imSteer],
      }),
    ).toMatchObject({ requiredClientCapabilities: [RUNTIME_CAPABILITY.imDelivery, RUNTIME_CAPABILITY.imSteer] });
    expect(() =>
      ServerWelcomeV2FrameSchema.parse({
        ...v2Welcome,
        requiredClientCapabilities: [RUNTIME_CAPABILITY.imDelivery, RUNTIME_CAPABILITY.imDelivery],
      }),
    ).toThrow("Required capabilities must be unique");
  });

  it("requires readiness observations to be unique and in canonical Provider order", () => {
    const imCli = [
      { provider: "feishu", status: "ready" },
      { provider: "slack", status: "install" },
    ];
    expect(RuntimeImCliReadinessCollectionSchema.parse(imCli)).toEqual(imCli);
    expect(RuntimeImCliReadinessCollectionSchema.parse([])).toEqual([]);
    expect(() => RuntimeImCliReadinessCollectionSchema.parse([...imCli].reverse())).toThrow(
      "IM CLI readiness must use canonical Provider order",
    );
    expect(() => RuntimeImCliReadinessCollectionSchema.parse([imCli[0], imCli[0]])).toThrow(
      "IM CLI readiness must be unique",
    );

    const providers = [
      { provider: "codex", status: "ready" },
      { provider: "claude-code", status: "sign-in" },
    ];
    expect(RuntimeProviderReadinessCollectionSchema.parse(providers)).toEqual(providers);
    expect(() => RuntimeProviderReadinessCollectionSchema.parse([providers[1], providers[0]])).toThrow(
      "Provider readiness must use canonical Provider order",
    );
    expect(() => RuntimeProviderReadinessCollectionSchema.parse([providers[0], providers[0]])).toThrow(
      "Provider readiness must be unique",
    );

    expect(
      RuntimeProviderReadinessNegotiationSchema.parse({ version: 1, providers: ["codex", "claude-code"] }),
    ).toEqual({
      version: 1,
      providers: ["codex", "claude-code"],
    });
    expect(() =>
      RuntimeProviderReadinessNegotiationSchema.parse({ version: 1, providers: ["claude-code", "codex"] }),
    ).toThrow("Provider readiness must use canonical Provider order");
    expect(() =>
      RuntimeProviderReadinessNegotiationSchema.parse({ version: 1, providers: ["codex", "codex"] }),
    ).toThrow("Provider readiness must be unique");
  });

  it("requires the heartbeat timeout to be at least twice the interval on every welcome", () => {
    expect(ServerWelcomeV1FrameSchema.parse({ ...v1Welcome, heartbeatTimeoutMs: 60_000 })).toMatchObject({
      heartbeatTimeoutMs: 60_000,
    });
    expect(() => ServerWelcomeV1FrameSchema.parse({ ...v1Welcome, heartbeatTimeoutMs: 59_999 })).toThrow(
      "Heartbeat timeout must be at least twice the interval",
    );
    expect(() => ServerWelcomeV2FrameSchema.parse({ ...v2Welcome, heartbeatTimeoutMs: 59_999 })).toThrow(
      "Heartbeat timeout must be at least twice the interval",
    );
  });

  it("rejects handshakes whose supported range excludes the selected v2 protocol", () => {
    expect(
      ServerWelcomeV2FrameSchema.parse({ ...v2Welcome, supportedProtocolVersions: { min: 2, max: 2 } }),
    ).toMatchObject({ supportedProtocolVersions: { min: 2, max: 2 } });
    expect(() =>
      ServerWelcomeV2FrameSchema.parse({ ...v2Welcome, supportedProtocolVersions: { min: 3, max: 4 } }),
    ).toThrow("outside the Server-supported range");
    expect(() =>
      ServerWelcomeV2FrameSchema.parse({ ...v2Welcome, supportedProtocolVersions: { min: 1, max: 1 } }),
    ).toThrow("outside the Server-supported range");

    const auth = {
      type: "auth",
      requestId: crypto.randomUUID(),
      protocolVersion: RUNTIME_PROTOCOL_V2,
      supportedProtocolVersions: { min: 2, max: 2 },
      machineToken: "machine",
    };
    expect(AuthV2FrameSchema.parse(auth)).toEqual(auth);
    expect(() => AuthV2FrameSchema.parse({ ...auth, supportedProtocolVersions: { min: 3, max: 4 } })).toThrow(
      "outside the Client-supported range",
    );
    expect(() => AuthV2FrameSchema.parse({ ...auth, supportedProtocolVersions: { min: 1, max: 1 } })).toThrow(
      "outside the Client-supported range",
    );
  });

  it("requires an error code on every failed result frame", () => {
    const registerResult = { type: "computer:register:result", requestId: crypto.randomUUID(), ok: false };
    expect(ComputerRegisterResultV1FrameSchema.parse({ ...registerResult, ok: true })).toMatchObject({ ok: true });
    expect(
      ComputerRegisterResultV1FrameSchema.parse({ ...registerResult, errorCode: "COMPUTER_IDENTITY_CONFLICT" }),
    ).toMatchObject({ ok: false, errorCode: "COMPUTER_IDENTITY_CONFLICT" });
    expect(() => ComputerRegisterResultV1FrameSchema.parse(registerResult)).toThrow(
      "A failed result requires an error code",
    );

    const heartbeatResult = {
      type: "heartbeat:result",
      requestId: crypto.randomUUID(),
      ok: false,
      serverTime: new Date().toISOString(),
    };
    expect(
      HeartbeatResultV1FrameSchema.parse({ ...heartbeatResult, errorCode: "COMPUTER_NOT_REGISTERED" }),
    ).toMatchObject({ ok: false, errorCode: "COMPUTER_NOT_REGISTERED" });
    expect(() => HeartbeatResultV1FrameSchema.parse(heartbeatResult)).toThrow("A failed result requires an error code");
    const heartbeatResultV2 = {
      ...heartbeatResult,
      protocolVersion: RUNTIME_PROTOCOL_V2,
      connectionId: crypto.randomUUID(),
    };
    expect(
      HeartbeatResultV2FrameSchema.parse({ ...heartbeatResultV2, errorCode: "COMPUTER_NOT_REGISTERED" }),
    ).toMatchObject({ ok: false, errorCode: "COMPUTER_NOT_REGISTERED" });
    expect(() => HeartbeatResultV2FrameSchema.parse(heartbeatResultV2)).toThrow(
      "A failed result requires an error code",
    );
  });

  it("ties v2 registration fencing state to the registration outcome", () => {
    const base = {
      type: "computer:register:result",
      requestId: crypto.randomUUID(),
      protocolVersion: RUNTIME_PROTOCOL_V2,
    };
    const connectionId = crypto.randomUUID();
    const negotiatedCapabilities = { [RUNTIME_CAPABILITY.imDelivery]: 2 };
    const accepted = { ...base, ok: true, connectionId, negotiatedCapabilities };
    expect(ComputerRegisterResultV2FrameSchema.parse(accepted)).toEqual(accepted);
    expect(ComputerRegisterResultV2FrameSchema.parse({ ...accepted, negotiatedCapabilities: {} })).toEqual({
      ...accepted,
      negotiatedCapabilities: {},
    });
    expect(() => ComputerRegisterResultV2FrameSchema.parse({ ...base, ok: true, negotiatedCapabilities })).toThrow(
      "A successful v2 registration requires negotiated fencing state",
    );
    expect(() => ComputerRegisterResultV2FrameSchema.parse({ ...base, ok: true, connectionId })).toThrow(
      "A successful v2 registration requires negotiated fencing state",
    );

    const rejected = { ...base, ok: false, errorCode: "COMPUTER_IDENTITY_CONFLICT" };
    expect(ComputerRegisterResultV2FrameSchema.parse(rejected)).toEqual(rejected);
    expect(() => ComputerRegisterResultV2FrameSchema.parse({ ...base, ok: false })).toThrow(
      "A failed result requires an error code",
    );
    expect(() => ComputerRegisterResultV2FrameSchema.parse({ ...rejected, connectionId })).toThrow(
      "A failed v2 registration forbids negotiated fencing state",
    );
    expect(() => ComputerRegisterResultV2FrameSchema.parse({ ...rejected, negotiatedCapabilities })).toThrow(
      "A failed v2 registration forbids negotiated fencing state",
    );
    expect(() => ComputerRegisterResultV2FrameSchema.parse({ ...base, ok: false, connectionId })).toThrow(
      "A failed v2 registration forbids negotiated fencing state",
    );
  });

  it("skips capabilities the remote does not offer or cannot overlap, in sorted order", () => {
    const negotiated = negotiateRuntimeCapabilities(
      {
        "zeta.localOnly": { min: 1, max: 1 },
        "beta.disjoint": { min: 3, max: 4 },
        "alpha.shared": { min: 1, max: 2 },
        "gamma.pinned": { min: 2, max: 2 },
      },
      {
        "gamma.pinned": { min: 1, max: 3 },
        "alpha.shared": { min: 2, max: 5 },
        "beta.disjoint": { min: 1, max: 2 },
        "delta.remoteOnly": { min: 1, max: 1 },
      },
    );
    expect(negotiated).toEqual({ "alpha.shared": 2, "gamma.pinned": 2 });
    expect(Object.keys(negotiated)).toEqual(["alpha.shared", "gamma.pinned"]);
    expect(negotiateRuntimeCapabilities({}, RUNTIME_SERVER_CAPABILITY_OFFERS)).toEqual({});
    expect(missingRuntimeCapabilities([], negotiated)).toEqual([]);
    expect(missingRuntimeCapabilities(["beta.disjoint", "alpha.shared", "zeta.localOnly"], negotiated)).toEqual([
      "beta.disjoint",
      "zeta.localOnly",
    ]);
  });

  it("compares negotiated capabilities by content regardless of key order", () => {
    expect(runtimeNegotiatedCapabilitiesEqual({}, {})).toBe(true);
    expect(
      runtimeNegotiatedCapabilitiesEqual(
        { [RUNTIME_CAPABILITY.imDelivery]: 2, [RUNTIME_CAPABILITY.agentTrace]: 1 },
        { [RUNTIME_CAPABILITY.agentTrace]: 1, [RUNTIME_CAPABILITY.imDelivery]: 2 },
      ),
    ).toBe(true);
    expect(
      runtimeNegotiatedCapabilitiesEqual(
        { [RUNTIME_CAPABILITY.imDelivery]: 2 },
        { [RUNTIME_CAPABILITY.imDelivery]: 1 },
      ),
    ).toBe(false);
    expect(
      runtimeNegotiatedCapabilitiesEqual(
        { [RUNTIME_CAPABILITY.imDelivery]: 2 },
        { [RUNTIME_CAPABILITY.imDelivery]: 2, [RUNTIME_CAPABILITY.agentTrace]: 1 },
      ),
    ).toBe(false);
    expect(
      runtimeNegotiatedCapabilitiesEqual({ [RUNTIME_CAPABILITY.imDelivery]: 2 }, { [RUNTIME_CAPABILITY.imSteer]: 2 }),
    ).toBe(false);
  });
});
