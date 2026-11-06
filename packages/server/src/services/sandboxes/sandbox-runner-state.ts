import { and, eq, isNull } from "drizzle-orm";
import { sandboxes } from "../../db/schema/index.js";
import { SandboxServiceError } from "./errors.js";

export const MARKER_RETRYABLE = ["cloud_create_rejected", "cloud_create_failed"] as const;
const RETRYABLE_MARKERS = new Set<string>(MARKER_RETRYABLE);

export const CLOUD_DELETE_PENDING = "cloud_delete_pending";
export const DELETE_CONFIRM_INTERVAL_MS = 15_000;
export const IDLE_RECLAIM_BATCH = 25;
export const WORKSPACE_RECOVERY_RETRY_DELAY_MS = 10 * 60_000;
export const WORKSPACE_SAVE_REQUIRED = "workspace_save_required";
export const WORKSPACE_SAVE_FAILED = "workspace_save_failed";

export interface IdleSiblingSnapshot {
  sandboxId: string;
  sessionId: string;
  environmentGeneration: number;
  resourceName: string;
  resourceUid: string;
}

export function runnerConflict(message: string): SandboxServiceError {
  return new SandboxServiceError("SANDBOX_RUNNER_CONFLICT", "deterministic", message, 409);
}

export function automaticAttemptMatches(row: typeof sandboxes.$inferSelect) {
  return and(
    eq(sandboxes.id, row.id),
    eq(sandboxes.lifecycle, row.lifecycle),
    eq(sandboxes.environmentGeneration, row.environmentGeneration),
    row.currentResourceName === null
      ? isNull(sandboxes.currentResourceName)
      : eq(sandboxes.currentResourceName, row.currentResourceName),
    row.currentResourceUid === null
      ? isNull(sandboxes.currentResourceUid)
      : eq(sandboxes.currentResourceUid, row.currentResourceUid),
    row.idleReclaimAt === null ? isNull(sandboxes.idleReclaimAt) : eq(sandboxes.idleReclaimAt, row.idleReclaimAt),
    row.lastErrorCode === null ? isNull(sandboxes.lastErrorCode) : eq(sandboxes.lastErrorCode, row.lastErrorCode),
    eq(sandboxes.updatedAt, row.updatedAt),
  );
}

export function isDefinitiveNoResourceMarker(marker: string | null): boolean {
  return marker !== null && RETRYABLE_MARKERS.has(marker);
}
