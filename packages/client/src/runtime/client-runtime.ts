import {
  type AgentRuntimeTestRequestFrame,
  type AgentRuntimeTestResultFrame,
  AgentRuntimeTestResultFrameSchema,
  type DirectImMessageDeliveryRequest,
  type ImMessageDeliveryResult,
  ImMessageDeliveryResultSchema,
  type InputRejectReason,
  type RuntimeImSteerRequest,
  type RuntimeImSteerResult,
  RuntimeImSteerResultSchema,
  ServerRuntimeBusinessFrameSchema,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryResult,
  SessionMessageDeliveryResultSchema,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  SessionReconcileResultSchema,
  type TurnReportResult,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import { SessionReconciler } from "./session-reconciler.js";

export interface DeliveryDecision {
  result: ImMessageDeliveryResult;
  onAcceptedSent?(): Promise<void> | void;
}

export interface ClientRuntimeOptions {
  logger?: ClientLogger;
  handleDelivery?(request: DirectImMessageDeliveryRequest): Promise<DeliveryDecision> | DeliveryDecision;
  handleSteer?(request: RuntimeImSteerRequest): Promise<RuntimeImSteerResult> | RuntimeImSteerResult;
  handleTurnReportResult?(result: TurnReportResult): Promise<void> | void;
  handleSessionMessageDelivery?(
    request: SessionMessageDeliveryRequest,
  ): Promise<SessionMessageDeliveryResult> | SessionMessageDeliveryResult;
  availabilityTester?: {
    run(
      request: AgentRuntimeTestRequestFrame,
      signal: AbortSignal,
    ): Promise<AgentRuntimeTestResultFrame> | AgentRuntimeTestResultFrame;
  };
  onReconcileResultSendFailed?(
    request: SessionReconcileRequest,
    result: SessionReconcileResult,
    error: unknown,
  ): Promise<void> | void;
  onReconciled?(request: SessionReconcileRequest, result: SessionReconcileResult): Promise<void> | void;
  prepareReconcileResult?(
    request: SessionReconcileRequest,
    result: SessionReconcileResult,
  ): Promise<SessionReconcileResult> | SessionReconcileResult;
  reconciler?: SessionReconciler;
}

export class ClientRuntime {
  readonly reconciler: SessionReconciler;
  readonly #connection: RuntimeConnection;
  readonly #options: ClientRuntimeOptions;
  readonly #logger: ClientLogger;
  readonly #abort = new AbortController();
  readonly #tests = new Map<string, AbortController>();
  #unsubscribe?: () => void;

  constructor(connection: RuntimeConnection, options: ClientRuntimeOptions = {}) {
    this.#connection = connection;
    this.#options = options;
    this.#logger = options.logger ?? createLogger("client-runtime");
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
      const fields = {
        agentId: frame.agentId,
        placementGeneration: frame.placementGeneration,
        requestId: frame.requestId,
        sessionId: frame.sessionId,
      };
      this.#logger.debug(fields, "Session reconcile received");
      const reconciled = await this.reconciler.reconcile(frame);
      const result = SessionReconcileResultSchema.parse(
        (await this.#options.prepareReconcileResult?.(frame, reconciled)) ?? reconciled,
      );
      try {
        await this.#connection.send(result, { priority: "result", signal: this.#abort.signal });
      } catch (error) {
        this.#logger.warn({ ...fields, status: result.status }, "Session reconcile result send failed");
        await this.#options.onReconcileResultSendFailed?.(frame, result, error);
        throw error;
      }
      this.#logger.debug({ ...fields, reason: result.reason, status: result.status }, "Session reconcile completed");
      await this.#options.onReconciled?.(frame, result);
      return;
    }
    if (frame.type === "im:deliver") {
      const fields = {
        agentId: frame.agentId,
        deliveryId: frame.deliveryId,
        placementGeneration: frame.placementGeneration,
        requestId: frame.requestId,
        sessionId: frame.sessionId,
      };
      this.#logger.debug(fields, "IM delivery received");
      const reason = this.reconciler.checkDelivery(frame);
      const decision = reason
        ? { result: rejectedDelivery(frame, reason) }
        : ((await this.#options.handleDelivery?.(frame)) ?? {
            result: rejectedDelivery(frame, "provider_unavailable"),
          });
      const result = ImMessageDeliveryResultSchema.parse(decision.result);
      await this.#connection.send(result, { priority: "result", signal: this.#abort.signal });
      const resultFields = { ...fields, reason: "reason" in result ? result.reason : undefined, status: result.status };
      if (result.status === "accepted") this.#logger.debug(resultFields, "IM delivery accepted");
      else if (result.status === "absorbed") this.#logger.debug(resultFields, "IM delivery absorbed");
      else this.#logger.warn(resultFields, "IM delivery rejected");
      if (result.status === "accepted") await decision.onAcceptedSent?.();
      return;
    }
    if (frame.type === "im:steer") {
      const result = RuntimeImSteerResultSchema.parse(
        (await this.#options.handleSteer?.(frame)) ?? {
          type: "im:steer:result",
          requestId: frame.requestId,
          deliveryId: frame.deliveryId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          rootDeliveryId: frame.rootDeliveryId,
          expectedTurnId: frame.expectedTurnId,
          status: "deferred",
          reason: "steer_unsupported",
        },
      );
      await this.#connection.send(result, { priority: "result", signal: this.#abort.signal });
      return;
    }
    if (frame.type === "session:message:deliver") {
      const result = SessionMessageDeliveryResultSchema.parse(
        (await this.#options.handleSessionMessageDelivery?.(frame)) ?? {
          type: "session:message:deliver:result",
          requestId: frame.requestId,
          messageId: frame.messageId,
          targetSessionId: frame.targetSessionId,
          placementGeneration: frame.placementGeneration,
          status: "rejected",
          reason: "provider_unavailable",
        },
      );
      await this.#connection.send(result, { priority: "result", signal: this.#abort.signal });
      return;
    }
    if (frame.type === "im:credential:result") return;
    if (
      frame.type === "provider-cli:requirement" ||
      frame.type === "provider-cli:validation:grant" ||
      frame.type === "provider-cli:cancel"
    ) {
      return;
    }
    if (frame.type === "agent-runtime:test") {
      await this.#runAgentRuntimeTest(frame);
      return;
    }
    if (frame.type === "agent-runtime:test:cancel") {
      this.#tests.get(frame.requestId)?.abort();
      return;
    }
    await this.#options.handleTurnReportResult?.(frame);
  }

  async #runAgentRuntimeTest(frame: AgentRuntimeTestRequestFrame): Promise<void> {
    const controller = new AbortController();
    this.#tests.set(frame.requestId, controller);
    const onStop = () => controller.abort();
    this.#abort.signal.addEventListener("abort", onStop, { once: true });
    let result: AgentRuntimeTestResultFrame;
    try {
      result = AgentRuntimeTestResultFrameSchema.parse(
        (await this.#options.availabilityTester?.run(frame, controller.signal)) ?? {
          type: "agent-runtime:test:result",
          requestId: frame.requestId,
          status: "failed",
          code: "capability_missing",
        },
      );
    } catch {
      result = {
        type: "agent-runtime:test:result",
        requestId: frame.requestId,
        status: "failed",
        code: "provider_failed",
      };
    } finally {
      this.#abort.signal.removeEventListener("abort", onStop);
      this.#tests.delete(frame.requestId);
    }
    await this.#connection.send(result, { priority: "result", signal: this.#abort.signal });
  }
}

function rejectedDelivery(request: DirectImMessageDeliveryRequest, reason: InputRejectReason): ImMessageDeliveryResult {
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
