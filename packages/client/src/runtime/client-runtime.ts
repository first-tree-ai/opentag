import {
  type DirectImMessageDeliveryRequest,
  type ImMessageDeliveryResult,
  ImMessageDeliveryResultSchema,
  ServerRuntimeBusinessFrameSchema,
  type TurnReportResult,
} from "@opentag/shared";
import type { RuntimeConnection } from "./runtime-connection.js";
import { SessionReconciler } from "./session-reconciler.js";

export interface DeliveryDecision {
  result: ImMessageDeliveryResult;
  onAcceptedSent?(): Promise<void> | void;
}

export interface ClientRuntimeOptions {
  handleDelivery?(request: DirectImMessageDeliveryRequest): Promise<DeliveryDecision> | DeliveryDecision;
  handleTurnReportResult?(result: TurnReportResult): Promise<void> | void;
  reconciler?: SessionReconciler;
}

export class ClientRuntime {
  readonly reconciler: SessionReconciler;
  readonly #connection: RuntimeConnection;
  readonly #options: ClientRuntimeOptions;
  readonly #abort = new AbortController();
  #unsubscribe?: () => void;

  constructor(connection: RuntimeConnection, options: ClientRuntimeOptions = {}) {
    this.#connection = connection;
    this.#options = options;
    this.reconciler = options.reconciler ?? new SessionReconciler({ computerId: connection.computerId });
  }

  async run(): Promise<void> {
    this.#unsubscribe = this.#connection.subscribeBusinessFrames((frame) => this.#handleBusinessFrame(frame));
    try {
      await this.#connection.run();
    } finally {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
    }
  }

  stop(): void {
    this.#abort.abort();
    this.#connection.stop();
  }

  async #handleBusinessFrame(input: unknown): Promise<void> {
    const parsed = ServerRuntimeBusinessFrameSchema.safeParse(input);
    if (!parsed.success || this.#abort.signal.aborted) return;
    const frame = parsed.data;
    if (frame.type === "session:reconcile") {
      const result = await this.reconciler.reconcile(frame);
      await this.#connection.send(result, { priority: "result", signal: this.#abort.signal });
      return;
    }
    if (frame.type === "im:deliver") {
      const reason = this.reconciler.checkDelivery(frame);
      const decision = reason
        ? { result: rejectedDelivery(frame, reason) }
        : ((await this.#options.handleDelivery?.(frame)) ?? {
            result: rejectedDelivery(frame, "provider_unavailable"),
          });
      const result = ImMessageDeliveryResultSchema.parse(decision.result);
      await this.#connection.send(result, { priority: "result", signal: this.#abort.signal });
      if (result.status === "accepted") await decision.onAcceptedSent?.();
      return;
    }
    await this.#options.handleTurnReportResult?.(frame);
  }
}

function rejectedDelivery(
  request: DirectImMessageDeliveryRequest,
  reason: ImMessageDeliveryResult["reason"],
): ImMessageDeliveryResult {
  if (!reason) throw new Error("A rejected delivery requires a reason");
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
