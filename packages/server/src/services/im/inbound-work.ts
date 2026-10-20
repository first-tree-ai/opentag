import { NormalizedInboundImEventSchema } from "@opentag/shared";
import { z } from "zod";

export const INBOUND_WORK_LEASE_MS = 60_000;
export const INBOUND_WORK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const INBOUND_WORK_MAX_BYTES = 2 * 1024 * 1024;

const SlackInboundWorkSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("slack"),
    bindingId: z.string().uuid().nullable().optional(),
    appId: z.string().min(1).max(255),
    teamId: z.string().min(1).max(255),
    botUserId: z.string().min(1).max(255),
    botId: z.string().min(1).max(255),
    eventId: z.string().min(1).max(255),
    eventTime: z.number().finite().optional(),
    identityClosed: z.boolean(),
    revokesBot: z.boolean(),
    event: z.unknown().transform((value) => slackWorkEvent(value)),
  })
  .strict();

const FeishuInboundWorkSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("feishu"),
    event: NormalizedInboundImEventSchema,
    senderOpenId: z.string().min(1).max(255).optional(),
  })
  .strict();

export const InboundWorkSchema = z
  .discriminatedUnion("provider", [SlackInboundWorkSchema, FeishuInboundWorkSchema])
  .superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value)) > INBOUND_WORK_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "Inbound work exceeds 2 MiB" });
    }
  });
export type InboundWork = z.infer<typeof InboundWorkSchema>;
export type SlackInboundWork = z.infer<typeof SlackInboundWorkSchema>;

const SLACK_INPUT_FIELDS = new Set([
  "type",
  "subtype",
  "channel",
  "channel_type",
  "user",
  "bot_id",
  "bot_profile",
  "app_id",
  "text",
  "ts",
  "deleted_ts",
  "event_ts",
  "thread_ts",
  "message",
  "previous_message",
  "files",
  "blocks",
  "attachments",
  "id",
  "name",
  "mimetype",
  "size",
  "url",
  "image_url",
  "alt_text",
  "slack_file",
  "elements",
  "style",
  "rows",
  "fields",
  "accessory",
  "title",
  "description",
  "video_url",
  "title_url",
  "file_id",
  "user_id",
  "channel_id",
  "usergroup_id",
  "range",
  "pretext",
  "title_link",
  "thumb_url",
  "fallback",
  "value",
  "bold",
  "italic",
  "strike",
  "code",
]);

export function slackWorkEvent(value: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (Array.isArray(value)) return value.map((item) => slackWorkEvent(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => SLACK_INPUT_FIELDS.has(key))
      .map(([key, item]) => [key, slackWorkEvent(item, depth + 1)]),
  );
}

export function inboundWorkRetryDelay(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.min(4, Math.max(0, attempt - 1)));
}
