import { z } from "zod";
import type { ImFeedbackActionsService } from "./im-feedback-actions.js";

const FeishuFeedback = z.object({
  operator: z.object({ open_id: z.string().min(1).max(255) }),
  action: z.object({
    value: z
      .object({
        feedbackId: z.string().uuid(),
        revision: z.number().int().positive().safe(),
        kind: z.literal("retry_task"),
      })
      .strict(),
  }),
  context: z.object({ open_message_id: z.string().min(1).max(255), open_chat_id: z.string().min(1).max(255) }),
});
export async function handleFeishuFeedbackAction(
  service: ImFeedbackActionsService,
  event: unknown,
  bindingId: string,
  generation: number,
): Promise<unknown | undefined> {
  const envelope = z.object({ event: z.unknown() }).safeParse(event);
  const body = envelope.success ? envelope.data.event : event;
  const parsed = FeishuFeedback.safeParse(body);
  if (!parsed.success) return undefined;
  const { operator, action, context } = parsed.data;
  const result = await service.submitNativeRetry({
    feedbackId: action.value.feedbackId,
    revision: action.value.revision,
    provider: "feishu",
    userId: operator.open_id,
    bindingId,
    generation,
    channelId: context.open_chat_id,
    messageId: context.open_message_id,
  });
  return {
    toast: {
      type: result === "recorded" ? "success" : "error",
      content: result === "recorded" ? "Retry queued." : "This operation is unavailable. Open its current details.",
    },
  };
}
