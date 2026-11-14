import { randomUUID } from "node:crypto";
import type { DirectImMessageDeliveryRequest, TurnQuotaWaitRequest, TurnQuotaWaitResult } from "@opentag/shared";
import type { ClientLogger } from "../observability/logger.js";

/**
 * Tells the Server that an IM Turn waits for a used-up model quota (`turn:quota-wait`, `runtime.quotaWait` v1), so
 * the conversation gets the Server's notice, edited when the reset moves. Best effort: nothing waits for an answer,
 * and a failure is only logged. The sequence is taken from the clock, so a restarted daemon never sends one the
 * Server takes for an older frame, and never falls below the last one sent, so frames in the same millisecond, and
 * a wait that ends and starts again, stay in order.
 */
export class QuotaWaitNotifier {
  readonly #send: (frame: TurnQuotaWaitRequest) => Promise<void> | void;
  readonly #enabled: () => boolean;
  readonly #now: () => number;
  readonly #logger: Pick<ClientLogger, "warn">;
  /** The reset last sent per waiting Turn. */
  readonly #resets = new Map<string, string>();
  #lastSequence = 0;

  constructor(options: {
    send(frame: TurnQuotaWaitRequest): Promise<void> | void;
    enabled(): boolean;
    logger: Pick<ClientLogger, "warn">;
    now?: () => number;
  }) {
    this.#send = options.send;
    this.#enabled = options.enabled;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  /** The Turn waits until `resetAt`; a repeat of the same time sends nothing. */
  waiting(request: DirectImMessageDeliveryRequest, turnId: string, resetAt: string): void {
    if (this.#resets.get(turnId) === resetAt) return;
    if (this.#publish(request, turnId, { resetAt })) this.#resets.set(turnId, resetAt);
  }

  /** The Turn runs again, so the Server stops editing its notice. Sent even after a restart forgot the wait. */
  ended(request: DirectImMessageDeliveryRequest, turnId: string): void {
    this.#resets.delete(turnId);
    this.#publish(request, turnId, { ended: true });
  }

  handleResult(result: TurnQuotaWaitResult): void {
    if (result.status === "recorded" || result.status === "stale_generation") return;
    this.#logger.warn(
      { code: "TURN_QUOTA_WAIT_NOTICE_FAILED", turnId: result.turnId, status: result.status },
      "The quota wait notice could not be written",
    );
  }

  #publish(
    request: DirectImMessageDeliveryRequest,
    turnId: string,
    fields: { resetAt: string } | { ended: true },
  ): boolean {
    if (!this.#enabled() || request.replyRole === "observer") return false;
    const sequence = Math.max(this.#now(), this.#lastSequence + 1);
    this.#lastSequence = sequence;
    const frame: TurnQuotaWaitRequest = {
      type: "turn:quota-wait",
      requestId: randomUUID(),
      deliveryId: request.deliveryId,
      sessionId: request.sessionId,
      agentId: request.agentId,
      turnId,
      placementGeneration: request.placementGeneration,
      sequence,
      ...fields,
    };
    void Promise.resolve()
      .then(() => this.#send(frame))
      .catch(() =>
        this.#logger.warn({ code: "TURN_QUOTA_WAIT_NOTICE_UNSENT", turnId }, "The quota wait notice could not be sent"),
      );
    return true;
  }
}
