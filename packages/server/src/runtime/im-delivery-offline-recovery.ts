import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { imMessageDeliveries, sessionPlacements } from "../db/schema/index.js";

/**
 * Recovery retries for an unreachable Local Computer back off with the outage: a brief connection
 * blip still recovers in seconds, while a Computer that has been gone for days is retried at most
 * every half hour until the delivery's own `expiresAt` settles it. A reconnect wakes the parked
 * rows immediately (`wakeOfflineRecoveryDeliveries`), so the backoff never delays a live recovery.
 */
const OFFLINE_BACKOFF_STEPS = [
  { offlineBeforeMs: 5 * 60_000, delayMs: 2_000 },
  { offlineBeforeMs: 60 * 60_000, delayMs: 30_000 },
  { offlineBeforeMs: 6 * 60 * 60_000, delayMs: 5 * 60_000 },
] as const;
const OFFLINE_MAX_DELAY_MS = 30 * 60_000;

/** Spacing between recovery attempts while the Computer that owns the delivery has no live runtime. */
function offlineRecoveryDelayMs(offlineSinceMs: number, nowMs: number): number {
  const offlineMs = Math.max(0, nowMs - offlineSinceMs);
  for (const step of OFFLINE_BACKOFF_STEPS) {
    if (offlineMs < step.offlineBeforeMs) return step.delayMs;
  }
  return OFFLINE_MAX_DELAY_MS;
}

export interface OfflineRecoveryInput {
  /** The Computer facts the backoff schedule is computed from. */
  computer: { id: string; connectedAt: Date | null; lastSeenAt: Date | null };
  database: DatabaseClient;
  deliveryId: string;
  /** Whether the Computer currently has a live runtime; re-checked after the failure write. */
  isReady: () => boolean;
  now: () => Date;
  recordFailure: (
    deliveryId: string,
    code: string,
    claimToken: string | undefined,
    retryDelayMs: number,
  ) => Promise<void>;
}

/**
 * Park one recovery attempt behind the offline backoff, then restore the registration wake when
 * the Computer came back while the failure write was in flight.
 *
 * `wakeOfflineRecoveryDeliveries` commits `nextAttemptAt = now` on registration. A wake that lands
 * between the caller's offline read and this failure write would otherwise be overwritten by the
 * unconditional backoff update, parking an already ready Computer for up to 30 more minutes.
 * Re-checking readiness after the write and waking again keeps the newest state authoritative in
 * both interleavings; the write and the wake remain the only row mutations.
 */
export async function recordOfflineRecovery(input: OfflineRecoveryInput): Promise<void> {
  const now = input.now();
  const offlineSinceMs = (input.computer.lastSeenAt ?? input.computer.connectedAt)?.getTime() ?? 0;
  await input.recordFailure(
    input.deliveryId,
    "IM_DELIVERY_RUNTIME_UNAVAILABLE",
    undefined,
    offlineRecoveryDelayMs(offlineSinceMs, now.getTime()),
  );
  if (input.isReady()) {
    await wakeOfflineRecoveryDeliveries(input.database, input.computer.id, now);
  }
}

/**
 * Reset every accepted, unreported delivery placed on the Computer to due. Called when the
 * Computer registers again so backoff-parked recovery rows are not left waiting out their delay.
 */
export async function wakeOfflineRecoveryDeliveries(
  database: DatabaseClient,
  computerId: string,
  now: Date,
): Promise<void> {
  await database
    .update(imMessageDeliveries)
    .set({ nextAttemptAt: now })
    .where(
      and(
        eq(imMessageDeliveries.state, "accepted"),
        isNull(imMessageDeliveries.reportedAt),
        gt(imMessageDeliveries.expiresAt, now),
        inArray(
          imMessageDeliveries.sessionId,
          database
            .select({ id: sessionPlacements.sessionId })
            .from(sessionPlacements)
            .where(eq(sessionPlacements.computerId, computerId)),
        ),
      ),
    );
}
