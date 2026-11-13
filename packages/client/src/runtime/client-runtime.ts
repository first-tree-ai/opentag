import type {
  SessionMessageOutcomeResult,
  SessionRecoverResult,
  SlackAutoSetupRuntimeRequest,
  SlackAutoSetupRuntimeResult,
  TurnActivityResult,
} from "@opentag/shared";
import {
  type AgentRuntimeOptions,
  type AgentRuntimeOptionsRequestFrame,
  type AgentRuntimeOptionsResultFrame,
  AgentRuntimeOptionsResultFrameSchema,
  type AgentRuntimeTestRequestFrame,
  type AgentRuntimeTestResultFrame,
  AgentRuntimeTestResultFrameSchema,
  type DirectImMessageDeliveryRequest,
  type ImMessageDeliveryResult,
  ImMessageDeliveryResultSchema,
  type InputRejectReason,
  RUNTIME_CAPABILITY,
  type RuntimeApprovalDecision,
  type RuntimeApprovalResult,
  type RuntimeImSteerRequest,
  type RuntimeImSteerResult,
  RuntimeImSteerResultSchema,
  type ServerRuntimeBusinessFrame,
  ServerRuntimeBusinessFrameSchema,
  type SessionMessageDeliveryRequestV3,
  type SessionMessageDeliveryResult,
  SessionMessageDeliveryResultSchema,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  SessionReconcileResultSchema,
  SlackAutoSetupRuntimeResultSchema,
  type TurnReportResult,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import { SessionReconciler } from "./session-reconciler.js";

type ResidualBusinessFrame = Extract<
  ServerRuntimeBusinessFrame,
  {
    type:
      | "provider-cli:prewarm"
      | "provider-cli:requirement"
      | "provider-cli:validation:grant"
      | "provider-cli:validation:run"
      | "provider-cli:cancel"
      | "slack:auto-setup"
      | "agent-runtime:options"
      | "agent-runtime:options:cancel"
      | "agent-runtime:test"
      | "agent-runtime:test:cancel"
      | "turn:report:result"
      | "approval:decision"
      | "session:message:outcome:result"
      | "session:recover:result"
      | "turn:activity:result"
      | "turn:quota-wait:result";
  }
>;

export interface DeliveryDecision {
  result: ImMessageDeliveryResult;
  onAcceptedSent?(): Promise<void> | void;
}

export interface ClientRuntimeOptions {
  handleApproval?(request: RuntimeApprovalDecision): Promise<RuntimeApprovalResult>;
  slackAutoSetup?: {
    run(request: SlackAutoSetupRuntimeRequest, signal?: AbortSignal): Promise<SlackAutoSetupRuntimeResult["result"]>;
  };
  logger?: ClientLogger;
  handleDelivery?(request: DirectImMessageDeliveryRequest): Promise<DeliveryDecision> | DeliveryDecision;
  handleSteer?(request: RuntimeImSteerRequest): Promise<RuntimeImSteerResult> | RuntimeImSteerResult;
  handleTurnActivityResult?(result: TurnActivityResult): void;
  handleSessionMessageOutcomeResult?(result: SessionMessageOutcomeResult): void;
  handleSessionRecoverResult?(result: SessionRecoverResult): void;
  handleTurnReportResult?(result: TurnReportResult): Promise<void> | void;
  handleSessionMessageDelivery?(
    request: SessionMessageDeliveryRequestV3,
  ): Promise<SessionMessageDeliveryResult> | SessionMessageDeliveryResult;
  getRuntimeOptions?(frame: AgentRuntimeOptionsRequestFrame, signal: AbortSignal): Promise<AgentRuntimeOptions>;
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
  readonly #optionQueries = new Map<string, AbortController>();
  readonly #tests = new Map<string, AbortController>();
  #unsubscribe?: () => void;

  constructor(connection: RuntimeConnection, options: ClientRuntimeOptions = {}) {
    this.#connection = connection;
    this.#options = options;
    this.#logger = options.logger ?? createLogger("client-runtime");
    this.reconciler = options.reconciler ?? new SessionReconciler({ installationId: connection.installationId });
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
    const frame = ownedBusinessFrame(input, this.#abort.signal.aborted);
    if (!frame) return;
    if (frame.type === "session:reconcile") {
      await this.#handleReconcile(frame);
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
      const result = await this.#receiveSessionMessage(frame);
      await this.#connection.send(result, { priority: "result", signal: this.#abort.signal });
      this.#logSessionMessageRejection(frame, result);
      return;
    }
    if (frame.type === "im:credential:result") return;
    await this.#handleResidualFrame(frame);
  }

  async #handleReconcile(frame: SessionReconcileRequest): Promise<void> {
    const fields = {
      agentId: frame.agentId,
      placementGeneration: frame.placementGeneration,
      requestId: frame.requestId,
      sessionId: frame.sessionId,
    };
    this.#logger.debug(fields, "Session reconcile received");
    if (frame.sessionMessage && this.#connection.capabilityVersion(RUNTIME_CAPABILITY.sessionMessageReconcile) !== 1) {
      return;
    }
    const { inlineMessageReady, ...reconciled } = await this.reconciler.reconcile(frame);
    const prepared = (await this.#options.prepareReconcileResult?.(frame, reconciled)) ?? reconciled;
    const sessionMessage = await this.#inlineSessionMessage(frame, prepared, inlineMessageReady);
    const result = SessionReconcileResultSchema.parse(
      sessionMessage === undefined ? prepared : { ...prepared, sessionMessage },
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
  }

  async #inlineSessionMessage(
    request: SessionReconcileRequest,
    result: SessionReconcileResult,
    inlineMessageReady: true | undefined,
  ): Promise<SessionReconcileResult["sessionMessage"]> {
    if (!request.sessionMessage) return undefined;
    if (
      !request.runtime ||
      !inlineMessageReady ||
      !["ready", "running", "reporting"].includes(result.status) ||
      result.retainedReports?.length ||
      this.#abort.signal.aborted
    ) {
      return "deferred";
    }
    const delivery: SessionMessageDeliveryRequestV3 = {
      type: "session:message:deliver",
      requestId: request.requestId,
      targetSessionId: request.sessionId,
      agentId: request.agentId,
      placementGeneration: request.placementGeneration,
      runtime: request.runtime,
      ...request.sessionMessage,
    };
    const receipt = await this.#receiveSessionMessage(delivery);
    this.#logSessionMessageRejection(delivery, receipt);
    return receipt;
  }

  async #receiveSessionMessage(frame: SessionMessageDeliveryRequestV3): Promise<SessionMessageDeliveryResult> {
    return SessionMessageDeliveryResultSchema.parse(
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
  }

  #logSessionMessageRejection(frame: SessionMessageDeliveryRequestV3, result: SessionMessageDeliveryResult): void {
    if (result.status !== "rejected") return;
    this.#logger.warn(
      {
        agentId: frame.agentId,
        messageId: frame.messageId,
        placementGeneration: frame.placementGeneration,
        reason: result.reason,
        requestId: frame.requestId,
        scheduled: frame.scheduledOrigin !== undefined,
        sessionId: frame.targetSessionId,
        status: result.status,
      },
      "Session message rejected",
    );
  }

  async #setupSlack(frame: SlackAutoSetupRuntimeRequest): Promise<void> {
    const result = (await this.#options.slackAutoSetup?.run(frame, this.#abort.signal)) ?? {
      status: "failed",
      code: "capability_missing",
    };
    await this.#connection.send(
      SlackAutoSetupRuntimeResultSchema.parse({
        type: "slack:auto-setup:result",
        requestId: frame.requestId,
        result,
      }),
      { priority: "result", signal: this.#abort.signal },
    );
  }

  async #handleResidualFrame(frame: ResidualBusinessFrame): Promise<void> {
    if (frame.type === "approval:decision") {
      const result = await this.#options.handleApproval?.(frame);
      if (result) await this.#connection.send(result);
      return;
    }

    if (frame.type === "agent-runtime:options:cancel") {
      this.#optionQueries.get(frame.requestId)?.abort();
      return;
    }
    if (frame.type === "agent-runtime:options") {
      await this.#queryRuntimeOptions(frame);
      return;
    }
    if (frame.type.startsWith("provider-cli:")) return;
    if (frame.type === "slack:auto-setup") {
      await this.#setupSlack(frame);
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
    if (frame.type === "turn:activity:result") this.#options.handleTurnActivityResult?.(frame);
    // This Client sends no quota-wait notices yet; a result is never expected.
    if (frame.type === "turn:quota-wait:result") return;
    if (frame.type === "session:message:outcome:result") this.#options.handleSessionMessageOutcomeResult?.(frame);
    if (frame.type === "session:recover:result") this.#options.handleSessionRecoverResult?.(frame);
    if (frame.type === "turn:report:result") await this.#options.handleTurnReportResult?.(frame);
  }

  async #queryRuntimeOptions(frame: AgentRuntimeOptionsRequestFrame): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.#abort.signal, AbortSignal.timeout(18_000)]);
    if (this.#optionQueries.size >= 32 || this.#optionQueries.has(frame.requestId)) return;
    this.#optionQueries.set(frame.requestId, controller);
    let result: AgentRuntimeOptionsResultFrame["result"];
    try {
      result = this.#options.getRuntimeOptions
        ? { status: "completed", options: await this.#options.getRuntimeOptions(frame, signal) }
        : { status: "failed", code: "capability_missing" };
    } catch {
      result = { status: "failed", code: signal.aborted ? "cancelled" : "provider_failed" };
    } finally {
      this.#optionQueries.delete(frame.requestId);
    }
    await this.#connection.send(
      AgentRuntimeOptionsResultFrameSchema.parse({
        type: "agent-runtime:options:result",
        requestId: frame.requestId,
        result,
      }),
      { priority: "result", signal: this.#abort.signal },
    );
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

function ownedBusinessFrame(input: unknown, aborted: boolean) {
  const parsed = ServerRuntimeBusinessFrameSchema.safeParse(input);
  if (!parsed.success || aborted || parsed.data.type === "runtime:self-check") return undefined;
  return parsed.data;
}
