import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  type DirectImMessageDeliveryRequest,
  hashTuple,
  type ImMessageDeliveryResult,
  type InputRejectReason,
  RuntimeSha256Schema,
} from "@opentag/shared";
import { AdmissionController, type AdmissionReservation } from "./admission-controller.js";
import type { DeliveryDecision } from "./client-runtime.js";
import { SessionBindingConflictError, type SessionBindingStore } from "./session-binding-store.js";
import type { SessionReconciler } from "./session-reconciler.js";

export interface TurnCustodyOwnerOptions {
  admission?: AdmissionController;
  bindingStore: SessionBindingStore;
  id?: () => string;
  maxRememberedRequests?: number;
  now?: () => number;
  preflight?(request: DirectImMessageDeliveryRequest): Promise<InputRejectReason | undefined>;
  reconciler: SessionReconciler;
  start?(owner: LiveTurnOwner): Promise<void> | void;
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

export class TurnCustodyOwner {
  readonly admission: AdmissionController;
  readonly #bindingStore: SessionBindingStore;
  readonly #reconciler: SessionReconciler;
  readonly #id: () => string;
  readonly #maxRememberedRequests: number;
  readonly #now: () => number;
  readonly #preflight?: TurnCustodyOwnerOptions["preflight"];
  readonly #start?: TurnCustodyOwnerOptions["start"];
  readonly #requests = new Map<string, RememberedRequest>();
  readonly #deliveries = new Map<string, OwnedDelivery>();
  readonly #turns = new Map<string, OwnedDelivery>();

  constructor(options: TurnCustodyOwnerOptions) {
    this.admission = options.admission ?? new AdmissionController();
    this.#bindingStore = options.bindingStore;
    this.#reconciler = options.reconciler;
    this.#id = options.id ?? randomUUID;
    this.#maxRememberedRequests = options.maxRememberedRequests ?? 512;
    this.#now = options.now ?? Date.now;
    this.#preflight = options.preflight;
    this.#start = options.start;
    if (!Number.isSafeInteger(this.#maxRememberedRequests) || this.#maxRememberedRequests < 1) {
      throw new Error("maxRememberedRequests must be a positive safe integer");
    }
  }

  accept(request: DirectImMessageDeliveryRequest): Promise<DeliveryDecision> {
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
      const decision = Promise.resolve({ result: rejected(request, admission.reason) });
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
    const decision = this.#prepare(owner);
    owner.decision = decision;
    this.#deliveries.set(request.deliveryId, owner);
    this.#turns.set(turnId, owner);
    this.#remember(request.requestId, requestHash, decision);
    return decision;
  }

  async markReporting(turnId: string, resultHash: string): Promise<void> {
    RuntimeSha256Schema.parse(resultHash);
    const owner = this.#requireTurn(turnId);
    if (owner.reservation.phase === "active") owner.reservation.markReporting();
    await this.#bindingStore.updateUnresolved(owner.request.agentId, owner.request.sessionId, turnId, "reporting", {
      resultHash,
    });
    this.#reconciler.setActivity(owner.request.sessionId, {
      phase: "reporting",
      deliveryId: owner.request.deliveryId,
      turnId,
    });
  }

  async recordResult(turnId: string, resultHash: string): Promise<void> {
    const owner = this.#requireTurn(turnId);
    await this.#bindingStore.recordResult(owner.request.agentId, owner.request.sessionId, turnId, resultHash);
    owner.reservation.release();
    this.#reconciler.clearActivity(owner.request.sessionId, turnId);
    this.#deliveries.delete(owner.request.deliveryId);
    this.#turns.delete(turnId);
  }

  getTurn(turnId: string): LiveTurnOwner | undefined {
    return this.#turns.get(turnId);
  }

  async #prepare(owner: OwnedDelivery): Promise<DeliveryDecision> {
    try {
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
      if (custody.status === "existing" && custody.unresolvedTurn.turnId !== owner.turnId) {
        this.#discard(owner);
        return { result: rejected(owner.request, "session_recovery_required") };
      }
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

function mapStorageError(error: unknown): InputRejectReason {
  if (error instanceof SessionBindingConflictError) {
    if (error.code === "recovery_required") return "session_recovery_required";
    if (error.code === "stale") return "stale_configuration";
    return "session_binding_conflict";
  }
  return "provider_unavailable";
}
