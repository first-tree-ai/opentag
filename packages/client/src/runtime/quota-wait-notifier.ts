import { randomUUID } from "node:crypto";
import type { DirectImMessageDeliveryRequest, TurnQuotaWaitRequest, TurnQuotaWaitResult } from "@opentag/shared";
import type { ClientLogger } from "../observability/logger.js";

/**
 * Tells the Server that an IM Turn waits for a used-up model quota (`turn:quota-wait`, `runtime.quotaWait` v1), so
 * the conversation gets the Server's notice, edited when the reset moves. Best effort: nothing waits for an answer,
 * and a failure is only logged. The sequence is taken from the clock, so a restarted daemon never sends one the
 * Server takes for an older frame.
 */
export class QuotaWaitNotifier {
  readonly #send: (frame: TurnQuotaWaitRequest) => Promise<void> | void;
  readonly #enabled: () => boolean;
  readonly #now: () => number;
  readonly #logger: Pick<ClientLogger, "warn">;
  /** The latest sequence and reset sent per Turn. */
  readonly #sent = new Map<string, { sequence: number; resetAt: string }>();

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
    if (this.#sent.get(turnId)?.resetAt === resetAt) return;
    const sequence = this.#publish(request, turnId, { resetAt });
    if (sequence !== undefined) this.#sent.set(turnId, { sequence, resetAt });
  }

  /** The Turn runs again, so the Server stops editing its notice. Sent even after a restart forgot the wait. */
  ended(request: DirectImMessageDeliveryRequest, turnId: string): void {
    this.#sent.delete(turnId);
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
  ): number | undefined {
    if (!this.#enabled() || request.replyRole === "observer") return undefined;
    const sequence = Math.max(this.#now(), (this.#sent.get(turnId)?.sequence ?? 0) + 1);
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
    return sequence;
  }
}
