/** How long a dropped runtime connection keeps its presence before the Computer reads offline. */
const DEFAULT_PRESENCE_GRACE_MS = 15_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ComputerPresenceGraceOptions {
  /** The grace window, in milliseconds. */
  graceMs?: number;
}

/**
 * A dropped runtime WebSocket is not yet an offline Computer. The client reconnects on a capped
 * exponential backoff that starts around a second, so an ordinary network blip ends in a fresh
 * registration a few seconds later. Clearing the Computer's presence the instant the socket closes
 * publishes that blip as a definite "offline", and every readiness projection derived from the
 * connection status follows it down to "unavailable" and back, which reads as a flicker.
 *
 * Only the user-visible presence waits. The ConnectionRegistry still drops the socket the moment it
 * closes, so nothing is dispatched to a dead connection during the grace window.
 *
 * A release is keyed by Computer and a later registration cancels it. A release that fires anyway
 * is harmless: it carries the instance it was scheduled for, and clearing presence only matches
 * while that instance is still the current one, so an old connection's release can never take a
 * newer instance offline.
 */
export class ComputerPresenceGrace {
  readonly #clearPresence: (computerId: string, instanceId: string) => Promise<unknown>;
  readonly #graceMs: number;
  readonly #pending = new Map<string, TimerHandle>();

  constructor(
    clearPresence: (computerId: string, instanceId: string) => Promise<unknown>,
    options: ComputerPresenceGraceOptions = {},
  ) {
    this.#clearPresence = clearPresence;
    this.#graceMs = options.graceMs ?? DEFAULT_PRESENCE_GRACE_MS;
  }

  /**
   * This instance's connection ended. The newest close is the one that matters, so a release
   * already pending for the Computer is replaced rather than kept alongside.
   */
  schedule(computerId: string, instanceId: string): void {
    this.cancel(computerId);
    const timer = setTimeout(() => {
      this.#pending.delete(computerId);
      void this.#clearPresence(computerId, instanceId).catch(() => undefined);
    }, this.#graceMs);
    timer.unref();
    this.#pending.set(computerId, timer);
  }

  /** The Computer is connected again, so the release it was heading for no longer applies. */
  cancel(computerId: string): void {
    const timer = this.#pending.get(computerId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#pending.delete(computerId);
  }

  /** Drop every pending release. The server is shutting down and nothing reconnects here. */
  close(): void {
    for (const timer of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
  }
}
