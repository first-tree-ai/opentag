import type { ServiceLogger } from "../../observability/service-logger.js";
import type { SessionCollaborationService } from "./session-collaboration-service.js";
import { heldMessageCutoff } from "./session-held-delivery.js";
import type { HeldSessionMessage, SessionService } from "./session-service.js";

const FLUSH_PAGE_SIZE = 200;
const SWEEP_PAGE_SIZE = 100;
const TARGET_CONCURRENCY = 4;
/** Only Computers holding messages are visited; this covers a Client that recovers without reconnecting. */
const DEFAULT_FALLBACK_INTERVAL_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60_000;
/** A Client finishes its own recovery shortly after it registers, so look again soon. */
const DEFAULT_READY_FOLLOW_UPS_MS = [5_000, 20_000];

export interface SessionHeldDeliveryWorkerOptions {
  collaboration: Pick<SessionCollaborationService, "expireHeld" | "redeliverHeld">;
  sessions: Pick<SessionService, "listHeldMessagesForComputer" | "sweepHeldMessages">;
  registry: { currentInstanceId(computerId: string): string | undefined };
  logger?: Pick<ServiceLogger, "error">;
  now?: () => number;
  fallbackIntervalMs?: number;
  sweepIntervalMs?: number;
  readyFollowUpsMs?: readonly number[];
}

/**
 * Delivers the Session messages the Server holds for a Local Client. A Client that registers triggers
 * delivery; a low-frequency pass covers recovery without a reconnect, such as a failed upgrade that
 * reopens admission. Each target gets its messages oldest first and stops at the first that must stay
 * held, so a batch keeps its order. A sweep expires what stayed held too long and, after a Server
 * restart or on another replica, finds the Computers that still hold messages.
 */
export class SessionHeldDeliveryWorker {
  readonly #options: SessionHeldDeliveryWorkerOptions;
  readonly #now: () => number;
  readonly #pending = new Set<string>();
  readonly #active = new Map<string, Promise<void>>();
  readonly #rerun = new Set<string>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #fallback: ReturnType<typeof setInterval> | undefined;
  #sweep: ReturnType<typeof setInterval> | undefined;
  #sweeping: Promise<void> | undefined;
  #stopped = false;

  constructor(options: SessionHeldDeliveryWorkerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    this.#fallback = setInterval(
      () => this.#flushPending(),
      this.#options.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS,
    );
    this.#fallback.unref?.();
    this.#sweep = setInterval(() => void this.sweep(), this.#options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    this.#sweep.unref?.();
    void this.sweep();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#fallback) clearInterval(this.#fallback);
    if (this.#sweep) clearInterval(this.#sweep);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    await Promise.allSettled([...this.#active.values(), this.#sweeping]);
  }

  markHeld(computerId: string): void {
    this.#pending.add(computerId);
  }

  /** A Client registered: its messages go now, and again once its own recovery has had time to finish. */
  notifyComputerReady(computerId: string): void {
    if (this.#stopped) return;
    this.#pending.add(computerId);
    void this.flush(computerId);
    for (const delay of this.#options.readyFollowUpsMs ?? DEFAULT_READY_FOLLOW_UPS_MS) {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        if (this.#pending.has(computerId)) void this.flush(computerId);
      }, delay);
      timer.unref?.();
      this.#timers.add(timer);
    }
  }

  /** One pass over a Computer's held messages. A pass that is running runs once more afterwards. */
  flush(computerId: string): Promise<void> {
    const active = this.#active.get(computerId);
    if (active) {
      this.#rerun.add(computerId);
      return active;
    }
    const pass = this.#drain(computerId)
      .catch(() => {
        this.#options.logger?.error({ code: "SESSION_HELD_DELIVERY_FAILED", computerId }, "Held delivery pass failed");
      })
      .finally(() => {
        this.#active.delete(computerId);
        if (this.#rerun.delete(computerId) && !this.#stopped) void this.flush(computerId);
      });
    this.#active.set(computerId, pass);
    return pass;
  }

  /** Expire what stayed held too long, and find Computers this process does not know are holding. */
  sweep(): Promise<void> {
    if (this.#sweeping) return this.#sweeping;
    this.#sweeping = this.#runSweep()
      .catch(() => {
        this.#options.logger?.error({ code: "SESSION_HELD_DELIVERY_SWEEP_FAILED" }, "Held delivery sweep failed");
      })
      .finally(() => {
        this.#sweeping = undefined;
      });
    return this.#sweeping;
  }

  async #runSweep(): Promise<void> {
    for (;;) {
      const swept = await this.#options.sessions.sweepHeldMessages(heldMessageCutoff(this.#now()), SWEEP_PAGE_SIZE);
      for (const computerId of swept.computerIds) this.#pending.add(computerId);
      for (const message of swept.expired) {
        if (this.#stopped) return;
        await this.#options.collaboration.expireHeld(message);
      }
      if (swept.expired.length < SWEEP_PAGE_SIZE || this.#stopped) break;
    }
    this.#flushPending();
  }

  #flushPending(): void {
    if (this.#stopped) return;
    for (const computerId of this.#pending) void this.flush(computerId);
  }

  async #drain(computerId: string): Promise<void> {
    while (!this.#stopped && this.#options.registry.currentInstanceId(computerId)) {
      const messages = await this.#options.sessions.listHeldMessagesForComputer(
        computerId,
        heldMessageCutoff(this.#now()),
        FLUSH_PAGE_SIZE,
      );
      if (messages.length === 0) {
        this.#pending.delete(computerId);
        return;
      }
      const results = await this.#deliverByTarget(messages);
      // Anything left held waits for the next event or fallback pass; a pass never spins on a refusal.
      if (results.includes("held")) return;
    }
  }

  /** Targets run side by side so one slow Session does not delay the others; each target stays in order. */
  async #deliverByTarget(messages: readonly HeldSessionMessage[]): Promise<("held" | "settled")[]> {
    const byTarget = new Map<string, HeldSessionMessage[]>();
    for (const message of messages) {
      const queue = byTarget.get(message.targetSessionId);
      if (queue) queue.push(message);
      else byTarget.set(message.targetSessionId, [message]);
    }
    const queues = [...byTarget.values()];
    const results: ("held" | "settled")[] = [];
    const worker = async () => {
      for (let queue = queues.shift(); queue; queue = queues.shift()) {
        for (const message of queue) {
          if (this.#stopped) {
            results.push("held");
            return;
          }
          const result = await this.#options.collaboration.redeliverHeld(message);
          results.push(result);
          if (result === "held") break;
        }
      }
    };
    await Promise.all(Array.from({ length: TARGET_CONCURRENCY }, worker));
    return results;
  }
}
