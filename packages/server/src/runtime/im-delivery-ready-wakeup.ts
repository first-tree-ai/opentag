import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { computers, imMessageDeliveries, sandboxes } from "../db/schema/index.js";
import type { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import type { ReadyRunnerAllocation } from "../services/sandboxes/sandbox-runner-service.js";
import type { CloudSessionAllocationPort } from "./im-delivery-worker.types.js";

const CLOUD_READINESS_RETRY_CODES = ["IM_DELIVERY_CLOUD_ENVIRONMENT_NOT_READY", "IM_DELIVERY_CLOUD_RUNNER_NOT_READY"];

export function isCloudReadinessRetry(code: string): boolean {
  return CLOUD_READINESS_RETRY_CODES.includes(code);
}

/** A targeted wakeup uses the normal claim transaction and all its ordering/custody guards. */
export function readySessionClaimGuard(sessionId?: string) {
  if (!sessionId) return undefined;
  return and(
    eq(imMessageDeliveries.sessionId, sessionId),
    eq(computers.kind, "cloud"),
    eq(imMessageDeliveries.state, "pending"),
    isNull(imMessageDeliveries.dispatchRequestId),
    inArray(imMessageDeliveries.lastErrorCode, CLOUD_READINESS_RETRY_CODES),
  );
}

interface ReadyWakeupInput {
  database: DatabaseClient;
  allocation?: CloudSessionAllocationPort;
  runSession: (sessionId: string) => Promise<void>;
  now: () => Date;
  supervisor?: BackgroundFailureSupervisor;
  onDiagnostic: (code: string) => void;
}

/** A transient notification bridge; the persisted queue and regular retry remain authoritative. */
export class ImDeliveryReadyWakeup {
  readonly #input: ReadyWakeupInput;
  readonly #readyWakeups = new Map<string, { requested: boolean; operation: Promise<void> }>();
  #closed = false;

  constructor(input: ReadyWakeupInput) {
    this.#input = input;
  }
  stop(): void {
    this.#closed = true;
  }

  /** An allocation event advances only readiness retries, then uses the existing claim/lane fences. */
  async notify(allocation: ReadyRunnerAllocation): Promise<void> {
    if (this.#closed || !this.#input.allocation?.readyAllocation) return;
    const key = `${allocation.sandboxId}:${allocation.environmentGeneration}:${allocation.resourceUid}`;
    const existing = this.#readyWakeups.get(key);
    if (existing) {
      existing.requested = true;
      return existing.operation;
    }
    const wakeup = { requested: true, operation: Promise.resolve() };
    // Defer entry so the coalescing record exists before any observer or failure recheck can join it.
    wakeup.operation = Promise.resolve().then(async () => {
      try {
        do {
          wakeup.requested = false;
          if (this.#closed) return;
          if (await this.#advanceReadinessRetries(allocation)) await this.#input.runSession(allocation.sessionId);
          // Only a new notification/recheck requests another pass. Never drain in a retry loop.
        } while (wakeup.requested);
      } finally {
        this.#readyWakeups.delete(key);
      }
    });
    this.#readyWakeups.set(key, wakeup);
    return wakeup.operation;
  }

  async #advanceReadinessRetries(allocation: ReadyRunnerAllocation): Promise<boolean> {
    const current = await this.#input.allocation?.readyAllocation?.(allocation.sandboxId);
    if (this.#closed) return false;
    if (
      !current ||
      current.sessionId !== allocation.sessionId ||
      current.environmentGeneration !== allocation.environmentGeneration ||
      current.resourceName !== allocation.resourceName ||
      current.resourceUid !== allocation.resourceUid
    )
      return false;
    const now = this.#input.now();
    const advanced = await this.#input.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: now })
      .where(
        and(
          eq(imMessageDeliveries.sessionId, allocation.sessionId),
          eq(imMessageDeliveries.state, "pending"),
          isNull(imMessageDeliveries.reason),
          isNull(imMessageDeliveries.dispatchRequestId),
          isNull(imMessageDeliveries.dispatchPayload),
          inArray(imMessageDeliveries.lastErrorCode, CLOUD_READINESS_RETRY_CODES),
          sql`${imMessageDeliveries.expiresAt} > now()`,
          exists(
            this.#input.database
              .select({ id: sandboxes.id })
              .from(sandboxes)
              .where(
                and(
                  eq(sandboxes.id, allocation.sandboxId),
                  eq(sandboxes.sessionId, imMessageDeliveries.sessionId),
                  eq(sandboxes.environmentGeneration, allocation.environmentGeneration),
                  eq(sandboxes.currentResourceName, allocation.resourceName),
                  eq(sandboxes.currentResourceUid, allocation.resourceUid),
                  eq(sandboxes.lifecycle, "ready"),
                  isNull(sandboxes.idleReclaimAt),
                ),
              ),
          ),
        ),
      )
      .returning({ id: imMessageDeliveries.id });
    return advanced.length > 0 && !this.#closed;
  }

  recheck(deliveryId: string): void {
    const operation = this.#recheck(deliveryId);
    if (this.#input.supervisor)
      this.#input.supervisor.track(operation, {
        code: "IM_DELIVERY_READY_WAKEUP_FAILED",
        category: "internal",
        retryability: "backoff",
        phase: "worker",
        operation: "im-delivery-worker.ready-recheck",
      });
    else void operation.catch(() => this.#input.onDiagnostic("IM_DELIVERY_READY_WAKEUP_FAILED"));
  }

  async #recheck(deliveryId: string): Promise<void> {
    if (this.#closed || !this.#input.allocation?.readyAllocation) return;
    const [row] = await this.#input.database
      .select({ sandboxId: sandboxes.id })
      .from(imMessageDeliveries)
      .innerJoin(sandboxes, eq(sandboxes.sessionId, imMessageDeliveries.sessionId))
      .where(eq(imMessageDeliveries.id, deliveryId))
      .limit(1);
    if (!row || this.#closed) return;
    const allocation = await this.#input.allocation.readyAllocation(row.sandboxId);
    if (allocation) await this.notify(allocation);
  }
}
