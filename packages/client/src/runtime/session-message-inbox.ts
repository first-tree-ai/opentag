import {
  hashTuple,
  type InputRejectReason,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  type RuntimeImOutboxContext,
  type SessionMessageDeliveryRequest,
  SessionMessageDeliveryRequestSchema,
  type SessionMessageDeliveryResult,
} from "@opentag/shared";
import type { AgentInput } from "../agent-runtime/types.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { AdmissionController } from "./admission-controller.js";
import type { ImCredentialEnvironmentManager } from "./im-credential-environment-manager.js";
import { buildProviderOutboxInstructions } from "./provider-outbox-instructions.js";
import type { SessionReconciler } from "./session-reconciler.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";

interface QueuedMessage {
  request: SessionMessageDeliveryRequest;
  hash: string;
}

interface RememberedMessage {
  hash: string;
  status: "accepted" | "rejected" | "retryable";
  reason?: InputRejectReason;
}

export interface SessionMessageInboxOptions {
  admission: AdmissionController;
  cliCommand?: string;
  credentialEnvironment: Pick<ImCredentialEnvironmentManager, "cleanup" | "prepare">;
  imCredentialGrantVersion(): number | undefined;
  logger?: Pick<ClientLogger, "warn">;
  maxQueuedPerSession?: number;
  maxQueuedTotal?: number;
  maxRememberedMessages?: number;
  reconciler: Pick<
    SessionReconciler,
    "checkSessionMessageDelivery" | "clearActivity" | "setActivity" | "withAgentLock"
  >;
  runtimeManager: Pick<SessionRuntimeManager, "ensureRuntime" | "sessionKind">;
}

export class SessionMessageInbox {
  readonly #admission: AdmissionController;
  readonly #cliCommand: string;
  readonly #credentialEnvironment: SessionMessageInboxOptions["credentialEnvironment"];
  readonly #imCredentialGrantVersion: SessionMessageInboxOptions["imCredentialGrantVersion"];
  readonly #logger: Pick<ClientLogger, "warn">;
  readonly #maxQueuedPerSession: number;
  readonly #maxQueuedTotal: number;
  readonly #maxRememberedMessages: number;
  readonly #reconciler: SessionMessageInboxOptions["reconciler"];
  readonly #runtimeManager: SessionMessageInboxOptions["runtimeManager"];
  readonly #queues = new Map<string, QueuedMessage[]>();
  readonly #drains = new Map<string, Promise<void>>();
  readonly #remembered = new Map<string, RememberedMessage>();
  readonly #abort = new AbortController();
  #queuedTotal = 0;

  constructor(options: SessionMessageInboxOptions) {
    this.#admission = options.admission;
    this.#cliCommand = options.cliCommand ?? "opentag";
    this.#credentialEnvironment = options.credentialEnvironment;
    this.#imCredentialGrantVersion = options.imCredentialGrantVersion;
    this.#logger = options.logger ?? createLogger("session-message-inbox");
    this.#maxQueuedPerSession = positive(options.maxQueuedPerSession ?? 64, "maxQueuedPerSession");
    this.#maxQueuedTotal = positive(options.maxQueuedTotal ?? 256, "maxQueuedTotal");
    this.#maxRememberedMessages = positive(options.maxRememberedMessages ?? 512, "maxRememberedMessages");
    this.#reconciler = options.reconciler;
    this.#runtimeManager = options.runtimeManager;
  }

  async accept(input: SessionMessageDeliveryRequest): Promise<SessionMessageDeliveryResult> {
    const request = SessionMessageDeliveryRequestSchema.parse(input);
    const key = `${request.targetSessionId}:${request.messageId}`;
    const hash = hashTuple([request.sourceSessionId, request.targetSessionId, request.agentId, request.content]);
    return this.#reconciler.withAgentLock(request.agentId, async () => {
      const remembered = this.#remembered.get(key);
      if (remembered) {
        if (remembered.hash !== hash) return deliveryResult(request, "rejected", "input_conflict");
        if (remembered.status !== "retryable") {
          return deliveryResult(request, remembered.status, remembered.reason);
        }
      }
      if (this.#abort.signal.aborted) return deliveryResult(request, "rejected", "client_busy");
      const reason = this.#reconciler.checkSessionMessageDelivery(request);
      if (reason) {
        this.#remember(
          key,
          retryableAuthorityReason(reason) ? { hash, status: "retryable" } : { hash, status: "rejected", reason },
        );
        return deliveryResult(request, "rejected", reason);
      }
      if (
        this.#runtimeManager.sessionKind(request.targetSessionId) === "visible" &&
        this.#imCredentialGrantVersion() !== 2
      ) {
        this.#remember(key, { hash, status: "retryable" });
        return deliveryResult(request, "rejected", "session_not_ready");
      }
      const queue = this.#queues.get(request.targetSessionId) ?? [];
      if (queue.length >= this.#maxQueuedPerSession || this.#queuedTotal >= this.#maxQueuedTotal) {
        return deliveryResult(request, "rejected", "client_busy");
      }
      queue.push({ request, hash });
      this.#queues.set(request.targetSessionId, queue);
      this.#queuedTotal += 1;
      this.#remember(key, { hash, status: "accepted" });
      this.#startDrain(request.targetSessionId);
      return deliveryResult(request, "accepted");
    });
  }

  stop(): void {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort(new Error("Session message inbox stopped"));
    this.#queues.clear();
    this.#queuedTotal = 0;
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#drains.values()]);
  }

  #startDrain(sessionId: string): void {
    if (this.#drains.has(sessionId) || this.#abort.signal.aborted) return;
    const drain = this.#drain(sessionId).finally(() => {
      if (this.#drains.get(sessionId) === drain) this.#drains.delete(sessionId);
      if ((this.#queues.get(sessionId)?.length ?? 0) > 0) this.#startDrain(sessionId);
    });
    this.#drains.set(sessionId, drain);
    void drain.catch(() => undefined);
  }

  async #drain(sessionId: string): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const queue = this.#queues.get(sessionId);
      const next = queue?.[0];
      if (!next) {
        this.#queues.delete(sessionId);
        return;
      }
      let reservation = this.#admission.reserve(sessionId, next.request.agentId);
      while (!reservation.accepted) {
        await this.#admission.waitForRelease(this.#abort.signal);
        reservation = this.#admission.reserve(sessionId, next.request.agentId);
      }
      queue?.shift();
      this.#queuedTotal -= 1;
      reservation.reservation.markActive();
      const runId = `session-message-${next.request.messageId}`;
      await this.#reconciler.withAgentLock(next.request.agentId, async () => {
        this.#reconciler.setActivity(sessionId, {
          phase: "running",
          deliveryId: next.request.messageId,
          turnId: runId,
        });
      });
      let credentialPrepared = false;
      try {
        const sessionKind = this.#runtimeManager.sessionKind(sessionId);
        let outboxContext: RuntimeImOutboxContext | undefined;
        if (sessionKind === "visible") {
          try {
            const prepared = await this.#credentialEnvironment.prepare(
              {
                sessionId,
                agentId: next.request.agentId,
                placementGeneration: next.request.placementGeneration,
              },
              this.#abort.signal,
            );
            credentialPrepared = true;
            if (!prepared.outboxContext) {
              throw new Error("The credential grant did not include visible Session outbox context");
            }
            outboxContext = prepared.outboxContext;
          } catch (error) {
            this.#logger.warn(
              {
                code: "SESSION_MESSAGE_OUTBOX_PREPARATION_FAILED",
                errorCode: error instanceof Error && "code" in error ? error.code : undefined,
                messageId: next.request.messageId,
                sessionId,
              },
              "Visible Session collaboration outbox preparation failed",
            );
            throw error;
          }
        }
        const runtime = await this.#runtimeManager.ensureRuntime(sessionId, this.#abort.signal);
        await runtime.waitForIdle();
        const timeout = new AbortController();
        const timer = setTimeout(
          () => timeout.abort(new Error("Session message Run timed out")),
          next.request.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS,
        );
        timer.unref();
        try {
          await runtime.prompt({
            runId,
            input: buildSessionMessageInput(
              next.request,
              this.#cliCommand,
              sessionKind === "visible"
                ? { sessionKind, outboxContext: requireOutboxContext(outboxContext) }
                : { sessionKind },
            ),
            signal: AbortSignal.any([this.#abort.signal, timeout.signal]),
          });
        } finally {
          clearTimeout(timer);
        }
      } finally {
        if (credentialPrepared) {
          await this.#credentialEnvironment.cleanup(sessionId).catch(() => undefined);
        }
        await this.#reconciler.withAgentLock(next.request.agentId, async () => {
          this.#reconciler.clearActivity(sessionId, runId);
          reservation.reservation.release();
        });
      }
    }
  }

  #remember(key: string, value: RememberedMessage): void {
    this.#remembered.set(key, value);
    while (this.#remembered.size > this.#maxRememberedMessages) {
      const oldest = this.#remembered.keys().next().value;
      if (oldest === undefined) break;
      this.#remembered.delete(oldest);
    }
  }
}

function retryableAuthorityReason(reason: InputRejectReason): boolean {
  return (
    reason === "stale_generation" ||
    reason === "session_not_ready" ||
    reason === "stale_configuration" ||
    reason === "session_recovery_required"
  );
}

export type SessionMessageTurnContext =
  | { readonly sessionKind: "internal" }
  | { readonly outboxContext: RuntimeImOutboxContext; readonly sessionKind: "visible" };

export function buildSessionMessageInput(
  request: SessionMessageDeliveryRequest,
  cliCommand = "opentag",
  turnContext: SessionMessageTurnContext = { sessionKind: "internal" },
): AgentInput {
  const managedContext =
    turnContext.sessionKind === "visible"
      ? [
          '<opentag-session-message-context source="managed">',
          "OpenTag internal collaboration message continuing the visible Session's existing work.",
          `Message ID: ${request.messageId}`,
          `Source Session: ${request.sourceSessionId}`,
          `Target Session: ${request.targetSessionId}`,
          "This message is not an IM provider event, but the target visible Session retains its IM outbox authority.",
          ...buildProviderOutboxInstructions({
            actionInstruction:
              "When this collaboration message contains a user-visible result, question, or blocker, synthesize it and deliver it through the provider CLI in this Turn before ending. Do not wait for another IM message. Do not automatically forward the source text verbatim.",
            provider: turnContext.outboxContext.provider,
            target: turnContext.outboxContext,
            targetLabel: "Default provider outbox context",
          }),
          ...(turnContext.outboxContext.sessionKind === "thread"
            ? turnContext.outboxContext.provider === "slack"
              ? ["Keep this collaboration continuation in the supplied Slack threadTs scope."]
              : [
                  "Keep this collaboration continuation in the supplied Feishu threadId scope. Use lark-cli to inspect the thread when a native message reply target is required.",
                ]
            : []),
          `Use ${cliCommand} session send <target-session-id> to continue Session collaboration when needed.`,
          "Ordinary final text remains Runtime console output and is not published automatically.",
          "</opentag-session-message-context>",
        ]
      : [
          '<opentag-session-message-context source="managed">',
          "OpenTag internal collaboration message.",
          `Message ID: ${request.messageId}`,
          `Source Session: ${request.sourceSessionId}`,
          `Target Session: ${request.targetSessionId}`,
          "This message is not an IM provider event.",
          "Your final text is not returned automatically.",
          `Use ${cliCommand} session send <target-session-id> to report progress or results, ask a question, or continue collaboration.`,
          "No IM provider reference or credential is attached to this message.",
          "</opentag-session-message-context>",
        ];
  return {
    items: [
      {
        type: "text",
        text: managedContext.join("\n"),
      },
      { type: "text", text: request.content.text },
    ],
  };
}

function requireOutboxContext(context: RuntimeImOutboxContext | undefined): RuntimeImOutboxContext {
  if (!context) throw new Error("Visible Session collaboration requires outbox context");
  return context;
}

function deliveryResult(
  request: SessionMessageDeliveryRequest,
  status: "accepted" | "rejected",
  reason?: InputRejectReason,
): SessionMessageDeliveryResult {
  return {
    type: "session:message:deliver:result",
    requestId: request.requestId,
    messageId: request.messageId,
    targetSessionId: request.targetSessionId,
    placementGeneration: request.placementGeneration,
    status,
    ...(reason ? { reason } : {}),
  };
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}
