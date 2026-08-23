import { z } from "zod";
import { AGENT_RUNTIME_PROVIDERS, AgentRuntimeProviderSchema } from "./agent.js";

export const ComputerPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const ComputerConnectionStatusSchema = z.enum(["online", "offline"]);
export const ProviderReadinessStatusSchema = z.enum(["checking", "install", "sign-in", "ready", "unavailable"]);
export const ImCliReadinessStatusSchema = z.enum(["checking", "install", "ready", "unavailable"]);
export const ImCliReadinessReasonSchema = z.enum(["version_incompatible"]);
export const IM_CLI_DETECTED_VERSION_MAX_LENGTH = 64;
export const ImCliDetectedVersionSchema = z.string().min(1).max(IM_CLI_DETECTED_VERSION_MAX_LENGTH);
export const IM_CLI_PROVIDERS = ["feishu", "slack"] as const;
export const ImCliProviderSchema = z.enum(IM_CLI_PROVIDERS);
export const PROVIDER_READINESS_V1_HEADER = "x-opentag-provider-readiness";

export const ComputerProviderReadinessSchema = z
  .object({
    provider: AgentRuntimeProviderSchema,
    status: ProviderReadinessStatusSchema,
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

export const ComputerProviderReadinessCollectionSchema = z
  .array(ComputerProviderReadinessSchema)
  .max(AGENT_RUNTIME_PROVIDERS.length)
  .superRefine((observations, context) => {
    const seen = new Set<string>();
    for (const [index, observation] of observations.entries()) {
      if (seen.has(observation.provider)) {
        context.addIssue({ code: "custom", path: [index, "provider"], message: "Provider readiness must be unique" });
      }
      seen.add(observation.provider);
      if (
        index > 0 &&
        AGENT_RUNTIME_PROVIDERS.indexOf(observation.provider) <
          AGENT_RUNTIME_PROVIDERS.indexOf(observations[index - 1]?.provider ?? "codex")
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "provider"],
          message: "Provider readiness must use canonical Provider order",
        });
      }
    }
  });

export const ComputerImCliReadinessSchema = z
  .object({
    provider: ImCliProviderSchema,
    status: ImCliReadinessStatusSchema,
    reason: ImCliReadinessReasonSchema.optional(),
    detectedVersion: ImCliDetectedVersionSchema.optional(),
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

export const ComputerImCliReadinessCollectionSchema = z
  .array(ComputerImCliReadinessSchema)
  .max(IM_CLI_PROVIDERS.length)
  .superRefine((observations, context) => {
    const seen = new Set<string>();
    for (const [index, observation] of observations.entries()) {
      if (seen.has(observation.provider)) {
        context.addIssue({ code: "custom", path: [index, "provider"], message: "IM CLI readiness must be unique" });
      }
      seen.add(observation.provider);
      if (
        index > 0 &&
        IM_CLI_PROVIDERS.indexOf(observation.provider) <
          IM_CLI_PROVIDERS.indexOf(observations[index - 1]?.provider ?? "feishu")
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "provider"],
          message: "IM CLI readiness must use canonical Provider order",
        });
      }
    }
  });

export const ComputerSchema = z
  .object({
    id: z.string().uuid(),
    ownerUserId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(255),
    platform: ComputerPlatformSchema,
    arch: z.string().trim().min(1).max(64),
    clientVersion: z.string().trim().min(1).max(64),
    connectionStatus: ComputerConnectionStatusSchema,
    providerReadiness: ComputerProviderReadinessCollectionSchema.optional(),
    imCliReadiness: ComputerImCliReadinessCollectionSchema.optional(),
    connectedAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime(),
  })
  .strict();

export const ListComputersResponseSchema = z
  .object({
    computers: z.array(ComputerSchema),
  })
  .strict();

export type ComputerPlatform = z.infer<typeof ComputerPlatformSchema>;
export type ComputerConnectionStatus = z.infer<typeof ComputerConnectionStatusSchema>;
export type ProviderReadinessStatus = z.infer<typeof ProviderReadinessStatusSchema>;
export type ImCliReadinessStatus = z.infer<typeof ImCliReadinessStatusSchema>;
export type ImCliReadinessReason = z.infer<typeof ImCliReadinessReasonSchema>;
export type ImCliProvider = z.infer<typeof ImCliProviderSchema>;
export type ComputerProviderReadiness = z.infer<typeof ComputerProviderReadinessSchema>;
export type ComputerProviderReadinessCollection = z.infer<typeof ComputerProviderReadinessCollectionSchema>;
export type ComputerImCliReadiness = z.infer<typeof ComputerImCliReadinessSchema>;
export type ComputerImCliReadinessCollection = z.infer<typeof ComputerImCliReadinessCollectionSchema>;
export type Computer = z.infer<typeof ComputerSchema>;
export type ListComputersResponse = z.infer<typeof ListComputersResponseSchema>;
