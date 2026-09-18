import { randomUUID } from "node:crypto";
import {
  RUNNER_WS_CLOSE,
  type RunnerAcceptanceResultFrame,
  type RunnerAcceptanceRunFrame,
  type RunnerReadiness,
  type RunnerServerFrame,
  type RunnerWorkspaceSealFrame,
  type RunnerWorkspaceSealResultFrame,
} from "@opentag/shared";

/**
 * In-memory hub of authenticated Runner control connections, keyed by Sandbox. A Sandbox has at
 * most one current Runner; the scope (sandboxId + sessionId + environmentGeneration + resource
 * name) is the Server-validated allocation identity, and the connection identity is the exact
 * socket object. Every inbound frame and every outbound send is checked against BOTH, so a
 * replaced or superseded connection can never publish readiness, resolve a result, or mutate a
 * newer allocation's entry.
 * Reconnect rules:
 * - a same-scope reconnect while the current connection is still live (activity inside the
 *   caller-provided window) is rejected as a duplicate, so a second holder of the bootstrap
 *   token can never take over a heartbeating Runner's channel; once the dead connection has
 *   been cleaned up — or has gone silent past the window — the reconnect attaches and the stale
 *   socket is closed;
 * - a new scope (a newer environment generation) closes the superseded connection as stale;
 * - a connection for one Sandbox can never touch another Sandbox's entry, so a reconnecting
 *   Session's Runner can never evict a different Session's Runner.
 * The hub holds no credentials: the bootstrap token is verified at the route layer and discarded.
 */

export interface RunnerScope {
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly environmentGeneration: number;
  readonly resourceName: string;
}

/**
 * Minimal send/close surface so the hub stays testable without a live socket. `send` must THROW
 * when the frame cannot be written; a silently dropped acceptance command would otherwise leave
 * its HTTP caller waiting for a result that can never arrive.
 */
export interface RunnerControlSocket {
  send(frame: RunnerServerFrame): void;
  close(code: number, reason: string): void;
}

export interface RunnerConnectionSnapshot {
  readonly connected: boolean;
  readonly ready: boolean;
  readonly readiness: RunnerReadiness | null;
  readonly scope: RunnerScope | null;
}

interface PendingAcceptance {
  readonly requestId: string;
  readonly resolve: (frame: RunnerAcceptanceResultFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * One in-flight workspace seal. A second concurrent request JOINS the same promise: stop retries
 * are idempotent and the proof bar (the object metadata read-back) is identical for every waiter.
 */
interface PendingWorkspaceSeal {
  readonly requestId: string;
  readonly promise: Promise<RunnerWorkspaceSealResultFrame>;
  readonly resolve: (frame: RunnerWorkspaceSealResultFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface HubEntry {
  scope: RunnerScope;
  socket: RunnerControlSocket;
  readiness: RunnerReadiness | null;
  lastSeenAt: number;
  pending: Map<string, PendingAcceptance>;
  activeAcceptanceId: string | null;
  pendingSeal: PendingWorkspaceSeal | null;
}

export class RunnerAcceptanceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerAcceptanceUnavailableError";
  }
}

/** A workspace seal could not be requested or settled; the caller keeps the allocation and retries. */
export class RunnerWorkspaceSealUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerWorkspaceSealUnavailableError";
  }
}

export type RunnerAttachOutcome = "attached" | "replaced" | "duplicate";

export class RunnerHub {
  readonly #entries = new Map<string, HubEntry>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  describe(sandboxId: string): RunnerConnectionSnapshot {
    const entry = this.#entries.get(sandboxId);
    if (!entry) return { connected: false, ready: false, readiness: null, scope: null };
    return { connected: true, ready: entry.readiness !== null, readiness: entry.readiness, scope: entry.scope };
  }

  /** The current socket for a scope, or undefined when a different connection owns it now. */
  currentSocket(sandboxId: string): RunnerControlSocket | undefined {
    return this.#entries.get(sandboxId)?.socket;
  }

  /** True only when this exact socket is the current connection for the Sandbox. */
  isCurrent(sandboxId: string, socket: RunnerControlSocket): boolean {
    return this.#entries.get(sandboxId)?.socket === socket;
  }

  /**
   * Register an authenticated connection for an already DB-validated scope. Returns "duplicate"
   * — without touching the current entry — when a SAME-scope connection is still live (activity
   * within `options.liveWindowMs`): unconditional last-wins would let a second token holder
   * evict a healthy, heartbeating Runner. A same-scope connection silent past the window is
   * dead weight: it is closed and replaced so a legitimate reconnect after a dead connection
   * always lands. Callers that omit the window keep unconditional last-wins replacement.
   */
  attach(
    scope: RunnerScope,
    socket: RunnerControlSocket,
    options: { liveWindowMs?: number } = {},
  ): RunnerAttachOutcome {
    const existing = this.#entries.get(scope.sandboxId);
    let outcome: RunnerAttachOutcome = "attached";
    if (existing) {
      const sameScope = this.#sameScope(existing.scope, scope);
      if (sameScope && options.liveWindowMs !== undefined && this.#now() - existing.lastSeenAt < options.liveWindowMs) {
        return "duplicate";
      }
      outcome = "replaced";
      this.#rejectAllPending(existing, new RunnerAcceptanceUnavailableError("The Runner connection was replaced"));
      if (sameScope) {
        existing.socket.close(RUNNER_WS_CLOSE.replaced, "replaced by a reconnect of the same Runner");
      } else {
        existing.socket.close(RUNNER_WS_CLOSE.staleScope, "superseded by a new environment generation");
      }
    }
    this.#entries.set(scope.sandboxId, {
      scope,
      socket,
      readiness: null,
      lastSeenAt: this.#now(),
      pending: new Map(),
      activeAcceptanceId: null,
      pendingSeal: null,
    });
    return outcome;
  }

  /** Detach only if this exact socket is still the current connection. */
  detach(sandboxId: string, socket: RunnerControlSocket): void {
    const entry = this.#entries.get(sandboxId);
    if (!entry || entry.socket !== socket) return;
    this.#rejectAllPending(entry, new RunnerAcceptanceUnavailableError("The Runner disconnected"));
    this.#entries.delete(sandboxId);
  }

  /**
   * Runner readiness belongs to the current scope AND the current socket. A superseded connection
   * of the same scope must never mark its replacement ready.
   */
  markReady(scope: RunnerScope, readiness: RunnerReadiness, socket: RunnerControlSocket): boolean {
    const entry = this.#entries.get(scope.sandboxId);
    if (!entry || entry.socket !== socket || !this.#sameScope(entry.scope, scope)) return false;
    entry.readiness = readiness;
    entry.lastSeenAt = this.#now();
    return true;
  }

  noteActivity(sandboxId: string, socket: RunnerControlSocket): boolean {
    const entry = this.#entries.get(sandboxId);
    if (!entry || entry.socket !== socket) return false;
    entry.lastSeenAt = this.#now();
    return true;
  }

  /**
   * Acknowledge an inbound heartbeat from the current connection: refresh liveness and answer with
   * a server heartbeat so the Runner's silence timer never expires on a healthy idle channel.
   * Returns false (and leaves the entry untouched) for a superseded socket.
   */
  acknowledge(sandboxId: string, socket: RunnerControlSocket, frame: RunnerServerFrame): boolean {
    const entry = this.#entries.get(sandboxId);
    if (!entry || entry.socket !== socket) return false;
    entry.lastSeenAt = this.#now();
    try {
      entry.socket.send(frame);
    } catch {
      this.#fail(entry, new RunnerAcceptanceUnavailableError("The Runner control channel is not writable"));
    }
    return true;
  }

  /**
   * Send a bounded acceptance command to the ready Runner and await its correlated result. The
   * caller's abort signal (HTTP disconnect or explicit stop) cancels the run on the Runner. One
   * active acceptance per Sandbox; a concurrent request fails immediately instead of queueing
   * behind a run that may hold the sandbox for many minutes.
   */
  async runAcceptance(
    sandboxId: string,
    command: Omit<RunnerAcceptanceRunFrame, "type" | "requestId">,
    options: { timeoutMs: number; signal?: AbortSignal; socket?: RunnerControlSocket },
  ): Promise<RunnerAcceptanceResultFrame> {
    const entry = this.#entries.get(sandboxId);
    if (!entry) throw new RunnerAcceptanceUnavailableError("No Runner is connected for this Sandbox");
    if (options.socket && entry.socket !== options.socket) {
      throw new RunnerAcceptanceUnavailableError("The Runner connection was replaced");
    }
    if (!entry.readiness) throw new RunnerAcceptanceUnavailableError("The Runner has not reported native readiness");
    if (entry.activeAcceptanceId !== null) {
      throw new RunnerAcceptanceUnavailableError("Another acceptance run is already active for this Sandbox");
    }
    if (options.signal?.aborted) {
      throw new RunnerAcceptanceUnavailableError("The acceptance request was already cancelled");
    }
    const requestId = randomUUID();
    const frame: RunnerAcceptanceRunFrame = { type: "acceptance:run", requestId, ...command };
    return new Promise<RunnerAcceptanceResultFrame>((resolve, reject) => {
      let settled = false;
      let frameSent = false;
      const finish = (error?: Error, result?: RunnerAcceptanceResultFrame) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        entry.pending.delete(requestId);
        if (entry.activeAcceptanceId === requestId) entry.activeAcceptanceId = null;
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const cancel = () => {
        if (!frameSent) return;
        try {
          entry.socket.send({ type: "acceptance:cancel", requestId });
        } catch {
          // The socket close path rejects the pending work; cancellation is best-effort on a dead
          // channel and must not mask the original outcome.
        }
      };
      const onAbort = () => {
        cancel();
        finish(new RunnerAcceptanceUnavailableError("The acceptance request was cancelled"));
      };
      const timer = setTimeout(() => {
        cancel();
        finish(new RunnerAcceptanceUnavailableError("The acceptance run exceeded its deadline"));
      }, options.timeoutMs);
      timer.unref?.();
      entry.pending.set(requestId, {
        requestId,
        resolve: (frame) => finish(undefined, frame),
        reject: (error) => finish(error),
        timer,
      });
      entry.activeAcceptanceId = requestId;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      // The signal may have aborted between the guard above and the listener registration; an
      // aborted request must never emit a run frame, and cancel is a no-op because nothing was
      // sent.
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      try {
        entry.socket.send(frame);
        frameSent = true;
      } catch {
        finish(new RunnerAcceptanceUnavailableError("The Runner control channel is not writable"));
      }
    });
  }

  /** Route an inbound acceptance result to its waiter; only the current socket may resolve it. */
  resolveAcceptanceResult(sandboxId: string, frame: RunnerAcceptanceResultFrame, socket: RunnerControlSocket): boolean {
    const entry = this.#entries.get(sandboxId);
    if (!entry || entry.socket !== socket) return false;
    const pending = entry.pending.get(frame.requestId);
    if (!pending) return false;
    entry.lastSeenAt = this.#now();
    pending.resolve(frame);
    return true;
  }

  /**
   * Ask the CURRENT connection to quiesce its writers and save the sealed workspace archive, and
   * await the correlated result. No readiness requirement: the release path seals through the
   * report-capable channel even after the environment left `ready`. The wait lives in the
   * caller (the account stop path), never in the per-connection frame chain, so heartbeats and
   * other frames keep flowing while a seal is outstanding. The request is pinned to the exact
   * current socket; a replacement, detach, or deadline rejects every waiter.
   */
  async requestWorkspaceSeal(
    sandboxId: string,
    options: { timeoutMs: number; socket?: RunnerControlSocket },
  ): Promise<RunnerWorkspaceSealResultFrame> {
    const entry = this.#entries.get(sandboxId);
    if (!entry) throw new RunnerWorkspaceSealUnavailableError("No Runner is connected for this Sandbox");
    if (options.socket && entry.socket !== options.socket) {
      throw new RunnerWorkspaceSealUnavailableError("The Runner connection was replaced");
    }
    if (entry.pendingSeal) return entry.pendingSeal.promise;
    const requestId = randomUUID();
    const frame: RunnerWorkspaceSealFrame = { type: "workspace:seal", requestId };
    let resolvePromise!: (frame: RunnerWorkspaceSealResultFrame) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<RunnerWorkspaceSealResultFrame>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    let settled = false;
    const finish = (error?: Error, result?: RunnerWorkspaceSealResultFrame) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (entry.pendingSeal?.requestId === requestId) entry.pendingSeal = null;
      if (error) rejectPromise(error);
      else if (result) resolvePromise(result);
    };
    const timer = setTimeout(() => {
      finish(new RunnerWorkspaceSealUnavailableError("The workspace seal exceeded its deadline"));
    }, options.timeoutMs);
    timer.unref?.();
    entry.pendingSeal = {
      requestId,
      promise,
      resolve: (result) => finish(undefined, result),
      reject: (error) => finish(error),
      timer,
    };
    try {
      entry.socket.send(frame);
    } catch {
      finish(new RunnerWorkspaceSealUnavailableError("The Runner control channel is not writable"));
    }
    return promise;
  }

  /**
   * Route an inbound seal result to its waiter. Only the exact current socket AND the exact
   * pending requestId may settle it — a stale socket or a fabricated/unknown id changes nothing.
   */
  settleWorkspaceSeal(sandboxId: string, frame: RunnerWorkspaceSealResultFrame, socket: RunnerControlSocket): boolean {
    const entry = this.#entries.get(sandboxId);
    if (!entry || entry.socket !== socket) return false;
    const pending = entry.pendingSeal;
    if (!pending || pending.requestId !== frame.requestId) return false;
    entry.lastSeenAt = this.#now();
    pending.resolve(frame);
    return true;
  }

  /** Terminate the current connection only if it belongs to exactly this (superseded) scope. */
  closeScope(scope: RunnerScope): void {
    const entry = this.#entries.get(scope.sandboxId);
    if (!entry || !this.#sameScope(entry.scope, scope)) return;
    this.#rejectAllPending(entry, new RunnerAcceptanceUnavailableError("The Sandbox environment was released"));
    entry.socket.close(RUNNER_WS_CLOSE.staleScope, "environment released");
    this.#entries.delete(scope.sandboxId);
  }

  /**
   * Send a frame to exactly one current connection (e.g. a refreshed credential). Never reaches a
   * superseded socket; a failed write is a dead connection, not something to swallow.
   */
  sendToCurrent(sandboxId: string, socket: RunnerControlSocket, frame: RunnerServerFrame): boolean {
    const entry = this.#entries.get(sandboxId);
    if (!entry || entry.socket !== socket) return false;
    try {
      entry.socket.send(frame);
      return true;
    } catch {
      this.#fail(entry, new RunnerAcceptanceUnavailableError("The Runner control channel is not writable"));
      return false;
    }
  }

  /** Cadenced server heartbeats to every current connection; dead sockets are failed closed. */
  heartbeatAll(frame: RunnerServerFrame): number {
    let sent = 0;
    for (const entry of [...this.#entries.values()]) {
      try {
        entry.socket.send(frame);
        sent += 1;
      } catch {
        this.#fail(entry, new RunnerAcceptanceUnavailableError("The Runner control channel is not writable"));
      }
    }
    return sent;
  }

  /** Terminate connections silent for longer than the cutoff; returns closed sockets count. */
  sweepStale(cutoffEpochMs: number): number {
    let closed = 0;
    for (const entry of [...this.#entries.values()]) {
      if (entry.lastSeenAt >= cutoffEpochMs) continue;
      this.#fail(entry, new RunnerAcceptanceUnavailableError("The Runner connection timed out"));
      closed += 1;
    }
    return closed;
  }

  closeAll(): void {
    for (const entry of [...this.#entries.values()]) {
      this.#fail(entry, new RunnerAcceptanceUnavailableError("The Server is shutting down"));
    }
  }

  #fail(entry: HubEntry, error: Error): void {
    this.#rejectAllPending(entry, error);
    try {
      entry.socket.close(RUNNER_WS_CLOSE.protocolError, "control channel failed");
    } catch {
      // The socket may already be closed; detach is idempotent.
    }
    if (this.#entries.get(entry.scope.sandboxId) === entry) this.#entries.delete(entry.scope.sandboxId);
  }

  #rejectAllPending(entry: HubEntry, error: Error): void {
    for (const pending of entry.pending.values()) pending.reject(error);
    entry.pending.clear();
    entry.activeAcceptanceId = null;
    entry.pendingSeal?.reject(error);
  }

  #sameScope(left: RunnerScope, right: RunnerScope): boolean {
    return (
      left.sandboxId === right.sandboxId &&
      left.sessionId === right.sessionId &&
      left.environmentGeneration === right.environmentGeneration &&
      left.resourceName === right.resourceName
    );
  }
}
