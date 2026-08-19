import { randomUUID } from "node:crypto";
import {
  computeTurnResultHash,
  type TurnReportHashInput,
  type TurnReportRequest,
  TurnReportRequestSchema,
  type TurnReportResult,
  TurnReportResultSchema,
} from "@opentag/shared";
import type { RuntimeConnection, RuntimeConnectionState } from "./runtime-connection.js";

export interface TurnReportOwnerOptions {
  connection: Pick<RuntimeConnection, "send" | "state" | "subscribeState">;
  id?: () => string;
  maxPending?: number;
  retryDelayMs?: number;
}

export type TurnReportTerminalStatus = "conflict" | "stale_generation";

export interface TurnReportSubmitOptions {
  onTerminal?(status: TurnReportTerminalStatus): void;
}

export type TurnReportRearmClaim = Pick<
  TurnReportRequest,
  "agentId" | "deliveryId" | "placementGeneration" | "resultHash" | "sessionId" | "turnId"
>;

interface PendingReport {
  confirm(): Promise<void> | void;
  confirming: boolean;
  promise: Promise<void>;
  report: TurnReportRequest;
  resolve(): void;
  reject(error: Error): void;
  resendRequested: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  sending: boolean;
  serverStatus?: TurnReportTerminalStatus;
  terminalListeners: Set<NonNullable<TurnReportSubmitOptions["onTerminal"]>>;
}

export class TurnReportOwnerStoppedError extends Error {
  constructor() {
    super("The Turn Report owner is stopped");
    this.name = "TurnReportOwnerStoppedError";
  }
}

export class TurnReportOwner {
  readonly #connection: TurnReportOwnerOptions["connection"];
  readonly #id: () => string;
  readonly #maxPending: number;
  readonly #retryDelayMs: number;
  readonly #pending = new Map<string, PendingReport>();
  readonly #unsubscribe: () => void;
  #stopped = false;

  constructor(options: TurnReportOwnerOptions) {
    this.#connection = options.connection;
    this.#id = options.id ?? randomUUID;
    this.#maxPending = options.maxPending ?? 99;
    this.#retryDelayMs = options.retryDelayMs ?? 5_000;
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1) {
      throw new Error("Turn Report pending limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 1) {
      throw new Error("Turn Report retry delay must be a positive safe integer");
    }
    this.#unsubscribe = this.#connection.subscribeState((state) => this.#onConnectionState(state));
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  create(input: TurnReportHashInput): TurnReportRequest {
    const report = {
      type: "turn:report" as const,
      requestId: this.#id(),
      ...input,
      resultHash: computeTurnResultHash(input),
    };
    return TurnReportRequestSchema.parse(report);
  }

  submit(
    reportInput: TurnReportRequest,
    confirm: () => Promise<void> | void,
    options: TurnReportSubmitOptions = {},
  ): Promise<void> {
    if (this.#stopped) return Promise.reject(new TurnReportOwnerStoppedError());
    const report = TurnReportRequestSchema.parse(reportInput);
    const existing = this.#pending.get(report.turnId);
    if (existing) {
      if (existing.report.requestId !== report.requestId || existing.report.resultHash !== report.resultHash) {
        return Promise.reject(new Error("A different Turn Report already owns this Turn"));
      }
      if (options.onTerminal) {
        if (existing.serverStatus) this.#notifyTerminal(options.onTerminal, existing.serverStatus);
        else existing.terminalListeners.add(options.onTerminal);
      }
      if (this.#connection.state === "registered" && !existing.serverStatus) {
        if (existing.sending) existing.resendRequested = true;
        else this.#send(existing);
      }
      return existing.promise;
    }
    if (this.#pending.size >= this.#maxPending) {
      return Promise.reject(new Error("The Turn Report owner reached its pending limit"));
    }
    let resolvePromise: (() => void) | undefined;
    let rejectPromise: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingReport = {
      report,
      confirm,
      confirming: false,
      sending: false,
      resendRequested: false,
      promise,
      resolve: () => resolvePromise?.(),
      reject: (error) => rejectPromise?.(error),
      terminalListeners: new Set(options.onTerminal ? [options.onTerminal] : []),
    };
    this.#pending.set(report.turnId, pending);
    if (this.#connection.state === "registered") this.#send(pending);
    return promise;
  }

  async handleResult(input: TurnReportResult): Promise<boolean> {
    const result = TurnReportResultSchema.parse(input);
    const pending = this.#pending.get(result.turnId);
    if (!pending) return false;
    if (result.requestId !== pending.report.requestId || result.resultHash !== pending.report.resultHash) return false;
    if (result.status === "conflict" || result.status === "stale_generation") {
      pending.serverStatus = result.status;
      this.#clearRetry(pending);
      const listeners = [...pending.terminalListeners];
      pending.terminalListeners.clear();
      for (const listener of listeners) this.#notifyTerminal(listener, result.status);
      return true;
    }
    if (pending.confirming) return true;
    pending.confirming = true;
    try {
      await pending.confirm();
      if (this.#pending.get(result.turnId) !== pending) return true;
      this.#pending.delete(result.turnId);
      this.#clearRetry(pending);
      pending.resolve();
    } catch {
      pending.confirming = false;
      this.#scheduleRetry(pending);
    }
    return true;
  }

  get(turnId: string): { report: TurnReportRequest; serverStatus?: TurnReportTerminalStatus } | undefined {
    const pending = this.#pending.get(turnId);
    if (!pending) return undefined;
    return {
      report: pending.report,
      ...(pending.serverStatus ? { serverStatus: pending.serverStatus } : {}),
    };
  }

  // MVP-only: only an exact durable Report advertised by a later reconciliation
  // may retry a terminal response from an uncertain manifest handoff.
  rearmTerminal(claim: TurnReportRearmClaim): boolean {
    if (this.#stopped) return false;
    const pending = this.#pending.get(claim.turnId);
    if (!pending?.serverStatus || !reportMatchesRearmClaim(pending.report, claim)) return false;
    pending.serverStatus = undefined;
    return true;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribe();
    const error = new TurnReportOwnerStoppedError();
    for (const pending of this.#pending.values()) {
      this.#clearRetry(pending);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #onConnectionState(state: RuntimeConnectionState): void {
    if (state !== "registered" || this.#stopped) return;
    for (const pending of this.#pending.values()) {
      this.#clearRetry(pending);
      if (pending.sending) pending.resendRequested = true;
      else this.#send(pending);
    }
  }

  #send(pending: PendingReport): void {
    if (pending.sending || this.#stopped || pending.serverStatus) return;
    this.#clearRetry(pending);
    pending.sending = true;
    void this.#connection
      .send(pending.report, { priority: "report" })
      .catch(() => undefined)
      .finally(() => {
        pending.sending = false;
        if (
          pending.resendRequested &&
          this.#pending.get(pending.report.turnId) === pending &&
          this.#connection.state === "registered"
        ) {
          pending.resendRequested = false;
          this.#send(pending);
        } else if (this.#pending.get(pending.report.turnId) === pending) {
          this.#scheduleRetry(pending);
        }
      });
  }

  #scheduleRetry(pending: PendingReport): void {
    if (
      pending.retryTimer ||
      this.#stopped ||
      pending.serverStatus ||
      this.#pending.get(pending.report.turnId) !== pending
    ) {
      return;
    }
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = undefined;
      if (this.#connection.state === "registered") this.#send(pending);
    }, this.#retryDelayMs);
    pending.retryTimer.unref();
  }

  #clearRetry(pending: PendingReport): void {
    if (!pending.retryTimer) return;
    clearTimeout(pending.retryTimer);
    pending.retryTimer = undefined;
  }

  #notifyTerminal(
    listener: NonNullable<TurnReportSubmitOptions["onTerminal"]>,
    status: TurnReportTerminalStatus,
  ): void {
    try {
      listener(status);
    } catch {
      // A terminal observer cannot alter the durable Report fence.
    }
  }
}

function reportMatchesRearmClaim(report: TurnReportRequest, claim: TurnReportRearmClaim): boolean {
  return (
    report.agentId === claim.agentId &&
    report.deliveryId === claim.deliveryId &&
    report.placementGeneration === claim.placementGeneration &&
    report.resultHash === claim.resultHash &&
    report.sessionId === claim.sessionId &&
    report.turnId === claim.turnId
  );
}
