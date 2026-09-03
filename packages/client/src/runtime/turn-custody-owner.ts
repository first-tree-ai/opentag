import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeRuntimeImSteerInputHash,
  type DirectImMessageDeliveryRequest,
  hashTuple,
  type ImMessageDeliveryResult,
  type InputRejectReason,
  type RuntimeImSteerRequest,
  type RuntimeImSteerResult,
  type TurnReportRequest,
  TurnReportRequestSchema,
} from "@opentag/shared";
import { AdmissionController, type AdmissionReservation } from "./admission-controller.js";
import type { DeliveryDecision } from "./client-runtime.js";
import { SessionBindingConflictError, type SessionBindingStore } from "./session-binding-store.js";
import type { SessionReconciler } from "./session-reconciler.js";

export interface TurnCustodyOwnerOptions {
  admission?: AdmissionController;
  bindingStore: SessionBindingStore;
  id?: () => string;
  imDeliveryVersion?: () => number | undefined;
  imSteerVersion?: () => number | undefined;
  maxRememberedRequests?: number;
  now?: () => number;
  preflight?(request: DirectImMessageDeliveryRequest): Promise<InputRejectReason | undefined>;
  reconciler: SessionReconciler;
  start?(owner: LiveTurnOwner): Promise<void> | void;
  steer?(request: RuntimeImSteerRequest): Promise<RuntimeImSteerResult>;
}

export interface LiveTurnOwner {
  readonly inputHash: string;
  readonly request: DirectImMessageDeliveryRequest;
  readonly reservation: AdmissionReservation;
  readonly turnId: string;
}

interface OwnedDelivery extends LiveTurnOwner {
  decision: Promise<DeliveryDecision>;
  started: boolean;
}

interface RememberedRequest {
  requestHash: string;
  decision: Promise<DeliveryDecision>;
}

interface RememberedSteer {
  requestHash: string;
  decision: Promise<RuntimeImSteerResult>;
}

interface SteerDelivery {
  inputHash: string;
  decision: Promise<RuntimeImSteerResult>;
}

export class TurnCustodyOwner {
  readonly admission: AdmissionController;
  readonly #bindingStore: SessionBindingStore;
  readonly #reconciler: SessionReconciler;
  readonly #id: () => string;
  readonly #imDeliveryVersion: () => number | undefined;
  readonly #imSteerVersion: () => number | undefined;
  readonly #maxRememberedRequests: number;
  readonly #now: () => number;
  readonly #preflight?: TurnCustodyOwnerOptions["preflight"];
  readonly #start?: TurnCustodyOwnerOptions["start"];
  readonly #steer?: TurnCustodyOwnerOptions["steer"];
  readonly #requests = new Map<string, RememberedRequest>();
  readonly #deliveries = new Map<string, OwnedDelivery>();
  readonly #turns = new Map<string, OwnedDelivery>();
  readonly #steerRequests = new Map<string, RememberedSteer>();
  readonly #steerDeliveries = new Map<string, SteerDelivery>();

  constructor(options: TurnCustodyOwnerOptions) {
    this.admission = options.admission ?? new AdmissionController();
    this.#bindingStore = options.bindingStore;
    this.#reconciler = options.reconciler;
    this.#id = options.id ?? randomUUID;
    this.#imDeliveryVersion = options.imDeliveryVersion ?? (() => undefined);
    this.#imSteerVersion = options.imSteerVersion ?? (() => undefined);
    this.#maxRememberedRequests = options.maxRememberedRequests ?? 512;
    this.#now = options.now ?? Date.now;
    this.#preflight = options.preflight;
    this.#start = options.start;
    this.#steer = options.steer;
    if (!Number.isSafeInteger(this.#maxRememberedRequests) || this.#maxRememberedRequests < 1) {
      throw new Error("maxRememberedRequests must be a positive safe integer");
    }
  }

  acceptSteer(request: RuntimeImSteerRequest): Promise<RuntimeImSteerResult> {
    if (request.replyRole === "observer" && this.#imSteerVersion() !== 2) {
      return Promise.resolve(deferredSteer(request, "steer_unsupported"));
    }
    const inputHash = computeRuntimeImSteerInputHash(request);
    const requestHash = hashTuple([request.deliveryId, inputHash]);
    const remembered = this.#steerRequests.get(request.requestId);
    if (remembered) {
      return remembered.requestHash === requestHash
        ? remembered.decision
        : Promise.resolve(rejectedSteer(request, "input_conflict"));
    }
    const existing = this.#steerDeliveries.get(request.deliveryId);
    if (existing) {
      const decision =
        existing.inputHash === inputHash
          ? existing.decision.then((result) => ({ ...result, requestId: request.requestId }))
          : Promise.resolve(rejectedSteer(request, "input_conflict"));
      this.#rememberSteer(request.requestId, requestHash, decision);
      return decision;
    }
    const deadline = request.deadlineAt ? Date.parse(request.deadlineAt) : undefined;
    const decision =
      deadline !== undefined && deadline <= this.#now()
        ? Promise.resolve(rejectedSteer(request, "invalid_input"))
        : (this.#steer?.(request) ?? Promise.resolve(deferredSteer(request, "steer_unsupported")));
    const delivery = { inputHash, decision };
    this.#steerDeliveries.set(request.deliveryId, delivery);
    void decision.then((result) => {
      if (result.status === "retry" && this.#steerDeliveries.get(request.deliveryId) === delivery) {
        this.#steerDeliveries.delete(request.deliveryId);
      }
    });
    this.#rememberSteer(request.requestId, requestHash, decision);
    return decision;
  }

  accept(request: DirectImMessageDeliveryRequest): Promise<DeliveryDecision> {
    if (request.replyRole === "observer" && this.#imDeliveryVersion() !== 2) {
      return Promise.resolve({ result: rejected(request, "session_not_ready") });
    }
    const inputHash = computeDirectInputHash(request);
    const requestHash = hashTuple([request.deliveryId, inputHash]);
    const remembered = this.#requests.get(request.requestId);
    if (remembered) {
      return remembered.requestHash === requestHash
        ? remembered.decision
        : Promise.resolve({ result: rejected(request, "input_conflict") });
    }
    const existingDelivery = this.#deliveries.get(request.deliveryId);
    if (existingDelivery) {
      const decision =
        existingDelivery.inputHash === inputHash
          ? existingDelivery.decision.then((existing) => ({
              ...existing,
              result: { ...existing.result, requestId: request.requestId },
            }))
          : Promise.resolve({ result: rejected(request, "input_conflict") });
      this.#remember(request.requestId, requestHash, decision);
      return decision;
    }

    const deadline = request.deadlineAt ? Date.parse(request.deadlineAt) : undefined;
    if (deadline !== undefined && deadline <= this.#now()) {
      const decision = Promise.resolve({ result: rejected(request, "turn_expired") });
      this.#remember(request.requestId, requestHash, decision);
      return decision;
    }
    const admission = this.admission.reserve(request.sessionId, request.agentId);
    if (!admission.accepted) {
      const decision = this.#absorbedOrRejected(request, admission.reason);
      this.#remember(request.requestId, requestHash, decision);
      return decision;
    }

    const turnId = this.#id();
    const owner = {
      inputHash,
      request,
      reservation: admission.reservation,
      turnId,
      started: false,
    } as OwnedDelivery;
    const decision = this.#reconciler.withAgentLock(request.agentId, () => this.#prepare(owner));
    owner.decision = decision;
    this.#deliveries.set(request.deliveryId, owner);
    this.#turns.set(turnId, owner);
    this.#remember(request.requestId, requestHash, decision);
    return decision;
  }

  async markReporting(turnId: string, reportInput: TurnReportRequest): Promise<void> {
    const report = TurnReportRequestSchema.parse(reportInput);
    const owner = this.#requireTurn(turnId);
    assertMatchingReport(owner, report);
    await this.#reconciler.withAgentLock(owner.request.agentId, async () => {
      if (owner.reservation.phase === "active") owner.reservation.markReporting();
      await this.#bindingStore.updateUnresolved(owner.request.agentId, owner.request.sessionId, turnId, "reporting", {
        report,
        resultHash: report.resultHash,
      });
      this.#reconciler.setActivity(owner.request.sessionId, {
        phase: "reporting",
        deliveryId: owner.request.deliveryId,
        turnId,
      });
    });
  }

  async recordResult(turnId: string, resultHash: string): Promise<void> {
    const owner = this.#requireTurn(turnId);
    await this.#reconciler.withAgentLock(owner.request.agentId, async () => {
      await this.#bindingStore.recordResult(owner.request.agentId, owner.request.sessionId, turnId, resultHash);
      owner.reservation.release();
      this.#reconciler.clearActivity(owner.request.sessionId, turnId);
      this.#deliveries.delete(owner.request.deliveryId);
      this.#turns.delete(turnId);
    });
  }

  getTurn(turnId: string): LiveTurnOwner | undefined {
    return this.#turns.get(turnId);
  }

  /** Accepted Turns still under local custody (accepted, not yet recorded as reported). */
  get liveTurnCount(): number {
    return this.#turns.size;
  }

  async #prepare(owner: OwnedDelivery): Promise<DeliveryDecision> {
    try {
      const deliveryReason = this.#reconciler.checkDelivery(owner.request);
      if (deliveryReason) {
        this.#discard(owner);
        return { result: rejected(owner.request, deliveryReason) };
      }
      const preflightReason = await this.#preflight?.(owner.request);
      if (preflightReason) {
        this.#discard(owner);
        return { result: rejected(owner.request, preflightReason) };
      }
      const custody = await this.#bindingStore.recordAccepted(owner.request, owner.inputHash, owner.turnId);
      if (custody.status === "recorded") {
        this.#discard(owner);
        return { result: accepted(owner.request, custody.recorded.turnId) };
      }
      if (custody.status === "absorbed") {
        this.#discard(owner);
        return { result: absorbed(owner.request, custody.recorded.rootDeliveryId, custody.recorded.turnId) };
      }
      if (custody.status === "existing" && custody.unresolvedTurn.turnId !== owner.turnId) {
        this.#discard(owner);
        return { result: rejected(owner.request, "session_recovery_required") };
      }
      this.#reconciler.setActivity(owner.request.sessionId, {
        phase: "running",
        deliveryId: owner.request.deliveryId,
        turnId: owner.turnId,
      });
      return {
        result: accepted(owner.request, owner.turnId),
        onAcceptedSent: async () => {
          if (owner.started) return;
          owner.started = true;
          owner.reservation.markActive();
          this.#reconciler.setActivity(owner.request.sessionId, {
            phase: "running",
            deliveryId: owner.request.deliveryId,
            turnId: owner.turnId,
          });
          await this.#start?.(owner);
        },
      };
    } catch (error) {
      this.#discard(owner);
      return { result: rejected(owner.request, mapStorageError(error)) };
    }
  }

  async #absorbedOrRejected(
    request: DirectImMessageDeliveryRequest,
    reason: InputRejectReason,
  ): Promise<DeliveryDecision> {
    try {
      const receipt = await this.#bindingStore.getAbsorbedReceipt(request);
      if (receipt) return { result: absorbed(request, receipt.rootDeliveryId, receipt.turnId) };
    } catch (error) {
      if (error instanceof SessionBindingConflictError && error.code === "conflict") {
        return { result: rejected(request, "input_conflict") };
      }
    }
    return { result: rejected(request, reason) };
  }

  #discard(owner: OwnedDelivery): void {
    owner.reservation.release();
    if (this.#deliveries.get(owner.request.deliveryId) === owner) this.#deliveries.delete(owner.request.deliveryId);
    if (this.#turns.get(owner.turnId) === owner) this.#turns.delete(owner.turnId);
  }

  #remember(requestId: string, requestHash: string, decision: Promise<DeliveryDecision>): void {
    this.#requests.set(requestId, { requestHash, decision });
    while (this.#requests.size > this.#maxRememberedRequests) {
      const oldest = this.#requests.keys().next().value;
      if (oldest === undefined) break;
      this.#requests.delete(oldest);
    }
  }

  #rememberSteer(requestId: string, requestHash: string, decision: Promise<RuntimeImSteerResult>): void {
    this.#steerRequests.set(requestId, { requestHash, decision });
    while (this.#steerRequests.size > this.#maxRememberedRequests) {
      const oldest = this.#steerRequests.keys().next().value;
      if (oldest === undefined) break;
      this.#steerRequests.delete(oldest);
    }
    while (this.#steerDeliveries.size > this.#maxRememberedRequests) {
      const oldest = this.#steerDeliveries.keys().next().value;
      if (oldest === undefined) break;
      this.#steerDeliveries.delete(oldest);
    }
  }

  #requireTurn(turnId: string): OwnedDelivery {
    const owner = this.#turns.get(turnId);
    if (!owner) throw new Error("The live Turn owner does not exist");
    return owner;
  }
}

function accepted(request: DirectImMessageDeliveryRequest, turnId: string): ImMessageDeliveryResult {
  return {
    type: "im:deliver:result",
    requestId: request.requestId,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    status: "accepted",
    turnId,
  };
}

function rejected(request: DirectImMessageDeliveryRequest, reason: InputRejectReason): ImMessageDeliveryResult {
  return {
    type: "im:deliver:result",
    requestId: request.requestId,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    status: "rejected",
    reason,
  };
}

function absorbed(
  request: DirectImMessageDeliveryRequest,
  rootDeliveryId: string,
  turnId: string,
): ImMessageDeliveryResult {
  return {
    type: "im:deliver:result",
    requestId: request.requestId,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    status: "absorbed",
    rootDeliveryId,
    turnId,
  };
}

function rejectedSteer(
  request: RuntimeImSteerRequest,
  reason: Extract<RuntimeImSteerResult, { status: "rejected" }>["reason"],
): RuntimeImSteerResult {
  return steerResult(request, "rejected", reason);
}

function deferredSteer(
  request: RuntimeImSteerRequest,
  reason: Extract<RuntimeImSteerResult, { status: "deferred" }>["reason"],
): RuntimeImSteerResult {
  return steerResult(request, "deferred", reason);
}

function steerResult(
  request: RuntimeImSteerRequest,
  status: "deferred" | "rejected",
  reason: Extract<RuntimeImSteerResult, { status: "deferred" | "rejected" }>["reason"],
): RuntimeImSteerResult {
  return {
    type: "im:steer:result",
    requestId: request.requestId,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    rootDeliveryId: request.rootDeliveryId,
    expectedTurnId: request.expectedTurnId,
    status,
    reason,
  } as RuntimeImSteerResult;
}

function mapStorageError(error: unknown): InputRejectReason {
  if (error instanceof SessionBindingConflictError) {
    if (error.code === "recovery_required") return "session_recovery_required";
    if (error.code === "stale") return "stale_configuration";
    return "session_binding_conflict";
  }
  return "provider_unavailable";
}

function assertMatchingReport(owner: LiveTurnOwner, report: TurnReportRequest): void {
  if (
    report.turnId !== owner.turnId ||
    report.deliveryId !== owner.request.deliveryId ||
    report.sessionId !== owner.request.sessionId ||
    report.agentId !== owner.request.agentId ||
    report.placementGeneration !== owner.request.placementGeneration
  ) {
    throw new Error("The Turn Report does not match its live custody owner");
  }
}
