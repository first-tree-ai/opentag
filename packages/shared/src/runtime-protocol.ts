import { z } from "zod";
import { AGENT_RUNTIME_PROVIDERS, AgentRuntimeProviderSchema } from "./agent.js";
import {
  ComputerPlatformSchema,
  IM_CLI_PROVIDERS,
  ImCliProviderSchema,
  ImCliReadinessStatusSchema,
  ProviderReadinessStatusSchema,
} from "./computer.js";
import { ErrorCodeSchema } from "./errors.js";

export const RUNTIME_PROTOCOL_V1 = 1 as const;
export const RUNTIME_PROTOCOL_V2 = 2 as const;
export const RUNTIME_PROTOCOL_VERSION = RUNTIME_PROTOCOL_V2;
export const RUNTIME_SUPPORTED_PROTOCOL_VERSIONS = { min: RUNTIME_PROTOCOL_V1, max: RUNTIME_PROTOCOL_V2 } as const;

export const RUNTIME_V0_CAPABILITIES = {
  sessionReconcile: 1,
  imDelivery: 1,
  turnReport: 1,
  agentTrace: 1,
  imCredentialGrant: 1,
} as const;

export const RUNTIME_CAPABILITY = {
  agentTrace: "runtime.agentTrace",
  imDelivery: "runtime.imDelivery",
  imCredentialGrant: "runtime.imCredentialGrant",
  sessionCollaboration: "runtime.sessionCollaboration",
  sessionReconcile: "runtime.sessionReconcile",
  turnReport: "runtime.turnReport",
} as const;

export const RUNTIME_SERVER_CAPABILITY_OFFERS = {
  [RUNTIME_CAPABILITY.agentTrace]: { min: 1, max: 1 },
  [RUNTIME_CAPABILITY.imDelivery]: { min: 1, max: 1 },
  [RUNTIME_CAPABILITY.imCredentialGrant]: { min: 1, max: 1 },
  [RUNTIME_CAPABILITY.sessionCollaboration]: { min: 1, max: 1 },
  [RUNTIME_CAPABILITY.sessionReconcile]: { min: 1, max: 1 },
  [RUNTIME_CAPABILITY.turnReport]: { min: 1, max: 1 },
} as const;

export const RUNTIME_CLIENT_CAPABILITY_OFFERS = RUNTIME_SERVER_CAPABILITY_OFFERS;
export const RUNTIME_REQUIRED_CLIENT_CAPABILITIES: readonly string[] = [];
export const RUNTIME_REQUIRED_SERVER_CAPABILITIES: readonly string[] = [];

export const RUNTIME_MAX_FRAME_BYTES = 64 * 1024;
export const RUNTIME_HEARTBEAT_INTERVAL_MIN_MS = 10;
export const RUNTIME_HEARTBEAT_INTERVAL_MAX_MS = 5 * 60 * 1_000;
export const RUNTIME_HEARTBEAT_TIMEOUT_MIN_MS = 100;
export const RUNTIME_HEARTBEAT_TIMEOUT_MAX_MS = 15 * 60 * 1_000;
export const RUNTIME_CLIENT_CAPABILITY_TTL_MS = 60_000;
export const RuntimeRequestIdSchema = z.string().uuid();
export const RuntimeConnectionIdSchema = z.string().uuid();

export const RuntimeFrameEnvelopeSchema = z
  .object({
    type: z.string().min(1).max(128),
    requestId: RuntimeRequestIdSchema.optional(),
    protocolVersion: z.number().int().safe().optional(),
    connectionId: RuntimeConnectionIdSchema.optional(),
    critical: z.boolean().optional(),
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

export const RuntimeProtocolRangeSchema = z
  .object({
    min: z.number().int().safe().positive(),
    max: z.number().int().safe().positive(),
  })
  .strict()
  .superRefine((range, context) => {
    if (range.min > range.max) {
      context.addIssue({ code: "custom", path: ["min"], message: "Protocol range minimum exceeds maximum" });
    }
  });

export const RuntimeCapabilityRangeSchema = z
  .object({
    min: z.number().int().safe().positive(),
    max: z.number().int().safe().positive(),
  })
  .strict()
  .superRefine((range, context) => {
    if (range.min > range.max) {
      context.addIssue({ code: "custom", path: ["min"], message: "Capability range minimum exceeds maximum" });
    }
  });

export const RuntimeCapabilityNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/, "Capability names must be namespaced identifiers");

export const RuntimeCapabilityOffersSchema = z.record(RuntimeCapabilityNameSchema, RuntimeCapabilityRangeSchema);
export const RuntimeRequiredCapabilitiesSchema = z
  .array(RuntimeCapabilityNameSchema)
  .max(128)
  .superRefine((capabilities, context) => {
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({ code: "custom", message: "Required capabilities must be unique" });
    }
  });
export const RuntimeNegotiatedCapabilitiesSchema = z.record(
  RuntimeCapabilityNameSchema,
  z.number().int().safe().positive(),
);

export const RuntimeCapabilitiesSchema = z
  .object({
    sessionReconcile: z.literal(1),
    imDelivery: z.literal(1),
    turnReport: z.literal(1),
    agentTrace: z.literal(1),
    imCredentialGrant: z.literal(1),
  })
  .strict();

export const RuntimeClientCapabilitiesSchema = z
  .object({
    imCredentialGrant: z.union([z.literal(0), z.literal(1)]),
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

export const RuntimeImCliReadinessObservationSchema = z
  .object({
    provider: ImCliProviderSchema,
    status: ImCliReadinessStatusSchema,
  })
  .strict();

export const RuntimeImCliReadinessCollectionSchema = z
  .array(RuntimeImCliReadinessObservationSchema)
  .max(IM_CLI_PROVIDERS.length)
  .superRefine((observations, context) =>
    validateCanonicalIds(
      observations.map((observation) => observation.provider),
      IM_CLI_PROVIDERS,
      "IM CLI readiness",
      context,
    ),
  );

export const RuntimeProviderReadinessNegotiationSchema = z
  .object({
    version: z.literal(1),
    providers: z.array(AgentRuntimeProviderSchema).max(AGENT_RUNTIME_PROVIDERS.length),
  })
  .strict()
  .superRefine((negotiation, context) => validateCanonicalProviderIds(negotiation.providers, context));

const heartbeatPolicyShape = {
  heartbeatIntervalMs: RuntimeHeartbeatIntervalMsSchema,
  heartbeatTimeoutMs: RuntimeHeartbeatTimeoutMsSchema,
};

function validateHeartbeatPolicy(
  frame: { heartbeatIntervalMs: number; heartbeatTimeoutMs: number },
  context: z.RefinementCtx,
): void {
  if (frame.heartbeatTimeoutMs < frame.heartbeatIntervalMs * 2) {
    context.addIssue({
      code: "custom",
      path: ["heartbeatTimeoutMs"],
      message: "Heartbeat timeout must be at least twice the interval",
    });
  }
}

export const ServerWelcomeV1FrameSchema = z
  .object({
    type: z.literal("server:welcome"),
    protocolVersion: z.literal(RUNTIME_PROTOCOL_V1),
    capabilities: RuntimeCapabilitiesSchema,
    ...heartbeatPolicyShape,
    providerReadiness: RuntimeProviderReadinessNegotiationSchema.optional(),
  })
  .strict()
  .superRefine(validateHeartbeatPolicy);

export const ServerWelcomeV2FrameSchema = z
  .object({
    type: z.literal("server:welcome"),
    protocolVersion: z.literal(RUNTIME_PROTOCOL_V2),
    supportedProtocolVersions: RuntimeProtocolRangeSchema,
    supportedCapabilities: RuntimeCapabilityOffersSchema,
    requiredClientCapabilities: RuntimeRequiredCapabilitiesSchema,
    ...heartbeatPolicyShape,
    providerReadiness: RuntimeProviderReadinessNegotiationSchema.optional(),
  })
  .passthrough()
  .superRefine((frame, context) => {
    validateHeartbeatPolicy(frame, context);
    if (
      frame.supportedProtocolVersions.min > RUNTIME_PROTOCOL_V2 ||
      frame.supportedProtocolVersions.max < RUNTIME_PROTOCOL_V2
    ) {
      context.addIssue({
        code: "custom",
        path: ["supportedProtocolVersions"],
        message: "The selected protocol is outside the Server-supported range",
      });
    }
  });

export const ServerWelcomeFrameSchema = z.union([ServerWelcomeV1FrameSchema, ServerWelcomeV2FrameSchema]);

export const AuthV1FrameSchema = z
  .object({
    type: z.literal("auth"),
    requestId: RuntimeRequestIdSchema,
    protocolVersion: z.literal(RUNTIME_PROTOCOL_V1),
    accessToken: z.string().min(1).max(4096),
  })
  .strict();

export const AuthV2FrameSchema = z
  .object({
    type: z.literal("auth"),
    requestId: RuntimeRequestIdSchema,
    protocolVersion: z.literal(RUNTIME_PROTOCOL_V2),
    supportedProtocolVersions: RuntimeProtocolRangeSchema,
    accessToken: z.string().min(1).max(4096),
  })
  .strict()
  .superRefine((frame, context) => {
    if (
      frame.supportedProtocolVersions.min > RUNTIME_PROTOCOL_V2 ||
      frame.supportedProtocolVersions.max < RUNTIME_PROTOCOL_V2
    ) {
      context.addIssue({
        code: "custom",
        path: ["supportedProtocolVersions"],
        message: "The bootstrap protocol is outside the Client-supported range",
      });
    }
  });

export const AuthFrameSchema = z.union([AuthV1FrameSchema, AuthV2FrameSchema]);

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

const computerRegistrationShape = {
  type: z.literal("computer:register"),
  requestId: RuntimeRequestIdSchema,
  computerId: z.string().uuid(),
  instanceId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(255),
  platform: ComputerPlatformSchema,
  arch: z.string().trim().min(1).max(64),
  clientVersion: z.string().trim().min(1).max(64),
  capabilities: RuntimeClientCapabilitiesSchema.default({ imCredentialGrant: 0 }),
  providerReadiness: RuntimeProviderReadinessCollectionSchema.optional(),
  imCliReadiness: RuntimeImCliReadinessCollectionSchema.optional(),
};

export const ComputerRegisterV1FrameSchema = z.object(computerRegistrationShape).strict();
export const ComputerRegisterV2FrameSchema = z
  .object({
    ...computerRegistrationShape,
    protocolVersion: z.literal(RUNTIME_PROTOCOL_V2),
    supportedCapabilities: RuntimeCapabilityOffersSchema,
    requiredServerCapabilities: RuntimeRequiredCapabilitiesSchema,
  })
  .strict();
export const ComputerRegisterFrameSchema = z.union([ComputerRegisterV1FrameSchema, ComputerRegisterV2FrameSchema]);

const computerRegisterResultShape = {
  type: z.literal("computer:register:result"),
  requestId: RuntimeRequestIdSchema,
  ok: z.boolean(),
  errorCode: ErrorCodeSchema.optional(),
};

export const ComputerRegisterResultV1FrameSchema = z
  .object(computerRegisterResultShape)
  .strict()
  .superRefine(validateFailedResult);
export const ComputerRegisterResultV2FrameSchema = z
  .object({
    ...computerRegisterResultShape,
    protocolVersion: z.literal(RUNTIME_PROTOCOL_V2),
    connectionId: RuntimeConnectionIdSchema.optional(),
    negotiatedCapabilities: RuntimeNegotiatedCapabilitiesSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    validateFailedResult(frame, context);
    if (frame.ok && (!frame.connectionId || !frame.negotiatedCapabilities)) {
      context.addIssue({ code: "custom", message: "A successful v2 registration requires negotiated fencing state" });
    }
    if (!frame.ok && (frame.connectionId || frame.negotiatedCapabilities)) {
      context.addIssue({ code: "custom", message: "A failed v2 registration forbids negotiated fencing state" });
    }
  });
export const ComputerRegisterResultFrameSchema = z.union([
  ComputerRegisterResultV1FrameSchema,
  ComputerRegisterResultV2FrameSchema,
]);

const heartbeatShape = {
  type: z.literal("heartbeat"),
  requestId: RuntimeRequestIdSchema,
  computerId: z.string().uuid(),
  instanceId: z.string().uuid(),
  capabilities: RuntimeClientCapabilitiesSchema.default({ imCredentialGrant: 0 }),
  providerReadiness: RuntimeProviderReadinessCollectionSchema.optional(),
  imCliReadiness: RuntimeImCliReadinessCollectionSchema.optional(),
};
export const HeartbeatV1FrameSchema = z.object(heartbeatShape).strict();
export const HeartbeatV2FrameSchema = z
  .object({
    ...heartbeatShape,
    protocolVersion: z.literal(RUNTIME_PROTOCOL_V2),
    connectionId: RuntimeConnectionIdSchema,
  })
  .strict();
export const HeartbeatFrameSchema = z.union([HeartbeatV1FrameSchema, HeartbeatV2FrameSchema]);

const heartbeatResultShape = {
  type: z.literal("heartbeat:result"),
  requestId: RuntimeRequestIdSchema,
  ok: z.boolean(),
  serverTime: z.string().datetime(),
  errorCode: ErrorCodeSchema.optional(),
};
export const HeartbeatResultV1FrameSchema = z.object(heartbeatResultShape).strict().superRefine(validateFailedResult);
export const HeartbeatResultV2FrameSchema = z
  .object({
    ...heartbeatResultShape,
    protocolVersion: z.literal(RUNTIME_PROTOCOL_V2),
    connectionId: RuntimeConnectionIdSchema,
  })
  .strict()
  .superRefine(validateFailedResult);
export const HeartbeatResultFrameSchema = z.union([HeartbeatResultV1FrameSchema, HeartbeatResultV2FrameSchema]);

export const RuntimeErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    requestId: RuntimeRequestIdSchema.optional(),
    code: ErrorCodeSchema,
    message: z.string().min(1).max(512),
  })
  .strict();

export const ClientRuntimeFrameSchema = z.union([
  AuthFrameSchema,
  ComputerRegisterFrameSchema,
  HeartbeatFrameSchema,
  RuntimeErrorFrameSchema,
]);
export const ServerRuntimeFrameSchema = z.union([
  ServerWelcomeFrameSchema,
  AuthResultFrameSchema,
  ComputerRegisterResultFrameSchema,
  HeartbeatResultFrameSchema,
  RuntimeErrorFrameSchema,
]);

export type RuntimeProtocolVersion = typeof RUNTIME_PROTOCOL_V1 | typeof RUNTIME_PROTOCOL_V2;
export type RuntimeProtocolRange = z.infer<typeof RuntimeProtocolRangeSchema>;
export type RuntimeCapabilityRange = z.infer<typeof RuntimeCapabilityRangeSchema>;
export type RuntimeCapabilityOffers = z.infer<typeof RuntimeCapabilityOffersSchema>;
export type RuntimeNegotiatedCapabilities = z.infer<typeof RuntimeNegotiatedCapabilitiesSchema>;
export type ServerWelcomeFrame = z.infer<typeof ServerWelcomeFrameSchema>;
export type ServerWelcomeV1Frame = z.infer<typeof ServerWelcomeV1FrameSchema>;
export type ServerWelcomeV2Frame = z.infer<typeof ServerWelcomeV2FrameSchema>;
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
export type RuntimeClientCapabilities = z.infer<typeof RuntimeClientCapabilitiesSchema>;
export type RuntimeProviderReadinessObservation = z.infer<typeof RuntimeProviderReadinessObservationSchema>;
export type RuntimeProviderReadinessCollection = z.infer<typeof RuntimeProviderReadinessCollectionSchema>;
export type RuntimeProviderReadinessNegotiation = z.infer<typeof RuntimeProviderReadinessNegotiationSchema>;
export type RuntimeImCliReadinessObservation = z.infer<typeof RuntimeImCliReadinessObservationSchema>;
export type RuntimeImCliReadinessCollection = z.infer<typeof RuntimeImCliReadinessCollectionSchema>;
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

export function negotiateRuntimeCapabilities(
  local: RuntimeCapabilityOffers,
  remote: RuntimeCapabilityOffers,
): RuntimeNegotiatedCapabilities {
  const negotiated: RuntimeNegotiatedCapabilities = {};
  for (const name of Object.keys(local).sort()) {
    const localRange = local[name];
    const remoteRange = remote[name];
    if (!localRange || !remoteRange) continue;
    const minimum = Math.max(localRange.min, remoteRange.min);
    const maximum = Math.min(localRange.max, remoteRange.max);
    if (minimum <= maximum) negotiated[name] = maximum;
  }
  return negotiated;
}

export function missingRuntimeCapabilities(
  required: readonly string[],
  negotiated: RuntimeNegotiatedCapabilities,
): string[] {
  return required.filter((name) => negotiated[name] === undefined);
}

export function runtimeNegotiatedCapabilitiesEqual(
  left: RuntimeNegotiatedCapabilities,
  right: RuntimeNegotiatedCapabilities,
): boolean {
  const leftEntries = Object.entries(left).sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  const rightEntries = Object.entries(right).sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export function runtimeFrameByteLength(serializedFrame: string): number {
  return new TextEncoder().encode(serializedFrame).byteLength;
}

function validateFailedResult(
  frame: { ok: boolean; errorCode?: z.infer<typeof ErrorCodeSchema> },
  context: z.RefinementCtx,
): void {
  if (!frame.ok && !frame.errorCode) {
    context.addIssue({ code: "custom", message: "A failed result requires an error code" });
  }
}

function validateCanonicalProviders(
  observations: readonly { provider: (typeof AGENT_RUNTIME_PROVIDERS)[number] }[],
  context: z.RefinementCtx,
): void {
  validateCanonicalIds(
    observations.map((observation) => observation.provider),
    AGENT_RUNTIME_PROVIDERS,
    "Provider readiness",
    context,
  );
}

function validateCanonicalProviderIds(
  providers: readonly (typeof AGENT_RUNTIME_PROVIDERS)[number][],
  context: z.RefinementCtx,
): void {
  validateCanonicalIds(providers, AGENT_RUNTIME_PROVIDERS, "Provider readiness", context);
}

function validateCanonicalIds<T extends string>(
  providers: readonly T[],
  canonical: readonly T[],
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, provider] of providers.entries()) {
    if (seen.has(provider)) {
      context.addIssue({ code: "custom", path: [index], message: `${label} must be unique` });
    }
    seen.add(provider);
    const previousProvider = providers[index - 1];
    if (previousProvider !== undefined && canonical.indexOf(provider) < canonical.indexOf(previousProvider)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: `${label} must use canonical Provider order`,
      });
    }
  }
}
