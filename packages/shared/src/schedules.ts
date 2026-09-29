import { z } from "zod";
import { runtimeByteString } from "./runtime-config.js";

/*
 * Agent Schedules — shared management and preview contract.
 *
 * A Schedule is a thin time-to-message primitive: the Server materializes one SessionMessage per
 * occurrence into the fixed target Session and hands it to the existing Local/Cloud delivery path.
 * These schemas describe only the management plane (CRUD + preview) and the persisted rule shapes;
 * execution, notification, and dispatch semantics stay with the Runtime layers.
 *
 * Semantic validation of time rules (five-field cron grammar, IANA existence, future occurrences)
 * belongs to the single Server-side schedule calculator. The schemas here enforce structure and
 * bounds only, so rule failures surface as the dedicated SCHEDULE_* error codes rather than
 * generic request validation.
 */

export const AGENT_SCHEDULE_NAME_MAX_CODE_POINTS = 120;
export const AGENT_SCHEDULE_PROMPT_MAX_BYTES = 16 * 1024;
export const AGENT_SCHEDULE_MIN_INTERVAL_SECONDS = 60;
export const AGENT_SCHEDULE_PREVIEW_MAX_COUNT = 5;
export const AGENT_SCHEDULE_TIMEZONE_MAX_LENGTH = 100;
export const AGENT_SCHEDULE_CRON_EXPRESSION_MAX_LENGTH = 100;
export const AGENT_SCHEDULE_LIST_LIMIT_DEFAULT = 50;
export const AGENT_SCHEDULE_LIST_LIMIT_MAX = 100;

/**
 * Canonical UTC instant with exactly millisecond precision (`2026-09-28T01:00:00.000Z`). This is
 * the only serialized form for stored or derived instants; the round-trip check also rejects
 * non-existent calendar days that `Date.parse` would otherwise roll over.
 */
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const ScheduleUtcInstantSchema = z
  .string()
  .regex(UTC_INSTANT_PATTERN, "Expected an ISO 8601 UTC instant with millisecond precision")
  .refine(
    (value) => {
      const time = Date.parse(value);
      return !Number.isNaN(time) && new Date(time).toISOString() === value;
    },
    { message: "Expected a real calendar instant" },
  );
export type ScheduleUtcInstant = z.infer<typeof ScheduleUtcInstantSchema>;

/**
 * Caller-supplied absolute instant: ISO 8601 with an explicit UTC offset or `Z`, seconds, and at
 * most millisecond fractions. Offset-less wall times and natural language never parse here.
 */
const ABSOLUTE_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
export const ScheduleAbsoluteInstantInputSchema = z
  .string()
  .regex(ABSOLUTE_INSTANT_PATTERN, "Expected an ISO 8601 instant with an explicit UTC offset or Z")
  .refine((value) => parseAbsoluteInstant(value) !== null, { message: "Expected a real calendar instant" });
export type ScheduleAbsoluteInstantInput = z.infer<typeof ScheduleAbsoluteInstantInputSchema>;

/**
 * Parse an offset-bearing instant into a UTC `Date`, rejecting impossible calendar fields
 * (`2026-02-31`) that `Date.parse` silently rolls into the next month. Returns null on any
 * shape or calendar failure.
 */
export function parseAbsoluteInstant(value: string): Date | null {
  const match = ABSOLUTE_INSTANT_PATTERN.exec(value);
  if (!match) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  const zone = match[8] ?? "Z";
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  }
  // Re-derive the stated wall clock from UTC through its own offset; a rolled-over date fails.
  const wall = new Date(time + offsetMinutes * 60_000);
  const [, year, month, day, hour, minute, second, fraction] = match;
  const expectedMs = Number((fraction ?? "0").padEnd(3, "0"));
  if (
    wall.getUTCFullYear() !== Number(year) ||
    wall.getUTCMonth() + 1 !== Number(month) ||
    wall.getUTCDate() !== Number(day) ||
    wall.getUTCHours() !== Number(hour) ||
    wall.getUTCMinutes() !== Number(minute) ||
    wall.getUTCSeconds() !== Number(second) ||
    wall.getUTCMilliseconds() !== expectedMs
  ) {
    return null;
  }
  return new Date(time);
}

/**
 * Trimmed display name, 1-120 Unicode code points. Zod string bounds count code points, so
 * non-BMP characters count once.
 */
export const AgentScheduleNameSchema = z.string().trim().min(1).max(AGENT_SCHEDULE_NAME_MAX_CODE_POINTS);
export type AgentScheduleName = z.infer<typeof AgentScheduleNameSchema>;

/** The task body. Exactly the SessionMessage 16 KiB UTF-8 budget; never truncated. */
export const AgentSchedulePromptSchema = runtimeByteString(
  AGENT_SCHEDULE_PROMPT_MAX_BYTES,
  "Schedule prompt exceeds the 16 KiB limit",
  1,
);
export type AgentSchedulePrompt = z.infer<typeof AgentSchedulePromptSchema>;

/**
 * Structural timezone field. IANA existence is validated by the Server schedule calculator so
 * every entry point shares one validator; this schema only keeps the value present and bounded.
 */
export const AgentScheduleTimezoneSchema = z.string().trim().min(1).max(AGENT_SCHEDULE_TIMEZONE_MAX_LENGTH);
export type AgentScheduleTimezone = z.infer<typeof AgentScheduleTimezoneSchema>;

/*
 * The Server-generated origin snapshot carried by a scheduled SessionMessage (wire v3 branch and
 * the `session_messages.scheduled_origin` column). Exactly one of this or `sourceSessionId`
 * exists on a message; the snapshot is immutable once the message exists and `scheduleId` is
 * traceability only, never an authorization input.
 */
export const SessionMessageScheduledOriginSchema = z
  .object({
    scheduleId: z.string().uuid(),
    /** The claimed occurrence instant, UTC with millisecond precision. */
    scheduledFor: ScheduleUtcInstantSchema,
    timezone: z.string().min(1).max(AGENT_SCHEDULE_TIMEZONE_MAX_LENGTH),
    /** Snapshot of the Schedule name at claim time. */
    name: z.string().min(1).max(AGENT_SCHEDULE_NAME_MAX_CODE_POINTS),
  })
  .strict();
export type SessionMessageScheduledOrigin = z.infer<typeof SessionMessageScheduledOriginSchema>;

/** Structural cron field. The five-field grammar and value ranges belong to the Server calculator. */
export const AgentScheduleCronExpressionSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_SCHEDULE_CRON_EXPRESSION_MAX_LENGTH);
export type AgentScheduleCronExpression = z.infer<typeof AgentScheduleCronExpressionSchema>;

export const AgentScheduleIntervalSecondsSchema = z.number().int().min(AGENT_SCHEDULE_MIN_INTERVAL_SECONDS).safe();

/* ----------------------------------------------------------------------------------------------
 * Rule shapes: caller input (no Server-owned fields) vs. persisted form (`every` gains anchorAt).
 * ------------------------------------------------------------------------------------------- */

export const AgentScheduleAtInputSchema = z
  .object({ kind: z.literal("at"), at: ScheduleAbsoluteInstantInputSchema })
  .strict();
export const AgentScheduleEveryInputSchema = z
  .object({ kind: z.literal("every"), intervalSeconds: AgentScheduleIntervalSecondsSchema })
  .strict();
export const AgentScheduleCronInputSchema = z
  .object({ kind: z.literal("cron"), expression: AgentScheduleCronExpressionSchema })
  .strict();
/** Exactly the three supported time types a caller may submit. `anchorAt` is never caller input. */
export const AgentScheduleInputSchema = z.discriminatedUnion("kind", [
  AgentScheduleAtInputSchema,
  AgentScheduleEveryInputSchema,
  AgentScheduleCronInputSchema,
]);
export type AgentScheduleInput = z.infer<typeof AgentScheduleInputSchema>;

export const AgentScheduleAtRuleSchema = z.object({ kind: z.literal("at"), at: ScheduleUtcInstantSchema }).strict();
export const AgentScheduleEveryRuleSchema = z
  .object({
    kind: z.literal("every"),
    intervalSeconds: AgentScheduleIntervalSecondsSchema,
    /** Server-written fixed anchor from the creation/change transaction; first run is one interval later. */
    anchorAt: ScheduleUtcInstantSchema,
  })
  .strict();
export const AgentScheduleCronRuleSchema = z
  .object({ kind: z.literal("cron"), expression: AgentScheduleCronExpressionSchema })
  .strict();
/** The persisted rule shape; mirrors the `agent_schedules.schedule` jsonb CHECK constraint. */
export const AgentScheduleRuleSchema = z.discriminatedUnion("kind", [
  AgentScheduleAtRuleSchema,
  AgentScheduleEveryRuleSchema,
  AgentScheduleCronRuleSchema,
]);
export type AgentScheduleRule = z.infer<typeof AgentScheduleRuleSchema>;

/* ----------------------------------------------------------------------------------------------
 * Latest dispatch summary (`last_dispatch` jsonb). Not a run history: only the most recent
 * claim/hand-off facts, so a user can see what happened last without a separate history system.
 * ------------------------------------------------------------------------------------------- */

/**
 * Schedule-summary outcomes only. `skipped` exists here but never in `session_message_outcome`;
 * `accepted` means the receiver took the message, never that the task completed.
 */
export const AgentScheduleDispatchOutcomeSchema = z.enum(["unknown", "accepted", "unreachable", "rejected", "skipped"]);
export type AgentScheduleDispatchOutcome = z.infer<typeof AgentScheduleDispatchOutcomeSchema>;

export const AgentScheduleLastDispatchSchema = z
  .object({
    /** The claimed occurrence instant, UTC. */
    scheduledFor: ScheduleUtcInstantSchema,
    /** When the hand-off was initiated; null when the occurrence was skipped without an attempt. */
    attemptedAt: ScheduleUtcInstantSchema.nullable(),
    /** The deterministic occurrence message id; null when no message was materialized. */
    messageId: z.string().uuid().nullable(),
    outcome: AgentScheduleDispatchOutcomeSchema,
    /** Stable machine code (existing outcome code or skip/disable reason); null when none applies. */
    code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,127}$/)
      .nullable(),
  })
  .strict();
export type AgentScheduleLastDispatch = z.infer<typeof AgentScheduleLastDispatchSchema>;

/* ----------------------------------------------------------------------------------------------
 * Management DTOs
 * ------------------------------------------------------------------------------------------- */

/** Fixed target display facts, read back from the pinned Session's existing IM conversation. */
export const AgentScheduleTargetSchema = z
  .object({
    sessionId: z.string().uuid(),
    provider: z.enum(["feishu", "slack"]),
    sessionKind: z.enum(["channel", "thread"]),
    channelId: z.string().min(1).max(512),
    threadKey: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type AgentScheduleTarget = z.infer<typeof AgentScheduleTargetSchema>;

/** Full Schedule DTO: every management field, the full prompt, and the Web detail link. */
export const AgentScheduleSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    target: AgentScheduleTargetSchema,
    name: AgentScheduleNameSchema,
    prompt: AgentSchedulePromptSchema,
    schedule: AgentScheduleRuleSchema,
    timezone: z.string().min(1).max(AGENT_SCHEDULE_TIMEZONE_MAX_LENGTH),
    enabled: z.boolean(),
    nextTriggerAt: ScheduleUtcInstantSchema.nullable(),
    revision: z.number().int().min(1).safe(),
    lastDispatch: AgentScheduleLastDispatchSchema.nullable(),
    /** Deep link into the owning Agent's Web detail page; never a public share link. */
    detailUrl: z.string().url().max(2048),
    createdAt: ScheduleUtcInstantSchema,
    updatedAt: ScheduleUtcInstantSchema,
  })
  .strict();
export type AgentSchedule = z.infer<typeof AgentScheduleSchema>;

/** List entries deliberately omit the full prompt and the detail link. */
export const AgentScheduleListItemSchema = AgentScheduleSchema.omit({ prompt: true, detailUrl: true }).strict();
export type AgentScheduleListItem = z.infer<typeof AgentScheduleListItemSchema>;

export const AgentScheduleListResponseSchema = z
  .object({
    items: z.array(AgentScheduleListItemSchema).max(AGENT_SCHEDULE_LIST_LIMIT_MAX),
    nextCursor: z.string().min(1).max(1024).nullable(),
  })
  .strict();
export type AgentScheduleListResponse = z.infer<typeof AgentScheduleListResponseSchema>;

/* ----------------------------------------------------------------------------------------------
 * Requests
 * ------------------------------------------------------------------------------------------- */

export const CreateAgentScheduleRequestSchema = z
  .object({
    name: AgentScheduleNameSchema,
    prompt: AgentSchedulePromptSchema,
    schedule: AgentScheduleInputSchema,
    timezone: AgentScheduleTimezoneSchema,
  })
  .strict();
export type CreateAgentScheduleRequest = z.infer<typeof CreateAgentScheduleRequestSchema>;

export const AgentScheduleListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(AGENT_SCHEDULE_LIST_LIMIT_MAX).default(AGENT_SCHEDULE_LIST_LIMIT_DEFAULT),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type AgentScheduleListQuery = z.infer<typeof AgentScheduleListQuerySchema>;

export const AgentScheduleExpectedRevisionSchema = z.number().int().min(1).safe();

export const UpdateAgentScheduleRequestSchema = z
  .object({
    expectedRevision: AgentScheduleExpectedRevisionSchema,
    name: AgentScheduleNameSchema.optional(),
    prompt: AgentSchedulePromptSchema.optional(),
    schedule: AgentScheduleInputSchema.optional(),
    timezone: AgentScheduleTimezoneSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.prompt !== undefined ||
      value.schedule !== undefined ||
      value.timezone !== undefined,
    { message: "At least one of name, prompt, schedule, or timezone must be updated" },
  );
export type UpdateAgentScheduleRequest = z.infer<typeof UpdateAgentScheduleRequestSchema>;

/** Pause/resume bodies: optimistic concurrency only. */
export const AgentScheduleRevisionRequestSchema = z
  .object({ expectedRevision: AgentScheduleExpectedRevisionSchema })
  .strict();
export type AgentScheduleRevisionRequest = z.infer<typeof AgentScheduleRevisionRequestSchema>;

/** DELETE carries the revision in the query string. */
export const AgentScheduleDeleteQuerySchema = z.object({ expectedRevision: z.coerce.number().int().min(1) }).strict();
export type AgentScheduleDeleteQuery = z.infer<typeof AgentScheduleDeleteQuerySchema>;

/** Preview either a persisted Schedule (keeps its `every` anchor) or an ad-hoc rule + timezone. */
export const PreviewAgentScheduleRequestSchema = z.union([
  z.object({ scheduleId: z.string().uuid() }).strict(),
  z.object({ schedule: AgentScheduleInputSchema, timezone: AgentScheduleTimezoneSchema }).strict(),
]);
export type PreviewAgentScheduleRequest = z.infer<typeof PreviewAgentScheduleRequestSchema>;

export const AgentSchedulePreviewItemSchema = z
  .object({
    /** UTC instant. */
    at: ScheduleUtcInstantSchema,
    /** The same instant in the Schedule timezone: `YYYY-MM-DD HH:mm:ss ±HH:MM`. */
    local: z.string().min(1).max(64),
    timezone: z.string().min(1).max(AGENT_SCHEDULE_TIMEZONE_MAX_LENGTH),
  })
  .strict();
export type AgentSchedulePreviewItem = z.infer<typeof AgentSchedulePreviewItemSchema>;

export const AgentSchedulePreviewSchema = z
  .object({
    /** The instant the preview was computed against (database time at the call). */
    calculatedAt: ScheduleUtcInstantSchema,
    /** Normalized persisted rule; an ad-hoc `every` preview carries its assumed anchor. */
    schedule: AgentScheduleRuleSchema,
    timezone: z.string().min(1).max(AGENT_SCHEDULE_TIMEZONE_MAX_LENGTH),
    /** One item for a future `at`, zero for an exhausted one, at most five otherwise. */
    items: z.array(AgentSchedulePreviewItemSchema).max(AGENT_SCHEDULE_PREVIEW_MAX_COUNT),
  })
  .strict();
export type AgentSchedulePreview = z.infer<typeof AgentSchedulePreviewSchema>;

/* ----------------------------------------------------------------------------------------------
 * Error codes
 * ------------------------------------------------------------------------------------------- */

export const SCHEDULE_ERROR_CODES = {
  INVALID_REQUEST: "SCHEDULE_INVALID_REQUEST",
  INVALID_RULE: "SCHEDULE_INVALID_RULE",
  INVALID_TIMEZONE: "SCHEDULE_INVALID_TIMEZONE",
  TARGET_REQUIRED: "SCHEDULE_TARGET_REQUIRED",
  TARGET_INVALID: "SCHEDULE_TARGET_INVALID",
  NO_FUTURE_OCCURRENCE: "SCHEDULE_NO_FUTURE_OCCURRENCE",
  REVISION_CONFLICT: "SCHEDULE_REVISION_CONFLICT",
} as const;
export type ScheduleErrorCode = (typeof SCHEDULE_ERROR_CODES)[keyof typeof SCHEDULE_ERROR_CODES];
export type ScheduleErrorCategory = "validation" | "deterministic";

/** The `category` / HTTP `statusCode` mapping every Schedule management failure uses. */
export const SCHEDULE_ERROR_CODE_METADATA: Readonly<
  Record<ScheduleErrorCode, { category: ScheduleErrorCategory; statusCode: number }>
> = {
  [SCHEDULE_ERROR_CODES.INVALID_REQUEST]: { category: "validation", statusCode: 400 },
  [SCHEDULE_ERROR_CODES.INVALID_RULE]: { category: "validation", statusCode: 400 },
  [SCHEDULE_ERROR_CODES.INVALID_TIMEZONE]: { category: "validation", statusCode: 400 },
  [SCHEDULE_ERROR_CODES.TARGET_REQUIRED]: { category: "deterministic", statusCode: 409 },
  [SCHEDULE_ERROR_CODES.TARGET_INVALID]: { category: "deterministic", statusCode: 409 },
  [SCHEDULE_ERROR_CODES.NO_FUTURE_OCCURRENCE]: { category: "deterministic", statusCode: 409 },
  [SCHEDULE_ERROR_CODES.REVISION_CONFLICT]: { category: "deterministic", statusCode: 409 },
};
