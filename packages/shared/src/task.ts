import { z } from "zod";
import { AgentRuntimeProviderSchema } from "./agent.js";
import { ImProviderSchema } from "./im-binding.js";
import {
  ImAttentionSchema,
  ImAuthorKindSchema,
  ImConversationKindSchema,
  ImMessageOperationSchema,
} from "./im-message.js";

export const TaskStatusSchema = z.enum(["queued", "running", "completed", "failed", "expired", "ended", "idle"]);
export const TaskSessionKindSchema = z.enum(["channel", "thread"]);
export const TASK_AUTO_TITLE_MAX_GRAPHEMES = 80;
export const TASK_TITLE_MAX_LENGTH = 120;
const taskTitleSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function taskTitleLength(value: string): number {
  let length = 0;
  for (const _segment of taskTitleSegmenter.segment(value)) length += 1;
  return length;
}

export const TaskTitleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => taskTitleLength(value) <= TASK_TITLE_MAX_LENGTH, {
    message: `Task title must contain at most ${TASK_TITLE_MAX_LENGTH} characters`,
  });

/** Manual Task title input. `null` explicitly clears the manual override. */
export const TaskTitleUpdateRequestSchema = z.object({ title: TaskTitleSchema.nullable() }).strict();

export const TaskSummarySchema = z
  .object({
    id: z.string().uuid(),
    agent: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        displayName: z.string().min(1),
        runtimeProvider: AgentRuntimeProviderSchema,
      })
      .strict(),
    source: z
      .object({
        provider: ImProviderSchema,
        conversationKind: ImConversationKindSchema,
        channelId: z.string().min(1),
        threadKey: z.string().min(1).nullable(),
      })
      .strict(),
    sessionKind: TaskSessionKindSchema,
    title: TaskTitleSchema,
    status: TaskStatusSchema,
    createdAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    lastActivityAt: z.string().datetime(),
  })
  .strict();

export const ListTasksResponseSchema = z
  .object({ tasks: z.array(TaskSummarySchema), nextCursor: z.string().min(1).nullable() })
  .strict();

export const TaskTitleUpdateResponseSchema = z.object({ task: TaskSummarySchema }).strict();

export const TaskTurnSchema = z
  .object({
    deliveryId: z.string().uuid(),
    attention: ImAttentionSchema,
    delivery: z
      .object({
        state: z.enum(["pending", "accepted", "steered", "terminal_rejected", "expired"]),
        attemptCount: z.number().int().nonnegative(),
        acceptedAt: z.string().datetime().nullable(),
        steeredAt: z.string().datetime().nullable(),
        expiresAt: z.string().datetime(),
        reason: z.string().nullable(),
        lastErrorCode: z.string().nullable(),
      })
      .strict(),
    message: z
      .object({
        id: z.string().uuid(),
        externalMessageId: z.string().min(1),
        operation: ImMessageOperationSchema,
        authorKind: ImAuthorKindSchema,
        authorDisplayName: z.string().nullable(),
        fallbackText: z.string(),
        truncated: z.boolean(),
        occurredAt: z.string().datetime(),
      })
      .strict(),
    absorbedBy: z
      .object({
        deliveryId: z.string().uuid(),
        turnId: z.string().min(1),
      })
      .strict()
      .nullable(),
    report: z
      .object({
        turnId: z.string().min(1),
        outcome: z.enum(["completed", "failed", "cancelled", "unknown"]),
        executionEffects: z.enum(["not_started", "may_have_occurred", "completed"]),
        finalText: z.string().nullable(),
        errorReason: z.string().nullable(),
        usage: z
          .object({
            inputTokens: z.number().int().nonnegative().nullable(),
            cachedInputTokens: z.number().int().nonnegative().nullable(),
            outputTokens: z.number().int().nonnegative().nullable(),
          })
          .strict()
          .nullable(),
        traceSummary: z
          .object({
            lastSequence: z.number().int().nonnegative(),
            droppedEvents: z.number().int().nonnegative(),
          })
          .strict(),
        reportedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const TaskInternalSessionSchema = z
  .object({
    id: z.string().uuid(),
    createdBySessionId: z.string().uuid(),
    createdAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    runtimeModel: z.string().nullable(),
    runtimeReasoningEffort: z.string().nullable(),
  })
  .strict();

export const TaskCollaborationMessageSchema = z
  .object({
    id: z.string().uuid(),
    sourceSessionId: z.string().uuid(),
    targetSessionId: z.string().uuid(),
    content: z.string().min(1),
    outcome: z.enum(["unknown", "accepted", "unreachable", "rejected"]),
    attemptCount: z.number().int().nonnegative(),
    lastErrorCode: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const TaskDetailSchema = z
  .object({
    task: TaskSummarySchema,
    turns: z.array(TaskTurnSchema),
    internalSessions: z.array(TaskInternalSessionSchema),
    collaborationMessages: z.array(TaskCollaborationMessageSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;
export type TaskTitleUpdateRequest = z.infer<typeof TaskTitleUpdateRequestSchema>;
export type TaskTitleUpdateResponse = z.infer<typeof TaskTitleUpdateResponseSchema>;
export type TaskTurn = z.infer<typeof TaskTurnSchema>;
export type TaskInternalSession = z.infer<typeof TaskInternalSessionSchema>;
export type TaskCollaborationMessage = z.infer<typeof TaskCollaborationMessageSchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
