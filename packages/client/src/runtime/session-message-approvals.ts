import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  type RuntimeApprovalDecision,
  type RuntimeApprovalRequest,
  type RuntimeApprovalResult,
  redactSensitive,
} from "@opentag/shared";
import type { AgentInteractionRequest, AgentRuntime, AgentRuntimeEvent } from "../agent-runtime/types.js";
import type { ClientLogger } from "../observability/logger.js";
import { approvalCommandPresentation, approvalDescription } from "./approval-presentation.js";
import { sessionMessageOfRun } from "./session-message-run.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";

/** How long a person has to answer before the request is declined for them. */
export const SESSION_MESSAGE_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

const NEXT_STEP =
  "Continue without it if you can; otherwise report in your reply that this step needs a person's approval.";

/** No person can be asked: the Server cannot route the request, or the request cannot be shown. */
export const SESSION_MESSAGE_APPROVAL_UNAVAILABLE = `No one could approve this action: this Run was started by a Session message, and nobody is reviewing it. ${NEXT_STEP}`;
/** The Server declined: the person asked declined it, or it found nobody to ask. */
export const SESSION_MESSAGE_APPROVAL_DECLINED = `This action was declined: the person asked declined it, or no one could be asked to approve it. Do not retry it. ${NEXT_STEP}`;
/** Nobody answered in time. */
export const SESSION_MESSAGE_APPROVAL_EXPIRED = `No one answered the approval request for this action within 10 minutes, so it was declined. ${NEXT_STEP}`;

export interface SessionMessageApprovalsOptions {
  readonly runtimeManager: Pick<SessionRuntimeManager, "observe">;
  /** Without one, or without `runtime.sessionMessageApproval`, every request is declined at once. */
  readonly connection?: {
    send(frame: RuntimeApprovalRequest): Promise<void>;
    capabilityVersion(capability: string): number | undefined;
  };
  readonly logger?: Pick<ClientLogger, "debug">;
  readonly timeoutMs?: number;
}

interface Pending {
  readonly runtime: AgentRuntime;
  readonly runId: string;
  readonly providerRequestId: string;
  readonly sessionId: string;
  readonly placementGeneration: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Answers the approval and question requests of Session message Runs. With `runtime.sessionMessageApproval`, an
 * approval is sent to the Server, which shows the usual card in the top visible Session's conversation; the
 * decision comes back here, and one unanswered for 10 minutes is declined. Otherwise each request is declined at
 * once. Either way the model is told why, so the Run never waits for an answer that cannot come.
 */
export class SessionMessageApprovals {
  readonly #options: SessionMessageApprovalsOptions;
  readonly #pending = new Map<string, Pending>();

  constructor(options: SessionMessageApprovalsOptions) {
    this.#options = options;
  }

  /** Watches one Run's requests until the returned function is called; requests still open then go stale. */
  watch(sessionId: string, runId: string, runtime: AgentRuntime, placementGeneration?: number): () => void {
    let stopObserving: () => void;
    try {
      stopObserving = this.#options.runtimeManager.observe(sessionId, async (event: AgentRuntimeEvent) => {
        if (event.type === "interaction_requested" && event.runId === runId)
          await this.#handle({ sessionId, runId, runtime, placementGeneration }, event.request);
      });
    } catch (error) {
      // Another owner already observes this Session's runtime, so it answers the requests.
      this.#options.logger?.debug(
        { code: "session_message_approvals_unobserved", sessionId, error: String(error) },
        "Session message Run approvals are answered elsewhere",
      );
      return () => undefined;
    }
    return () => {
      stopObserving();
      for (const [id, pending] of this.#pending) {
        if (pending.runId !== runId) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
      }
    };
  }

  /** The Server's decision for a request this Client sent. */
  async respondToApproval(decision: RuntimeApprovalDecision): Promise<RuntimeApprovalResult> {
    const { type: _type, decision: answer, ...identity } = decision;
    const pending = this.#pending.get(decision.requestId);
    if (
      !pending ||
      pending.runId !== decision.turnId ||
      pending.sessionId !== decision.sessionId ||
      sessionMessageOfRun(pending.runId) !== decision.deliveryId ||
      pending.placementGeneration !== decision.placementGeneration
    )
      return { ...identity, type: "approval:result", status: "stale" };
    this.#pending.delete(decision.requestId);
    clearTimeout(pending.timer);
    try {
      await pending.runtime.respond({
        expectedRunId: pending.runId,
        requestId: pending.providerRequestId,
        kind: "approval",
        decision: answer,
        scope: "run",
        ...(answer === "decline" ? { reason: SESSION_MESSAGE_APPROVAL_DECLINED } : {}),
      });
      return { ...identity, type: "approval:result", status: "applied" };
    } catch {
      return { ...identity, type: "approval:result", status: "stale" };
    }
  }

  async #handle(
    run: { sessionId: string; runId: string; runtime: AgentRuntime; placementGeneration: number | undefined },
    request: AgentInteractionRequest,
  ): Promise<void> {
    const messageId = sessionMessageOfRun(run.runId);
    const description = approvalDescription(request);
    const connection = this.#options.connection;
    if (
      request.kind !== "approval" ||
      !connection ||
      connection.capabilityVersion(RUNTIME_CAPABILITY.sessionMessageApproval) !== 1 ||
      !messageId ||
      run.placementGeneration === undefined ||
      description.length === 0 ||
      description.length > 6000
    ) {
      this.#answer(run.runtime, run.runId, request, SESSION_MESSAGE_APPROVAL_UNAVAILABLE);
      return;
    }
    const requestId = randomUUID();
    const timeoutMs = this.#options.timeoutMs ?? SESSION_MESSAGE_APPROVAL_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (!this.#pending.delete(requestId)) return;
      this.#answer(run.runtime, run.runId, request, SESSION_MESSAGE_APPROVAL_EXPIRED);
    }, timeoutMs);
    timer.unref?.();
    this.#pending.set(requestId, {
      runtime: run.runtime,
      runId: run.runId,
      providerRequestId: request.requestId,
      sessionId: run.sessionId,
      placementGeneration: run.placementGeneration,
      timer,
    });
    try {
      await connection.send({
        type: "approval:request",
        requestId,
        turnId: run.runId,
        sessionId: run.sessionId,
        deliveryId: messageId,
        placementGeneration: run.placementGeneration,
        source: "session-message",
        title: request.title.slice(0, 256),
        description: redactSensitive(description),
        ...approvalCommandPresentation(request.details, request.message),
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      });
    } catch (error) {
      if (!this.#pending.delete(requestId)) return;
      clearTimeout(timer);
      this.#options.logger?.debug(
        { code: "session_message_approval_not_sent", runId: run.runId, error: String(error) },
        "A Session message Run approval could not be sent",
      );
      this.#answer(run.runtime, run.runId, request, SESSION_MESSAGE_APPROVAL_UNAVAILABLE);
    }
  }

  #answer(runtime: AgentRuntime, runId: string, request: AgentInteractionRequest, reason: string): void {
    const identity = { expectedRunId: runId, requestId: request.requestId };
    const response =
      request.kind === "approval"
        ? { ...identity, kind: "approval" as const, decision: "decline" as const, reason }
        : { ...identity, kind: "question" as const, decision: "cancel" as const };
    // Answer after the event sink returns: the runtime registers the request before it dispatches the event.
    queueMicrotask(() => {
      void runtime.respond(response).catch((error: unknown) => {
        this.#options.logger?.debug(
          { code: "session_message_approval_unanswered", runId, error: String(error) },
          "A Session message Run approval could not be declined",
        );
      });
    });
  }
}

/** Sends each Server decision to the owner of its request: Session message Runs here, IM Turns to the runner. */
export function routeApprovalDecision(
  sessionMessages: Pick<SessionMessageApprovals, "respondToApproval">,
  turns: { respondToApproval(decision: RuntimeApprovalDecision): Promise<RuntimeApprovalResult> },
): (decision: RuntimeApprovalDecision) => Promise<RuntimeApprovalResult> {
  return (decision) =>
    decision.source === "session-message"
      ? sessionMessages.respondToApproval(decision)
      : turns.respondToApproval(decision);
}
