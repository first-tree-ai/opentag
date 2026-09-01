import type { InputRejectReason } from "@opentag/shared";

export type AdmissionPhase = "provisional" | "active" | "reporting" | "released";

export interface AdmissionLimits {
  agent: number;
  client: number;
  session: number;
}

export interface AdmissionSnapshot {
  activeAgents: ReadonlyMap<string, number>;
  client: number;
  sessions: number;
}

export type AdmissionDecision =
  | { accepted: true; reservation: AdmissionReservation }
  | { accepted: false; reason: InputRejectReason };

const DEFAULT_LIMITS: AdmissionLimits = { session: 1, agent: 10, client: 99 };

export class AdmissionReservation {
  #phase: AdmissionPhase = "provisional";

  constructor(
    readonly sessionId: string,
    readonly agentId: string,
    private readonly releaseOwner: (reservation: AdmissionReservation) => void,
  ) {}

  get phase(): AdmissionPhase {
    return this.#phase;
  }

  markActive(): void {
    this.#transition("active");
  }

  markReporting(): void {
    this.#transition("reporting");
  }

  release(): void {
    if (this.#phase === "released") return;
    this.#phase = "released";
    this.releaseOwner(this);
  }

  #transition(next: Exclude<AdmissionPhase, "provisional" | "released">): void {
    if (this.#phase === "released") throw new Error("A released admission reservation cannot transition");
    if (next === "active" && this.#phase !== "provisional") {
      throw new Error("Only a provisional reservation can become active");
    }
    if (next === "reporting" && this.#phase !== "active") {
      throw new Error("Only an active reservation can become reporting");
    }
    this.#phase = next;
  }
}

export class AdmissionController {
  readonly #limits: AdmissionLimits;
  readonly #sessions = new Map<string, AdmissionReservation>();
  readonly #agents = new Map<string, number>();
  readonly #releaseWaiters = new Set<() => void>();
  #paused = false;

  constructor(limits: Partial<AdmissionLimits> = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [name, limit] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`${name} admission limit must be positive`);
    }
    if (this.#limits.session !== 1) throw new Error("The V0 Session admission limit must be exactly one");
  }

  reserve(sessionId: string, agentId: string, options: { acceptedWork?: boolean } = {}): AdmissionDecision {
    if (this.#paused && !options.acceptedWork) return { accepted: false, reason: "client_busy" };
    if (this.#sessions.has(sessionId)) {
      return { accepted: false, reason: "session_busy" };
    }
    if ((this.#agents.get(agentId) ?? 0) >= this.#limits.agent) return { accepted: false, reason: "agent_busy" };
    if (this.#sessions.size >= this.#limits.client) return { accepted: false, reason: "client_busy" };
    const reservation = new AdmissionReservation(sessionId, agentId, (released) => this.#release(released));
    this.#sessions.set(sessionId, reservation);
    this.#agents.set(agentId, (this.#agents.get(agentId) ?? 0) + 1);
    return { accepted: true, reservation };
  }

  /** Stop taking new work while already accepted work continues to drain. */
  pause(): void {
    this.#paused = true;
  }

  /** Resume ordinary admission after an update attempt fails or is superseded. */
  resume(): void {
    this.#paused = false;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get(sessionId: string): AdmissionReservation | undefined {
    return this.#sessions.get(sessionId);
  }

  snapshot(): AdmissionSnapshot {
    return {
      activeAgents: new Map(this.#agents),
      client: this.#sessions.size,
      sessions: this.#sessions.size,
    };
  }

  waitForRelease(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.#releaseWaiters.delete(onRelease);
        signal?.removeEventListener("abort", onAbort);
      };
      const onRelease = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason);
      };
      this.#releaseWaiters.add(onRelease);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #release(reservation: AdmissionReservation): void {
    if (this.#sessions.get(reservation.sessionId) !== reservation) return;
    this.#sessions.delete(reservation.sessionId);
    const count = this.#agents.get(reservation.agentId) ?? 0;
    if (count <= 1) this.#agents.delete(reservation.agentId);
    else this.#agents.set(reservation.agentId, count - 1);
    for (const waiter of [...this.#releaseWaiters]) waiter();
  }
}
