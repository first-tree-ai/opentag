import { z } from "zod";
import { runtimeByteString } from "./runtime-config.js";
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

/**
 * How long `session stop` waits for its execution side before answering `pending`. It must stay below the
 * CLI's request timeout, or a frozen Client turns a stop that already took effect into a transport error, and
 * above what a Client needs to close a provider that ignores the interrupt (5 s of grace plus the close).
 */
export const SESSION_STOP_ANSWER_BUDGET_MS = 15_000;

export const SessionCliStopRequestSchema = z
  .object({
    targetSessionId: z.string().uuid(),
  })
  .strict();

/**
 * What became of the Session's work once the Session ended. `stopped`: its Client confirmed the Run and
 * queue are gone. `requested`: its Cloud Runner was sent the cancellation. `pending`: its Computer could not
 * be reached or did not answer in time; the stop is sent again when the Computer reconnects. `not_interrupted`: its Client is too old
 * to interrupt a Run, which continues without Session authority until it ends.
 */
export const SessionCliStopExecutionSchema = z.enum(["stopped", "requested", "pending", "not_interrupted"]);

export const SessionCliStopResponseSchema = z
  .object({
    status: z.enum(["stopped", "unreachable", "rejected"]),
    sessionId: z.string().uuid(),
    code: z.string().min(1).max(128).optional(),
    execution: SessionCliStopExecutionSchema.optional(),
    alreadyStopped: z.boolean().optional(),
    /** Descendants this stop ended along with its target. `execution` covers them too. */
    stoppedDescendantCount: z.number().int().min(0).optional(),
  })
  .strict();

export const SessionCliListQuerySchema = z
  .object({
    recursive: z.boolean().default(false),
    includeStopped: z.boolean().optional(),
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
    /** Only on a page that asked for stopped Sessions, so an older CLI never sees the field. */
    stoppedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const SessionCliListResponseSchema = z
  .object({
    items: z.array(SessionCliListItemSchema).max(SESSION_CLI_MAX_LIMIT),
    nextCursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

/**
 * The Server-minted proof a managed Runtime hands to the in-Session CLI. The token is a bearer
 * credential bound to the exact Session/placement/execution connection; it is delivered only over
 * authenticated runtime channels (Local reconcile, Cloud verified frames) and worker stdin.
 */
export const SessionCliProofGrantSchema = z
  .object({
    proofId: z.string().uuid(),
    token: runtimeByteString(4096, "Session CLI proof exceeds the 4 KiB limit", 32),
  })
  .strict();
export type SessionCliProofGrant = z.infer<typeof SessionCliProofGrantSchema>;

export type SessionCliCreateRequest = z.infer<typeof SessionCliCreateRequestSchema>;
export type SessionCliSendRequest = z.infer<typeof SessionCliSendRequestSchema>;
export type SessionCliCommandResponse = z.infer<typeof SessionCliCommandResponseSchema>;
export type SessionCliStopExecution = z.infer<typeof SessionCliStopExecutionSchema>;
export type SessionCliStopRequest = z.infer<typeof SessionCliStopRequestSchema>;
export type SessionCliStopResponse = z.infer<typeof SessionCliStopResponseSchema>;
export type SessionCliListQuery = z.infer<typeof SessionCliListQuerySchema>;
export type SessionCliListItem = z.infer<typeof SessionCliListItemSchema>;
export type SessionCliListResponse = z.infer<typeof SessionCliListResponseSchema>;
