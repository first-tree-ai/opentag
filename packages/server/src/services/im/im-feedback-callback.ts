import { z } from "zod";

/** The Retry button on a failure card from before Task Retry was disabled. */
const LegacyFeishuFeedback = z.object({
  action: z.object({
    value: z.object({ feedbackId: z.string().uuid(), kind: z.literal("retry_task") }),
  }),
});

/**
 * Failure messages are plain text now. A button on an old card still reaches the callback, and it gets a
 * toast instead of falling through to the approval handler's message.
 */
export function legacyFeishuFeedbackAction(event: unknown): unknown | undefined {
  const envelope = z.object({ event: z.unknown() }).safeParse(event);
  if (!LegacyFeishuFeedback.safeParse(envelope.success ? envelope.data.event : event).success) return undefined;
  return {
    toast: { type: "error", content: "This button is no longer available. Send the message again to retry." },
  };
}
