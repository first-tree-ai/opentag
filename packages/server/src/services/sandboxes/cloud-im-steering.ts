import {
  computeRuntimeImMessageSemanticHash,
  computeRuntimeImSteerInputHash,
  type RunnerCloudSteerResultFrame,
  type RunnerServerFrame,
  type RuntimeImSteerRequest,
  RuntimeImSteerRequestSchema,
  type RuntimeImSteerResult,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { imMessageDeliveries } from "../../db/schema/index.js";
import { markExternalCallTimedOut, traceExternalCall } from "../../observability/external-call-logger.js";
import { type PerformanceLogger, updateCurrentPerformanceContext } from "../../observability/performance-logger.js";
import type { RuntimeCustodyStore, SteerDispatchStatus } from "../../runtime/runtime-custody-store.js";
import { RuntimeDispatchDeferredError } from "../../runtime/runtime-domain-owner.js";
import type { RuntimeBusinessContext } from "../../runtime/runtime-session.js";
import { InboundReceiptPendingError } from "../im/inbound-admission.js";
import type { CloudConnectionRecord } from "./cloud-runtime-fence.js";

interface SteeringConnection {
  record: CloudConnectionRecord;
  context: RuntimeBusinessContext;
  send(frame: RunnerServerFrame): boolean;
}
interface PendingSteer {
  connectionId: string;
  hash: string;
  resolve(result: RuntimeImSteerResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class CloudImSteering {
  readonly #pending = new Map<string, PendingSteer>();
  constructor(
    readonly options: {
      database: DatabaseClient;
      custody: RuntimeCustodyStore;
      performanceLogger?: PerformanceLogger;
      connection(sessionId: string): Promise<SteeringConnection | undefined>;
      current(record: CloudConnectionRecord): boolean;
      validAllocation(record: CloudConnectionRecord): Promise<boolean>;
      context(record: CloudConnectionRecord): RuntimeBusinessContext;
      send(record: CloudConnectionRecord, frame: RunnerServerFrame): boolean;
    },
  ) {}

  async request(
    request: RuntimeImSteerRequest,
    onDispatched: () => void,
    signal?: AbortSignal,
  ): Promise<RuntimeImSteerResult> {
    let attempts = 0;
    return traceExternalCall(
      this.options.performanceLogger,
      {
        provider: "sandbox-runner",
        operation: "external.sandbox-runner.deliverySteer",
        agentId: request.agentId,
        sessionId: request.sessionId,
        deliveryId: request.deliveryId,
        turnId: request.expectedTurnId,
      },
      () =>
        this.#executeRequest(
          request,
          onDispatched,
          () => {
            attempts += 1;
          },
          signal,
        ),
      {
        resultAttributes: (res) => ({
          status: res.status,
          attemptCount: attempts,
          retryCount: Math.max(0, attempts - 1),
        }),
        errorAttributes: () => ({
          attemptCount: attempts,
          retryCount: Math.max(0, attempts - 1),
        }),
        fallbackErrorCode: "CLOUD_STEER_FAILED",
      },
    );
  }

  async #executeRequest(
    request: RuntimeImSteerRequest,
    onDispatched: () => void,
    onAttempt: () => void,
    signal?: AbortSignal,
  ): Promise<RuntimeImSteerResult> {
    signal?.throwIfAborted();
    const connection = await this.options.connection(request.sessionId);
    signal?.throwIfAborted();
    if (!connection) throw new Error("CLOUD_STEER_UNAVAILABLE");
    const computerId = connection.record?.computerId;
    const sandboxId = connection.record?.scope?.sandboxId;
    updateCurrentPerformanceContext({
      ...(computerId ? { computerId } : {}),
      ...(sandboxId ? { sandboxId } : {}),
    });
    const hash = computeRuntimeImSteerInputHash(request);
    const status = await this.options.custody.beginSteerDispatch(request, hash, connection.context);
    signal?.throwIfAborted();
    assertSteerDispatchStatus(status);
    const current = await this.options.connection(request.sessionId);
    signal?.throwIfAborted();
    if (current?.record.connectionId !== connection.record.connectionId) {
      if (status === "dispatched") await this.options.custody.releaseSteerDispatch(request, hash, "retry");
      throw new Error("CLOUD_STEER_CONNECTION_REPLACED");
    }
    const previous = this.#pending.get(request.requestId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.reject(new Error("CLOUD_STEER_ATTEMPT_REPLACED"));
    }
    if (this.#pending.size >= 1024 && !previous) {
      if (status === "dispatched") await this.options.custody.releaseSteerDispatch(request, hash, "retry");
      throw new Error("CLOUD_STEER_CAPACITY");
    }
    const result = new Promise<RuntimeImSteerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.requestId);
        reject(markExternalCallTimedOut(new Error("CLOUD_STEER_RESULT_UNCONFIRMED")));
      }, 5_000);
      this.#pending.set(request.requestId, {
        resolve,
        reject,
        timer,
        hash,
        connectionId: connection.record.connectionId,
      });
    });
    onAttempt();
    if (!current.send({ type: "delivery:steer", requestId: request.requestId, steer: request })) {
      this.#reject(request.requestId, new Error("CLOUD_STEER_SEND_FAILED"));
    }
    onDispatched();
    return result;
  }

  async handle(record: CloudConnectionRecord, frame: RunnerCloudSteerResultFrame): Promise<void> {
    if (!this.options.current(record) || record.imInputVersion !== 1 || !(await this.options.validAllocation(record)))
      return;
    const result = frame.result;
    const [row] = await this.options.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, result.deliveryId));
    const parsed = RuntimeImSteerRequestSchema.safeParse(row?.dispatchPayload);
    if (!parsed.success || parsed.data.requestId !== frame.requestId || row?.dispatchInputHash !== frame.inputHash) {
      await this.#ackObsolete(record, frame);
      return;
    }
    const request = parsed.data;
    if (!matchesSteerResult(request, record, frame) || !this.options.current(record)) return;
    const { committed, effective } = await this.#record(request, record, frame);
    if (committed === "conflict" || committed === "stale_generation") return;
    if (!this.options.current(record)) return;
    this.options.send(record, {
      type: "delivery:steer:ack",
      requestId: frame.requestId,
      deliveryId: result.deliveryId,
      inputHash: frame.inputHash,
      status: "recorded",
    });
    const pending = this.#pending.get(frame.requestId);
    if (pending?.connectionId === record.connectionId && pending.hash === frame.inputHash) {
      clearTimeout(pending.timer);
      this.#pending.delete(frame.requestId);
      pending.resolve(effective);
    }
  }

  async #record(request: RuntimeImSteerRequest, record: CloudConnectionRecord, frame: RunnerCloudSteerResultFrame) {
    const result = frame.result;
    if (result.status === "steered")
      return {
        effective: result,
        committed: await this.options.custody.recordSteered(
          request,
          frame.inputHash,
          computeRuntimeImMessageSemanticHash(request),
          this.options.context(record),
        ),
      };
    const uncertain =
      (result.status === "deferred" && result.reason === "steer_state_unknown") ||
      (result.status === "rejected" && result.reason === "input_conflict");
    const disposition = uncertain ? "uncertain" : result.status === "retry" ? "retry" : "deferred";
    const committed = await this.options.custody.releaseSteerDispatch(request, frame.inputHash, disposition);
    const effective: RuntimeImSteerResult = uncertain
      ? { ...result, status: "deferred", reason: "steer_state_unknown" }
      : result;
    return { committed, effective };
  }

  async #ackObsolete(record: CloudConnectionRecord, frame: RunnerCloudSteerResultFrame): Promise<void> {
    const result = frame.result;
    if (result.sessionId !== record.scope.sessionId) return;
    const [root] = await this.options.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, result.rootDeliveryId));
    const noEffect =
      result.status === "retry" || (result.status === "deferred" && result.reason !== "steer_state_unknown");
    const retired =
      root?.sessionId === record.scope.sessionId &&
      root.turnId === result.expectedTurnId &&
      root.reportedAt !== null &&
      root.turnReport?.outcome !== "completed";
    if ((noEffect || retired) && this.options.current(record))
      this.options.send(record, {
        type: "delivery:steer:ack",
        requestId: frame.requestId,
        deliveryId: result.deliveryId,
        inputHash: frame.inputHash,
        status: "conflict",
      });
  }

  detach(connectionId: string): void {
    for (const [id, pending] of this.#pending)
      if (pending.connectionId === connectionId) this.#reject(id, new Error("CLOUD_STEER_CONNECTION_CLOSED"));
  }

  #reject(id: string, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    pending.reject(error);
  }
}

function assertSteerDispatchStatus(status: SteerDispatchStatus): void {
  if (status === "dispatched" || status === "already_dispatched") return;
  if (status === "inbound_pending") throw new InboundReceiptPendingError();
  if (status === "target_ended" || status === "batch_changed") throw new RuntimeDispatchDeferredError(status);
  throw new Error("CLOUD_STEER_DISPATCH_CONFLICT");
}

function matchesSteerResult(
  request: RuntimeImSteerRequest,
  record: CloudConnectionRecord,
  frame: RunnerCloudSteerResultFrame,
): boolean {
  const result = frame.result;
  return (
    request.sessionId === record.scope.sessionId &&
    result.sessionId === request.sessionId &&
    result.requestId === request.requestId &&
    result.placementGeneration === request.placementGeneration &&
    result.rootDeliveryId === request.rootDeliveryId &&
    result.expectedTurnId === request.expectedTurnId &&
    computeRuntimeImSteerInputHash(request) === frame.inputHash
  );
}
