import { z } from "zod";

export const ComputerPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const ComputerConnectionStatusSchema = z.enum(["online", "offline"]);

export const ComputerSchema = z
  .object({
    id: z.string().uuid(),
    ownerUserId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(255),
    platform: ComputerPlatformSchema,
    arch: z.string().trim().min(1).max(64),
    clientVersion: z.string().trim().min(1).max(64),
    connectionStatus: ComputerConnectionStatusSchema,
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
export type Computer = z.infer<typeof ComputerSchema>;
export type ListComputersResponse = z.infer<typeof ListComputersResponseSchema>;
