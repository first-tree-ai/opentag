import type { ServiceLogger } from "../../observability/service-logger.js";
import type { SessionCollaborationService } from "./session-collaboration-service.js";
import { heldMessageCutoff } from "./session-held-delivery.js";
import type { HeldSweepCursor, HeldSweepMessage, SessionService } from "./session-service.js";

const TARGET_PAGE_SIZE = 200;
const MESSAGE_PAGE_SIZE = 200;
const SWEEP_PAGE_SIZE = 100;
const TARGET_CONCURRENCY = 4;
/** Only Computers holding messages are visited; this covers a Client that recovers without reconnecting. */
const DEFAULT_FALLBACK_INTERVAL_MS = 60_000;
/** The sweep reads the held index. A notice for an expired message can be this late. */
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * Longer than one attempt's reconcile and delivery timeouts together. A message attempted more recently may
 * still get a receipt, even on another replica, so giving it up now could contradict that answer.
 */
const ATTEMPT_SETTLE_MS = 2 * 60_000;
/** A Client finishes its own recovery shortly after it registers, so look again soon. */
const DEFAULT_READY_FOLLOW_UPS_MS = [5_000, 20_000];

export interface SessionHeldDeliveryWorkerOptions {
  collaboration: Pick<
    SessionCollaborationService,
    "expireHeld" | "redeliverHeld" | "settleEndedTargetHeld" | "settleReplacedHeld"
  >;
  sessions: Pick<SessionService, "listHeldMessagesForTarget" | "listHeldTargetsForComputer" | "sweepHeldMessages">;
  registry: { currentInstanceId(computerId: string): string | undefined };
  logger?: Pick<ServiceLogger, "error">;
  now?: () => number;
  fallbackIntervalMs?: number;
  sweepIntervalMs?: number;
  readyFollowUpsMs?: readonly number[];
}

type TargetResult = "held" | "settled";

/**
 * Delivers the Session messages the Server holds for a Local Client. A Client that registers triggers
 * delivery; a low-frequency pass covers recovery without a reconnect, such as a failed upgrade that
 * reopens admission. Each target gets its messages oldest first and stops at the first that must stay
 * held, so a batch keeps its order and a refusal blocks only that target. A sweep expires what stayed
 * held too long and, after a Server restart or on another replica, finds the Computers still holding.
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

  markHeld(computerId: string, options?: { flushNow: boolean }): void {
    this.#pending.add(computerId);
    if (options?.flushNow && !this.#stopped) void this.flush(computerId);
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
    const cutoff = heldMessageCutoff(this.#now());
    let cursor: HeldSweepCursor | null = null;
    while (!this.#stopped) {
      const page = await this.#options.sessions.sweepHeldMessages(cursor, SWEEP_PAGE_SIZE);
      for (const message of page) await this.#sweepMessage(message, cutoff);
      const last = page.at(-1);
      if (!last || page.length < SWEEP_PAGE_SIZE) break;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    this.#flushPending();
  }

  async #sweepMessage(message: HeldSweepMessage, cutoff: Date): Promise<void> {
    if (this.#stopped) return;
    if (message.createdAt > cutoff && message.computerId) this.#pending.add(message.computerId);
    if (this.#attemptMayStillAnswer(message)) return;
    if (message.targetEnded) await this.#options.collaboration.settleEndedTargetHeld(message);
    else if (message.createdAt <= cutoff) await this.#options.collaboration.expireHeld(message);
    else await this.#options.collaboration.settleReplacedHeld(message);
  }

  #attemptMayStillAnswer({ lastAttemptAt }: HeldSweepMessage): boolean {
    return lastAttemptAt !== null && this.#now() - lastAttemptAt.getTime() < ATTEMPT_SETTLE_MS;
  }

  #flushPending(): void {
    if (this.#stopped) return;
    for (const computerId of this.#pending) void this.flush(computerId);
  }

  async #drain(computerId: string): Promise<void> {
    while (!this.#stopped && this.#options.registry.currentInstanceId(computerId)) {
      const { anyHeld, sawTarget } = await this.#visitTargets(computerId);
      if (!sawTarget) {
        this.#pending.delete(computerId);
        return;
      }
      // Anything left held waits for the next event or fallback pass; a pass never spins on a refusal.
      if (anyHeld) return;
    }
  }

  /** Every holding target gets its turn, so one that stays blocked cannot hide the others behind it. */
  async #visitTargets(computerId: string): Promise<{ anyHeld: boolean; sawTarget: boolean }> {
    let after: string | null = null;
    let anyHeld = false;
    let sawTarget = false;
    while (!this.#stopped) {
      const targets: string[] = await this.#options.sessions.listHeldTargetsForComputer(
        computerId,
        heldMessageCutoff(this.#now()),
        after,
        TARGET_PAGE_SIZE,
      );
      const last = targets.at(-1);
      if (!last) break;
      sawTarget = true;
      if ((await this.#deliverTargets(targets)).includes("held")) anyHeld = true;
      if (targets.length < TARGET_PAGE_SIZE) break;
      after = last;
    }
    return { anyHeld, sawTarget };
  }

  /** Targets run side by side so one slow Session does not delay the others. */
  async #deliverTargets(targets: readonly string[]): Promise<TargetResult[]> {
    const queue = [...targets];
    const results: TargetResult[] = [];
    const worker = async () => {
      for (let target = queue.shift(); target; target = queue.shift()) {
        results.push(await this.#deliverTarget(target));
      }
    };
    await Promise.all(Array.from({ length: TARGET_CONCURRENCY }, worker));
    return results;
  }

  /** One target, oldest first, until it is empty or a message must stay held. */
  async #deliverTarget(targetSessionId: string): Promise<TargetResult> {
    let previousFirst: string | undefined;
    while (!this.#stopped) {
      const page = await this.#options.sessions.listHeldMessagesForTarget(
        targetSessionId,
        heldMessageCutoff(this.#now()),
        MESSAGE_PAGE_SIZE,
      );
      const first = page[0];
      if (!first) return "settled";
      // A row answered as settled that is still listed was not settled; do not spin on it.
      if (first.id === previousFirst) return "held";
      previousFirst = first.id;
      for (const message of page) {
        if (this.#stopped) return "held";
        if ((await this.#options.collaboration.redeliverHeld(message)) === "held") return "held";
      }
    }
    return "held";
  }
}
