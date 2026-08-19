import { createHash } from "node:crypto";
import { z } from "zod";
import { RuntimeRequestIdSchema } from "./runtime-protocol.js";

export const RUNTIME_ID_MAX_BYTES = 128;
export const RUNTIME_DIRECT_TEXT_MAX_BYTES = 16 * 1024;
export const RUNTIME_INSTRUCTIONS_MAX_BYTES = 24 * 1024;
export const RUNTIME_FINAL_TEXT_MAX_BYTES = 48 * 1024;
export const RUNTIME_TRACE_EVENT_MAX_BYTES = 16 * 1024;
export const RUNTIME_TRACE_BATCH_MAX_EVENTS = 64;
export const RUNTIME_IM_HISTORY_MAX_BYTES = 40 * 1024;
export const RUNTIME_IM_RESOURCE_MAX_COUNT = 16;
export const OPENTAG_MESSAGE_TOOLS = [
  "opentag_message_send",
  "opentag_message_reply",
  "opentag_message_react",
] as const;
// MVP recovery bridge. Post-MVP, authoritative Turn results move to durable Server ownership.
export const RUNTIME_MVP_RETAINED_REPORT_LIMIT = 65;

const utf8 = new TextEncoder();
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const relativePathPattern = /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/;

function utf8Length(value: string): number {
  return utf8.encode(value).byteLength;
}

function byteString(maxBytes: number, message: string, minimumBytes = 0) {
  return z.string().superRefine((value, context) => {
    const bytes = utf8Length(value);
    if (bytes < minimumBytes || bytes > maxBytes) {
      context.addIssue({ code: "custom", message });
    }
  });
}

export const RuntimeOpaqueIdSchema = z
  .string()
  .min(1)
  .max(RUNTIME_ID_MAX_BYTES)
  .regex(opaqueIdPattern, "Runtime IDs must be opaque, path-safe ASCII identifiers");
export const RuntimeSequenceSchema = z.number().int().safe().nonnegative();
export const RuntimeSha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");

export const RuntimeRevisionSchema = z
  .object({
    sequence: RuntimeSequenceSchema,
    id: RuntimeOpaqueIdSchema,
  })
  .strict();

export const RuntimeUsageSchema = z
  .object({
    inputTokens: RuntimeSequenceSchema.optional(),
    cachedInputTokens: RuntimeSequenceSchema.optional(),
    outputTokens: RuntimeSequenceSchema.optional(),
  })
  .strict();

export const EffectiveRuntimeSnapshotSchema = z
  .object({
    revision: z
      .object({
        agent: RuntimeRevisionSchema,
        session: RuntimeRevisionSchema,
      })
      .strict(),
    agentId: RuntimeOpaqueIdSchema,
    provider: z.literal("codex"),
    model: byteString(128, "Model exceeds the 128-byte limit", 1).optional(),
    reasoningEffort: byteString(64, "Reasoning effort exceeds the 64-byte limit", 1).optional(),
    instructions: z
      .object({
        platform: byteString(RUNTIME_INSTRUCTIONS_MAX_BYTES, "Platform instructions are too large"),
        agent: byteString(RUNTIME_INSTRUCTIONS_MAX_BYTES, "Agent instructions are too large"),
        session: byteString(RUNTIME_INSTRUCTIONS_MAX_BYTES, "Session instructions are too large").optional(),
      })
      .strict(),
    allowedTools: z.array(byteString(RUNTIME_ID_MAX_BYTES, "Tool ID exceeds the 128-byte limit", 1)).max(64),
    execution: z
      .object({
        approvalPolicy: z.literal("never"),
        networkAccess: z.boolean(),
      })
      .strict(),
    workspace: z
      .object({
        workspaceId: RuntimeOpaqueIdSchema,
        mode: z.literal("empty_on_create"),
        sharing: z.literal("agent"),
      })
      .strict(),
    budget: z
      .object({
        maxDurationMs: z
          .number()
          .int()
          .safe()
          .positive()
          .max(24 * 60 * 60 * 1_000)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const instructionBytes =
      utf8Length(snapshot.instructions.platform) +
      utf8Length(snapshot.instructions.agent) +
      utf8Length(snapshot.instructions.session ?? "");
    if (instructionBytes > RUNTIME_INSTRUCTIONS_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["instructions"],
        message: "Combined instructions exceed the 24 KiB limit",
      });
    }
    if (new Set(snapshot.allowedTools).size !== snapshot.allowedTools.length) {
      context.addIssue({ code: "custom", path: ["allowedTools"], message: "Tool IDs must be unique" });
    }
  });

export const InputRejectReasonSchema = z.enum([
  "invalid_input",
  "target_mismatch",
  "session_not_ready",
  "stale_generation",
  "stale_configuration",
  "agent_configuration_busy",
  "input_conflict",
  "session_binding_conflict",
  "session_recovery_required",
  "turn_expired",
  "session_busy",
  "agent_busy",
  "client_busy",
  "provider_unavailable",
  "configuration_unsupported",
]);

export const TurnFailureReasonSchema = z.enum([
  "workspace_failed",
  "configuration_conflict",
  "credential_unavailable",
  "sandbox_unavailable",
  "provider_start_failed",
  "session_resume_failed",
  "provider_protocol_error",
  "provider_failed",
  "provider_empty_result",
  "output_too_large",
  "provider_teardown_failed",
  "turn_state_unknown",
  "turn_timeout",
  "client_shutdown",
]);

export const SessionReconcileRequestSchema = z
  .object({
    type: z.literal("session:reconcile"),
    requestId: RuntimeRequestIdSchema,
    computerId: z.string().uuid(),
    sessionId: RuntimeOpaqueIdSchema,
    agentId: RuntimeOpaqueIdSchema,
    placementGeneration: RuntimeSequenceSchema,
    desired: z.enum(["ready", "stopped"]),
    runtime: EffectiveRuntimeSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.desired === "ready" && !frame.runtime) {
      context.addIssue({ code: "custom", path: ["runtime"], message: "A ready reconcile requires a runtime snapshot" });
    }
    if (frame.desired === "stopped" && frame.runtime) {
      context.addIssue({
        code: "custom",
        path: ["runtime"],
        message: "A stopped reconcile forbids a runtime snapshot",
      });
    }
    if (frame.runtime && frame.runtime.agentId !== frame.agentId) {
      context.addIssue({ code: "custom", path: ["runtime", "agentId"], message: "Agent identity does not match" });
    }
  });

const ReconcileTurnSchema = z
  .object({
    turnId: RuntimeOpaqueIdSchema,
    deliveryId: RuntimeOpaqueIdSchema,
  })
  .strict();

export const RuntimeImResourceReferenceSchema = z
  .object({
    resourceId: RuntimeOpaqueIdSchema,
    kind: z.enum(["image", "file", "audio", "video"]),
    filename: byteString(512, "Resource filename exceeds the 512-byte limit", 1).optional(),
    mediaType: byteString(255, "Resource media type exceeds the 255-byte limit", 1).optional(),
    sizeBytes: z.number().int().safe().nonnegative().optional(),
    availability: z.enum(["available", "unavailable", "too_large", "unsupported"]),
  })
  .strict();

export const RuntimeImHistoryItemSchema = z
  .object({
    imMessageId: RuntimeOpaqueIdSchema,
    occurredAt: z.string().datetime({ offset: true }),
    text: byteString(RUNTIME_DIRECT_TEXT_MAX_BYTES, "History item exceeds the 16 KiB limit"),
  })
  .strict();

export const RetainedTurnReportClaimSchema = z
  .object({
    deliveryId: RuntimeOpaqueIdSchema,
    turnId: RuntimeOpaqueIdSchema,
    placementGeneration: RuntimeSequenceSchema,
    resultHash: RuntimeSha256Schema,
  })
  .strict();

export const SessionReconcileResultSchema = z
  .object({
    type: z.literal("session:reconcile:result"),
    requestId: RuntimeRequestIdSchema,
    sessionId: RuntimeOpaqueIdSchema,
    placementGeneration: RuntimeSequenceSchema,
    status: z.enum(["ready", "stopped", "running", "reporting", "busy", "recovery_required", "rejected"]),
    reason: byteString(256, "Reconcile reason exceeds the 256-byte limit", 1).optional(),
    turn: ReconcileTurnSchema.optional(),
    // MVP-only recovery manifest. Durable Server-side Turn ownership replaces it after MVP.
    retainedReports: z.array(RetainedTurnReportClaimSchema).max(RUNTIME_MVP_RETAINED_REPORT_LIMIT).optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    const needsTurn =
      frame.status === "running" || frame.status === "reporting" || frame.status === "recovery_required";
    if (needsTurn !== Boolean(frame.turn)) {
      context.addIssue({
        code: "custom",
        path: ["turn"],
        message: "The reconcile status and turn fields do not match",
      });
    }
    if ((frame.status === "ready" || frame.status === "stopped") && frame.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Successful reconcile results cannot include a reason",
      });
    }
    if (frame.status === "rejected" && frame.retainedReports) {
      context.addIssue({
        code: "custom",
        path: ["retainedReports"],
        message: "Rejected reconciliation cannot establish retained Turn Report claims",
      });
    }
    if (frame.retainedReports) {
      const turnIds = new Set(frame.retainedReports.map((claim) => claim.turnId));
      if (turnIds.size !== frame.retainedReports.length) {
        context.addIssue({
          code: "custom",
          path: ["retainedReports"],
          message: "Retained Turn Report claims must have unique Turn IDs",
        });
      }
      const deliveryIds = new Set(frame.retainedReports.map((claim) => claim.deliveryId));
      if (deliveryIds.size !== frame.retainedReports.length) {
        context.addIssue({
          code: "custom",
          path: ["retainedReports"],
          message: "Retained Turn Report claims must have unique delivery IDs",
        });
      }
      if (frame.retainedReports.some((claim) => claim.placementGeneration > frame.placementGeneration)) {
        context.addIssue({
          code: "custom",
          path: ["retainedReports"],
          message: "Retained Turn Report claims cannot be from a future placement generation",
        });
      }
    }
  });

export const DirectImMessageDeliveryRequestSchema = z
  .object({
    type: z.literal("im:deliver"),
    requestId: RuntimeRequestIdSchema,
    deliveryId: RuntimeOpaqueIdSchema,
    imMessageId: RuntimeOpaqueIdSchema,
    imMessageRevision: z.number().int().safe().positive(),
    sessionId: RuntimeOpaqueIdSchema,
    agentId: RuntimeOpaqueIdSchema,
    placementGeneration: RuntimeSequenceSchema,
    attention: z.enum(["direct", "ambient"]),
    content: z
      .object({
        kind: z.literal("text"),
        text: byteString(RUNTIME_DIRECT_TEXT_MAX_BYTES, "Direct text exceeds the 16 KiB limit", 1),
        history: z.array(RuntimeImHistoryItemSchema).max(100).optional(),
        historyTruncated: z.boolean().optional(),
        resources: z.array(RuntimeImResourceReferenceSchema).max(RUNTIME_IM_RESOURCE_MAX_COUNT).optional(),
      })
      .strict(),
    runtime: EffectiveRuntimeSnapshotSchema,
    deadlineAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.runtime.agentId !== frame.agentId) {
      context.addIssue({ code: "custom", path: ["runtime", "agentId"], message: "Agent identity does not match" });
    }
    const historyBytes = utf8Length(JSON.stringify(frame.content.history ?? []));
    if (historyBytes > RUNTIME_IM_HISTORY_MAX_BYTES) {
      context.addIssue({ code: "custom", path: ["content", "history"], message: "IM history exceeds 40 KiB" });
    }
  });

export const RuntimeImToolRequestSchema = z
  .object({
    type: z.literal("im:tool"),
    requestId: RuntimeRequestIdSchema,
    sessionId: RuntimeOpaqueIdSchema,
    agentId: RuntimeOpaqueIdSchema,
    placementGeneration: RuntimeSequenceSchema,
    expectedLatestImMessageId: RuntimeOpaqueIdSchema,
    operation: z.enum(["send", "reply", "react"]),
    text: byteString(RUNTIME_DIRECT_TEXT_MAX_BYTES, "Outbound text exceeds the 16 KiB limit", 1).optional(),
    replyToImMessageId: RuntimeOpaqueIdSchema.optional(),
    targetImMessageId: RuntimeOpaqueIdSchema.optional(),
    emoji: byteString(128, "Reaction emoji exceeds the 128-byte limit", 1).optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.operation === "react") {
      if (!frame.targetImMessageId)
        context.addIssue({ code: "custom", path: ["targetImMessageId"], message: "Reaction target is required" });
      if (!frame.emoji) context.addIssue({ code: "custom", path: ["emoji"], message: "Reaction emoji is required" });
      if (frame.text || frame.replyToImMessageId)
        context.addIssue({ code: "custom", message: "Reaction payload is invalid" });
      return;
    }
    if (!frame.text) context.addIssue({ code: "custom", path: ["text"], message: "Outbound text is required" });
    if (frame.operation === "reply" && !frame.replyToImMessageId) {
      context.addIssue({ code: "custom", path: ["replyToImMessageId"], message: "Reply target is required" });
    }
  });

export const RuntimeImToolResultSchema = z
  .object({
    type: z.literal("im:tool:result"),
    requestId: RuntimeRequestIdSchema,
    state: z.enum(["succeeded", "deterministic_failed", "credential_failed", "transient_failed", "unknown"]),
    code: byteString(160, "IM tool result code exceeds the 160-byte limit", 1).optional(),
    providerMessageId: byteString(512, "Provider message ID exceeds the 512-byte limit", 1).optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
  })
  .strict();

export const ImMessageDeliveryResultSchema = z
  .object({
    type: z.literal("im:deliver:result"),
    requestId: RuntimeRequestIdSchema,
    deliveryId: RuntimeOpaqueIdSchema,
    sessionId: RuntimeOpaqueIdSchema,
    placementGeneration: RuntimeSequenceSchema,
    status: z.enum(["accepted", "rejected"]),
    turnId: RuntimeOpaqueIdSchema.optional(),
    reason: InputRejectReasonSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.status === "accepted" && (!frame.turnId || frame.reason)) {
      context.addIssue({ code: "custom", message: "Accepted deliveries require a turn ID and forbid a reason" });
    }
    if (frame.status === "rejected" && (!frame.reason || frame.turnId)) {
      context.addIssue({ code: "custom", message: "Rejected deliveries require a reason and forbid a turn ID" });
    }
  });

const TraceEventBaseSchema = z.object({
  sequence: z.number().int().safe().positive(),
  at: z.string().datetime({ offset: true }),
});

export const AgentTraceEventSchema = z
  .discriminatedUnion("kind", [
    TraceEventBaseSchema.extend({ kind: z.literal("turn_started") }).strict(),
    TraceEventBaseSchema.extend({
      kind: z.literal("item_completed"),
      itemType: z.enum(["agent_message", "command", "file_change", "tool", "other"]),
      status: z.enum(["completed", "failed"]),
      path: byteString(512, "Trace path exceeds the 512-byte limit", 1).regex(relativePathPattern).optional(),
      preview: byteString(2 * 1024, "Trace preview exceeds the 2 KiB limit").optional(),
    }).strict(),
    TraceEventBaseSchema.extend({ kind: z.literal("usage_updated"), usage: RuntimeUsageSchema }).strict(),
    TraceEventBaseSchema.extend({
      kind: z.literal("warning"),
      code: RuntimeOpaqueIdSchema,
      message: byteString(2 * 1024, "Trace warning exceeds the 2 KiB limit", 1),
    }).strict(),
    TraceEventBaseSchema.extend({
      kind: z.literal("turn_completed"),
      outcome: z.enum(["completed", "failed", "cancelled", "unknown"]),
    }).strict(),
  ])
  .superRefine((event, context) => {
    if (utf8Length(JSON.stringify(event)) > RUNTIME_TRACE_EVENT_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "Trace event exceeds the 16 KiB limit" });
    }
  });

export const AgentTraceBatchSchema = z
  .object({
    type: z.literal("agent:trace"),
    batchId: RuntimeOpaqueIdSchema,
    sessionId: RuntimeOpaqueIdSchema,
    turnId: RuntimeOpaqueIdSchema,
    placementGeneration: RuntimeSequenceSchema,
    events: z.array(AgentTraceEventSchema).min(1).max(RUNTIME_TRACE_BATCH_MAX_EVENTS),
  })
  .strict()
  .superRefine((batch, context) => {
    for (let index = 1; index < batch.events.length; index += 1) {
      const previous = batch.events[index - 1];
      const current = batch.events[index];
      if (previous && current && current.sequence <= previous.sequence) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message: "Trace sequences must increase",
        });
      }
    }
  });

export const TurnReportRequestSchema = z
  .object({
    type: z.literal("turn:report"),
    requestId: RuntimeRequestIdSchema,
    deliveryId: RuntimeOpaqueIdSchema,
    turnId: RuntimeOpaqueIdSchema,
    sessionId: RuntimeOpaqueIdSchema,
    agentId: RuntimeOpaqueIdSchema,
    placementGeneration: RuntimeSequenceSchema,
    outcome: z.enum(["completed", "failed", "cancelled", "unknown"]),
    executionEffects: z.enum(["not_started", "may_have_occurred", "completed"]),
    finalText: byteString(RUNTIME_FINAL_TEXT_MAX_BYTES, "Final text exceeds the 48 KiB limit", 1).optional(),
    errorReason: TurnFailureReasonSchema.optional(),
    usage: RuntimeUsageSchema.optional(),
    traceSummary: z
      .object({
        lastSequence: RuntimeSequenceSchema,
        droppedEvents: RuntimeSequenceSchema,
      })
      .strict(),
    resultHash: RuntimeSha256Schema,
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.outcome === "completed" && frame.errorReason) {
      context.addIssue({ code: "custom", path: ["errorReason"], message: "Completed reports cannot include an error" });
    }
    if (frame.outcome !== "completed" && !frame.errorReason) {
      context.addIssue({ code: "custom", path: ["errorReason"], message: "Non-completed reports require an error" });
    }
    if (frame.resultHash !== computeTurnResultHash(frame)) {
      context.addIssue({ code: "custom", path: ["resultHash"], message: "Turn result hash does not match the report" });
    }
  });

export const TurnReportResultSchema = z
  .object({
    type: z.literal("turn:report:result"),
    requestId: RuntimeRequestIdSchema,
    turnId: RuntimeOpaqueIdSchema,
    status: z.enum(["recorded", "already_recorded", "conflict", "stale_generation"]),
    resultHash: RuntimeSha256Schema,
  })
  .strict();

export const ServerRuntimeBusinessFrameSchema = z.discriminatedUnion("type", [
  SessionReconcileRequestSchema,
  DirectImMessageDeliveryRequestSchema,
  TurnReportResultSchema,
  RuntimeImToolResultSchema,
]);

export const ClientRuntimeBusinessFrameSchema = z.discriminatedUnion("type", [
  SessionReconcileResultSchema,
  ImMessageDeliveryResultSchema,
  AgentTraceBatchSchema,
  TurnReportRequestSchema,
  RuntimeImToolRequestSchema,
]);

export type RuntimeRevision = z.infer<typeof RuntimeRevisionSchema>;
export type RuntimeUsage = z.infer<typeof RuntimeUsageSchema>;
export type EffectiveRuntimeSnapshot = z.infer<typeof EffectiveRuntimeSnapshotSchema>;
export type InputRejectReason = z.infer<typeof InputRejectReasonSchema>;
export type TurnFailureReason = z.infer<typeof TurnFailureReasonSchema>;
export type SessionReconcileRequest = z.infer<typeof SessionReconcileRequestSchema>;
export type SessionReconcileResult = z.infer<typeof SessionReconcileResultSchema>;
export type RetainedTurnReportClaim = z.infer<typeof RetainedTurnReportClaimSchema>;
export type DirectImMessageDeliveryRequest = z.infer<typeof DirectImMessageDeliveryRequestSchema>;
export type RuntimeImResourceReference = z.infer<typeof RuntimeImResourceReferenceSchema>;
export type RuntimeImHistoryItem = z.infer<typeof RuntimeImHistoryItemSchema>;
export type RuntimeImToolRequest = z.infer<typeof RuntimeImToolRequestSchema>;
export type RuntimeImToolResult = z.infer<typeof RuntimeImToolResultSchema>;
export type ImMessageDeliveryResult = z.infer<typeof ImMessageDeliveryResultSchema>;
export type AgentTraceEvent = z.infer<typeof AgentTraceEventSchema>;
export type AgentTraceBatch = z.infer<typeof AgentTraceBatchSchema>;
export type TurnReportRequest = z.infer<typeof TurnReportRequestSchema>;
export type TurnReportResult = z.infer<typeof TurnReportResultSchema>;
export type ServerRuntimeBusinessFrame = z.infer<typeof ServerRuntimeBusinessFrameSchema>;
export type ClientRuntimeBusinessFrame = z.infer<typeof ClientRuntimeBusinessFrameSchema>;

export interface RuntimeSnapshotHashes {
  agentConfigHash: string;
  sessionConfigHash: string;
  effectiveSnapshotHash: string;
}

export function computeRuntimeSnapshotHashes(input: EffectiveRuntimeSnapshot): RuntimeSnapshotHashes {
  const snapshot = EffectiveRuntimeSnapshotSchema.parse(input);
  const agentConfigHash = hashTuple([
    1,
    snapshot.agentId,
    snapshot.provider,
    snapshot.revision.agent.sequence,
    snapshot.revision.agent.id,
    snapshot.instructions.platform,
    snapshot.instructions.agent,
    snapshot.workspace.workspaceId,
    snapshot.workspace.mode,
    snapshot.workspace.sharing,
  ]);
  const sessionConfigHash = hashTuple([
    1,
    snapshot.revision.session.sequence,
    snapshot.revision.session.id,
    snapshot.model ?? null,
    snapshot.reasoningEffort ?? null,
    snapshot.instructions.session ?? null,
    [...snapshot.allowedTools].sort(),
    snapshot.execution.approvalPolicy,
    snapshot.execution.networkAccess,
    snapshot.budget?.maxDurationMs ?? null,
  ]);
  return {
    agentConfigHash,
    sessionConfigHash,
    effectiveSnapshotHash: hashTuple([1, agentConfigHash, sessionConfigHash]),
  };
}

export function computeDirectInputHash(input: DirectImMessageDeliveryRequest): string {
  const frame = DirectImMessageDeliveryRequestSchema.parse(input);
  return hashTuple([
    1,
    frame.imMessageId,
    frame.imMessageRevision,
    frame.sessionId,
    frame.agentId,
    frame.placementGeneration,
    frame.attention,
    frame.content.kind,
    frame.content.text,
    frame.content.history ?? [],
    frame.content.historyTruncated ?? false,
    frame.content.resources ?? [],
    computeRuntimeSnapshotHashes(frame.runtime).effectiveSnapshotHash,
    frame.deadlineAt ?? null,
  ]);
}

export function computeReconcilePayloadHash(input: SessionReconcileRequest): string {
  const frame = SessionReconcileRequestSchema.parse(input);
  return hashTuple([
    1,
    frame.computerId,
    frame.sessionId,
    frame.agentId,
    frame.placementGeneration,
    frame.desired,
    frame.runtime ? computeRuntimeSnapshotHashes(frame.runtime).effectiveSnapshotHash : null,
  ]);
}

export type TurnReportHashInput = Omit<TurnReportRequest, "resultHash" | "type" | "requestId">;

export function computeTurnResultHash(input: TurnReportHashInput): string {
  return hashTuple([
    input.deliveryId,
    input.turnId,
    input.sessionId,
    input.agentId,
    input.placementGeneration,
    input.outcome,
    input.executionEffects,
    input.finalText ?? null,
    input.errorReason ?? null,
    [input.usage?.inputTokens ?? null, input.usage?.cachedInputTokens ?? null, input.usage?.outputTokens ?? null],
    [input.traceSummary.lastSequence, input.traceSummary.droppedEvents],
  ]);
}

export function hashTuple(tuple: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
}
