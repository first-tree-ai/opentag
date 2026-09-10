import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ComputerImCliReadinessSchema,
  ImBindingDiagnosticsSchema,
  ImBindingHandoffStatusSchema,
  INTEGRATION_CREDENTIAL_EXECUTION_REASONS,
  ProviderCliHandoffProgressSchema,
} from "../index.js";

/** Exact Computer IM CLI readiness shape at 8cc14e38786b53fdd9c876167eecf2fc3f40e890. Extra keys fail. */
const LegacyComputerImCliReadinessSchema = z
  .object({
    provider: z.enum(["feishu", "slack"]),
    status: z.enum(["checking", "install", "ready", "unavailable"]),
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

/** Exact handoff progress shape at 8cc14e38786b53fdd9c876167eecf2fc3f40e890. */
const LegacyProviderCliHandoffProgressSchema = z
  .object({
    phase: z.enum(["preparing_cli", "checking_credentials", "needs_attention"]),
    reason: z.enum(INTEGRATION_CREDENTIAL_EXECUTION_REASONS).optional(),
  })
  .strict();

const LegacyImBindingDiagnosticsSchema = z
  .object({
    imBindingId: z.string().uuid(),
    provider: z.enum(["feishu", "slack"]),
    ready: z.boolean(),
    agentRuntimeReadiness: z.enum(["checking", "install", "sign-in", "ready", "unavailable"]),
    providerCliReadiness: z.enum(["checking", "install", "ready", "unavailable"]),
    credentialExecutionReadiness: z.enum(["unconfirmed", "checking", "retrying", "ready", "needs_attention"]),
    credentialExecutionReason: z.enum(INTEGRATION_CREDENTIAL_EXECUTION_REASONS).optional(),
    credentialGeneration: z.number().int().min(0),
    credentialStatus: z.enum(["valid", "invalid"]),
    requiredCapabilities: z.array(z.string().min(1).max(160)).max(128),
    grantedCapabilities: z.array(z.string().min(1).max(160)).max(128),
    missingCapabilities: z.array(z.string().min(1).max(160)).max(128),
    reauthorizationRequired: z.boolean(),
    slackAppId: z
      .object({
        value: z.string().min(1).max(255),
        evidence: z.literal("configured"),
        ingressMatchRequired: z.literal(true),
      })
      .strict()
      .nullable(),
    slackIdentityClosure: z.unknown().nullable(),
    connection: z
      .object({
        state: z.enum(["connected", "disconnected"]),
        observedAt: z.string().datetime(),
      })
      .nullable(),
    lastInboundAt: z.string().datetime().nullable(),
    lastValidatedAt: z.string().datetime().nullable(),
    lastRuntimeObservationAt: z.string().datetime().nullable(),
    lastErrorCode: z.string().min(1).max(120).nullable(),
  })
  .strict();

const diagnostics = {
  imBindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
  provider: "feishu" as const,
  ready: false,
  agentRuntimeReadiness: "ready" as const,
  providerCliReadiness: "unavailable" as const,
  credentialExecutionReadiness: "needs_attention" as const,
  credentialExecutionReason: "credential_rejected" as const,
  credentialGeneration: 1,
  credentialStatus: "valid" as const,
  requiredCapabilities: [] as string[],
  grantedCapabilities: [] as string[],
  missingCapabilities: [] as string[],
  reauthorizationRequired: false,
  slackAppId: null,
  slackIdentityClosure: null,
  connection: null,
  lastInboundAt: null,
  lastValidatedAt: null,
  lastRuntimeObservationAt: null,
  lastErrorCode: null,
};

describe("frozen Provider CLI HTTP v1 parsers", () => {
  it("accepts the pre-#490 Computer IM CLI shape and rejects allowlisted reasons", () => {
    const v1 = { provider: "slack" as const, status: "unavailable" as const, observedAt: null };
    expect(LegacyComputerImCliReadinessSchema.parse(v1)).toEqual(v1);
    expect(ComputerImCliReadinessSchema.parse(v1)).toEqual(v1);
    expect(() => LegacyComputerImCliReadinessSchema.parse({ ...v1, reason: "unsupported_platform" })).toThrow();
    expect(ComputerImCliReadinessSchema.parse({ ...v1, reason: "unsupported_platform" })).toMatchObject({
      reason: "unsupported_platform",
    });
  });

  it("keeps legacy credential reasons on handoff and rejects artifact reasons and nextAction", () => {
    const credential = { phase: "needs_attention" as const, reason: "credential_rejected" as const };
    expect(LegacyProviderCliHandoffProgressSchema.parse(credential)).toEqual(credential);
    expect(ProviderCliHandoffProgressSchema.parse(credential)).toEqual(credential);
    expect(() =>
      LegacyProviderCliHandoffProgressSchema.parse({ ...credential, reason: "unsupported_platform" }),
    ).toThrow();
    expect(
      ProviderCliHandoffProgressSchema.parse({ phase: "needs_attention", reason: "unsupported_platform" }),
    ).toEqual({ phase: "needs_attention", reason: "unsupported_platform" });
    expect(() =>
      LegacyProviderCliHandoffProgressSchema.parse({ ...credential, nextAction: "use_supported_computer" }),
    ).toThrow();
    expect(() =>
      ImBindingHandoffStatusSchema.parse({
        bindingState: "active",
        handoffReady: false,
        providerCli: { phase: "needs_attention", nextAction: "retry" },
      }),
    ).toThrow();
  });

  it("accepts pre-#490 diagnostics and rejects providerCliReason", () => {
    expect(LegacyImBindingDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(ImBindingDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(() =>
      LegacyImBindingDiagnosticsSchema.parse({ ...diagnostics, providerCliReason: "unsupported_platform" }),
    ).toThrow();
    expect(
      ImBindingDiagnosticsSchema.parse({ ...diagnostics, providerCliReason: "unsupported_platform" }),
    ).toMatchObject({ providerCliReason: "unsupported_platform" });
  });
});
