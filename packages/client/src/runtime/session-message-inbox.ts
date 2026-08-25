import {
  hashTuple,
  type InputRejectReason,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  type SessionMessageDeliveryRequest,
  SessionMessageDeliveryRequestSchema,
  type SessionMessageDeliveryResult,
} from "@opentag/shared";
import type { AgentInput } from "../agent-runtime/types.js";
import type { AdmissionController } from "./admission-controller.js";
import type { SessionReconciler } from "./session-reconciler.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";

interface QueuedMessage {
  request: SessionMessageDeliveryRequest;
  hash: string;
}

interface RememberedMessage {
  hash: string;
  status: "accepted" | "rejected";
  reason?: InputRejectReason;
}

export interface SessionMessageInboxOptions {
  admission: AdmissionController;
  maxQueuedPerSession?: number;
  maxQueuedTotal?: number;
  maxRememberedMessages?: number;
  reconciler: Pick<SessionReconciler, "checkSessionMessageDelivery">;
  runtimeManager: Pick<SessionRuntimeManager, "ensureRuntime">;
}

export class SessionMessageInbox {
  readonly #admission: AdmissionController;
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
    this.#maxQueuedPerSession = positive(options.maxQueuedPerSession ?? 64, "maxQueuedPerSession");
    this.#maxQueuedTotal = positive(options.maxQueuedTotal ?? 256, "maxQueuedTotal");
    this.#maxRememberedMessages = positive(options.maxRememberedMessages ?? 512, "maxRememberedMessages");
    this.#reconciler = options.reconciler;
    this.#runtimeManager = options.runtimeManager;
  }

  accept(input: SessionMessageDeliveryRequest): SessionMessageDeliveryResult {
    const request = SessionMessageDeliveryRequestSchema.parse(input);
    const key = `${request.targetSessionId}:${request.messageId}`;
    const hash = hashTuple([request.sourceSessionId, request.targetSessionId, request.agentId, request.content]);
    const remembered = this.#remembered.get(key);
    if (remembered) {
      return remembered.hash === hash
        ? deliveryResult(request, remembered.status, remembered.reason)
        : deliveryResult(request, "rejected", "input_conflict");
    }
    if (this.#abort.signal.aborted) return deliveryResult(request, "rejected", "client_busy");
    const reason = this.#reconciler.checkSessionMessageDelivery(request);
    if (reason) {
      this.#remember(key, { hash, status: "rejected", reason });
      return deliveryResult(request, "rejected", reason);
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
      try {
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
            runId: `session-message-${next.request.messageId}`,
            input: buildSessionMessageInput(next.request),
            signal: AbortSignal.any([this.#abort.signal, timeout.signal]),
          });
        } finally {
          clearTimeout(timer);
        }
      } finally {
        reservation.reservation.release();
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

export function buildSessionMessageInput(request: SessionMessageDeliveryRequest): AgentInput {
  return {
    items: [
      {
        type: "text",
        text: [
          '<opentag-session-message-context source="managed">',
          "OpenTag internal collaboration message.",
          `Source Session: ${request.sourceSessionId}`,
          `Target Session: ${request.targetSessionId}`,
          "This message is not an IM provider event.",
          "Your final text is not returned automatically.",
          "Use send_session_message to report progress or results, ask a question, or continue collaboration.",
          "No IM provider reference or credential is attached to this message.",
          "</opentag-session-message-context>",
        ].join("\n"),
      },
      { type: "text", text: request.content.text },
    ],
  };
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
