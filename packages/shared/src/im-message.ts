import { z } from "zod";

export const ImConversationKindSchema = z.enum(["channel", "dm", "group_dm"]);
const NormalizedImConversationKindSchema = z.union([ImConversationKindSchema, z.literal("unknown")]);
export const ImMessageOperationSchema = z.enum(["created", "edited", "deleted"]);
export const ImMessageDirectionSchema = z.enum(["inbound", "outbound"]);
export const ImAuthorKindSchema = z.enum(["human", "bot", "system"]);
export const ImAttentionSchema = z.enum(["direct", "ambient"]);

export const ImResourceDescriptorSchema = z
  .object({
    providerResourceKey: z.string().min(1).max(2048),
    kind: z.enum(["image", "file", "audio", "video"]),
    filename: z.string().max(512).nullable(),
    mediaType: z.string().max(255).nullable(),
    sizeBytes: z.number().int().nonnegative().safe().nullable(),
    ordinal: z.number().int().min(0).max(15).optional(),
    availability: z.enum(["available", "unavailable", "too_large", "unsupported"]).optional(),
  })
  .strict();

const ImTextBlockSchema = z.object({ type: z.literal("text"), text: z.string().max(64 * 1024) }).strict();
const ImMentionBlockSchema = z
  .object({ type: z.literal("mention"), externalId: z.string().min(1).max(255), label: z.string().max(512) })
  .strict();
const ImLinkBlockSchema = z
  .object({ type: z.literal("link"), url: z.string().url(), label: z.string().max(2048) })
  .strict();
const ImCodeBlockSchema = z
  .object({ type: z.literal("code"), language: z.string().max(80).nullable(), text: z.string().max(64 * 1024) })
  .strict();
const ImQuoteBlockSchema = z.object({ type: z.literal("quote"), text: z.string().max(64 * 1024) }).strict();
const ImResourceBlockSchema = z
  .object({
    type: z.enum(["image", "file"]),
    resourceOrdinal: z.number().int().min(0).max(15),
    label: z.string().max(512),
  })
  .strict();
const ImUnsupportedBlockSchema = z
  .object({ type: z.literal("unsupported"), providerType: z.string().min(1).max(160) })
  .strict();

export const ImContentBlockSchema = z.discriminatedUnion("type", [
  ImTextBlockSchema,
  ImMentionBlockSchema,
  ImLinkBlockSchema,
  ImCodeBlockSchema,
  ImQuoteBlockSchema,
  ImResourceBlockSchema,
  ImUnsupportedBlockSchema,
]);

export const ImContentV1Schema = z
  .object({
    version: z.literal(1),
    fallbackText: z.string().max(64 * 1024),
    blocks: z.array(ImContentBlockSchema).max(512),
    resources: z.array(ImResourceDescriptorSchema).max(16).optional(),
    truncated: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) {
      context.addIssue({ code: "custom", message: "Canonical IM content exceeds 256 KiB" });
    }
  });

export const ExternalMentionSchema = z
  .object({ externalId: z.string().min(1).max(255), displayName: z.string().max(512).nullable() })
  .strict();

export const NormalizedInboundImEventSchema = z
  .object({
    providerEventId: z.string().min(1).max(512),
    externalAppId: z.string().min(1).max(255),
    externalTeamId: z.string().min(1).max(255),
    conversation: z
      .object({
        externalId: z.string().min(1).max(512),
        kind: NormalizedImConversationKindSchema,
        displayName: z.string().max(512).nullable().optional(),
      })
      .strict(),
    message: z
      .object({
        externalId: z.string().min(1).max(512),
        revisionKey: z.string().min(1).max(512),
        operation: ImMessageOperationSchema,
        threadKey: z.string().min(1).max(512).nullable().optional(),
        replyToExternalId: z.string().min(1).max(512).nullable().optional(),
        author: z
          .object({
            externalId: z.string().min(1).max(255),
            kind: ImAuthorKindSchema,
            displayName: z.string().max(512).nullable().optional(),
          })
          .strict(),
        occurredAt: z.coerce.date(),
        content: ImContentV1Schema,
        resources: z.array(ImResourceDescriptorSchema).max(16),
      })
      .strict(),
    mentions: z.array(ExternalMentionSchema).max(256),
  })
  .strict();

export const ProviderWriteErrorCategorySchema = z.enum([
  "validation",
  "deterministic",
  "authorization",
  "credential",
  "rate_limited",
  "transient",
  "unknown",
  "stale",
]);

export const ProviderWriteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), externalMessageId: z.string().min(1), occurredAt: z.coerce.date() }).strict(),
  z
    .object({
      ok: z.literal(false),
      category: ProviderWriteErrorCategorySchema,
      code: z.string().min(1).max(160),
      retryAfterSeconds: z.number().int().positive().optional(),
    })
    .strict(),
]);

export type ImConversationKind = z.infer<typeof ImConversationKindSchema>;
export type ImMessageOperation = z.infer<typeof ImMessageOperationSchema>;
export type ImAttention = z.infer<typeof ImAttentionSchema>;
export type ImContentV1 = z.infer<typeof ImContentV1Schema>;
export type NormalizedInboundImEvent = z.infer<typeof NormalizedInboundImEventSchema>;
export type ProviderWriteResult = z.infer<typeof ProviderWriteResultSchema>;
