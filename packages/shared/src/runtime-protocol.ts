import { z } from "zod";
import { AGENT_RUNTIME_PROVIDERS, AgentRuntimeProviderSchema } from "./agent.js";
import { ComputerPlatformSchema, ProviderReadinessStatusSchema } from "./computer.js";
import { ErrorCodeSchema } from "./errors.js";

export const RUNTIME_PROTOCOL_VERSION = 1 as const;
export const RUNTIME_V0_CAPABILITIES = {
  sessionReconcile: 1,
  imDelivery: 1,
  turnReport: 1,
  agentTrace: 1,
  imMessageTool: 1,
} as const;
export const RUNTIME_MAX_FRAME_BYTES = 64 * 1024;
export const RUNTIME_HEARTBEAT_INTERVAL_MIN_MS = 10;
export const RUNTIME_HEARTBEAT_INTERVAL_MAX_MS = 5 * 60 * 1_000;
export const RUNTIME_HEARTBEAT_TIMEOUT_MIN_MS = 100;
export const RUNTIME_HEARTBEAT_TIMEOUT_MAX_MS = 15 * 60 * 1_000;
export const RUNTIME_CLIENT_CAPABILITY_TTL_MS = 60_000;
export const RuntimeRequestIdSchema = z.string().uuid();

export const RuntimeFrameEnvelopeSchema = z
  .object({
    type: z.string().min(1).max(128),
    requestId: RuntimeRequestIdSchema.optional(),
    protocolVersion: z.number().int().safe().optional(),
  })
  .passthrough();

export const RuntimeHeartbeatIntervalMsSchema = z
  .number()
  .int()
  .min(RUNTIME_HEARTBEAT_INTERVAL_MIN_MS)
  .max(RUNTIME_HEARTBEAT_INTERVAL_MAX_MS);

export const RuntimeHeartbeatTimeoutMsSchema = z
  .number()
  .int()
  .min(RUNTIME_HEARTBEAT_TIMEOUT_MIN_MS)
  .max(RUNTIME_HEARTBEAT_TIMEOUT_MAX_MS);

export const RuntimeCapabilitiesSchema = z
  .object({
    sessionReconcile: z.literal(1),
    imDelivery: z.literal(1),
    turnReport: z.literal(1),
    agentTrace: z.literal(1),
    imMessageTool: z.literal(1),
  })
  .strict();

export const RuntimeClientCapabilitiesSchema = z
  .object({
    imMessageTool: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

export const RuntimeProviderReadinessObservationSchema = z
  .object({
    provider: AgentRuntimeProviderSchema,
    status: ProviderReadinessStatusSchema,
  })
  .strict();

export const RuntimeProviderReadinessCollectionSchema = z
  .array(RuntimeProviderReadinessObservationSchema)
  .max(AGENT_RUNTIME_PROVIDERS.length)
  .superRefine(validateCanonicalProviders);

export const RuntimeProviderReadinessNegotiationSchema = z
  .object({
    version: z.literal(1),
    providers: z.array(AgentRuntimeProviderSchema).max(AGENT_RUNTIME_PROVIDERS.length),
  })
  .strict()
  .superRefine((negotiation, context) => validateCanonicalProviderIds(negotiation.providers, context));

export const ServerWelcomeFrameSchema = z
  .object({
    type: z.literal("server:welcome"),
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    capabilities: RuntimeCapabilitiesSchema,
    heartbeatIntervalMs: RuntimeHeartbeatIntervalMsSchema,
    heartbeatTimeoutMs: RuntimeHeartbeatTimeoutMsSchema,
    providerReadiness: RuntimeProviderReadinessNegotiationSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.heartbeatTimeoutMs < frame.heartbeatIntervalMs * 2) {
      context.addIssue({
        code: "custom",
        path: ["heartbeatTimeoutMs"],
        message: "Heartbeat timeout must be at least twice the interval",
      });
    }
  });

export const AuthFrameSchema = z
  .object({
    type: z.literal("auth"),
    requestId: RuntimeRequestIdSchema,
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    accessToken: z.string().min(1).max(4096),
  })
  .strict();
export const AuthResultFrameSchema = z
  .object({
    type: z.literal("auth:result"),
    requestId: RuntimeRequestIdSchema,
    ok: z.boolean(),
    userId: z.string().uuid().optional(),
    tokenExpiresAt: z.string().datetime().optional(),
    errorCode: ErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.ok && (!frame.userId || !frame.tokenExpiresAt)) {
      context.addIssue({ code: "custom", message: "A successful auth result requires user identity and expiry" });
    }
    if (!frame.ok && !frame.errorCode) {
      context.addIssue({ code: "custom", message: "A failed auth result requires an error code" });
    }
  });
export const ComputerRegisterFrameSchema = z
  .object({
    type: z.literal("computer:register"),
    requestId: RuntimeRequestIdSchema,
    computerId: z.string().uuid(),
    instanceId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(255),
    platform: ComputerPlatformSchema,
    arch: z.string().trim().min(1).max(64),
    clientVersion: z.string().trim().min(1).max(64),
    capabilities: RuntimeClientCapabilitiesSchema.default({ imMessageTool: 0 }),
    providerReadiness: RuntimeProviderReadinessCollectionSchema.optional(),
  })
  .strict();
export const ComputerRegisterResultFrameSchema = z
  .object({
    type: z.literal("computer:register:result"),
    requestId: RuntimeRequestIdSchema,
    ok: z.boolean(),
    errorCode: ErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (!frame.ok && !frame.errorCode) {
      context.addIssue({ code: "custom", message: "A failed register result requires an error code" });
    }
  });
export const HeartbeatFrameSchema = z
  .object({
    type: z.literal("heartbeat"),
    requestId: RuntimeRequestIdSchema,
    computerId: z.string().uuid(),
    instanceId: z.string().uuid(),
    capabilities: RuntimeClientCapabilitiesSchema.default({ imMessageTool: 0 }),
    providerReadiness: RuntimeProviderReadinessCollectionSchema.optional(),
  })
  .strict();
export const HeartbeatResultFrameSchema = z
  .object({
    type: z.literal("heartbeat:result"),
    requestId: RuntimeRequestIdSchema,
    ok: z.boolean(),
    serverTime: z.string().datetime(),
    errorCode: ErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (!frame.ok && !frame.errorCode) {
      context.addIssue({ code: "custom", message: "A failed heartbeat result requires an error code" });
    }
  });
export const RuntimeErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    requestId: RuntimeRequestIdSchema.optional(),
    code: ErrorCodeSchema,
    message: z.string().min(1).max(512),
  })
  .strict();

export const ClientRuntimeFrameSchema = z.discriminatedUnion("type", [
  AuthFrameSchema,
  ComputerRegisterFrameSchema,
  HeartbeatFrameSchema,
  RuntimeErrorFrameSchema,
]);
export const ServerRuntimeFrameSchema = z.discriminatedUnion("type", [
  ServerWelcomeFrameSchema,
  AuthResultFrameSchema,
  ComputerRegisterResultFrameSchema,
  HeartbeatResultFrameSchema,
  RuntimeErrorFrameSchema,
]);

export type ServerWelcomeFrame = z.infer<typeof ServerWelcomeFrameSchema>;
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
export type RuntimeClientCapabilities = z.infer<typeof RuntimeClientCapabilitiesSchema>;
export type RuntimeProviderReadinessObservation = z.infer<typeof RuntimeProviderReadinessObservationSchema>;
export type RuntimeProviderReadinessCollection = z.infer<typeof RuntimeProviderReadinessCollectionSchema>;
export type RuntimeProviderReadinessNegotiation = z.infer<typeof RuntimeProviderReadinessNegotiationSchema>;
export type RuntimeFrameEnvelope = z.infer<typeof RuntimeFrameEnvelopeSchema>;
export type AuthFrame = z.infer<typeof AuthFrameSchema>;
export type AuthResultFrame = z.infer<typeof AuthResultFrameSchema>;
export type ComputerRegisterFrame = z.infer<typeof ComputerRegisterFrameSchema>;
export type ComputerRegisterResultFrame = z.infer<typeof ComputerRegisterResultFrameSchema>;
export type HeartbeatFrame = z.infer<typeof HeartbeatFrameSchema>;
export type HeartbeatResultFrame = z.infer<typeof HeartbeatResultFrameSchema>;
export type RuntimeErrorFrame = z.infer<typeof RuntimeErrorFrameSchema>;
export type ClientRuntimeFrame = z.infer<typeof ClientRuntimeFrameSchema>;
export type ServerRuntimeFrame = z.infer<typeof ServerRuntimeFrameSchema>;

export function runtimeFrameByteLength(serializedFrame: string): number {
  return new TextEncoder().encode(serializedFrame).byteLength;
}

function validateCanonicalProviders(
  observations: readonly { provider: (typeof AGENT_RUNTIME_PROVIDERS)[number] }[],
  context: z.RefinementCtx,
): void {
  validateCanonicalProviderIds(
    observations.map((observation) => observation.provider),
    context,
  );
}

function validateCanonicalProviderIds(
  providers: readonly (typeof AGENT_RUNTIME_PROVIDERS)[number][],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, provider] of providers.entries()) {
    if (seen.has(provider)) {
      context.addIssue({ code: "custom", path: [index], message: "Provider readiness must be unique" });
    }
    seen.add(provider);
    if (
      index > 0 &&
      AGENT_RUNTIME_PROVIDERS.indexOf(provider) < AGENT_RUNTIME_PROVIDERS.indexOf(providers[index - 1] ?? "codex")
    ) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "Provider readiness must use canonical Provider order",
      });
    }
  }
}
