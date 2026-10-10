import { z } from "zod";
import type { RuntimeApprovalOwner } from "./runtime-approval-owner.js";

const ActionSchema = z.object({
  operator: z.object({ open_id: z.string().min(1).max(128) }),
  action: z.object({ value: z.object({ approvalId: z.string().uuid(), decision: z.enum(["accept", "decline"]) }) }),
  context: z.object({ open_message_id: z.string().min(1).max(128), open_chat_id: z.string().min(1).max(128) }),
});
export async function handleFeishuApprovalAction(
  owner: Pick<RuntimeApprovalOwner, "decide">,
  event: unknown,
  imBindingId: string,
  generation: number,
) {
  const envelope = z.object({ event: z.unknown() }).safeParse(event);
  const parsed = ActionSchema.safeParse(envelope.success ? envelope.data.event : event);
  if (!parsed.success) return { toast: { type: "error", content: "This approval is unavailable." } };
  const { operator, action, context } = parsed.data;
  const result = await owner.decide({
    ...action.value,
    provider: "feishu",
    userId: operator.open_id,
    imBindingId,
    generation,
    messageId: context.open_message_id,
    channelId: context.open_chat_id,
  });
  return {
    toast: {
      type: result === "recorded" ? "success" : "error",
      content:
        result === "recorded" ? "Decision recorded." : "This approval is unavailable or belongs to another user.",
    },
  };
}
