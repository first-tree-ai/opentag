import { createHash, randomBytes } from "node:crypto";
import { RUNTIME_PROXY_TICKET_TTL_MS } from "@opentag/shared";

export interface RuntimeProxyTicketRecord {
  ticketHash: string;
  executionId: string;
  computerId: string;
  instanceId: string;
  connectionId: string;
  expiresAt: number;
}

export interface RuntimeProxyTicketStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxTickets?: number;
}

export class RuntimeProxyTicketStoreCapacityError extends Error {
  constructor() {
    super("The runtime proxy ticket store is full");
    this.name = "RuntimeProxyTicketStoreCapacityError";
  }
}

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

/**
 * Single-use, 15-second data-channel tickets. Tickets are issued only to the trusted Runner over
 * the authenticated control channel and bind the exact execution plus its control connection.
 * They are never valid as a bare HTTP bearer credential: `consume` deletes the ticket, so replay
 * fails closed.
 */
export class RuntimeProxyTicketStore {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxTickets: number;
  readonly #tickets = new Map<string, RuntimeProxyTicketRecord>();

  constructor(options: RuntimeProxyTicketStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? RUNTIME_PROXY_TICKET_TTL_MS;
    this.#maxTickets = options.maxTickets ?? 1024;
  }

  get size(): number {
    return this.#tickets.size;
  }

  issue(input: { executionId: string; computerId: string; instanceId: string; connectionId: string }): {
    ticket: string;
    expiresAt: number;
  } {
    this.sweep(this.#now());
    if (this.#tickets.size >= this.#maxTickets) throw new RuntimeProxyTicketStoreCapacityError();
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#ttlMs;
    this.#tickets.set(hashTicket(ticket), {
      ticketHash: hashTicket(ticket),
      executionId: input.executionId,
      computerId: input.computerId,
      instanceId: input.instanceId,
      connectionId: input.connectionId,
      expiresAt,
    });
    return { ticket, expiresAt };
  }

  /** Consumes the ticket exactly once; expiry, replay, and unknown tickets all return undefined. */
  consume(ticket: string, now = this.#now()): RuntimeProxyTicketRecord | undefined {
    const hash = hashTicket(ticket);
    const record = this.#tickets.get(hash);
    if (!record) return undefined;
    this.#tickets.delete(hash);
    if (record.expiresAt <= now) return undefined;
    return record;
  }

  revokeExecution(executionId: string): number {
    let removed = 0;
    for (const [hash, record] of [...this.#tickets.entries()]) {
      if (record.executionId !== executionId) continue;
      this.#tickets.delete(hash);
      removed += 1;
    }
    return removed;
  }

  sweep(now = this.#now()): number {
    let removed = 0;
    for (const [hash, record] of [...this.#tickets.entries()]) {
      if (record.expiresAt > now) continue;
      this.#tickets.delete(hash);
      removed += 1;
    }
    return removed;
  }
}
