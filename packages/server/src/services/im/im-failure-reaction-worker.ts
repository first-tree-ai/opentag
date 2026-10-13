import type { ServiceLogger } from "../../observability/service-logger.js";
import { FailureReactionError } from "../im-bindings/failure-reaction-error.js";
import type { ImProviderAdapter } from "../im-bindings/provider-adapter.js";
import type { FailureReactionTarget, ImFailureReactionStore } from "./im-failure-reaction-store.js";

export class ImFailureReactionWorker {
  #timer: ReturnType<typeof setInterval> | undefined;
  #pass: Promise<void> | undefined;
  #stopped = false;
  #notBefore = 0;
  constructor(
    readonly options: {
      store: Pick<ImFailureReactionStore, "reconcile" | "claim" | "ownsClaim" | "settle">;
      resolveAdapter(bindingId: string, generation: number): Promise<ImProviderAdapter<unknown>>;
      logger: Pick<ServiceLogger, "warn">;
      now?: () => number;
    },
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.runOnce();
    }, 5_000);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pass;
  }

  runOnce(): Promise<void> {
    this.#pass ??= this.#pump()
      .catch(() => {
        this.options.logger.warn({ code: "IM_FAILURE_REACTION_PUMP_FAILED" }, "IM failure reaction pump failed");
      })
      .finally(() => {
        this.#pass = undefined;
      });
    return this.#pass;
  }

  async #pump(): Promise<void> {
    if ((this.options.now?.() ?? Date.now()) < this.#notBefore) return;
    await this.options.store.reconcile();
    // A small batch keeps normal Slack traffic below the reactions API's per-minute budget.
    for (let count = 0; count < 2 && !this.#stopped; count += 1) {
      const target = await this.options.store.claim();
      if (!target) return;
      await this.#apply(target);
      if ((this.options.now?.() ?? Date.now()) < this.#notBefore) return;
    }
  }

  async #apply(target: FailureReactionTarget): Promise<void> {
    try {
      const adapter = await this.options.resolveAdapter(target.bindingId, target.credentialGeneration);
      if (!adapter.setFailureReaction) throw new Error("IM_FAILURE_REACTION_UNSUPPORTED");
      if (!(await this.options.store.ownsClaim(target))) {
        await this.options.store.settle(target, 0);
        return;
      }
      await adapter.setFailureReaction({
        channelId: target.channelId,
        externalMessageId: target.externalMessageId,
        failed: target.desired,
      });
      await this.options.store.settle(target);
    } catch (error) {
      this.options.logger.warn({ code: "IM_FAILURE_REACTION_API_FAILED" }, "IM failure reaction request failed");
      // Keep cleanup durable even during an extended provider outage. Never abandon removals.
      const delayMs =
        error instanceof FailureReactionError
          ? error.retryAfterMs
          : Math.min(300_000, 2_000 * 2 ** Math.min(target.failures, 8));
      await this.options.store.settle(target, delayMs);
      if (error instanceof FailureReactionError) this.#notBefore = (this.options.now?.() ?? Date.now()) + delayMs;
    }
  }
}
