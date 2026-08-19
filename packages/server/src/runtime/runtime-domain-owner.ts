import {
  type AgentTraceBatch,
  type ClientRuntimeBusinessFrame,
  ClientRuntimeBusinessFrameSchema,
  computeDirectInputHash,
  computeReconcilePayloadHash,
  type DirectImMessageDeliveryRequest,
  hashTuple,
  type ImMessageDeliveryResult,
  RUNTIME_MVP_RETAINED_REPORT_LIMIT,
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

interface ExpiredDelivery {
  computerId: string;
  hash: string;
  inputHash: string;
  instanceId: string;
  kind: "delivery";
  request: DirectImMessageDeliveryRequest;
}

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
  computerId: string;
  instanceId: string;
  report: TurnReportRequest;
  resultHash: string;
}

interface RecoveredTurnClaim {
  agentId: string;
  computerId: string;
  deliveryId: string;
  instanceId: string;
  placementGeneration: number;
  resultHash: string;
  sessionId: string;
  turnId: string;
}

interface ReconciledSessionClaim {
  agentId: string;
  computerId: string;
  instanceId: string;
  placementGeneration: number;
  sessionId: string;
}

export class RuntimeDomainOwner {
  readonly #registry: ConnectionRegistry;
  readonly #options: Required<Pick<RuntimeDomainOwnerOptions, "maxPendingRequests" | "requestTimeoutMs">> &
    Pick<RuntimeDomainOwnerOptions, "onTrace">;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #expiredDeliveries = new Map<string, ExpiredDelivery>();
  readonly #completed = new Map<string, CompletedRequest>();
  readonly #deliveries = new Map<string, AcceptedDeliveryRecord>();
  // MVP-only recovery bridge. Durable Server-side Turn ownership will replace
  // these reconciliation claims and the Client replay protocol after MVP.
  readonly #reconciledSessions = new Map<string, ReconciledSessionClaim>();
  readonly #recoveredTurns = new Map<string, RecoveredTurnClaim>();
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
    this.#expiredDeliveries.clear();
    this.#completed.clear();
    this.#reconciledSessions.clear();
    this.#recoveredTurns.clear();
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
      failureResult: () => undefined,
      overloadResult: () => undefined,
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
    const expired = this.#expiredDeliveries.get(request.requestId);
    if (expired) {
      if (
        kind !== "delivery" ||
        expired.hash !== hash ||
        expired.computerId !== computerId ||
        expired.instanceId !== instanceId
      ) {
        throw new RuntimeDomainConflictError("The request ID is already bound to a different runtime request");
      }
    }
    if (this.#pending.size >= this.#options.maxPendingRequests) {
      throw new RuntimeDomainRequestError("The runtime request owner is full");
    }
    if (expired) this.#expiredDeliveries.delete(request.requestId);

    let resolvePromise: (result: SessionReconcileResult | ImMessageDeliveryResult) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<SessionReconcileResult | ImMessageDeliveryResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      if (this.#pending.get(request.requestId)?.promise !== promise) return;
      this.#pending.delete(request.requestId);
      if (pending.kind === "delivery") this.#rememberExpiredDelivery(pending);
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
      if (pending.kind === "delivery") this.#rememberExpiredDelivery(pending);
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
    if (result.status !== "rejected") {
      this.#rememberReconciledSession(pending);
      for (const claim of result.retainedReports ?? []) this.#rememberRecoveredTurn(pending, claim);
    }
    this.#settle(pending, result);
  }

  #completeDelivery(result: ImMessageDeliveryResult, context: RuntimeBusinessContext): void {
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
      const current = this.#deliveries.get(result.deliveryId);
      if (current && (current.inputHash !== attempt.inputHash || current.turnId !== result.turnId)) return;
      this.#deliveries.set(result.deliveryId, {
        agentId: attempt.request.agentId,
        computerId: attempt.computerId,
        deliveryId: result.deliveryId,
        inputHash: attempt.inputHash,
        instanceId: attempt.instanceId,
        placementGeneration: result.placementGeneration,
        sessionId: result.sessionId,
        turnId: result.turnId,
      });
    }
    if (pending?.kind === "delivery") {
      this.#settle(pending, result);
      return;
    }
    if (!expired) return;
    this.#expiredDeliveries.delete(result.requestId);
    this.#rememberCompleted(expired, result);
  }

  #recordTurn(report: TurnReportRequest, context: RuntimeBusinessContext): TurnReportResult | undefined {
    const base = {
      type: "turn:report:result" as const,
      requestId: report.requestId,
      turnId: report.turnId,
      resultHash: report.resultHash,
    };
    const recovered = this.#recoveredTurns.get(report.turnId);
    const currentRecovered =
      recovered && this.#matchesContext(recovered, context) && recoveredClaimMatchesReport(recovered, report)
        ? recovered
        : undefined;
    const recorded = this.#turns.get(report.turnId);
    if (recorded) {
      const sameTurn =
        recorded.computerId === context.computerId &&
        recorded.report.deliveryId === report.deliveryId &&
        recorded.report.sessionId === report.sessionId &&
        recorded.report.agentId === report.agentId &&
        recorded.report.placementGeneration === report.placementGeneration &&
        recorded.resultHash === report.resultHash;
      if (!sameTurn) return { ...base, status: "conflict" };
      if (recorded.instanceId !== context.instanceId) {
        if (!currentRecovered) {
          return this.#hasCurrentReconciliation(report.sessionId, context)
            ? { ...base, status: "conflict" }
            : undefined;
        }
        this.#turns.set(report.turnId, { ...recorded, instanceId: context.instanceId });
      }
      if (currentRecovered) this.#recoveredTurns.delete(report.turnId);
      return { ...base, status: "already_recorded" };
    }

    let delivery = this.#deliveries.get(report.deliveryId);
    const attempt = this.#matchingDeliveryAttempt(report, context);
    if (!delivery && !recovered && attempt) {
      this.#completeDelivery(
        {
          type: "im:deliver:result",
          requestId: attempt.request.requestId,
          deliveryId: attempt.request.deliveryId,
          sessionId: attempt.request.sessionId,
          placementGeneration: attempt.request.placementGeneration,
          status: "accepted",
          turnId: report.turnId,
        },
        context,
      );
      delivery = this.#deliveries.get(report.deliveryId);
    }
    const owner = currentRecovered ?? delivery ?? recovered;
    if (!owner) {
      const reconciled = this.#reconciledSessions.get(report.sessionId);
      if (!reconciled || !this.#matchesContext(reconciled, context)) return undefined;
      if (reconciled.agentId !== report.agentId) return { ...base, status: "conflict" };
      if (report.placementGeneration > reconciled.placementGeneration) {
        return { ...base, status: "stale_generation" };
      }
      return { ...base, status: "conflict" };
    }
    if (
      owner.deliveryId !== report.deliveryId ||
      owner.computerId !== context.computerId ||
      owner.turnId !== report.turnId ||
      owner.sessionId !== report.sessionId ||
      owner.agentId !== report.agentId
    ) {
      return { ...base, status: "conflict" };
    }
    if (owner.placementGeneration !== report.placementGeneration) {
      return { ...base, status: "stale_generation" };
    }
    if ("resultHash" in owner && owner.resultHash !== report.resultHash) return { ...base, status: "conflict" };
    if (owner.instanceId !== context.instanceId) {
      return this.#hasCurrentReconciliation(report.sessionId, context) ? { ...base, status: "conflict" } : undefined;
    }
    this.#turns.set(report.turnId, {
      computerId: context.computerId,
      instanceId: context.instanceId,
      report,
      resultHash: report.resultHash,
    });
    this.#recoveredTurns.delete(report.turnId);
    return { ...base, status: "recorded" };
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

  #rememberRecoveredTurn(
    pending: PendingReconcile,
    retained: NonNullable<SessionReconcileResult["retainedReports"]>[number],
  ): void {
    const current = this.#recoveredTurns.get(retained.turnId);
    const claim: RecoveredTurnClaim = {
      agentId: pending.request.agentId,
      computerId: pending.computerId,
      deliveryId: retained.deliveryId,
      instanceId: pending.instanceId,
      placementGeneration: retained.placementGeneration,
      resultHash: retained.resultHash,
      sessionId: pending.request.sessionId,
      turnId: retained.turnId,
    };
    const delivery =
      this.#deliveries.get(claim.deliveryId) ??
      [...this.#deliveries.values()].find((candidate) => candidate.turnId === claim.turnId);
    if (delivery && !deliveryMatchesRecoveredClaim(delivery, claim)) return;
    const recorded = this.#turns.get(claim.turnId);
    if (recorded && !recordedTurnMatchesRecoveredClaim(recorded, claim)) return;
    if (current && !sameRecoveredTurnIdentity(current, claim)) return;
    this.#recoveredTurns.set(retained.turnId, claim);
    const limit = this.#options.maxPendingRequests * RUNTIME_MVP_RETAINED_REPORT_LIMIT;
    while (this.#recoveredTurns.size > limit) {
      const oldest = this.#recoveredTurns.keys().next().value;
      if (oldest === undefined) break;
      this.#recoveredTurns.delete(oldest);
    }
  }

  #rememberReconciledSession(pending: PendingReconcile): void {
    this.#reconciledSessions.set(pending.request.sessionId, {
      agentId: pending.request.agentId,
      computerId: pending.computerId,
      instanceId: pending.instanceId,
      placementGeneration: pending.request.placementGeneration,
      sessionId: pending.request.sessionId,
    });
    while (this.#reconciledSessions.size > this.#options.maxPendingRequests) {
      const oldest = this.#reconciledSessions.keys().next().value;
      if (oldest === undefined) break;
      this.#reconciledSessions.delete(oldest);
    }
  }

  #matchesContext(
    request: Pick<PendingRequest | ExpiredDelivery, "computerId" | "instanceId">,
    context: RuntimeBusinessContext,
  ): boolean {
    return request.computerId === context.computerId && request.instanceId === context.instanceId;
  }

  #hasCurrentReconciliation(sessionId: string, context: RuntimeBusinessContext): boolean {
    const reconciled = this.#reconciledSessions.get(sessionId);
    return Boolean(reconciled && this.#matchesContext(reconciled, context));
  }

  #settle(pending: PendingRequest, result: SessionReconcileResult | ImMessageDeliveryResult): void {
    if (this.#pending.get(pending.request.requestId) !== pending) return;
    this.#pending.delete(pending.request.requestId);
    clearTimeout(pending.timer);
    this.#rememberCompleted(pending, result);
    pending.resolve(result as never);
  }

  #rememberCompleted(
    request: Pick<PendingRequest | ExpiredDelivery, "computerId" | "hash" | "instanceId" | "kind" | "request">,
    result: SessionReconcileResult | ImMessageDeliveryResult,
  ): void {
    this.#completed.set(request.request.requestId, {
      computerId: request.computerId,
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
      computerId: pending.computerId,
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

function domainLaneKey(frame: ClientRuntimeBusinessFrame): string {
  if (frame.type === "session:reconcile:result") return `request:${frame.requestId}`;
  if (frame.type === "im:deliver:result" || frame.type === "turn:report") return `delivery:${frame.deliveryId}`;
  return `turn:${frame.turnId}`;
}

function sameRecoveredTurnIdentity(left: RecoveredTurnClaim, right: RecoveredTurnClaim): boolean {
  return (
    left.agentId === right.agentId &&
    left.computerId === right.computerId &&
    left.deliveryId === right.deliveryId &&
    left.placementGeneration === right.placementGeneration &&
    left.resultHash === right.resultHash &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId
  );
}

function recoveredClaimMatchesReport(claim: RecoveredTurnClaim, report: TurnReportRequest): boolean {
  return (
    claim.agentId === report.agentId &&
    claim.deliveryId === report.deliveryId &&
    claim.placementGeneration === report.placementGeneration &&
    claim.resultHash === report.resultHash &&
    claim.sessionId === report.sessionId &&
    claim.turnId === report.turnId
  );
}

function deliveryMatchesRecoveredClaim(delivery: AcceptedDeliveryRecord, claim: RecoveredTurnClaim): boolean {
  return (
    delivery.agentId === claim.agentId &&
    delivery.computerId === claim.computerId &&
    delivery.deliveryId === claim.deliveryId &&
    delivery.placementGeneration === claim.placementGeneration &&
    delivery.sessionId === claim.sessionId &&
    delivery.turnId === claim.turnId
  );
}

function recordedTurnMatchesRecoveredClaim(recorded: RecordedTurnRecord, claim: RecoveredTurnClaim): boolean {
  return (
    recorded.computerId === claim.computerId &&
    recorded.report.agentId === claim.agentId &&
    recorded.report.deliveryId === claim.deliveryId &&
    recorded.report.placementGeneration === claim.placementGeneration &&
    recorded.report.sessionId === claim.sessionId &&
    recorded.report.turnId === claim.turnId &&
    recorded.resultHash === claim.resultHash
  );
}
