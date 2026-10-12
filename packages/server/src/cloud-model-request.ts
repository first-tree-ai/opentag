import { z } from "zod";

export const CloudModelTransportLimitsSchema = z.object({
  requestTimeoutMs: z.coerce.number().int().min(10_000).max(1_800_000).default(600_000),
  maxResponseBytes: z.coerce
    .number()
    .int()
    .min(1024 * 1024)
    .max(64 * 1024 * 1024)
    .default(16 * 1024 * 1024),
});
export type CloudModelTransportLimits = z.infer<typeof CloudModelTransportLimitsSchema>;
export const CLOUD_MODEL_ERROR_BODY_MAX_BYTES = 8 * 1024;

/**
 * Chat history for one turn is bounded by the route's HTTP body byte cap, not by a message count:
 * a long compacted Session legitimately holds far more than a thousand short messages, and byte
 * accounting is the bound that protects the process. The per-message structural bounds below stay.
 */
const MAX_CONTENT_PARTS_PER_MESSAGE = 64;
const MAX_TOOLS_PER_REQUEST = 128;
const MAX_TOOL_CALLS_PER_MESSAGE = 128;
const MAX_REASONING_DETAILS_PER_MESSAGE = 128;
const MAX_REASONING_DETAIL_CHARS = 64 * 1_024;
const MAX_REASONING_DETAIL_FIELDS = 8;
/**
 * Tool call and tool result identifiers stay intact end to end: providers emit opaque ids well
 * beyond the historical 256-byte norm, and only the request body cap — never a per-field guess —
 * decides what fits the model window.
 */

const textContentPart = z.object({ type: z.literal("text"), text: z.string() }).strict();
const imageContentPart = z
  .object({ type: z.literal("image_url"), image_url: z.object({ url: z.string().min(1) }).strict() })
  .strict();

const functionToolCall = z
  .object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z.object({ name: z.string().min(1).max(128), arguments: z.string() }).strict(),
  })
  .strict();

/**
 * One encrypted reasoning detail the pinned Pi re-emits: it JSON-parses each signed tool call's
 * `thoughtSignature` (an upstream `reasoning.encrypted` object) and writes the parsed object back
 * verbatim, so the opaque `id`/`data` and any provider metadata must round-trip unchanged. The
 * signed payload is preserved; the object stays bounded and only exists inside an assistant
 * message's `reasoning_details` — never at the request or message top level.
 */
const reasoningDetailScalar = z.union([
  z.string().max(MAX_REASONING_DETAIL_CHARS),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const encryptedReasoningDetail = z
  .object({
    type: z.literal("reasoning.encrypted"),
    id: z.string().min(1).max(512),
    data: z.string().min(1).max(MAX_REASONING_DETAIL_CHARS),
  })
  .catchall(reasoningDetailScalar)
  .refine((detail) => Object.keys(detail).length <= MAX_REASONING_DETAIL_FIELDS, {
    message: "too many reasoning detail fields",
  });

/**
 * The exact message shapes the pinned Pi's openai-completions conversion emits (system/user text,
 * assistant text-or-null with function tool calls, the upstream reasoning echo under whichever of
 * `reasoning_content`/`reasoning`/`reasoning_text` the provider streamed, encrypted
 * `reasoning_details` for signed tool calls, tool results, and text/image user content parts).
 * `developer` covers the OpenAI reasoning-model role.
 */
const chatMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("developer"), content: z.string() }).strict(),
  z
    .object({
      role: z.literal("user"),
      content: z.union([
        z.string(),
        z
          .array(z.union([textContentPart, imageContentPart]))
          .min(1)
          .max(MAX_CONTENT_PARTS_PER_MESSAGE),
      ]),
    })
    .strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string().nullable().optional(),
      tool_calls: z.array(functionToolCall).min(1).max(MAX_TOOL_CALLS_PER_MESSAGE).optional(),
      // Pi tracks whichever reasoning field the upstream streamed (`reasoning_content`,
      // `reasoning`, or `reasoning_text`) and echoes it under that same key on the next call.
      reasoning_content: z.string().optional(),
      reasoning: z.string().optional(),
      reasoning_text: z.string().optional(),
      // Signed tool-call thinking: the parsed `thoughtSignature` objects, verbatim.
      reasoning_details: z.array(encryptedReasoningDetail).min(1).max(MAX_REASONING_DETAILS_PER_MESSAGE).optional(),
    })
    .strict(),
  z.object({ role: z.literal("tool"), content: z.string(), tool_call_id: z.string().min(1) }).strict(),
]);

const chatTool = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1).max(128),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        strict: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const chatToolChoice = z.union([
  z.enum(["none", "auto", "required"]),
  z
    .object({
      type: z.literal("function"),
      function: z.object({ name: z.string().min(1).max(128) }).strict(),
    })
    .strict(),
]);

/**
 * Strict request allowlist: exactly the fields the pinned Pi openai-completions path can emit for
 * the Sandbox's custom provider (model/messages/stream/stream_options/store/max_completion_tokens
 * or max_tokens/temperature/tools/tool_choice), the standard `top_p`/`n` knobs, and the bounded
 * DeepSeek reasoning fields (`thinking`, `reasoning_effort`, message-level `reasoning_content`).
 * Everything else — above all router/credential overrides — is rejected. `n` is bounded to a
 * single choice: Pi never sets it and `n > 1` would multiply completions on the master key.
 */
export const CloudModelRequestSchema = z
  .object({
    model: z.string().min(1).max(128),
    // Non-empty history; the total size is bounded by the route body byte cap, not a count.
    messages: z.array(chatMessage).min(1),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
    store: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    // Output budgets are validated structurally here and clamped to the issued grant's budget in
    // `authorize`, once the token's Server-selected capability is known.
    max_tokens: z.number().int().min(1).optional(),
    max_completion_tokens: z.number().int().min(1).optional(),
    n: z.literal(1).optional(),
    tools: z.array(chatTool).max(MAX_TOOLS_PER_REQUEST).optional(),
    tool_choice: chatToolChoice.optional(),
    reasoning_effort: z.string().min(1).max(32).optional(),
    thinking: z
      .object({ type: z.enum(["enabled", "disabled"]) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Apply the issued grant's output budget: each explicit budget field is clamped to it (never
 * relayed above the issued capability), and when the caller supplied neither field the proxy
 * supplies the issued budget itself, so omission cannot bypass the bound.
 */
export function applyCloudModelOutputBudget(
  body: z.infer<typeof CloudModelRequestSchema>,
  maxTokens: number,
): z.infer<typeof CloudModelRequestSchema> {
  const result = { ...body };
  if (body.max_tokens !== undefined) result.max_tokens = Math.min(body.max_tokens, maxTokens);
  if (body.max_completion_tokens !== undefined)
    result.max_completion_tokens = Math.min(body.max_completion_tokens, maxTokens);
  if (body.max_tokens === undefined && body.max_completion_tokens === undefined) result.max_tokens = maxTokens;
  return result;
}
