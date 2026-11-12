import type { AgentInteractionRequest, AgentRuntime, AgentRuntimeEvent } from "../agent-runtime/types.js";
import type { ClientLogger } from "../observability/logger.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";

/**
 * What the model is told when a Session message Run asks for an approval that no person can give. The Run
 * must not wait for an answer that never comes: it would hang until its duration limit.
 */
export const SESSION_MESSAGE_APPROVAL_UNAVAILABLE =
  "No one could approve this action: this Run was started by a Session message, and nobody is reviewing it. " +
  "Continue without it if you can; otherwise report in your reply that this step needs a person's approval.";

export interface SessionMessageApprovalsOptions {
  readonly runtimeManager: Pick<SessionRuntimeManager, "observe">;
  readonly logger?: Pick<ClientLogger, "debug">;
}

/**
 * Answers the approval and question requests of Session message Runs. IM Turns route theirs to a person through
 * the Server; a Session message Run has no IM input of its own, so each request is declined at once and the model
 * is told why.
 */
export class SessionMessageApprovals {
  readonly #runtimeManager: SessionMessageApprovalsOptions["runtimeManager"];
  readonly #logger: SessionMessageApprovalsOptions["logger"];

  constructor(options: SessionMessageApprovalsOptions) {
    this.#runtimeManager = options.runtimeManager;
    this.#logger = options.logger;
  }

  /** Watches one Run's requests until the returned function is called. */
  watch(sessionId: string, runId: string, runtime: AgentRuntime): () => void {
    try {
      return this.#runtimeManager.observe(sessionId, async (event: AgentRuntimeEvent) => {
        if (event.type === "interaction_requested" && event.runId === runId)
          this.#decline(runtime, runId, event.request);
      });
    } catch (error) {
      // Another owner already observes this Session's runtime, so it answers the requests.
      this.#logger?.debug(
        { code: "session_message_approvals_unobserved", sessionId, error: String(error) },
        "Session message Run approvals are answered elsewhere",
      );
      return () => undefined;
    }
  }

  #decline(runtime: AgentRuntime, runId: string, request: AgentInteractionRequest): void {
    const identity = { expectedRunId: runId, requestId: request.requestId };
    const response =
      request.kind === "approval"
        ? {
            ...identity,
            kind: "approval" as const,
            decision: "decline" as const,
            reason: SESSION_MESSAGE_APPROVAL_UNAVAILABLE,
          }
        : { ...identity, kind: "question" as const, decision: "cancel" as const };
    // Answer after the event sink returns: the runtime registers the request before it dispatches the event.
    queueMicrotask(() => {
      void runtime.respond(response).catch((error: unknown) => {
        this.#logger?.debug(
          { code: "session_message_approval_unanswered", runId, error: String(error) },
          "A Session message Run approval could not be declined",
        );
      });
    });
  }
}
