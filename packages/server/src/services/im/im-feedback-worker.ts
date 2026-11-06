import type { ServiceLogger } from "../../observability/service-logger.js";
import {
  FeedbackCooldownStorageError,
  FeedbackProviderError,
  type FeedbackTransport,
} from "./im-feedback-messenger.js";
import type { FeedbackTarget, ImFeedbackStore } from "./im-feedback-store.js";

type ReactionResult = { value: FeedbackTarget["appliedReaction"]; failed: boolean; retryAfterMs?: number };
export class ImFeedbackWorker {
  #timer: ReturnType<typeof setInterval> | undefined;
  #pass: Promise<void> | undefined;
  #stopped = false;
  constructor(
    readonly options: {
      store: Pick<
        ImFeedbackStore,
        | "claim"
        | "isCurrent"
        | "refreshQueued"
        | "markSending"
        | "settle"
        | "latestAction"
        | "desiredReaction"
        | "reserveOfflineNotice"
        | "releaseOfflineNotice"
      >;
      transport: FeedbackTransport;
      logger: Pick<ServiceLogger, "warn">;
      now?: () => Date;
      reconcileAction?: (target: FeedbackTarget) => Promise<void>;
    },
  ) {}
  start(): void {
    this.#stopped = false;
    this.#timer ??= setInterval(() => {
      if (!this.#pass) void this.runOnce();
    }, 1_000);
    this.#timer.unref?.();
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pass;
  }
  runOnce(): Promise<void> {
    this.#pass ??= this.runPass()
      .catch(() => this.options.logger.warn({ code: "IM_FEEDBACK_PUMP_FAILED" }, "IM feedback worker failed"))
      .finally(() => {
        this.#pass = undefined;
      });
    return this.#pass;
  }
  async runPass(): Promise<void> {
    const active = new Map<FeedbackTarget, Promise<void>>();
    let halted = false;
    const halt = () => {
      halted = true;
    };
    let claimed = 0;
    try {
      while (claimed < 8 && !this.#stopped && !halted) {
        const target = await this.options.store.claim([...active.keys()]);
        if (!target) {
          if (active.size === 0) break;
          await Promise.race(active.values());
          continue;
        }
        claimed++;
        if (this.#stopped || halted) {
          await this.options.store.settle(target, { delayMs: 0 });
          break;
        }
        const task = this.#apply(target, halt)
          .catch(() => {
            halted = true;
            this.options.logger.warn(
              { code: "IM_FEEDBACK_PUMP_FAILED", feedbackId: target.id },
              "IM feedback target failed",
            );
          })
          .finally(() => active.delete(target));
        active.set(target, task);
        if (active.size >= 4) await Promise.race(active.values());
      }
    } finally {
      await Promise.all(active.values());
    }
  }
  async #owns(target: FeedbackTarget): Promise<boolean> {
    if (await this.options.store.isCurrent(target)) return true;
    const authorized = await this.options.store.isCurrent(target, false);
    await this.options.store.settle(target, authorized ? { delayMs: 0 } : { stale: true });
    return false;
  }
  async #apply(original: FeedbackTarget, halt: () => void): Promise<void> {
    let target = original;
    let retryAfterMs = 0;
    try {
      target = await this.options.store.refreshQueued(target);
      if (!(await this.#owns(target))) return;
      await this.options.reconcileAction?.(target);
      if (!(await this.#owns(target))) return;
      const reaction = await this.#reaction(target);
      retryAfterMs = reaction.retryAfterMs ?? 0;
      if (target.cardState === "send_unknown") await this.#recover(target, reaction);
      else if (target.cardState === "pending" && !target.cardMessageId) await this.#publish(target, reaction);
      else {
        await this.#offlineNotice(target);
        await this.#settleKnown(target, reaction);
      }
    } catch (error) {
      if (error instanceof FeedbackCooldownStorageError) halt();
      await this.#failure(target, error, retryAfterMs);
    }
  }
  /** Queued targets are revisited every fifteen seconds, which bounds how late past sixty seconds this runs. */
  async #offlineNotice(target: FeedbackTarget): Promise<void> {
    if (target.state !== "queued" || target.cardState !== "none") return;
    let reservedAt: Date | undefined;
    try {
      reservedAt = await this.options.store.reserveOfflineNotice(target);
      if (reservedAt) await this.options.transport.postOfflineNotice(target);
    } catch (error) {
      this.options.logger.warn(
        { code: "IM_FEEDBACK_OFFLINE_NOTICE_FAILED", feedbackId: target.id, provider: target.provider },
        "IM offline notice was not confirmed",
      );
      if (reservedAt && error instanceof FeedbackProviderError && error.knownNotApplied)
        await this.options.store.releaseOfflineNotice(target, reservedAt);
    }
  }
  async #failure(target: FeedbackTarget, error: unknown, retryAfterMs: number): Promise<void> {
    this.options.logger.warn(
      { code: "IM_FEEDBACK_PROJECTION_FAILED", feedbackId: target.id },
      "IM feedback remains pending",
    );
    await this.options.store.settle(target, {
      delayMs: Math.max(
        retryAfterMs,
        error instanceof FeedbackProviderError
          ? (error.retryAfterMs ?? feedbackRetryDelay(target.attemptCount))
          : feedbackRetryDelay(target.attemptCount),
      ),
      errorCode: error instanceof FeedbackCooldownStorageError ? error.code : "IM_FEEDBACK_PROJECTION_FAILED",
      ...(error instanceof FeedbackCooldownStorageError && target.cardState === "pending"
        ? { cardState: "pending" as const }
        : {}),
    });
    if (error instanceof FeedbackCooldownStorageError) throw error;
  }
  async #reaction(target: FeedbackTarget): Promise<ReactionResult> {
    let value = target.appliedReaction;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const desired = await this.options.store.desiredReaction(target);
        if (value === desired) return { value, failed: false };
        await this.options.transport.reaction(target, desired);
        value = desired;
      }
      return { value, failed: false };
    } catch (error) {
      if (error instanceof FeedbackCooldownStorageError) throw error;
      this.options.logger.warn(
        { code: "IM_FEEDBACK_REACTION_FAILED", feedbackId: target.id },
        "IM feedback reaction is pending",
      );
      return {
        value: null,
        failed: true,
        ...(error instanceof FeedbackProviderError && error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
  }
  async #expireReadback(target: FeedbackTarget, reaction: ReactionResult): Promise<boolean> {
    if (target.actionsExpireAt > (this.options.now?.() ?? new Date())) return false;
    await this.options.store.settle(target, {
      reaction: reaction.value,
      errorCode: "IM_FEEDBACK_SEND_UNKNOWN_EXPIRED",
      ...reactionRetry(target, reaction),
      dormant: !reaction.failed,
    });
    return true;
  }
  async #recover(target: FeedbackTarget, reaction: ReactionResult): Promise<void> {
    if (await this.#expireReadback(target, reaction)) return;
    const result = await this.#readback(target);
    if (!result) return;
    const { matches, cursor } = result;
    if (matches.size === 1) {
      await this.options.store.settle(target, {
        reaction: reaction.value,
        cardState: "sent",
        cardMessageId: [...matches][0],
        cardRevision: 0,
        delayMs: reaction.retryAfterMs ?? 0,
      });
      return;
    }
    this.options.logger.warn(
      {
        code: matches.size > 1 ? "IM_FEEDBACK_DUPLICATE_CARD" : "IM_FEEDBACK_SEND_UNKNOWN",
        feedbackId: target.id,
        provider: target.provider,
      },
      "Inspect delivery evidence before attempting another card send",
    );
    await this.options.store.settle(target, {
      reaction: reaction.value,
      errorCode: matches.size > 1 ? "IM_FEEDBACK_DUPLICATE_CARD" : "IM_FEEDBACK_SEND_UNKNOWN",
      delayMs: Math.max(300_000, reaction.retryAfterMs ?? 0),
      reconciliationCursor: cursor ?? null,
    });
  }
  async #readback(target: FeedbackTarget): Promise<{ matches: Set<string>; cursor?: string } | undefined> {
    let cursor = target.reconciliationCursor ?? undefined;
    const matches = new Set<string>();
    for (let page = 0; page < 5; page++) {
      if (!(await this.#owns(target))) return;
      const result = await this.options.transport.find(target, cursor);
      for (const id of result.ids) matches.add(id);
      cursor = result.cursor;
      if (matches.size > 1) break;
      if (!cursor) break;
    }
    return { matches, cursor };
  }
  async #publish(target: FeedbackTarget, reaction: ReactionResult): Promise<void> {
    if (!(await this.#owns(target))) return;
    if (!(await this.options.store.markSending(target))) {
      await this.options.store.settle(target, { delayMs: 0 });
      return;
    }
    try {
      const id = await this.options.transport.post(target, await this.options.store.latestAction(target.id));
      await this.options.store.settle(target, {
        reaction: reaction.value,
        cardMessageId: id,
        cardState: "sent",
        cardRevision: target.revision,
        ...reactionRetry(target, reaction),
      });
    } catch (error) {
      if (error instanceof FeedbackCooldownStorageError) throw error;
      const failure = sendFailure(error, target);
      await this.options.store.settle(target, {
        reaction: reaction.value,
        ...failure,
        delayMs: Math.max(failure.delayMs, reaction.retryAfterMs ?? 0),
      });
    }
  }
  async #settleKnown(target: FeedbackTarget, reaction: ReactionResult): Promise<void> {
    if (target.cardMessageId && target.cardRevision < target.revision) {
      if (!(await this.#owns(target))) return;
      await this.options.transport.update(target, await this.options.store.latestAction(target.id));
    }
    await this.options.store.settle(target, {
      reaction: reaction.value,
      ...(target.cardMessageId ? { cardRevision: target.revision } : {}),
      ...reactionRetry(target, reaction),
    });
  }
}
function reactionRetry(target: FeedbackTarget, result: ReactionResult) {
  return result.failed
    ? {
        delayMs: result.retryAfterMs ?? feedbackRetryDelay(target.attemptCount),
        errorCode: "IM_FEEDBACK_REACTION_FAILED",
      }
    : {};
}
function sendFailure(
  error: unknown,
  target: FeedbackTarget,
): { cardState: FeedbackTarget["cardState"]; errorCode: string; delayMs: number } {
  if (!(error instanceof FeedbackProviderError) || !error.knownNotApplied)
    return { cardState: "send_unknown", errorCode: "IM_FEEDBACK_SEND_UNKNOWN", delayMs: 30_000 };
  return {
    cardState: error.permanent ? "blocked" : "pending",
    errorCode: error.code,
    delayMs: error.retryAfterMs ?? (error.permanent ? 300_000 : feedbackRetryDelay(target.attemptCount)),
  };
}

function feedbackRetryDelay(attempt: number): number {
  return [2_000, 4_000, 8_000, 16_000, 30_000][attempt] ?? 300_000;
}
