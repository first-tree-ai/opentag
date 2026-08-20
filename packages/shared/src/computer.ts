import { z } from "zod";
import { AGENT_RUNTIME_PROVIDERS, AgentRuntimeProviderSchema } from "./agent.js";

export const ComputerPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const ComputerConnectionStatusSchema = z.enum(["online", "offline"]);
export const ProviderReadinessStatusSchema = z.enum(["checking", "install", "sign-in", "ready", "unavailable"]);
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
export type ComputerProviderReadiness = z.infer<typeof ComputerProviderReadinessSchema>;
export type ComputerProviderReadinessCollection = z.infer<typeof ComputerProviderReadinessCollectionSchema>;
export type Computer = z.infer<typeof ComputerSchema>;
export type ListComputersResponse = z.infer<typeof ListComputersResponseSchema>;
