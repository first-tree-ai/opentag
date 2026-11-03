import { z } from "zod";

export const ImFeedbackActionKindSchema = z.enum(["retry_task", "save_release", "discard"]);
export const ImFeedbackStateSchema = z.enum([
  "queued",
  "working",
  "completed",
  "failed",
  "workspace_blocked",
  "retry_queued",
  "resolved",
  "stale",
]);
const confirmationFields = {
  revision: z.number().int().positive().safe(),
  confirmation: z.string().min(1).max(2048),
};
export const ImFeedbackActionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retry_task"), ...confirmationFields }).strict(),
  z.object({ kind: z.literal("save_release"), ...confirmationFields }).strict(),
  z.object({ kind: z.literal("discard"), ...confirmationFields, permanentLossAcknowledged: z.literal(true) }).strict(),
]);
export const ImFeedbackViewSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    taskId: z.string().uuid(),
    sessionId: z.string().uuid(),
    revision: z.number().int().positive().safe(),
    state: ImFeedbackStateSchema,
    errorCode: z.string().max(128).nullable(),
    effects: z.enum(["not_started", "may_have_occurred", "completed"]).nullable(),
    sandboxId: z.string().uuid().nullable(),
    environmentGeneration: z.number().int().nonnegative().safe().nullable(),
    retryBlockedReason: z.enum(["batch_initial"]).nullable(),
    deliveryState: z.enum(["none", "pending", "sending", "sent", "send_unknown", "blocked"]),
    actions: z
      .array(z.object({ kind: ImFeedbackActionKindSchema, confirmation: z.string().max(2048) }).strict())
      .max(3),
    action: z
      .object({
        kind: ImFeedbackActionKindSchema,
        state: z.enum(["confirmed", "submitting", "checking", "succeeded", "failed", "stale"]),
        resultCode: z.string().max(128).nullable(),
        actorDisplayName: z.string().max(255),
        updatedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ImFeedbackActionKind = z.infer<typeof ImFeedbackActionKindSchema>;
export type ImFeedbackActionRequest = z.infer<typeof ImFeedbackActionRequestSchema>;
export type ImFeedbackView = z.infer<typeof ImFeedbackViewSchema>;

export const ImFeedbackListSchema = z
  .object({
    items: z
      .array(
        ImFeedbackViewSchema.pick({
          id: true,
          agentId: true,
          sessionId: true,
          state: true,
          errorCode: true,
          deliveryState: true,
        })
          .extend({ createdAt: z.string().datetime() })
          .strict(),
      )
      .max(20),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export type ImFeedbackList = z.infer<typeof ImFeedbackListSchema>;
