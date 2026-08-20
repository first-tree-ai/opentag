import { z } from "zod";

export const ComputerPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const ComputerConnectionStatusSchema = z.enum(["online", "offline"]);
export const ProviderReadinessStatusSchema = z.enum(["checking", "install", "sign-in", "ready", "unavailable"]);
export const PROVIDER_READINESS_V1_HEADER = "x-opentag-provider-readiness";

export const ComputerProviderReadinessSchema = z
  .object({
    provider: z.literal("codex"),
    status: ProviderReadinessStatusSchema,
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

export const ComputerSchema = z
  .object({
    id: z.string().uuid(),
    ownerUserId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(255),
    platform: ComputerPlatformSchema,
    arch: z.string().trim().min(1).max(64),
    clientVersion: z.string().trim().min(1).max(64),
    connectionStatus: ComputerConnectionStatusSchema,
    providerReadiness: ComputerProviderReadinessSchema.optional(),
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
export type Computer = z.infer<typeof ComputerSchema>;
export type ListComputersResponse = z.infer<typeof ListComputersResponseSchema>;
