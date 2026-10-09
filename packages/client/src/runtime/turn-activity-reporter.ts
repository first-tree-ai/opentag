import { randomUUID } from "node:crypto";
import {
  type DirectImMessageDeliveryRequest,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  type TurnActivityRequest,
  type TurnActivityResult,
} from "@opentag/shared";

interface Entry {
  frame: TurnActivityRequest;
  acknowledged: boolean;
  heartbeatAt: number;
  expiresAt: number;
}

/** Liveness is replaceable, but the latest sequence is retried until acknowledged. */
export class TurnActivityReporter {
  readonly #entries = new Map<string, Entry>();
  readonly #send: (frame: TurnActivityRequest) => Promise<void> | void;
  readonly #enabled: () => boolean;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    send(frame: TurnActivityRequest): Promise<void> | void;
    enabled(): boolean;
    now?: () => number;
  }) {
    this.#send = options.send;
    this.#enabled = options.enabled;
    this.#now = options.now ?? Date.now;
  }

  start(request: DirectImMessageDeliveryRequest, turnId: string): void {
    if (!this.#enabled() || request.replyRole === "observer" || request.content.providerRef.provider !== "slack")
      return;
    if (this.#entries.has(turnId)) return;
    const now = this.#now();
    const entry: Entry = {
      frame: {
        type: "turn:activity",
        requestId: randomUUID(),
        deliveryId: request.deliveryId,
        sessionId: request.sessionId,
        agentId: request.agentId,
        placementGeneration: request.placementGeneration,
        turnId,
        sequence: 1,
        phase: "running",
      },
      acknowledged: false,
      heartbeatAt: now + 30_000,
      expiresAt: request.deadlineAt
        ? Date.parse(request.deadlineAt)
        : now + (request.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS),
    };
    this.#entries.set(turnId, entry);
    this.#publish(entry);
    this.#timer ??= setInterval(() => this.#tick(), 2_000);
    this.#timer.unref?.();
  }

  end(turnId: string): void {
    const entry = this.#entries.get(turnId);
    if (!entry || entry.frame.phase === "terminal") return;
    entry.frame = { ...entry.frame, requestId: randomUUID(), sequence: entry.frame.sequence + 1, phase: "terminal" };
    entry.acknowledged = false;
    entry.expiresAt = this.#now() + 30_000;
    this.#publish(entry);
  }

  acknowledge(result: TurnActivityResult): void {
    const entry = this.#entries.get(result.turnId);
    if (!entry || entry.frame.requestId !== result.requestId || entry.frame.sequence !== result.sequence) return;
    entry.acknowledged = true;
    if (
      entry.frame.phase === "terminal" ||
      result.status === "stale_generation" ||
      result.status === "unsupported_capability"
    ) {
      this.#entries.delete(result.turnId);
      this.#stopIdleTimer();
    }
  }

  close(): void {
    for (const turnId of this.#entries.keys()) this.end(turnId);
  }

  #tick(): void {
    const now = this.#now();
    for (const [turnId, entry] of this.#entries) {
      if (now >= entry.expiresAt) {
        if (entry.frame.phase === "terminal") this.#entries.delete(turnId);
        else this.end(turnId);
        continue;
      }
      if (entry.frame.phase === "running" && now >= entry.heartbeatAt) {
        entry.frame = { ...entry.frame, requestId: randomUUID(), sequence: entry.frame.sequence + 1 };
        entry.acknowledged = false;
        entry.heartbeatAt = now + 30_000;
      }
      if (!entry.acknowledged) this.#publish(entry);
    }
    this.#stopIdleTimer();
  }

  #publish(entry: Entry): void {
    if (!this.#enabled()) return;
    try {
      void Promise.resolve(this.#send(entry.frame)).catch(() => {
        /* Retried by the liveness timer. */
      });
    } catch {
      /* Disconnected transports are retried within the bounded lease. */
    }
  }

  #stopIdleTimer(): void {
    if (this.#entries.size) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
