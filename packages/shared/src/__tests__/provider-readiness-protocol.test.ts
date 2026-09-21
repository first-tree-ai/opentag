import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PROVIDER_READINESS_V1_HEADER,
  PROVIDER_READINESS_V2_HEADER,
  requestsProviderReadinessV1,
  requestsProviderReadinessV2,
} from "../computer.js";
import {
  advertisedProviderReadiness,
  negotiateProviderReadinessFromHeaders,
  RUNTIME_PROVIDER_READINESS_V1,
  RUNTIME_PROVIDER_READINESS_V1_PROVIDERS,
  RUNTIME_PROVIDER_READINESS_V2,
  RUNTIME_PROVIDER_READINESS_V2_PROVIDERS,
  RuntimeProviderReadinessNegotiationSchema,
  ServerWelcomeV1FrameSchema,
  ServerWelcomeV2FrameSchema,
} from "../runtime-protocol.js";

/**
 * Exact readiness negotiation vocabulary before Pi was added to the global
 * Agent runtime Provider enum. A v1 welcome that includes `pi` fails here,
 * which is what a base Client still on the frozen schema would do.
 */
const FrozenBaseReadinessV1NegotiationSchema = z
  .object({
    version: z.literal(1),
    providers: z.array(z.enum(["codex", "claude-code"])),
  })
  .strict();

const FrozenBaseWelcomeV1Schema = z
  .object({
    type: z.literal("server:welcome"),
    protocolVersion: z.literal(1),
    capabilities: z
      .object({
        sessionReconcile: z.literal(1),
        imDelivery: z.literal(1),
        turnReport: z.literal(1),
        agentTrace: z.literal(1),
        imCredentialGrant: z.literal(1),
      })
      .strict(),
    heartbeatIntervalMs: z.number(),
    heartbeatTimeoutMs: z.number(),
    providerReadiness: FrozenBaseReadinessV1NegotiationSchema.optional(),
  })
  .strict();

const v1Welcome = {
  type: "server:welcome" as const,
  protocolVersion: 1 as const,
  capabilities: {
    sessionReconcile: 1 as const,
    imDelivery: 1 as const,
    turnReport: 1 as const,
    agentTrace: 1 as const,
    imCredentialGrant: 1 as const,
  },
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 90_000,
};

const admitted = ["codex", "claude-code", "pi"] as const;

describe("provider readiness rolling-upgrade vocabulary", () => {
  it("freezes v1 negotiation to the pre-Pi exact vocabulary", () => {
    const frozen = { version: 1 as const, providers: ["codex", "claude-code"] as const };
    expect(FrozenBaseReadinessV1NegotiationSchema.parse(frozen)).toEqual(frozen);
    expect(RuntimeProviderReadinessNegotiationSchema.parse(frozen)).toEqual(frozen);
    expect(RUNTIME_PROVIDER_READINESS_V1_PROVIDERS).toEqual(["codex", "claude-code"]);

    const leaked = { version: 1 as const, providers: ["codex", "claude-code", "pi"] as const };
    expect(() => FrozenBaseReadinessV1NegotiationSchema.parse(leaked)).toThrow();
    expect(() => RuntimeProviderReadinessNegotiationSchema.parse(leaked)).toThrow();
    expect(() => ServerWelcomeV1FrameSchema.parse({ ...v1Welcome, providerReadiness: leaked })).toThrow();
    expect(() => FrozenBaseWelcomeV1Schema.parse({ ...v1Welcome, providerReadiness: leaked })).toThrow();
  });

  it("accepts Pi only on an explicit v2 negotiation", () => {
    const v2 = {
      version: RUNTIME_PROVIDER_READINESS_V2,
      providers: [...RUNTIME_PROVIDER_READINESS_V2_PROVIDERS],
    };
    expect(RuntimeProviderReadinessNegotiationSchema.parse(v2)).toEqual(v2);
    expect(() => FrozenBaseReadinessV1NegotiationSchema.parse(v2)).toThrow();
    expect(
      ServerWelcomeV2FrameSchema.parse({
        type: "server:welcome",
        protocolVersion: 2,
        supportedProtocolVersions: { min: 1, max: 2 },
        supportedCapabilities: { "runtime.turnReport": { min: 1, max: 1 } },
        requiredClientCapabilities: [],
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 90_000,
        providerReadiness: v2,
      }),
    ).toMatchObject({ providerReadiness: v2 });
  });

  it("prefers the v2 header only when it is an explicit opt-in", () => {
    expect(requestsProviderReadinessV1("1")).toBe(true);
    expect(requestsProviderReadinessV1(["1"])).toBe(true);
    expect(requestsProviderReadinessV1("2")).toBe(false);
    expect(requestsProviderReadinessV2("2")).toBe(true);
    expect(requestsProviderReadinessV2(["2"])).toBe(true);
    expect(requestsProviderReadinessV2("1")).toBe(false);
    expect(requestsProviderReadinessV2("v2")).toBe(false);

    expect(negotiateProviderReadinessFromHeaders({}, admitted)).toBeUndefined();
    expect(negotiateProviderReadinessFromHeaders({ [PROVIDER_READINESS_V1_HEADER]: "0" }, admitted)).toBeUndefined();
    expect(negotiateProviderReadinessFromHeaders({ [PROVIDER_READINESS_V2_HEADER]: "1" }, admitted)).toBeUndefined();

    expect(negotiateProviderReadinessFromHeaders({ [PROVIDER_READINESS_V1_HEADER]: "1" }, admitted)).toEqual({
      version: RUNTIME_PROVIDER_READINESS_V1,
      providers: [...RUNTIME_PROVIDER_READINESS_V1_PROVIDERS],
    });
    expect(
      FrozenBaseReadinessV1NegotiationSchema.parse(
        negotiateProviderReadinessFromHeaders({ [PROVIDER_READINESS_V1_HEADER]: "1" }, admitted),
      ),
    ).toEqual({
      version: 1,
      providers: ["codex", "claude-code"],
    });

    expect(negotiateProviderReadinessFromHeaders({ [PROVIDER_READINESS_V2_HEADER]: "2" }, admitted)).toEqual({
      version: RUNTIME_PROVIDER_READINESS_V2,
      providers: [...RUNTIME_PROVIDER_READINESS_V2_PROVIDERS],
    });
    expect(
      negotiateProviderReadinessFromHeaders(
        { [PROVIDER_READINESS_V1_HEADER]: "1", [PROVIDER_READINESS_V2_HEADER]: "2" },
        admitted,
      ),
    ).toEqual({
      version: RUNTIME_PROVIDER_READINESS_V2,
      providers: [...RUNTIME_PROVIDER_READINESS_V2_PROVIDERS],
    });
    expect(
      negotiateProviderReadinessFromHeaders(
        { [PROVIDER_READINESS_V1_HEADER]: "1", [PROVIDER_READINESS_V2_HEADER]: "bogus" },
        admitted,
      ),
    ).toEqual({
      version: RUNTIME_PROVIDER_READINESS_V1,
      providers: [...RUNTIME_PROVIDER_READINESS_V1_PROVIDERS],
    });
  });

  it("never advertises Pi under v1 even when the admitted set includes it", () => {
    expect(advertisedProviderReadiness(RUNTIME_PROVIDER_READINESS_V1, admitted)).toEqual({
      version: RUNTIME_PROVIDER_READINESS_V1,
      providers: ["codex", "claude-code"],
    });
    expect(advertisedProviderReadiness(RUNTIME_PROVIDER_READINESS_V1, ["pi"])).toBeUndefined();
    expect(advertisedProviderReadiness(RUNTIME_PROVIDER_READINESS_V2, admitted)).toEqual({
      version: RUNTIME_PROVIDER_READINESS_V2,
      providers: ["codex", "claude-code", "pi"],
    });
  });
});
