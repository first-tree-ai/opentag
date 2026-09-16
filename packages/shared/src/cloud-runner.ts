import { z } from "zod";
import { runtimeUtf8Length } from "./runtime-config.js";
import { SandboxLifecycleSchema } from "./sandbox.js";

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
  .object({ ...FrameBase, type: z.literal("auth"), token: z.string().min(1).max(8192) })
  .strict();

export const RunnerHeartbeatFrameSchema = z.object({ ...FrameBase, type: z.literal("heartbeat") }).strict();

/** Runner -> Server after native sandbox + tool readiness was verified inside the Instance. */
export const RunnerReadyFrameSchema = z
  .object({
    ...FrameBase,
    type: z.literal("runner:ready"),
    readiness: RunnerReadinessSchema.omit({ reportedAt: true }),
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

export const RunnerClientFrameSchema = z.discriminatedUnion("type", [
  RunnerAuthFrameSchema,
  RunnerHeartbeatFrameSchema,
  RunnerReadyFrameSchema,
  RunnerAcceptanceResultFrameSchema,
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
  .object({ type: z.literal("server:credential"), token: z.string().min(1).max(8192) })
  .strict();

export const RunnerServerFrameSchema = z.discriminatedUnion("type", [
  RunnerWelcomeFrameSchema,
  RunnerAuthResultFrameSchema,
  RunnerAcceptanceRunFrameSchema,
  RunnerAcceptanceCancelFrameSchema,
  RunnerServerHeartbeatFrameSchema,
  RunnerServerCredentialFrameSchema,
  RunnerServerErrorFrameSchema,
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
