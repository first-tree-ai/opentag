import { z } from "zod";
import {
  RUNNER_WORKSPACE_VERSION,
  RunnerWorkspaceSealFrameSchema,
  RunnerWorkspaceSealResultFrameSchema,
} from "./runner-workspace.js";
import { runtimeUtf8Length } from "./runtime-config.js";
import { RuntimeCredentialClientFrameSchema, RuntimeCredentialServerFrameSchema } from "./runtime-credentials.js";
import {
  DirectImMessageDeliveryRequestSchema,
  RuntimeImOutboxContextSchema,
  RuntimeModelSchema,
  RuntimeOpaqueIdSchema,
  SessionMessageDeliveryRequestSchema,
  TurnReportRequestSchema,
} from "./runtime-domain.js";
import { SandboxLifecycleSchema } from "./sandbox.js";
import { SessionCliProofGrantSchema } from "./session-cli.js";

/**
 * E3 Cloud Runner contract: the Session-owned Sandbox is materialized as exactly one Cloud Run
 * Instance that dials the Server over an outbound WebSocket and launches the native sandbox.
 *
 * The WebSocket protocol authenticates with a first-frame bootstrap bearer token (never a URL
 * token). The token claims (sandboxId/sessionId/environmentGeneration/resourceName) are verified
 * against the CURRENT database allocation on every connect, so a stale Runner from a replaced
 * environment generation can never attach to the new environment.
 */

export const RUNNER_WS_PROTOCOL_VERSION = 1;
/**
 * E4 Cloud-delivery capability negotiated inside the existing protocol version 1 auth/welcome
 * exchange (E3 compatibility contract, `docs/cloud-runner-execution.md`). A new Runner requests it
 * in the auth frame; a Cloud-enabled Server echoes it in the welcome ONLY for a requesting
 * connection whose current allocation UID is already tracked. Legacy E3 channels never receive
 * E4 frames.
 */
export const RUNNER_CLOUD_DELIVERY_VERSION = 1 as const;
/**
 * E7 physical-instance reuse capability negotiated in the same auth/welcome exchange. A Runner
 * that holds a physical control credential requests it; the Server echoes it only after a
 * control-token attach resolved a current owner. Legacy Runners never send it, so they are never
 * asked to follow a Session-to-Session hand-off (idle deletion still saves them through E5).
 */
export const RUNNER_REUSE_VERSION = 1 as const;
/**
 * E8 Session-collaboration capability negotiated in the same auth/welcome exchange. The E8
 * Runner asks for it explicitly, and the Server echoes it ONLY for a requesting connection whose
 * Cloud allocation was fenced. Every `session:message:*` frame and the open-result
 * `sessionCliProof` field are gated on this echo, so an E7 Runner (same `runnerVersion` string,
 * strict frame schemas) never receives a field or frame it does not understand. A Runner that
 * does not request the capability keeps existing IM delivery unchanged. Deployment order is
 * Server-first with a pinned E8 Runner image: an E8 Runner against an old Server fails its auth
 * handshake (the strict E7 auth schema rejects the extra request field) instead of executing
 * without collaboration authority.
 */
export const RUNNER_SESSION_COLLABORATION_VERSION = 1 as const;

/** The Cloud Session-collaboration frame budget; mirrors the delivery run frame bound. */
const RUNNER_SESSION_MESSAGE_CONTEXT_REFINE = (value: {
  sessionKind: "internal" | "visible";
  outboxContext?: unknown;
}): boolean =>
  value.sessionKind === "visible" ? value.outboxContext !== undefined : value.outboxContext === undefined;
/** Server-mediated model proxy base path; the only paths below it are the source-owned allowlist. */
export const CLOUD_MODEL_PROXY_PATH = "/api/v1/cloud-model" as const;
/** The single OpenAI-compatible operation E4 admits. */
export const CLOUD_MODEL_CHAT_COMPLETIONS_PATH = `${CLOUD_MODEL_PROXY_PATH}/chat/completions` as const;
/** Runner control frames stay small; acceptance reports are bounded separately below. */
export const RUNNER_WS_MAX_FRAME_BYTES = 256 * 1024;
/** Bounded credential/config payloads: each document an Account may push for one acceptance run. */
export const RUNNER_PI_CONFIG_DOCUMENT_MAX_CHARS = 32 * 1024;
/** UTF-8 byte bound for a single Pi config document (non-ASCII text counts per byte). */
export const RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES = 32 * 1024;
/** Tightest dispatch budget: the serialized `kind/mode/piConfig` stdin document the worker reads. */
export const RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES = 128 * 1024;
export const RUNNER_ACCEPTANCE_MODES = ["offline", "real"] as const;
/** The only model provider E3 real acceptance admits. */
export const RUNNER_ACCEPTANCE_PROVIDER = "deepseek";

const UuidSchema = z.string().uuid();
const RequestIdSchema = z.string().min(1).max(256);
const ResourceNameSchema = z.string().min(1).max(1024);

export const RunnerAcceptanceModeSchema = z.enum(RUNNER_ACCEPTANCE_MODES);
export type RunnerAcceptanceMode = z.infer<typeof RunnerAcceptanceModeSchema>;

/* ----------------------------------------------------------------------------------------------
 * Runner acceptance report (wire-safe mirror of the Client Runner report; sanitized, no secrets)
 * ------------------------------------------------------------------------------------------- */

const ReportTextSchema = z.string().max(4 * 1024);

export const RunnerAcceptanceEventWireSchema = z
  .object({
    name: z.string().min(1).max(256),
    status: z.enum(["failed", "skipped", "passed"]),
    detail: ReportTextSchema.optional(),
  })
  .strict();

export const RunnerAcceptanceEvidenceWireSchema = z
  .object({
    cancel: z
      .object({
        livePidsBeforeCancel: z.number().int().nonnegative(),
        trackedPiPids: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    skillsLoaded: z.array(z.string().min(1).max(256)).max(64).optional(),
    tools: z
      .object({
        names: z.array(z.string().min(1).max(256)).max(128),
        successfulCount: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The identity document is accepted as bounded opaque evidence: it is emitted by the pinned
 * image and carries versions/SHAs only. Unknown extra keys are stripped rather than failing the
 * run, so a newer image does not break an older Server.
 */
export const RunnerIdentityWireSchema = z
  .object({
    version: z.string().max(64).optional(),
    sourceSha: z.string().max(64).optional(),
    sourceDirty: z.boolean().optional(),
    channel: z.string().max(32).optional(),
    nodeVersion: z.string().max(64).optional(),
    piVersion: z.string().max(64).optional(),
  })
  .strip();

export const RunnerAcceptanceReportWireSchema = z
  .object({
    events: z.array(RunnerAcceptanceEventWireSchema).max(256),
    evidence: RunnerAcceptanceEvidenceWireSchema.optional(),
    failed: z.boolean(),
    firstTaskMs: z.number().nonnegative().optional(),
    identity: RunnerIdentityWireSchema.optional(),
    model: z.enum(["failed", "skipped", "passed"]),
    offline: z.enum(["failed", "passed"]),
    skillArguments: z.array(z.string().max(1024)).max(64).optional(),
  })
  .strict();

export type RunnerAcceptanceReportWire = z.infer<typeof RunnerAcceptanceReportWireSchema>;

/* ----------------------------------------------------------------------------------------------
 * Account-facing HTTP schemas
 * ------------------------------------------------------------------------------------------- */

/** Minimal Pi configuration for one real acceptance run. Delivered per-request only; never persisted. */
const RunnerPiConfigDocumentSchema = z
  .string()
  .min(1)
  .max(RUNNER_PI_CONFIG_DOCUMENT_MAX_CHARS)
  .superRefine((value, context) => {
    if (runtimeUtf8Length(value) > RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Pi config documents exceed the ${RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES}-byte UTF-8 limit`,
      });
    }
  });

export const RunnerPiConfigInputSchema = z
  .object({
    authJson: RunnerPiConfigDocumentSchema,
    modelsJson: RunnerPiConfigDocumentSchema.optional(),
    settingsJson: RunnerPiConfigDocumentSchema.optional(),
  })
  .strict();

export type RunnerPiConfigInput = z.infer<typeof RunnerPiConfigInputSchema>;

/**
 * The exact stdin document the Runner hands to the in-sandbox worker. It is the serialization
 * that counts toward the wire budget: JSON escaping (quotes, backslashes, control characters)
 * expands the document bytes, so the bound is measured on this string, not on each document.
 */
export function serializeRunnerAcceptanceWorkerStdin(input: {
  mode: RunnerAcceptanceMode;
  piConfig?: RunnerPiConfigInput;
}): string {
  return JSON.stringify({
    kind: "acceptance",
    mode: input.mode,
    ...(input.piConfig ? { piConfig: input.piConfig } : {}),
  });
}

/** Reject an acceptance command that would not fit the worker stdin and/or the control frame. */
function checkRunnerAcceptanceWireBytes(
  value: { mode: RunnerAcceptanceMode; piConfig?: RunnerPiConfigInput },
  context: z.RefinementCtx,
  serializedFrame?: string,
): void {
  if (
    value.piConfig &&
    runtimeUtf8Length(serializeRunnerAcceptanceWorkerStdin(value)) > RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES
  ) {
    context.addIssue({
      code: "custom",
      path: ["piConfig"],
      message: `piConfig exceeds the ${RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES}-byte serialized worker stdin budget`,
    });
  }
  if (serializedFrame !== undefined && runtimeUtf8Length(serializedFrame) > RUNNER_WS_MAX_FRAME_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["piConfig"],
      message: `The acceptance frame exceeds the ${RUNNER_WS_MAX_FRAME_BYTES}-byte control-channel budget`,
    });
  }
}

export const AccountSandboxRunnerAcceptanceRequestSchema = z
  .object({
    mode: RunnerAcceptanceModeSchema,
    piConfig: RunnerPiConfigInputSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "real" && !value.piConfig) {
      context.addIssue({ code: "custom", path: ["piConfig"], message: "Real acceptance requires piConfig" });
    }
    if (value.mode === "offline" && value.piConfig) {
      context.addIssue({ code: "custom", path: ["piConfig"], message: "Offline acceptance must not carry piConfig" });
    }
    checkRunnerAcceptanceWireBytes(value, context);
  });

export type AccountSandboxRunnerAcceptanceRequest = z.infer<typeof AccountSandboxRunnerAcceptanceRequestSchema>;

/** Ordinary stop saves first; discarding local files requires an explicit allocation generation. */
export const AccountSandboxRunnerStopRequestSchema = z.union([
  z.object({}).strict(),
  z
    .object({ discardUnsavedChanges: z.literal(true), environmentGeneration: z.number().int().positive().safe() })
    .strict(),
]);
export type AccountSandboxRunnerStopRequest = z.infer<typeof AccountSandboxRunnerStopRequestSchema>;

/**
 * Native-sandbox/tool readiness as the Runner reported it after authentication. `runnerVersion`
 * is the pinned Runner build the image reports from its identity document; the Server requires
 * the exact configured version before an environment may become ready.
 */
export const RunnerReadinessSchema = z
  .object({
    sandboxName: z.string().min(1).max(128),
    rootfs: z.string().min(1).max(512),
    nodeVersion: z.string().min(1).max(64),
    piVersion: z.string().min(1).max(64),
    runnerVersion: z.string().min(1).max(64),
    reportedAt: z.string().datetime(),
  })
  .strict();

export type RunnerReadiness = z.infer<typeof RunnerReadinessSchema>;

/**
 * Runner state as an Account may read it. `runnerReady` is true only after an authenticated
 * Runner reported native sandbox/tool readiness for the CURRENT environment generation — never
 * from cloud provider readiness alone.
 */
export const AccountSandboxRunnerStatusResponseSchema = z
  .object({
    sandboxId: UuidSchema,
    sessionId: UuidSchema,
    lifecycle: SandboxLifecycleSchema,
    environmentGeneration: z.number().int().nonnegative(),
    currentResourceName: ResourceNameSchema.nullable(),
    currentResourceUid: z.string().min(1).max(128).nullable(),
    currentOperationName: ResourceNameSchema.nullable(),
    runnerConnected: z.boolean(),
    runnerReady: z.boolean(),
    runnerReadiness: RunnerReadinessSchema.nullable(),
    lastErrorCode: z.string().min(1).max(128).nullable(),
    lastErrorAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type AccountSandboxRunnerStatusResponse = z.infer<typeof AccountSandboxRunnerStatusResponseSchema>;

export const AccountSandboxRunnerAcceptanceResponseSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    sandboxId: UuidSchema,
    environmentGeneration: z.number().int().nonnegative(),
    mode: RunnerAcceptanceModeSchema,
    outcome: z.enum(["passed", "failed", "cancelled"]),
    report: RunnerAcceptanceReportWireSchema.optional(),
    failure: z
      .object({ code: z.string().min(1).max(128), message: z.string().min(1).max(2048) })
      .strict()
      .optional(),
  })
  .strict();

export type AccountSandboxRunnerAcceptanceResponse = z.infer<typeof AccountSandboxRunnerAcceptanceResponseSchema>;

/* ----------------------------------------------------------------------------------------------
 * Runner WebSocket protocol frames
 * ------------------------------------------------------------------------------------------- */

const FrameBase = { requestId: RequestIdSchema.optional() };

/** First frame, Runner -> Server. The token is a Server-minted bootstrap bearer credential. */
export const RunnerAuthFrameSchema = z
  .object({
    ...FrameBase,
    type: z.literal("auth"),
    token: z.string().min(1).max(8192),
    /**
     * E4: an E4 Runner opts in to Cloud delivery frames. Additive and optional; an older Server
     * with a strict schema rejects the extra field, so deployment order is Server-first with a
     * pinned E4 Runner image (handoff contract). Legacy E3 Runners never set it.
     */
    cloudDeliveryVersion: z.literal(RUNNER_CLOUD_DELIVERY_VERSION).optional(),
    workspaceVersion: z.literal(RUNNER_WORKSPACE_VERSION).optional(),
    /**
     * E8: opt in to Cloud Session collaboration. Only sent by a Runner build that can journal and
     * execute `session:message:*` frames; the Server echoes it in the welcome before any session
     * frame, proof-bearing open result, or Session-collaboration capability is used.
     */
    sessionCollaborationVersion: z.literal(RUNNER_SESSION_COLLABORATION_VERSION).optional(),
    /** Opt in to renewal-only replies for an expired token of a still-live allocation. */
    renewExpired: z.literal(true).optional(),
    /**
     * E7: physical control credential, separate audience from the Session bootstrap bearer. It is
     * the only credential allowed to resolve a Runner to a DIFFERENT current holder after a
     * transfer; the Session token is never used for cross-assignment authority.
     */
    controlToken: z.string().min(1).max(8192).optional(),
    /** E7: opt in to physical-instance reuse negotiation. Only sent with a control token. */
    reuseVersion: z.literal(RUNNER_REUSE_VERSION).optional(),
  })
  .strict();

export const RunnerHeartbeatFrameSchema = z.object({ ...FrameBase, type: z.literal("heartbeat") }).strict();

/** Runner -> Server after native sandbox + tool readiness was verified inside the Instance. */
export const RunnerReadyFrameSchema = z
  .object({
    ...FrameBase,
    type: z.literal("runner:ready"),
    readiness: RunnerReadinessSchema.omit({ reportedAt: true }),
    workspaceRestored: z.literal(true).optional(),
  })
  .strict();

export const RunnerAcceptanceResultFrameSchema = z
  .object({
    ...FrameBase,
    type: z.literal("acceptance:result"),
    requestId: RequestIdSchema,
    outcome: z.enum(["passed", "failed", "cancelled"]),
    report: RunnerAcceptanceReportWireSchema.optional(),
    failure: z
      .object({ code: z.string().min(1).max(128), message: z.string().min(1).max(2048) })
      .strict()
      .optional(),
  })
  .strict();

export type RunnerAcceptanceResultFrame = z.infer<typeof RunnerAcceptanceResultFrameSchema>;

/* ----------------------------------------------------------------------------------------------
 * E4 Cloud IM delivery frames (additive; E3 acceptance frames are unchanged)
 *
 * A normalized IM delivery becomes a Session-scoped Cloud execution over this channel:
 * `delivery:run` (Server, dispatch columns already persisted) -> the Runner journals the input in
 * trusted parent storage with fsync -> `delivery:received` -> the Server persists durable custody
 * (`acceptDelivery`) -> `delivery:verified` -> the Runner starts the native Pi worker ->
 * `delivery:report` -> the Server records the Turn Report -> `delivery:report:ack`. A receipt or
 * report is idempotent on reconnect; a verified delivery whose start outcome is unknown after a
 * crash is reported `unknown`/`turn_state_unknown` and never blindly replayed.
 *
 * `credential:frame` tunnels the #633 runtime-credential control frames (execution open/acquire/
 * renew/close/ticket) over this authenticated, scope-validated channel; the data plane stays the
 * separate ticket-authenticated provider-proxy WebSocket. No frame here carries raw platform
 * secrets.
 * ------------------------------------------------------------------------------------------- */

/** Execution-scoped, short-lived model call permission minted by the Server. */
export const RunnerCloudModelGrantSchema = z
  .object({
    /** Server model-proxy base URL (fixed deployment origin + path; never an arbitrary URL). */
    baseUrl: z.string().url().max(1024),
    /** Allowlisted model id the token is bound to; the proxy rejects any other model. */
    model: RuntimeModelSchema,
    /**
     * Opaque execution-scoped bearer token; never a platform master key. The 4096-byte budget is
     * the actual proxy bearer budget: a valid HS256 JWT with a 128-byte model id plus the wired
     * claims measured 639 bytes, and the token must always fit the control frame.
     */
    token: z.string().min(32).max(4096),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type RunnerCloudModelGrant = z.infer<typeof RunnerCloudModelGrantSchema>;

export const RunnerCloudDeliveryRunFrameSchema = z
  .object({
    type: z.literal("delivery:run"),
    requestId: RequestIdSchema,
    /** The exact persisted dispatch payload; `requestId` mirrors `delivery.requestId`. */
    delivery: DirectImMessageDeliveryRequestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.delivery.requestId !== value.requestId) {
      context.addIssue({ code: "custom", path: ["requestId"], message: "Delivery request id mismatch" });
    }
    if (runtimeUtf8Length(JSON.stringify(value)) > RUNNER_WS_MAX_FRAME_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["delivery"],
        message: "The delivery frame exceeds the channel budget",
      });
    }
  });
export type RunnerCloudDeliveryRunFrame = z.infer<typeof RunnerCloudDeliveryRunFrameSchema>;

export const RunnerCloudDeliveryVerifiedFrameSchema = z
  .object({
    type: z.literal("delivery:verified"),
    requestId: RequestIdSchema,
    /**
     * "verified": durable custody is persisted and execution may start. "rejected": the Server
     * refused custody (stale generation/scope conflict); the Runner must not start and must
     * settle its journal entry without executing.
     */
    status: z.enum(["verified", "rejected"]),
    code: z.string().min(1).max(128).optional(),
    /** Present only on "verified" when the deployment model proxy is enabled. */
    model: RunnerCloudModelGrantSchema.optional(),
  })
  .strict();
export type RunnerCloudDeliveryVerifiedFrame = z.infer<typeof RunnerCloudDeliveryVerifiedFrameSchema>;

export const RunnerCloudDeliveryCancelFrameSchema = z
  .object({
    type: z.literal("delivery:cancel"),
    requestId: RequestIdSchema.optional(),
    deliveryId: RuntimeOpaqueIdSchema,
  })
  .strict();
export type RunnerCloudDeliveryCancelFrame = z.infer<typeof RunnerCloudDeliveryCancelFrameSchema>;

/**
 * Server recovery query for one accepted delivery: the Runner answers from its durable journal
 * (never from memory alone). "received"/"started" entries are resumed/settled exactly once; a
 * missing entry means the allocation's writable state was lost and the turn outcome is unknown.
 */
export const RunnerCloudDeliveryQueryFrameSchema = z
  .object({
    type: z.literal("delivery:query"),
    requestId: RequestIdSchema,
    deliveryId: RuntimeOpaqueIdSchema,
    turnId: RuntimeOpaqueIdSchema,
  })
  .strict();
export type RunnerCloudDeliveryQueryFrame = z.infer<typeof RunnerCloudDeliveryQueryFrameSchema>;

export const RunnerCloudDeliveryQueryResultFrameSchema = z
  .object({
    type: z.literal("delivery:query:result"),
    requestId: RequestIdSchema,
    deliveryId: RuntimeOpaqueIdSchema,
    turnId: RuntimeOpaqueIdSchema,
    phase: z.enum(["none", "received", "started", "reported"]),
  })
  .strict();
export type RunnerCloudDeliveryQueryResultFrame = z.infer<typeof RunnerCloudDeliveryQueryResultFrameSchema>;

export const RunnerCloudDeliveryReportAckFrameSchema = z
  .object({
    type: z.literal("delivery:report:ack"),
    requestId: RequestIdSchema,
    turnId: RuntimeOpaqueIdSchema,
    status: z.enum(["recorded", "already_recorded", "conflict", "stale_generation"]),
    resultHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RunnerCloudDeliveryReportAckFrame = z.infer<typeof RunnerCloudDeliveryReportAckFrameSchema>;

export const RunnerCloudDeliveryReceivedFrameSchema = z
  .object({
    type: z.literal("delivery:received"),
    requestId: RequestIdSchema,
    deliveryId: RuntimeOpaqueIdSchema,
    /** Runner-allocated Turn id; stable across receipt retransmissions of the same dispatch. */
    turnId: RuntimeOpaqueIdSchema,
  })
  .strict();
export type RunnerCloudDeliveryReceivedFrame = z.infer<typeof RunnerCloudDeliveryReceivedFrameSchema>;

/* ----------------------------------------------------------------------------------------------
 * E8 Cloud Session collaboration frames (additive; the pinned Runner build gates readiness, so a
 * Runner that predates these frames never becomes ready on a Server that sends them)
 *
 * A SessionMessage delivery mirrors the IM custody boundary without any IM-specific row:
 * `session:message:run` (Server dispatch) -> the Runner journals the message in trusted parent
 * storage with fsync -> `session:message:received` (accepted = durable custody taken) -> the
 * Server records the accepted outcome, mints the execution-scoped grant, and answers
 * `session:message:verified` -> the Runner runs the Turn in the SAME single-slot Session queue as
 * IM deliveries -> on terminal settlement the Runner retires the journal entry locally and sends
 * `session:message:settled` (best-effort activity signal; there is deliberately no Server-side
 * Turn row for Session messages). A receipt retransmitted after reconnect re-verifies entries the
 * Server already accepted and retires everything else; execution is at-most-once per messageId.
 * ------------------------------------------------------------------------------------------- */

/** Server -> Runner dispatch of one authorized SessionMessage. `requestId` mirrors `message.requestId`. */
export const RunnerCloudSessionMessageRunFrameSchema = z
  .object({
    type: z.literal("session:message:run"),
    requestId: RequestIdSchema,
    message: SessionMessageDeliveryRequestSchema,
    /**
     * The target Session's actual role. The Server derives it from the target Session row, never
     * from instruction prose or from missing credentials.
     */
    sessionKind: z.enum(["internal", "visible"]),
    /**
     * The nonsecret bridge-derived IM outbox context. Present exactly for a visible target (the
     * Server requires an active binding), absent for an internal child so no IM material can ever
     * be fabricated for it.
     */
    outboxContext: RuntimeImOutboxContextSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.message.requestId !== value.requestId) {
      context.addIssue({ code: "custom", path: ["requestId"], message: "Session message request id mismatch" });
    }
    if (!RUNNER_SESSION_MESSAGE_CONTEXT_REFINE(value)) {
      context.addIssue({
        code: "custom",
        path: ["outboxContext"],
        message: "A visible Session message requires outbox context and an internal one forbids it",
      });
    }
    if (runtimeUtf8Length(JSON.stringify(value)) > RUNNER_WS_MAX_FRAME_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "The Session message frame exceeds the channel budget",
      });
    }
  });
export type RunnerCloudSessionMessageRunFrame = z.infer<typeof RunnerCloudSessionMessageRunFrameSchema>;

/**
 * Runner -> Server receipt for one Session message dispatch. `accepted` means the message is
 * durably journaled (fsynced) under the exact allocation scope — the custody boundary the
 * Server's `accepted` outcome requires. `phase` is the Runner's journal phase for the entry: a
 * reconnect re-announcement of an already-started Turn says `started` so the Server refreshes its
 * liveness picture without minting a second permission. Rejected receipts carry no custody.
 */
export const RunnerCloudSessionMessageReceivedFrameSchema = z.discriminatedUnion("status", [
  z
    .object({
      type: z.literal("session:message:received"),
      requestId: RequestIdSchema,
      messageId: z.string().uuid(),
      /** Runner-allocated Turn id; stable across receipt retransmissions of the same message. */
      turnId: RuntimeOpaqueIdSchema,
      status: z.literal("accepted"),
      phase: z.enum(["received", "started"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("session:message:received"),
      requestId: RequestIdSchema,
      messageId: z.string().uuid(),
      status: z.literal("rejected"),
      reason: z.enum(["client_busy", "input_conflict", "target_mismatch"]),
    })
    .strict(),
]);
export type RunnerCloudSessionMessageReceivedFrame = z.infer<typeof RunnerCloudSessionMessageReceivedFrameSchema>;

/**
 * Server -> Runner execution permission for one accepted Session message. Same semantics as
 * `delivery:verified`, keyed by the dispatch/journal request id: `verified` carries the
 * execution-scoped model grant; `rejected` retires a `received` journal entry that never started.
 */
export const RunnerCloudSessionMessageVerifiedFrameSchema = z
  .object({
    type: z.literal("session:message:verified"),
    requestId: RequestIdSchema,
    status: z.enum(["verified", "rejected"]),
    code: z.string().min(1).max(128).optional(),
    model: RunnerCloudModelGrantSchema.optional(),
  })
  .strict();
export type RunnerCloudSessionMessageVerifiedFrame = z.infer<typeof RunnerCloudSessionMessageVerifiedFrameSchema>;

/**
 * Server -> Runner cancellation of one journaled Session message (explicit stop). Best-effort
 * like the IM cancel frame: the durable journal entry stays authoritative until the Runner
 * retires it, and the Server never re-dispatches a cancelled message.
 */
export const RunnerCloudSessionMessageCancelFrameSchema = z
  .object({
    type: z.literal("session:message:cancel"),
    requestId: RequestIdSchema,
    messageId: z.string().uuid(),
  })
  .strict();
export type RunnerCloudSessionMessageCancelFrame = z.infer<typeof RunnerCloudSessionMessageCancelFrameSchema>;

/**
 * Runner -> Server terminal settlement signal for one journaled Session message. Best-effort
 * execution evidence (drives the Server's idle-reclaim busy picture and activity clock); it is
 * NOT a durable Turn Report — Session messages have no Server-side Turn columns by design.
 */
export const RunnerCloudSessionMessageSettledFrameSchema = z
  .object({
    type: z.literal("session:message:settled"),
    /** The dispatch/journal request id, for correlation and logs. */
    requestId: RequestIdSchema,
    messageId: z.string().uuid(),
    turnId: RuntimeOpaqueIdSchema,
    outcome: z.enum(["completed", "failed", "cancelled", "unknown"]),
  })
  .strict();
export type RunnerCloudSessionMessageSettledFrame = z.infer<typeof RunnerCloudSessionMessageSettledFrameSchema>;

/**
 * Server -> Runner terminal acknowledgement. `recorded` means the exact outcome was durably
 * committed now; `already_recorded` means an identical terminal result was already committed.
 * The Runner holds its immutable terminal result until this ack and replays it on reconnect; a
 * missing or uncommittable record never receives a success ack.
 */
export const RunnerCloudSessionMessageSettledAckFrameSchema = z
  .object({
    type: z.literal("session:message:settled:ack"),
    requestId: RequestIdSchema,
    messageId: z.string().uuid(),
    turnId: RuntimeOpaqueIdSchema,
    status: z.enum(["recorded", "already_recorded"]),
  })
  .strict();
export type RunnerCloudSessionMessageSettledAckFrame = z.infer<typeof RunnerCloudSessionMessageSettledAckFrameSchema>;

export const RunnerCloudDeliveryReportFrameSchema = z
  .object({
    type: z.literal("delivery:report"),
    requestId: RequestIdSchema,
    report: TurnReportRequestSchema,
  })
  .strict();
export type RunnerCloudDeliveryReportFrame = z.infer<typeof RunnerCloudDeliveryReportFrameSchema>;

/** Runner -> Server tunnel of #633 credential control frames. */
export const RunnerCredentialTunnelFrameSchema = z
  .object({ type: z.literal("credential:frame"), frame: RuntimeCredentialClientFrameSchema })
  .strict();
export type RunnerCredentialTunnelFrame = z.infer<typeof RunnerCredentialTunnelFrameSchema>;

/** Server -> Runner tunnel of #633 credential control results. */
export const RunnerCredentialTunnelResultFrameSchema = z
  .object({ type: z.literal("credential:frame"), frame: RuntimeCredentialServerFrameSchema })
  .strict();
export type RunnerCredentialTunnelResultFrame = z.infer<typeof RunnerCredentialTunnelResultFrameSchema>;

/* ----------------------------------------------------------------------------------------------
 * E4 in-sandbox Turn worker document (stdin, bounded)
 * ------------------------------------------------------------------------------------------- */

/** Bounded stdin document the trusted Runner hands to the in-sandbox Turn worker. */
export const RUNNER_CLOUD_TURN_WORKER_STDIN_MAX_BYTES = 256 * 1024;

export const RunnerCloudTurnWorkerRequestSchema = z
  .object({
    kind: z.literal("turn"),
    /** The exact delivery the Server dispatched (and persisted) for this Sandbox's Session. */
    delivery: DirectImMessageDeliveryRequestSchema,
    /** Execution-scoped model grant minted at the verified boundary. */
    model: RunnerCloudModelGrantSchema,
    /** In-sandbox absolute path of the per-turn public material directory (proxy manifest). */
    executionDir: z.string().min(1).max(512),
    /**
     * Optional allocation-stable in-sandbox directory for Pi conversation continuity across the
     * turns of one Agent Session. When absent the worker uses its own default location inside the
     * disposable Sandbox. The trusted Runner only ever supplies an in-sandbox path.
     */
    piSessionDirectory: z.string().min(1).max(512).optional(),
    /**
     * E8 Session collaboration material for the Session's own CLI: the current Session-CLI proof
     * plus the Server URL the in-sandbox CLI must call. Present exactly when the Server minted a
     * proof at the verified boundary; stdin-only, never journaled or logged by the Runner.
     */
    sessionCollaboration: z
      .object({
        proof: SessionCliProofGrantSchema,
        serverUrl: z.string().url().max(1024),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (runtimeUtf8Length(JSON.stringify(value)) > RUNNER_CLOUD_TURN_WORKER_STDIN_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "The Turn worker document exceeds its stdin budget" });
    }
  });
export type RunnerCloudTurnWorkerRequest = z.infer<typeof RunnerCloudTurnWorkerRequestSchema>;

/**
 * E8: the in-sandbox worker document for one accepted Session collaboration message. Same
 * boundary as the IM Turn document — the exact dispatched message, the execution-scoped grant,
 * and the per-execution public material directory — but carries the genuine SessionMessage
 * contract instead of any IM-shaped input.
 */
export const RunnerCloudSessionWorkerRequestSchema = z
  .object({
    kind: z.literal("session-message"),
    /** The exact Session message the Server dispatched and the Runner journaled. */
    message: SessionMessageDeliveryRequestSchema,
    /** Execution-scoped model grant minted at the verified boundary. */
    model: RunnerCloudModelGrantSchema,
    /** In-sandbox absolute path of the per-turn public material directory (proxy manifest). */
    executionDir: z.string().min(1).max(512),
    /** Allocation-stable in-sandbox directory for Pi conversation continuity. */
    piSessionDirectory: z.string().min(1).max(512).optional(),
    /**
     * The target Session's actual role, carried from the journaled run frame. `buildSessionMessageInput`
     * selects its visible/internal instruction mode from this value alone.
     */
    sessionKind: z.enum(["internal", "visible"]),
    /**
     * The one absolute execution deadline the parent anchored when the Turn left its queue (never
     * at dispatch, so legitimate queue wait is not charged). The worker's own timeout and the
     * parent's exec backstop both derive from it, so a slow bridge/startup can never turn a real
     * `turn_timeout` into an `unknown`. Absent only from an older parent: the worker falls back
     * to the relative runtime budget.
     */
    deadlineAt: z.string().datetime({ offset: true }).optional(),
    /** Nonsecret outbox context, present exactly for a visible target. */
    outboxContext: RuntimeImOutboxContextSchema.optional(),
    /** E8 Session-CLI material for the target Session; stdin-only, never journaled or logged. */
    sessionCollaboration: z
      .object({
        proof: SessionCliProofGrantSchema,
        serverUrl: z.string().url().max(1024),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!RUNNER_SESSION_MESSAGE_CONTEXT_REFINE(value)) {
      context.addIssue({
        code: "custom",
        path: ["outboxContext"],
        message: "A visible Session worker document requires outbox context and an internal one forbids it",
      });
    }
    if (runtimeUtf8Length(JSON.stringify(value)) > RUNNER_CLOUD_TURN_WORKER_STDIN_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "The Session worker document exceeds its stdin budget" });
    }
  });
export type RunnerCloudSessionWorkerRequest = z.infer<typeof RunnerCloudSessionWorkerRequestSchema>;

/** The backward-compatible in-sandbox worker document union: existing `turn` documents are unchanged. */
export const RunnerCloudWorkerRequestSchema = z.discriminatedUnion("kind", [
  RunnerCloudTurnWorkerRequestSchema,
  RunnerCloudSessionWorkerRequestSchema,
]);
export type RunnerCloudWorkerRequest = z.infer<typeof RunnerCloudWorkerRequestSchema>;

/** Serialize a Turn worker document, enforcing the stdin budget before any write. */
export function serializeRunnerCloudTurnWorkerStdin(input: Omit<RunnerCloudTurnWorkerRequest, "kind">): string {
  const serialized = JSON.stringify({ kind: "turn", ...input });
  if (runtimeUtf8Length(serialized) > RUNNER_CLOUD_TURN_WORKER_STDIN_MAX_BYTES) {
    throw new Error("The Turn worker document exceeds its stdin budget");
  }
  return serialized;
}

/** Serialize a Session-message worker document, enforcing the stdin budget before any write. */
export function serializeRunnerCloudSessionWorkerStdin(input: Omit<RunnerCloudSessionWorkerRequest, "kind">): string {
  const serialized = JSON.stringify({ kind: "session-message", ...input });
  if (runtimeUtf8Length(serialized) > RUNNER_CLOUD_TURN_WORKER_STDIN_MAX_BYTES) {
    throw new Error("The Session worker document exceeds its stdin budget");
  }
  return serialized;
}

export const RunnerClientFrameSchema = z.discriminatedUnion("type", [
  RunnerAuthFrameSchema,
  RunnerHeartbeatFrameSchema,
  RunnerReadyFrameSchema,
  RunnerAcceptanceResultFrameSchema,
  RunnerCloudDeliveryReceivedFrameSchema,
  RunnerCloudDeliveryReportFrameSchema,
  RunnerCloudDeliveryQueryResultFrameSchema,
  RunnerCloudSessionMessageReceivedFrameSchema,
  RunnerCloudSessionMessageSettledFrameSchema,
  RunnerCredentialTunnelFrameSchema,
  RunnerWorkspaceSealResultFrameSchema,
]);
export type RunnerClientFrame = z.infer<typeof RunnerClientFrameSchema>;

export const RunnerWelcomeFrameSchema = z
  .object({
    type: z.literal("server:welcome"),
    protocolVersion: z.literal(RUNNER_WS_PROTOCOL_VERSION),
    sandboxId: UuidSchema,
    sessionId: UuidSchema,
    environmentGeneration: z.number().int().nonnegative(),
    resourceName: ResourceNameSchema,
    /**
     * E4 capability echo. Present ONLY for a connection that requested
     * `cloudDeliveryVersion: 1` and whose Cloud allocation is enabled; the Client must not run
     * Cloud journal reconciliation or Cloud frame handlers without it.
     */
    cloudDeliveryVersion: z.literal(RUNNER_CLOUD_DELIVERY_VERSION).optional(),
    /**
     * E4: verified Cloud UID of the CURRENT allocation, echoed by the Runner inside credential
     * execution-open sandbox facts. Required when `cloudDeliveryVersion` is present; a
     * Cloud-capable welcome with a null UID must be retried transiently until the UID is tracked
     * (the attach never publishes a Cloud welcome without it).
     */
    resourceUid: z.string().min(1).max(128).nullable().optional(),
    workspaceVersion: z.literal(RUNNER_WORKSPACE_VERSION).optional(),
    /** E7: echo of the physical-reuse capability for a control-authenticated Runner. */
    reuseVersion: z.literal(RUNNER_REUSE_VERSION).optional(),
    /** E8: echo of the Session-collaboration capability for a requesting, fenced connection. */
    sessionCollaborationVersion: z.literal(RUNNER_SESSION_COLLABORATION_VERSION).optional(),
    heartbeatIntervalMs: z.number().int().positive(),
    heartbeatTimeoutMs: z.number().int().positive(),
  })
  .strict();
export type RunnerWelcomeFrame = z.infer<typeof RunnerWelcomeFrameSchema>;

export const RunnerAuthResultFrameSchema = z
  .object({
    type: z.literal("auth:result"),
    requestId: RequestIdSchema.optional(),
    ok: z.boolean(),
  })
  .strict();

export const RunnerAcceptanceRunFrameSchema = z
  .object({
    type: z.literal("acceptance:run"),
    requestId: RequestIdSchema,
    mode: RunnerAcceptanceModeSchema,
    /** Absolute wall-clock deadline (Unix ms); the Runner cancels the run once it passes. */
    deadlineAtMs: z.number().int().positive(),
    piConfig: RunnerPiConfigInputSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    checkRunnerAcceptanceWireBytes(value, context, JSON.stringify(value));
  });
export type RunnerAcceptanceRunFrame = z.infer<typeof RunnerAcceptanceRunFrameSchema>;

export const RunnerAcceptanceCancelFrameSchema = z
  .object({ type: z.literal("acceptance:cancel"), requestId: RequestIdSchema })
  .strict();

export const RunnerServerErrorFrameSchema = z
  .object({ type: z.literal("error"), code: z.string().min(1).max(128), message: z.string().min(1).max(2048) })
  .strict();

/**
 * Liveness acknowledgement. The Server sends this in response to every Runner heartbeat and on a
 * cadence while the connection is healthy, so an idle but healthy Runner never mistakes silence
 * for a lost control channel. Carries no credential or state.
 */
export const RunnerServerHeartbeatFrameSchema = z.object({ type: z.literal("server:heartbeat") }).strict();

/**
 * Refreshed, same-scope bootstrap credential. Sent on welcome and at half the token TTL while the
 * authenticated connection stays current; the Runner keeps only the latest value in memory and
 * uses it for the next reconnect. Never sent to a stale or detached connection.
 */
export const RunnerServerCredentialFrameSchema = z
  .object({
    type: z.literal("server:credential"),
    token: z.string().min(1).max(8192),
    /** E7: refreshed physical control credential for the same immutable instance identity. */
    controlToken: z.string().min(1).max(8192).optional(),
  })
  .strict();

export const RunnerServerFrameSchema = z.discriminatedUnion("type", [
  RunnerWelcomeFrameSchema,
  RunnerAuthResultFrameSchema,
  // This is not authentication success: reconnect with the fresh token before any other frame.
  z
    .object({
      type: z.literal("auth:renewed"),
      token: z.string().min(1).max(8192).optional(),
      /** E7: a fresh physical control credential when only that credential could be renewed. */
      controlToken: z.string().min(1).max(8192).optional(),
    })
    .strict()
    .refine((frame) => frame.token !== undefined || frame.controlToken !== undefined, {
      message: "auth:renewed must carry at least one refreshed credential",
    }),
  RunnerAcceptanceRunFrameSchema,
  RunnerAcceptanceCancelFrameSchema,
  RunnerServerHeartbeatFrameSchema,
  RunnerServerCredentialFrameSchema,
  RunnerServerErrorFrameSchema,
  RunnerCloudDeliveryRunFrameSchema,
  RunnerCloudDeliveryVerifiedFrameSchema,
  RunnerCloudDeliveryCancelFrameSchema,
  RunnerCloudDeliveryQueryFrameSchema,
  RunnerCloudDeliveryReportAckFrameSchema,
  RunnerCloudSessionMessageRunFrameSchema,
  RunnerCloudSessionMessageVerifiedFrameSchema,
  RunnerCloudSessionMessageCancelFrameSchema,
  RunnerCloudSessionMessageSettledAckFrameSchema,
  RunnerCredentialTunnelResultFrameSchema,
  RunnerWorkspaceSealFrameSchema,
]);
export type RunnerServerFrame = z.infer<typeof RunnerServerFrameSchema>;

/** WebSocket close codes used by the Runner control channel (private-use range). */
export const RUNNER_WS_CLOSE = {
  authFailed: 4401,
  protocolError: 4400,
  staleScope: 4409,
  replaced: 4412,
  /** A live, heartbeating connection already owns this scope; the newcomer is rejected. */
  duplicate: 4413,
  shuttingDown: 1001,
} as const;
