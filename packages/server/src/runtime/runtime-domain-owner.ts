import {
  type AgentTraceBatch,
  type ClientRuntimeBusinessFrame,
  ClientRuntimeBusinessFrameSchema,
  computeDirectInputHash,
  computeReconcilePayloadHash,
  type DirectImMessageDeliveryRequest,
  hashTuple,
  type ImMessageDeliveryResult,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  type TurnReportRequest,
  type TurnReportResult,
} from "@opentag/shared";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeBusinessContext, RuntimeBusinessOptions } from "./runtime-session.js";

export class RuntimeDomainConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeDomainConflictError";
  }
}

export class RuntimeDomainRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeDomainRequestError";
  }
}

export interface RuntimeDomainOwnerOptions {
  maxPendingRequests?: number;
  onTrace?(batch: AgentTraceBatch, context: RuntimeBusinessContext): Promise<void> | void;
  requestTimeoutMs?: number;
}

interface PendingBase<TRequest, TResult> {
  computerId: string;
  hash: string;
  instanceId: string;
  request: TRequest;
  promise: Promise<TResult>;
  reject(error: Error): void;
  resolve(result: TResult): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingReconcile extends PendingBase<SessionReconcileRequest, SessionReconcileResult> {
  kind: "reconcile";
}

interface PendingDelivery extends PendingBase<DirectImMessageDeliveryRequest, ImMessageDeliveryResult> {
  kind: "delivery";
  inputHash: string;
}

type PendingRequest = PendingReconcile | PendingDelivery;

interface CompletedRequest {
  computerId: string;
  hash: string;
  instanceId: string;
  kind: "reconcile" | "delivery";
  result: SessionReconcileResult | ImMessageDeliveryResult;
}

export interface AcceptedDeliveryRecord {
  agentId: string;
  computerId: string;
  deliveryId: string;
  inputHash: string;
  instanceId: string;
  placementGeneration: number;
  sessionId: string;
  turnId: string;
}

export interface RecordedTurnRecord {
  report: TurnReportRequest;
  resultHash: string;
}

export class RuntimeDomainOwner {
  readonly #registry: ConnectionRegistry;
  readonly #options: Required<Pick<RuntimeDomainOwnerOptions, "maxPendingRequests" | "requestTimeoutMs">> &
    Pick<RuntimeDomainOwnerOptions, "onTrace">;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #completed = new Map<string, CompletedRequest>();
  readonly #deliveries = new Map<string, AcceptedDeliveryRecord>();
  readonly #turns = new Map<string, RecordedTurnRecord>();

  constructor(registry: ConnectionRegistry, options: RuntimeDomainOwnerOptions = {}) {
    this.#registry = registry;
    this.#options = {
      maxPendingRequests: options.maxPendingRequests ?? 1024,
      onTrace: options.onTrace,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    };
    if (!Number.isSafeInteger(this.#options.maxPendingRequests) || this.#options.maxPendingRequests < 1) {
      throw new Error("maxPendingRequests must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#options.requestTimeoutMs) || this.#options.requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs must be a positive safe integer");
    }
  }

  getDelivery(deliveryId: string): AcceptedDeliveryRecord | undefined {
    return this.#deliveries.get(deliveryId);
  }

  getTurn(turnId: string): RecordedTurnRecord | undefined {
    return this.#turns.get(turnId);
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RuntimeDomainRequestError("The runtime domain owner stopped"));
    }
    this.#pending.clear();
    this.#completed.clear();
  }

  requestReconcile(
    computerId: string,
    instanceId: string,
    request: SessionReconcileRequest,
  ): Promise<SessionReconcileResult> {
    return this.#request(
      "reconcile",
      computerId,
      instanceId,
      request,
      computeReconcilePayloadHash(request),
    ) as Promise<SessionReconcileResult>;
  }

  requestDelivery(
    computerId: string,
    instanceId: string,
    request: DirectImMessageDeliveryRequest,
  ): Promise<ImMessageDeliveryResult> {
    const inputHash = computeDirectInputHash(request);
    const existing = this.#deliveries.get(request.deliveryId);
    if (existing && existing.inputHash !== inputHash) {
      throw new RuntimeDomainConflictError("The delivery ID is already bound to different input");
    }
    return this.#request(
      "delivery",
      computerId,
      instanceId,
      request,
      hashTuple([request.deliveryId, inputHash]),
      inputHash,
    ) as Promise<ImMessageDeliveryResult>;
  }

  async resend(requestId: string): Promise<void> {
    const pending = this.#pending.get(requestId);
    if (!pending) throw new RuntimeDomainRequestError("The runtime request is not pending");
    await this.#registry.send(pending.computerId, pending.instanceId, pending.request);
  }

  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const parsed = ClientRuntimeBusinessFrameSchema.safeParse(input);
        return parsed.success ? parsed.data : undefined;
      },
      laneKey: (frame) => domainLaneKey(frame as ClientRuntimeBusinessFrame),
      handle: (frame, context) => this.handle(frame as ClientRuntimeBusinessFrame, context),
      failureResult: (frame) => failureResult(frame as ClientRuntimeBusinessFrame),
      overloadResult: (frame) => failureResult(frame as ClientRuntimeBusinessFrame),
      maxConcurrent: 32,
      maxQueuedPerKey: 32,
      maxQueuedTotal: 1024,
    };
  }

  async handle(
    frame: ClientRuntimeBusinessFrame,
    context: RuntimeBusinessContext,
  ): Promise<TurnReportResult | undefined> {
    if (this.#registry.currentInstanceId(context.computerId) !== context.instanceId) {
      if (frame.type === "turn:report") {
        return {
          type: "turn:report:result",
          requestId: frame.requestId,
          turnId: frame.turnId,
          status: "stale_generation",
          resultHash: frame.resultHash,
        };
      }
      return undefined;
    }
    if (frame.type === "session:reconcile:result") {
      this.#completeRequest("reconcile", frame.requestId, frame, context);
      return undefined;
    }
    if (frame.type === "im:deliver:result") {
      this.#completeDelivery(frame, context);
      return undefined;
    }
    if (frame.type === "agent:trace") {
      const delivery = [...this.#deliveries.values()].find((record) => record.turnId === frame.turnId);
      if (
        delivery &&
        delivery.computerId === context.computerId &&
        delivery.instanceId === context.instanceId &&
        delivery.sessionId === frame.sessionId &&
        delivery.placementGeneration === frame.placementGeneration
      ) {
        await this.#options.onTrace?.(frame, context);
      }
      return undefined;
    }
    return this.#recordTurn(frame, context);
  }

  #request(
    kind: "reconcile" | "delivery",
    computerId: string,
    instanceId: string,
    request: SessionReconcileRequest | DirectImMessageDeliveryRequest,
    hash: string,
    inputHash?: string,
  ): Promise<SessionReconcileResult | ImMessageDeliveryResult> {
    const existing = this.#pending.get(request.requestId);
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.hash !== hash ||
        existing.computerId !== computerId ||
        existing.instanceId !== instanceId
      ) {
        throw new RuntimeDomainConflictError("The request ID is already bound to a different runtime request");
      }
      return existing.promise;
    }
    const completed = this.#completed.get(request.requestId);
    if (completed) {
      if (
        completed.kind !== kind ||
        completed.hash !== hash ||
        completed.computerId !== computerId ||
        completed.instanceId !== instanceId
      ) {
        throw new RuntimeDomainConflictError("The request ID is already bound to a different runtime request");
      }
      return Promise.resolve(completed.result);
    }
    if (this.#pending.size >= this.#options.maxPendingRequests) {
      throw new RuntimeDomainRequestError("The runtime request owner is full");
    }

    let resolvePromise: (result: SessionReconcileResult | ImMessageDeliveryResult) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<SessionReconcileResult | ImMessageDeliveryResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      if (this.#pending.get(request.requestId)?.promise !== promise) return;
      this.#pending.delete(request.requestId);
      rejectPromise(new RuntimeDomainRequestError("The runtime domain request timed out"));
    }, this.#options.requestTimeoutMs);
    timer.unref();
    const base = {
      computerId,
      hash,
      instanceId,
      request,
      promise,
      reject: rejectPromise,
      resolve: resolvePromise,
      timer,
    };
    const pending: PendingRequest =
      kind === "reconcile"
        ? ({ ...base, kind, request: request as SessionReconcileRequest } as PendingReconcile)
        : ({
            ...base,
            kind,
            request: request as DirectImMessageDeliveryRequest,
            inputHash: inputHash ?? "",
          } as PendingDelivery);
    this.#pending.set(request.requestId, pending);
    void this.#registry.send(computerId, instanceId, request).catch((error: unknown) => {
      if (this.#pending.get(request.requestId) !== pending) return;
      this.#pending.delete(request.requestId);
      clearTimeout(timer);
      pending.reject(
        error instanceof Error ? error : new RuntimeDomainRequestError("The runtime request could not be sent"),
      );
    });
    return promise;
  }

  #completeRequest(
    kind: "reconcile",
    requestId: string,
    result: SessionReconcileResult,
    context: RuntimeBusinessContext,
  ): void {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.kind !== kind) return;
    if (!this.#matchesContext(pending, context)) return;
    if (
      result.sessionId !== pending.request.sessionId ||
      result.placementGeneration !== pending.request.placementGeneration
    ) {
      return;
    }
    this.#settle(pending, result);
  }

  #completeDelivery(result: ImMessageDeliveryResult, context: RuntimeBusinessContext): void {
    const pending = this.#pending.get(result.requestId);
    if (pending?.kind !== "delivery" || !this.#matchesContext(pending, context)) return;
    if (
      result.deliveryId !== pending.request.deliveryId ||
      result.sessionId !== pending.request.sessionId ||
      result.placementGeneration !== pending.request.placementGeneration
    ) {
      return;
    }
    if (result.status === "accepted") {
      if (!result.turnId) return;
      const current = this.#deliveries.get(result.deliveryId);
      if (current && (current.inputHash !== pending.inputHash || current.turnId !== result.turnId)) return;
      this.#deliveries.set(result.deliveryId, {
        agentId: pending.request.agentId,
        computerId: pending.computerId,
        deliveryId: result.deliveryId,
        inputHash: pending.inputHash,
        instanceId: pending.instanceId,
        placementGeneration: result.placementGeneration,
        sessionId: result.sessionId,
        turnId: result.turnId,
      });
    }
    this.#settle(pending, result);
  }

  #recordTurn(report: TurnReportRequest, context: RuntimeBusinessContext): TurnReportResult {
    const base = {
      type: "turn:report:result" as const,
      requestId: report.requestId,
      turnId: report.turnId,
      resultHash: report.resultHash,
    };
    const delivery = this.#deliveries.get(report.deliveryId);
    if (
      !delivery ||
      delivery.computerId !== context.computerId ||
      delivery.instanceId !== context.instanceId ||
      delivery.turnId !== report.turnId ||
      delivery.sessionId !== report.sessionId ||
      delivery.agentId !== report.agentId
    ) {
      return { ...base, status: "conflict" };
    }
    if (delivery.placementGeneration !== report.placementGeneration) {
      return { ...base, status: "stale_generation" };
    }
    const recorded = this.#turns.get(report.turnId);
    if (recorded) {
      return { ...base, status: recorded.resultHash === report.resultHash ? "already_recorded" : "conflict" };
    }
    this.#turns.set(report.turnId, { report, resultHash: report.resultHash });
    return { ...base, status: "recorded" };
  }

  #matchesContext(pending: PendingRequest, context: RuntimeBusinessContext): boolean {
    return pending.computerId === context.computerId && pending.instanceId === context.instanceId;
  }

  #settle(pending: PendingRequest, result: SessionReconcileResult | ImMessageDeliveryResult): void {
    if (this.#pending.get(pending.request.requestId) !== pending) return;
    this.#pending.delete(pending.request.requestId);
    clearTimeout(pending.timer);
    this.#completed.set(pending.request.requestId, {
      computerId: pending.computerId,
      hash: pending.hash,
      instanceId: pending.instanceId,
      kind: pending.kind,
      result,
    });
    while (this.#completed.size > this.#options.maxPendingRequests) {
      const oldest = this.#completed.keys().next().value;
      if (oldest === undefined) break;
      this.#completed.delete(oldest);
    }
    pending.resolve(result as never);
  }
}

function domainLaneKey(frame: ClientRuntimeBusinessFrame): string {
  if (frame.type === "session:reconcile:result" || frame.type === "im:deliver:result") {
    return `request:${frame.requestId}`;
  }
  return `turn:${frame.turnId}`;
}

function failureResult(frame: ClientRuntimeBusinessFrame): TurnReportResult | undefined {
  if (frame.type !== "turn:report") return undefined;
  return {
    type: "turn:report:result",
    requestId: frame.requestId,
    turnId: frame.turnId,
    status: "conflict",
    resultHash: frame.resultHash,
  };
}
