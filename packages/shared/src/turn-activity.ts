import { z } from "zod";

/** Optional, replayable execution liveness. Receipt and queue admission are not execution. */
export const TurnActivityRequestSchema = z
  .object({
    type: z.literal("turn:activity"),
    requestId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    sessionId: z.string().uuid(),
    agentId: z.string().uuid(),
    turnId: z.string().min(1).max(256),
    placementGeneration: z.number().int().nonnegative(),
    sequence: z.number().int().positive().safe(),
    phase: z.enum(["running", "waiting_user", "terminal"]),
  })
  .strict();

export const TurnActivityResultSchema = z
  .object({
    type: z.literal("turn:activity:result"),
    requestId: z.string().uuid(),
    turnId: z.string().min(1).max(256),
    sequence: z.number().int().positive().safe(),
    status: z.enum(["recorded", "already_recorded", "stale_generation", "unsupported_capability"]),
  })
  .strict();

export type TurnActivityRequest = z.infer<typeof TurnActivityRequestSchema>;
export type TurnActivityResult = z.infer<typeof TurnActivityResultSchema>;
