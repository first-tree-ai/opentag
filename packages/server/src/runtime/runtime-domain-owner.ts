import {
  type AgentTraceBatch,
  type ClientRuntimeBusinessFrame,
  ClientRuntimeBusinessFrameSchema,
  computeDirectInputHash,
  computeReconcilePayloadHash,
  type DirectImMessageDeliveryRequest,
  hashTuple,
  type ImMessageDeliveryResult,
  type RuntimeImCredentialGrantRequest,
  type RuntimeImCredentialGrantResult,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryResult,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  type TurnReportRequest,
  type TurnReportResult,
} from "@opentag/shared";
import { outcomeAttrs, runtimeAttrs, setActiveSpanAttributes, tracePromise, withSpan } from "../observability/index.js";
import { type ConnectionRegistry, RuntimeRegistrySendError } from "./connection-registry.js";
import type { AcceptedDeliveryRecord, RecordedTurnRecord, RuntimeCustodyStore } from "./runtime-custody-store.js";
import type { RuntimeBusinessContext, RuntimeBusinessOptions } from "./runtime-session.js";

export type { AcceptedDeliveryRecord, RecordedTurnRecord } from "./runtime-custody-store.js";

export class RuntimeDomainConflictError extends Error {
  readonly code = "conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeDomainConflictError";
  }
}

export class RuntimeDomainRequestError extends Error {
  constructor(
    readonly code:
      | "authority_unavailable"
      | "capacity"
      | "not_pending"
      | "send_unavailable"
      | "stale_placement"
      | "stopped"
      | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeDomainRequestError";
  }
}

export type RuntimeDispatchAdmission<T> = (
  operation: (onDispatched: () => void) => Promise<T>,
) => Promise<{ admitted: false } | { admitted: true; result: Promise<T> }>;

export interface RuntimeDomainOwnerOptions {
  maxPendingRequests?: number;
  onTrace?(batch: AgentTraceBatch, context: RuntimeBusinessContext): Promise<void> | void;
  onImCredentialGrant?(
    request: RuntimeImCredentialGrantRequest,
    context: RuntimeBusinessContext,
  ): Promise<RuntimeImCredentialGrantResult>;
  prepareReconcile?(
    workspaceComputerId: string,
    instanceId: string,
    request: SessionReconcileRequest,
  ): Promise<SessionReconcileRequest>;
  requestTimeoutMs?: number;
}

interface PendingBase<TRequest, TResult> {
  workspaceComputerId: string;
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

interface PendingSessionMessage extends PendingBase<SessionMessageDeliveryRequest, SessionMessageDeliveryResult> {
  kind: "session-message";
}

type PendingRequest = PendingReconcile | PendingDelivery | PendingSessionMessage;

interface ExpiredDelivery {
  workspaceComputerId: string;
  hash: string;
  inputHash: string;
  instanceId: string;
  kind: "delivery";
  request: DirectImMessageDeliveryRequest;
}

interface CompletedRequest {
  workspaceComputerId: string;
  hash: string;
  instanceId: string;
  kind: "reconcile" | "delivery" | "session-message";
  result: SessionReconcileResult | ImMessageDeliveryResult | SessionMessageDeliveryResult;
}

interface StartingDelivery {
  workspaceComputerId: string;
  hash: string;
  instanceId: string;
  promise: Promise<ImMessageDeliveryResult>;
}

export class RuntimeDomainOwner {
  readonly #registry: ConnectionRegistry;
  readonly #custody: RuntimeCustodyStore;
  readonly #options: Required<Pick<RuntimeDomainOwnerOptions, "maxPendingRequests" | "requestTimeoutMs">> &
    Pick<RuntimeDomainOwnerOptions, "onImCredentialGrant" | "onTrace" | "prepareReconcile">;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #startingDeliveries = new Map<string, StartingDelivery>();
  readonly #expiredDeliveries = new Map<string, ExpiredDelivery>();
  readonly #completed = new Map<string, CompletedRequest>();
  readonly #tracedPromises = new WeakMap<Promise<unknown>, Promise<unknown>>();
  readonly #preparingReconciles = new Map<
    string,
    { hash: string; instanceId: string; workspaceComputerId: string; promise: Promise<SessionReconcileResult> }
  >();

  constructor(registry: ConnectionRegistry, custody: RuntimeCustodyStore, options: RuntimeDomainOwnerOptions = {}) {
    this.#registry = registry;
    this.#custody = custody;
    this.#options = {
      maxPendingRequests: options.maxPendingRequests ?? 1024,
      onTrace: options.onTrace,
      onImCredentialGrant: options.onImCredentialGrant,
      prepareReconcile: options.prepareReconcile,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    };
    if (!Number.isSafeInteger(this.#options.maxPendingRequests) || this.#options.maxPendingRequests < 1) {
      throw new Error("maxPendingRequests must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#options.requestTimeoutMs) || this.#options.requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs must be a positive safe integer");
    }
  }

  getDelivery(deliveryId: string): Promise<AcceptedDeliveryRecord | undefined> {
    return this.#custody.getDelivery(deliveryId);
  }

  getTurn(turnId: string): Promise<RecordedTurnRecord | undefined> {
    return this.#custody.getTurn(turnId);
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RuntimeDomainRequestError("stopped", "The runtime domain owner stopped"));
    }
    this.#pending.clear();
    this.#startingDeliveries.clear();
    this.#expiredDeliveries.clear();
    this.#completed.clear();
    this.#preparingReconciles.clear();
  }

  requestReconcile(
    workspaceComputerId: string,
    instanceId: string,
    request: SessionReconcileRequest,
    onDispatched?: () => void,
    admission?: RuntimeDispatchAdmission<SessionReconcileResult>,
  ): Promise<SessionReconcileResult> {
    const attrs = runtimeAttrs({
      requestId: request.requestId,
      sessionId: request.sessionId,
      agentId: request.agentId,
      computerId: request.computerId,
      workspaceComputerId,
      instanceId,
      placementGeneration: request.placementGeneration,
    });
    let operation: Promise<SessionReconcileResult>;
    try {
      const hash = computeReconcilePayloadHash(request);
      const preparation = this.#options.prepareReconcile;
      if (!preparation) {
        operation = this.#withDispatchAdmission(
          admission,
          (admissionDispatched) =>
            this.#request(
              "reconcile",
              workspaceComputerId,
              instanceId,
              request,
              hash,
              undefined,
              admissionDispatched,
            ) as Promise<SessionReconcileResult>,
          onDispatched,
        );
      } else {
        const existing = this.#preparingReconciles.get(request.requestId);
        if (existing) {
          if (
            existing.hash !== hash ||
            existing.workspaceComputerId !== workspaceComputerId ||
            existing.instanceId !== instanceId
          ) {
            throw new RuntimeDomainConflictError("The request ID is already bound to a different runtime request");
          }
          onDispatched?.();
          operation = existing.promise;
        } else {
          operation = preparation(workspaceComputerId, instanceId, request).then((value) =>
            this.#withDispatchAdmission(
              admission,
              (admissionDispatched) =>
                this.#request(
                  "reconcile",
                  workspaceComputerId,
                  instanceId,
                  value,
                  computeReconcilePayloadHash(value),
                  undefined,
                  admissionDispatched,
                ) as Promise<SessionReconcileResult>,
              onDispatched,
            ),
          );
          this.#preparingReconciles.set(request.requestId, {
            hash,
            instanceId,
            workspaceComputerId,
            promise: operation,
          });
          while (this.#preparingReconciles.size > this.#options.maxPendingRequests) {
            const oldest = this.#preparingReconciles.keys().next().value;
            if (oldest === undefined) break;
            this.#preparingReconciles.delete(oldest);
          }
        }
      }
    } catch (error) {
      return tracePromise(
        "runtime.reconcile",
        attrs,
        () => {
          throw error;
        },
        undefined,
        runtimeDomainFailureAttrs,
      );
    }
    return this.#traceOnce(
      "runtime.reconcile",
      attrs,
      operation,
      (result) => outcomeAttrs(result.status, result.reason),
      runtimeDomainFailureAttrs,
    );
  }

  requestDelivery(
    workspaceComputerId: string,
    instanceId: string,
    request: DirectImMessageDeliveryRequest,
    onDispatched?: () => void,
  ): Promise<ImMessageDeliveryResult> {
    const attrs = runtimeAttrs({
      requestId: request.requestId,
      deliveryId: request.deliveryId,
      messageId: request.imMessageId,
      sessionId: request.sessionId,
      agentId: request.agentId,
      workspaceComputerId,
      instanceId,
      placementGeneration: request.placementGeneration,
    });
    let operation: Promise<ImMessageDeliveryResult>;
    try {
      operation = this.#requestDelivery(workspaceComputerId, instanceId, request, onDispatched);
    } catch (error) {
      return tracePromise(
        "runtime.delivery",
        attrs,
        () => {
          throw error;
        },
        undefined,
        runtimeDomainFailureAttrs,
      );
    }
    return this.#traceOnce(
      "runtime.delivery",
      attrs,
      operation,
      (result) => outcomeAttrs(result.status, result.reason),
      runtimeDomainFailureAttrs,
    );
  }

  requestSessionMessageDelivery(
    workspaceComputerId: string,
    instanceId: string,
    request: SessionMessageDeliveryRequest,
    onDispatched?: () => void,
    admission?: RuntimeDispatchAdmission<SessionMessageDeliveryResult>,
  ): Promise<SessionMessageDeliveryResult> {
    return this.#withDispatchAdmission(
      admission,
      (admissionDispatched) =>
        this.#request(
          "session-message",
          workspaceComputerId,
          instanceId,
          request,
          hashTuple([
            request.messageId,
            request.sourceSessionId,
            request.targetSessionId,
            request.agentId,
            request.placementGeneration,
            request.content,
            request.runtime,
          ]),
          undefined,
          admissionDispatched,
        ) as Promise<SessionMessageDeliveryResult>,
      onDispatched,
    );
  }

  #withDispatchAdmission<T>(
    admission: RuntimeDispatchAdmission<T> | undefined,
    operation: (onDispatched?: () => void) => Promise<T>,
    onDispatched?: () => void,
  ): Promise<T> {
    if (!admission) return operation(onDispatched);
    return admission((admissionDispatched) =>
      operation(() => {
        admissionDispatched();
        onDispatched?.();
      }),
    ).then((admitted) => {
      if (!admitted.admitted) {
        throw new RuntimeDomainRequestError("authority_unavailable", "Runtime dispatch authority is unavailable");
      }
      return admitted.result;
    });
  }

  #traceOnce<T>(
    name: string,
    attrs: Record<string, unknown>,
    operation: Promise<T>,
    resultAttrs: (result: T) => Record<string, unknown>,
    errorAttrs: (error: unknown) => Record<string, unknown>,
  ): Promise<T> {
    const existing = this.#tracedPromises.get(operation);
    if (existing) return existing as Promise<T>;
    const traced = tracePromise(name, attrs, () => operation, resultAttrs, errorAttrs);
    this.#tracedPromises.set(operation, traced);
    return traced;
  }

  #requestDelivery(
    workspaceComputerId: string,
    instanceId: string,
    request: DirectImMessageDeliveryRequest,
    onDispatched?: () => void,
  ): Promise<ImMessageDeliveryResult> {
    const inputHash = computeDirectInputHash(request);
    const requestHash = hashTuple([request.deliveryId, inputHash]);
    const starting = this.#startingDeliveries.get(request.requestId);
    if (starting) {
      if (
        starting.hash !== requestHash ||
        starting.workspaceComputerId !== workspaceComputerId ||
        starting.instanceId !== instanceId
      ) {
        throw new RuntimeDomainConflictError("The request ID is already bound to a different runtime request");
      }
      onDispatched?.();
      return starting.promise;
    }
    if (
      this.#pending.has(request.requestId) ||
      this.#completed.has(request.requestId) ||
      this.#expiredDeliveries.has(request.requestId)
    ) {
      return this.#request(
        "delivery",
        workspaceComputerId,
        instanceId,
        request,
        requestHash,
        inputHash,
        onDispatched,
      ) as Promise<ImMessageDeliveryResult>;
    }
    const promise = this.#startDelivery(workspaceComputerId, instanceId, request, requestHash, inputHash, onDispatched);
    const owner = { workspaceComputerId, hash: requestHash, instanceId, promise };
    this.#startingDeliveries.set(request.requestId, owner);
    void promise.then(
      () => {
        if (this.#startingDeliveries.get(request.requestId) === owner)
          this.#startingDeliveries.delete(request.requestId);
      },
      () => {
        if (this.#startingDeliveries.get(request.requestId) === owner)
          this.#startingDeliveries.delete(request.requestId);
      },
    );
    return promise;
  }

  async #startDelivery(
    workspaceComputerId: string,
    instanceId: string,
    request: DirectImMessageDeliveryRequest,
    requestHash: string,
    inputHash: string,
    onDispatched?: () => void,
  ): Promise<ImMessageDeliveryResult> {
    const dispatch = await this.#custody.beginDeliveryDispatch(request, inputHash, {
      workspaceComputerId,
      instanceId,
    });
    if (dispatch === "conflict") throw new RuntimeDomainConflictError("The delivery dispatch conflicts");
    if (dispatch === "stale_generation") {
      throw new RuntimeDomainRequestError("stale_placement", "The delivery dispatch placement is stale");
    }
    return this.#request(
      "delivery",
      workspaceComputerId,
      instanceId,
      request,
      requestHash,
      inputHash,
      onDispatched,
    ) as Promise<ImMessageDeliveryResult>;
  }

  async resend(requestId: string): Promise<void> {
    const pending = this.#pending.get(requestId);
    if (!pending) throw new RuntimeDomainRequestError("not_pending", "The runtime request is not pending");
    await this.#registry.send(pending.workspaceComputerId, pending.instanceId, pending.request);
  }

  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const parsed = ClientRuntimeBusinessFrameSchema.safeParse(input);
        return parsed.success ? parsed.data : undefined;
      },
      laneKey: (frame) => domainLaneKey(frame as ClientRuntimeBusinessFrame),
      handle: (frame, context) => this.handle(frame as ClientRuntimeBusinessFrame, context),
      failureResult: (frame) => businessFailureResult(frame),
      overloadResult: (frame) => businessFailureResult(frame),
      maxConcurrent: 32,
      maxQueuedPerKey: 32,
      maxQueuedTotal: 1024,
    };
  }

  async handle(
    frame: ClientRuntimeBusinessFrame,
    context: RuntimeBusinessContext,
  ): Promise<TurnReportResult | RuntimeImCredentialGrantResult | undefined> {
    if (this.#registry.currentInstanceId(context.workspaceComputerId) !== context.instanceId) {
      if (frame.type === "turn:report") {
        return {
          type: "turn:report:result",
          requestId: frame.requestId,
          turnId: frame.turnId,
          status: "stale_generation",
          resultHash: frame.resultHash,
        };
      }
      if (frame.type === "im:credential") {
        return {
          type: "im:credential:result",
          requestId: frame.requestId,
          status: "rejected",
          code: "placement_stale",
        };
      }
      return undefined;
    }
    if (frame.type === "session:reconcile:result") {
      await this.#completeRequest("reconcile", frame.requestId, frame, context);
      return undefined;
    }
    if (frame.type === "im:deliver:result") {
      await this.#completeDelivery(frame, context);
      return undefined;
    }
    if (frame.type === "session:message:deliver:result") {
      await this.#completeSessionMessage(frame, context);
      return undefined;
    }
    if (frame.type === "agent:trace") {
      const delivery = await this.#custody.getDeliveryByTurn(frame.turnId);
      if (
        delivery &&
        delivery.workspaceComputerId === context.workspaceComputerId &&
        delivery.instanceId === context.instanceId &&
        delivery.sessionId === frame.sessionId &&
        delivery.placementGeneration === frame.placementGeneration
      ) {
        await this.#options.onTrace?.(frame, context);
      }
      return undefined;
    }
    if (frame.type === "im:credential") {
      if (!this.#options.onImCredentialGrant) return businessFailureResult(frame);
      return this.#options.onImCredentialGrant(frame, context);
    }
    return withSpan(
      "runtime.report",
      runtimeAttrs({
        requestId: frame.requestId,
        deliveryId: frame.deliveryId,
        sessionId: frame.sessionId,
        agentId: frame.agentId,
        computerId: context.computerId,
        workspaceComputerId: context.workspaceComputerId,
        instanceId: context.instanceId,
        placementGeneration: frame.placementGeneration,
      }),
      async () => {
        const result = await this.#recordTurn(frame, context);
        setActiveSpanAttributes(outcomeAttrs(result?.status ?? "ignored"));
        return result;
      },
    );
  }

  #request(
    kind: "reconcile" | "delivery" | "session-message",
    workspaceComputerId: string,
    instanceId: string,
    request: SessionReconcileRequest | DirectImMessageDeliveryRequest | SessionMessageDeliveryRequest,
    hash: string,
    inputHash?: string,
    onDispatched?: () => void,
  ): Promise<SessionReconcileResult | ImMessageDeliveryResult | SessionMessageDeliveryResult> {
    const existing = this.#pending.get(request.requestId);
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.hash !== hash ||
        existing.workspaceComputerId !== workspaceComputerId ||
        existing.instanceId !== instanceId
      ) {
        throw new RuntimeDomainConflictError("The request ID is already bound to a different runtime request");
      }
      onDispatched?.();
      return existing.promise;
    }
    const completed = this.#completed.get(request.requestId);
    if (completed) {
      if (
        completed.kind !== kind ||
        completed.hash !== hash ||
        completed.workspaceComputerId !== workspaceComputerId ||
        completed.instanceId !== instanceId
      ) {
        throw new RuntimeDomainConflictError("The request ID is already bound to a different runtime request");
      }
      onDispatched?.();
      return Promise.resolve(completed.result);
    }
    const expired = this.#expiredDeliveries.get(request.requestId);
    if (expired) {
      if (
        kind !== "delivery" ||
        expired.hash !== hash ||
        expired.workspaceComputerId !== workspaceComputerId ||
        expired.instanceId !== instanceId
      ) {
        throw new RuntimeDomainConflictError("The request ID is already bound to a different runtime request");
      }
    }
    if (this.#pending.size >= this.#options.maxPendingRequests) {
      throw new RuntimeDomainRequestError("capacity", "The runtime request owner is full");
    }
    if (expired) this.#expiredDeliveries.delete(request.requestId);

    let resolvePromise: (
      result: SessionReconcileResult | ImMessageDeliveryResult | SessionMessageDeliveryResult,
    ) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<SessionReconcileResult | ImMessageDeliveryResult | SessionMessageDeliveryResult>(
      (resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      },
    );
    const timer = setTimeout(() => {
      if (this.#pending.get(request.requestId)?.promise !== promise) return;
      this.#pending.delete(request.requestId);
      if (pending.kind === "delivery") this.#rememberExpiredDelivery(pending);
      rejectPromise(new RuntimeDomainRequestError("timeout", "The runtime domain request timed out"));
    }, this.#options.requestTimeoutMs);
    timer.unref();
    const base = {
      workspaceComputerId,
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
        : kind === "delivery"
          ? ({
              ...base,
              kind,
              request: request as DirectImMessageDeliveryRequest,
              inputHash: inputHash ?? "",
            } as PendingDelivery)
          : ({ ...base, kind, request: request as SessionMessageDeliveryRequest } as PendingSessionMessage);
    this.#pending.set(request.requestId, pending);
    const dispatch = this.#registry.send(workspaceComputerId, instanceId, request);
    onDispatched?.();
    void dispatch.catch((error: unknown) => {
      if (this.#pending.get(request.requestId) !== pending) return;
      this.#pending.delete(request.requestId);
      clearTimeout(timer);
      if (pending.kind === "delivery") this.#rememberExpiredDelivery(pending);
      pending.reject(
        error instanceof Error
          ? error
          : new RuntimeDomainRequestError("send_unavailable", "The runtime request could not be sent"),
      );
    });
    return promise;
  }

  async #completeRequest(
    kind: "reconcile",
    requestId: string,
    result: SessionReconcileResult,
    context: RuntimeBusinessContext,
  ): Promise<void> {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.kind !== kind) return;
    if (!this.#matchesContext(pending, context)) return;
    if (
      result.sessionId !== pending.request.sessionId ||
      result.placementGeneration !== pending.request.placementGeneration
    ) {
      return;
    }
    if (result.status !== "rejected") {
      await this.#custody.claimRetainedReports(pending.request, result.retainedReports ?? [], context);
    }
    this.#settle(pending, result);
  }

  async #completeDelivery(result: ImMessageDeliveryResult, context: RuntimeBusinessContext): Promise<void> {
    const pending = this.#pending.get(result.requestId);
    const expired = this.#expiredDeliveries.get(result.requestId);
    const attempt = pending?.kind === "delivery" ? pending : expired;
    if (!attempt || !this.#matchesContext(attempt, context)) return;
    if (
      result.deliveryId !== attempt.request.deliveryId ||
      result.sessionId !== attempt.request.sessionId ||
      result.placementGeneration !== attempt.request.placementGeneration
    ) {
      return;
    }
    if (result.status === "accepted") {
      if (!result.turnId) return;
      const custody = await this.#custody.acceptDelivery(attempt.request, attempt.inputHash, result.turnId, context);
      if (custody === "conflict") throw new RuntimeDomainConflictError("The delivery custody conflicts");
      if (custody === "stale_generation") {
        if (pending?.kind === "delivery") {
          this.#settle(pending, { ...result, status: "rejected", turnId: undefined, reason: "target_mismatch" });
        }
        return;
      }
    }
    if (pending?.kind === "delivery") {
      this.#settle(pending, result);
      return;
    }
    if (!expired) return;
    this.#expiredDeliveries.delete(result.requestId);
    this.#rememberCompleted(expired, result);
  }

  async #completeSessionMessage(result: SessionMessageDeliveryResult, context: RuntimeBusinessContext): Promise<void> {
    const pending = this.#pending.get(result.requestId);
    if (pending?.kind !== "session-message" || !this.#matchesContext(pending, context)) {
      return;
    }
    if (
      result.messageId !== pending.request.messageId ||
      result.targetSessionId !== pending.request.targetSessionId ||
      result.placementGeneration !== pending.request.placementGeneration
    ) {
      return undefined;
    }
    this.#settle(pending, result);
    return undefined;
  }

  async #recordTurn(report: TurnReportRequest, context: RuntimeBusinessContext): Promise<TurnReportResult | undefined> {
    const base = {
      type: "turn:report:result" as const,
      requestId: report.requestId,
      turnId: report.turnId,
      resultHash: report.resultHash,
    };
    const attempt = this.#matchingDeliveryAttempt(report, context);
    if (attempt) {
      const accepted = await this.#custody.acceptDelivery(attempt.request, attempt.inputHash, report.turnId, context);
      if (accepted === "conflict" || accepted === "stale_generation") return { ...base, status: accepted };
      if ("promise" in attempt && this.#pending.get(attempt.request.requestId) === attempt) {
        this.#settle(attempt, {
          type: "im:deliver:result",
          requestId: attempt.request.requestId,
          deliveryId: attempt.request.deliveryId,
          sessionId: attempt.request.sessionId,
          placementGeneration: attempt.request.placementGeneration,
          status: "accepted",
          turnId: report.turnId,
        });
      }
    }
    const status = await this.#custody.recordTurn(report, context);
    return status ? { ...base, status } : undefined;
  }

  #matchingDeliveryAttempt(
    report: TurnReportRequest,
    context: RuntimeBusinessContext,
  ): PendingDelivery | ExpiredDelivery | undefined {
    for (const attempt of [...this.#pending.values(), ...this.#expiredDeliveries.values()]) {
      if (
        attempt.kind === "delivery" &&
        attempt.request.deliveryId === report.deliveryId &&
        attempt.request.sessionId === report.sessionId &&
        attempt.request.agentId === report.agentId &&
        attempt.request.placementGeneration === report.placementGeneration &&
        this.#matchesContext(attempt, context)
      ) {
        return attempt;
      }
    }
    return undefined;
  }

  #matchesContext(
    request: Pick<PendingRequest | ExpiredDelivery, "instanceId" | "workspaceComputerId">,
    context: RuntimeBusinessContext,
  ): boolean {
    return request.workspaceComputerId === context.workspaceComputerId && request.instanceId === context.instanceId;
  }

  #settle(
    pending: PendingRequest,
    result: SessionReconcileResult | ImMessageDeliveryResult | SessionMessageDeliveryResult,
  ): void {
    if (this.#pending.get(pending.request.requestId) !== pending) return;
    this.#pending.delete(pending.request.requestId);
    clearTimeout(pending.timer);
    this.#rememberCompleted(pending, result);
    pending.resolve(result as never);
  }

  #rememberCompleted(
    request: Pick<PendingRequest | ExpiredDelivery, "hash" | "instanceId" | "kind" | "request" | "workspaceComputerId">,
    result: SessionReconcileResult | ImMessageDeliveryResult | SessionMessageDeliveryResult,
  ): void {
    this.#completed.set(request.request.requestId, {
      workspaceComputerId: request.workspaceComputerId,
      hash: request.hash,
      instanceId: request.instanceId,
      kind: request.kind,
      result,
    });
    while (this.#completed.size > this.#options.maxPendingRequests) {
      const oldest = this.#completed.keys().next().value;
      if (oldest === undefined) break;
      this.#completed.delete(oldest);
    }
  }

  #rememberExpiredDelivery(pending: PendingDelivery): void {
    this.#expiredDeliveries.set(pending.request.requestId, {
      workspaceComputerId: pending.workspaceComputerId,
      hash: pending.hash,
      inputHash: pending.inputHash,
      instanceId: pending.instanceId,
      kind: "delivery",
      request: pending.request,
    });
    while (this.#expiredDeliveries.size > this.#options.maxPendingRequests) {
      const oldest = this.#expiredDeliveries.keys().next().value;
      if (oldest === undefined) break;
      this.#expiredDeliveries.delete(oldest);
    }
  }
}

function runtimeDomainFailureAttrs(error: unknown): Record<string, unknown> {
  let code = "RUNTIME_REQUEST_FAILED";
  if (error instanceof RuntimeDomainConflictError) {
    code = "RUNTIME_REQUEST_CONFLICT";
  } else if (error instanceof RuntimeDomainRequestError) {
    code =
      {
        authority_unavailable: "RUNTIME_AUTHORITY_UNAVAILABLE",
        capacity: "RUNTIME_OWNER_CAPACITY",
        not_pending: "RUNTIME_REQUEST_NOT_PENDING",
        send_unavailable: "RUNTIME_SEND_UNAVAILABLE",
        stale_placement: "RUNTIME_PLACEMENT_STALE",
        stopped: "RUNTIME_OWNER_STOPPED",
        timeout: "RUNTIME_REQUEST_TIMEOUT",
      }[error.code] ?? code;
  } else if (error instanceof RuntimeRegistrySendError) {
    code =
      {
        frame_too_large: "RUNTIME_FRAME_TOO_LARGE",
        instance_replaced: "RUNTIME_INSTANCE_REPLACED",
        unavailable: "RUNTIME_SEND_UNAVAILABLE",
      }[error.code] ?? code;
  }
  return outcomeAttrs("failed", code);
}

function businessFailureResult(frame: unknown): RuntimeImCredentialGrantResult | undefined {
  const parsed = ClientRuntimeBusinessFrameSchema.safeParse(frame);
  if (!parsed.success) return undefined;
  if (parsed.data.type === "im:credential") {
    return {
      type: "im:credential:result",
      requestId: parsed.data.requestId,
      status: "rejected",
      code: "credential_stale",
    };
  }
  return undefined;
}

function domainLaneKey(frame: ClientRuntimeBusinessFrame): string {
  if (frame.type === "session:reconcile:result") return `request:${frame.requestId}`;
  if (frame.type === "im:deliver:result" || frame.type === "turn:report") return `delivery:${frame.deliveryId}`;
  if (frame.type === "im:credential") return `session:${frame.sessionId}`;
  if (frame.type === "session:message:deliver:result") {
    return `session-message:${frame.targetSessionId}:${frame.messageId}`;
  }
  return `turn:${frame.turnId}`;
}
