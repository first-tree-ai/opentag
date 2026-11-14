import { z } from "zod";

/**
 * A Local Client tells the Server that an accepted IM Turn waits for a used-up model quota window to reset
 * (`runtime.quotaWait` v1). The Server writes the notice to the conversation and edits it when `resetAt` moves; the
 * Client sends no copy. Sent when the wait starts and whenever its reset time changes, and with `ended` when it ends.
 */
export const TurnQuotaWaitRequestSchema = z
  .object({
    type: z.literal("turn:quota-wait"),
    requestId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    sessionId: z.string().uuid(),
    agentId: z.string().uuid(),
    turnId: z.string().min(1).max(256),
    placementGeneration: z.number().int().nonnegative(),
    sequence: z.number().int().positive().safe(),
    /** When the Turn resumes; required unless the wait ended. */
    resetAt: z.string().datetime().optional(),
    ended: z.literal(true).optional(),
  })
  .strict()
  .refine((frame) => frame.ended === true || frame.resetAt !== undefined, {
    message: "a quota wait names its reset time until it ends",
  });

export const TurnQuotaWaitResultSchema = z
  .object({
    type: z.literal("turn:quota-wait:result"),
    requestId: z.string().uuid(),
    turnId: z.string().min(1).max(256),
    sequence: z.number().int().positive().safe(),
    /** `failed`: the notice could not be sent or edited; the wait itself is unaffected. */
    status: z.enum(["recorded", "stale_generation", "unsupported_capability", "failed"]),
  })
  .strict();

export type TurnQuotaWaitRequest = z.infer<typeof TurnQuotaWaitRequestSchema>;
export type TurnQuotaWaitResult = z.infer<typeof TurnQuotaWaitResultSchema>;
