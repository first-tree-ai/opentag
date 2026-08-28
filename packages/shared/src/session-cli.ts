import { z } from "zod";
import {
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  RuntimeMaxDurationMsSchema,
  RuntimeModelSchema,
  RuntimeReasoningEffortSchema,
} from "./runtime-domain.js";

export const SESSION_CLI_DEFAULT_LIMIT = 20;
export const SESSION_CLI_MAX_LIMIT = 100;
export const SESSION_CLI_TASK_PREVIEW_MAX_BYTES = 256;
export const SESSION_CLI_PROOF_HEADER = "x-opentag-session-proof";

const SessionCliTextSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= RUNTIME_DIRECT_TEXT_MAX_BYTES, {
    message: "Session message exceeds the 16 KiB limit",
  });

export const SessionCliCreateRequestSchema = z
  .object({
    messageId: z.string().uuid(),
    message: SessionCliTextSchema,
    model: RuntimeModelSchema.optional(),
    reasoningEffort: RuntimeReasoningEffortSchema.optional(),
    maxDurationMs: RuntimeMaxDurationMsSchema.optional(),
  })
  .strict();

export const SessionCliSendRequestSchema = z
  .object({
    messageId: z.string().uuid(),
    targetSessionId: z.string().uuid(),
    message: SessionCliTextSchema,
  })
  .strict();

export const SessionCliCommandStatusSchema = z.enum(["accepted", "unreachable", "unknown", "rejected"]);

export const SessionCliCommandResponseSchema = z
  .object({
    messageId: z.string().uuid(),
    status: SessionCliCommandStatusSchema,
    sessionId: z.string().uuid().optional(),
    code: z.string().min(1).max(128).optional(),
  })
  .strict();

export const SessionCliListQuerySchema = z
  .object({
    recursive: z.boolean().default(false),
    limit: z.number().int().min(1).max(SESSION_CLI_MAX_LIMIT).default(SESSION_CLI_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(2048).optional(),
    since: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const SessionCliListItemSchema = z
  .object({
    sessionId: z.string().uuid(),
    parentSessionId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    lastMessageAt: z.string().datetime({ offset: true }),
    lastDeliveryOutcome: z.enum(["unknown", "accepted", "unreachable", "rejected"]),
    taskPreview: z.string(),
  })
  .strict();

export const SessionCliListResponseSchema = z
  .object({
    items: z.array(SessionCliListItemSchema).max(SESSION_CLI_MAX_LIMIT),
    nextCursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

export type SessionCliCreateRequest = z.infer<typeof SessionCliCreateRequestSchema>;
export type SessionCliSendRequest = z.infer<typeof SessionCliSendRequestSchema>;
export type SessionCliCommandResponse = z.infer<typeof SessionCliCommandResponseSchema>;
export type SessionCliListQuery = z.infer<typeof SessionCliListQuerySchema>;
export type SessionCliListItem = z.infer<typeof SessionCliListItemSchema>;
export type SessionCliListResponse = z.infer<typeof SessionCliListResponseSchema>;
