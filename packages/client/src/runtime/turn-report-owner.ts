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
import {
  DEFAULT_RUNTIME_RETRY_POLICY,
  type DurableFailure,
  type DurableWorkRecord,
  defaultRuntimeRetryScheduler,
  RuntimeDurabilityFailure,
  type RuntimeDurabilityMetrics,
  type RuntimeDurabilityStore,
  type RuntimeRetryPolicy,
  type RuntimeRetryScheduler,
  retryDelay,
  retryExhausted,
} from "./runtime-durability.js";

export interface TurnReportOwnerOptions {
  connection: Pick<RuntimeConnection, "send" | "state" | "subscribeState">;
  id?: () => string;
  maxPending?: number;
  readonly metrics?: RuntimeDurabilityMetrics;
  readonly now?: () => number;
  readonly onFailure?: (failure: DurableFailure) => void;
  readonly persistence?: RuntimeDurabilityStore;
  readonly retryPolicy?: Partial<RuntimeRetryPolicy>;
  retryDelayMs?: number;
  readonly scheduler?: RuntimeRetryScheduler;
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
  readonly confirm?: () => Promise<void> | void;
  confirming: boolean;
  promise: Promise<void>;
  report: TurnReportRequest;
  resolve(): void;
  reject(error: Error): void;
  resendRequested: boolean;
  sending: boolean;
  serverStatus?: TurnReportTerminalStatus;
  terminalListeners: Set<NonNullable<TurnReportSubmitOptions["onTerminal"]>>;
  readonly record: DurableWorkRecord<TurnReportRequest>;
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
  readonly #metrics?: RuntimeDurabilityMetrics;
  readonly #now: () => number;
  readonly #onFailure?: TurnReportOwnerOptions["onFailure"];
  readonly #persistence?: RuntimeDurabilityStore;
  readonly #retryPolicy: RuntimeRetryPolicy;
  readonly #scheduler: RuntimeRetryScheduler;
  readonly #pending = new Map<string, PendingReport>();
  readonly #records = new Map<string, DurableWorkRecord<TurnReportRequest>>();
  readonly #retryTimers = new Map<string, { cancel(): void }>();
  readonly #unsubscribe: () => void;
  readonly #readyPromise: Promise<void>;
  #stopped = false;

  constructor(options: TurnReportOwnerOptions) {
    this.#connection = options.connection;
    this.#id = options.id ?? randomUUID;
    this.#maxPending = options.maxPending ?? 99;
    this.#retryDelayMs = options.retryDelayMs ?? 5_000;
    this.#metrics = options.metrics;
    this.#now = options.now ?? Date.now;
    this.#onFailure = options.onFailure;
    this.#persistence = options.persistence;
    this.#retryPolicy = normalizeRetryPolicy({
      ...options.retryPolicy,
      ...(options.retryDelayMs ? { baseDelayMs: options.retryDelayMs } : {}),
    });
    this.#scheduler = options.scheduler ?? defaultRuntimeRetryScheduler;
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1) {
      throw new Error("Turn Report pending limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 1) {
      throw new Error("Turn Report retry delay must be a positive safe integer");
    }
    this.#readyPromise = this.#hydrate();
    this.#unsubscribe = this.#connection.subscribeState((state) => this.#onConnectionState(state));
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  ready(): Promise<void> {
    return this.#readyPromise;
  }

  getState(turnId: string): DurableWorkRecord<TurnReportRequest> | undefined {
    return this.#records.get(turnId);
  }

  metricsSnapshot(): ReturnType<RuntimeDurabilityMetrics["snapshot"]> | undefined {
    return this.#metrics?.snapshot();
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
      return this.#reusePending(existing, report, confirm, options);
    }
    const stored = this.#records.get(report.turnId);
    if (stored?.status === "succeeded") return Promise.resolve();
    if (this.#pending.size >= this.#maxPending) {
      return Promise.reject(new Error("The Turn Report owner reached its pending limit"));
    }
    return this.#createPending(report, confirm, options, stored);
  }

  #reusePending(
    existing: PendingReport,
    report: TurnReportRequest,
    confirm: () => Promise<void> | void,
    options: TurnReportSubmitOptions,
  ): Promise<void> {
    if (existing.report.requestId !== report.requestId || existing.report.resultHash !== report.resultHash) {
      return Promise.reject(new Error("A different Turn Report already owns this Turn"));
    }
    if (options.onTerminal) {
      if (existing.serverStatus) this.#notifyTerminal(options.onTerminal, existing.serverStatus);
      else existing.terminalListeners.add(options.onTerminal);
    }
    existing.confirm = confirm;
    if (this.#connection.state === "registered" && !existing.serverStatus) {
      if (existing.sending) existing.resendRequested = true;
      else this.#send(existing);
    }
    return existing.promise;
  }

  #createPending(
    report: TurnReportRequest,
    confirm: () => Promise<void> | void,
    options: TurnReportSubmitOptions,
    stored?: DurableWorkRecord<TurnReportRequest>,
  ): Promise<void> {
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
      record: stored ?? {
        acceptedAt: this.#now(),
        attempts: 0,
        key: report.turnId,
        kind: "turn-report",
        payload: report,
        status: "accepted",
        updatedAt: this.#now(),
      },
    };
    this.#pending.set(report.turnId, pending);
    void this.#persist(pending.record)
      .then(() => {
        if (this.#connection.state === "registered") this.#send(pending);
      })
      .catch((error) => this.#handleFailure(pending, "persist", error));
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
      const failure: DurableFailure = {
        category: "server",
        code: result.status,
        message: `Server rejected the Turn Report: ${result.status}`,
        phase: "confirmation",
        requestId: pending.report.requestId,
        retryability: "terminal",
      };
      this.#emitFailure(failure);
      await this.#transition(pending, "failed", {
        lastError: failure,
      });
      const listeners = [...pending.terminalListeners];
      pending.terminalListeners.clear();
      for (const listener of listeners) this.#notifyTerminal(listener, result.status);
      return true;
    }
    if (pending.confirming || !pending.confirm) return true;
    pending.confirming = true;
    try {
      await pending.confirm();
      if (this.#pending.get(result.turnId) !== pending) return true;
      this.#pending.delete(result.turnId);
      this.#clearRetry(pending);
      await this.#transition(pending, "succeeded", { nextAttemptAt: undefined });
      pending.resolve();
    } catch (error) {
      pending.confirming = false;
      await this.#handleFailure(pending, "confirmation", error);
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
    for (const timer of this.#retryTimers.values()) timer.cancel();
    this.#retryTimers.clear();
    const error = new TurnReportOwnerStoppedError();
    for (const pending of this.#pending.values()) {
      this.#clearRetry(pending);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #onConnectionState(state: RuntimeConnectionState): void {
    if (state !== "registered" || this.#stopped) return;
    void this.#readyPromise.then(() => {
      for (const pending of this.#pending.values()) {
        this.#clearRetry(pending);
        if (pending.sending) pending.resendRequested = true;
        else this.#send(pending);
      }
    });
  }

  #send(pending: PendingReport): void {
    if (pending.sending || this.#stopped || pending.serverStatus) return;
    this.#clearRetry(pending);
    pending.sending = true;
    void this.#transition(pending, "running")
      .then(() => this.#connection.send(pending.report, { priority: "report" }))
      .catch((error) => this.#handleFailure(pending, "transport", error))
      .finally(() => {
        pending.sending = false;
        if (
          pending.resendRequested &&
          this.#pending.get(pending.report.turnId) === pending &&
          this.#connection.state === "registered"
        ) {
          pending.resendRequested = false;
          this.#send(pending);
        } else if (this.#pending.get(pending.report.turnId) === pending && !pending.serverStatus) {
          const record = this.#records.get(pending.report.turnId);
          if (record) this.#scheduleRetry(pending, record);
        }
      });
  }

  #scheduleRetry(pending: PendingReport, record: DurableWorkRecord<TurnReportRequest>): void {
    if (this.#retryTimers.has(record.key) || this.#stopped || pending.serverStatus) return;
    const delay = Math.max(0, (record.nextAttemptAt ?? this.#now()) - this.#now());
    const timer = this.#scheduler.schedule(delay, () => {
      this.#retryTimers.delete(record.key);
      if (this.#connection.state !== "registered") return;
      const current = this.#records.get(record.key);
      if (!current || current.status === "succeeded" || pending.serverStatus) return;
      if (current.status === "retryable") {
        void this.#transition(pending, "accepted")
          .then(() => this.#send(pending))
          .catch(() => undefined);
      } else {
        void this.#handleFailure(pending, "transport", new Error("Turn Report acknowledgement timed out"));
      }
    });
    this.#retryTimers.set(record.key, timer);
  }

  #clearRetry(pending: PendingReport): void {
    const timer = this.#retryTimers.get(pending.report.turnId);
    if (!timer) return;
    timer.cancel();
    this.#retryTimers.delete(pending.report.turnId);
  }

  async #hydrate(): Promise<void> {
    if (!this.#persistence) return;
    const records = await this.#persistence.list<TurnReportRequest>("turn-report");
    for (const stored of records) {
      const parsed = TurnReportRequestSchema.safeParse(stored.payload);
      if (!parsed.success) continue;
      let record = { ...stored, payload: parsed.data } as DurableWorkRecord<TurnReportRequest>;
      this.#records.set(record.key, record);
      if (record.status === "succeeded" || record.status === "dead-letter") continue;
      if (
        record.status === "failed" &&
        (record.lastError?.code === "conflict" || record.lastError?.code === "stale_generation")
      ) {
        this.#addHydratedPending(record, record.lastError.code);
        continue;
      }
      if (retryExhausted(this.#retryPolicy, record, this.#now())) {
        record = { ...record, status: "dead-letter", nextAttemptAt: undefined, updatedAt: this.#now() };
        await this.#persist(record);
        continue;
      }
      if (record.status === "running") {
        record = { ...record, status: "retryable", nextAttemptAt: this.#now(), updatedAt: this.#now() };
        await this.#persist(record);
      }
      this.#addHydratedPending(record);
    }
  }

  #addHydratedPending(record: DurableWorkRecord<TurnReportRequest>, serverStatus?: TurnReportTerminalStatus): void {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.#pending.set(record.key, {
      report: record.payload,
      confirm: undefined,
      confirming: false,
      sending: false,
      resendRequested: false,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      record,
      ...(serverStatus ? { serverStatus } : {}),
      terminalListeners: new Set(),
    });
  }

  async #transition(
    pending: PendingReport,
    status: DurableWorkRecord<TurnReportRequest>["status"],
    fields: Partial<DurableWorkRecord<TurnReportRequest>> = {},
  ): Promise<DurableWorkRecord<TurnReportRequest>> {
    const record = this.#records.get(pending.report.turnId) ?? pending.record;
    const next = { ...record, ...fields, status, updatedAt: this.#now(), payload: pending.report };
    pending.record = next;
    this.#records.set(next.key, next);
    this.#metrics?.transition("turn-report", record.status, status);
    await this.#persist(next);
    return next;
  }

  async #handleFailure(pending: PendingReport, phase: string, error: unknown): Promise<void> {
    if (this.#stopped || pending.serverStatus) return;
    const record = this.#records.get(pending.report.turnId) ?? pending.record;
    const failure = toFailure(pending.report.requestId, phase, error);
    this.#emitFailure(failure);
    const attempts = record.attempts + 1;
    const now = this.#now();
    const candidate = { ...record, attempts, lastError: failure, updatedAt: now };
    if (failure.retryability === "terminal" || retryExhausted(this.#retryPolicy, candidate, now)) {
      await this.#transition(pending, "dead-letter", { ...candidate, nextAttemptAt: undefined }).catch(() => undefined);
      pending.reject(new RuntimeDurabilityFailure(failure));
      this.#pending.delete(pending.report.turnId);
      return;
    }
    let retryable: DurableWorkRecord<TurnReportRequest>;
    try {
      retryable = await this.#transition(pending, "retryable", {
        ...candidate,
        nextAttemptAt: now + retryDelay(this.#retryPolicy, attempts),
      });
    } catch {
      return;
    }
    this.#scheduleRetry(pending, retryable);
  }

  async #persist(record: DurableWorkRecord<TurnReportRequest>): Promise<void> {
    this.#records.set(record.key, record);
    await this.#persistence?.write(record);
  }

  #emitFailure(failure: DurableFailure): void {
    try {
      this.#onFailure?.(failure);
    } catch {
      // Observers cannot alter the durable Report state machine.
    }
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

function normalizeRetryPolicy(overrides: Partial<RuntimeRetryPolicy>): RuntimeRetryPolicy {
  const policy = { ...DEFAULT_RUNTIME_RETRY_POLICY, ...overrides };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Runtime retry ${name} must be a positive safe integer`);
  }
  return policy;
}

function toFailure(requestId: string, phase: string, error: unknown): DurableFailure {
  if (error && typeof error === "object" && "code" in error && "category" in error && "retryability" in error) {
    const candidate = error as Partial<DurableFailure>;
    if (
      typeof candidate.code === "string" &&
      typeof candidate.category === "string" &&
      typeof candidate.retryability === "string" &&
      typeof candidate.phase === "string" &&
      typeof candidate.requestId === "string"
    ) {
      return {
        code: candidate.code,
        category: candidate.category,
        retryability: candidate.retryability as DurableFailure["retryability"],
        phase: candidate.phase,
        requestId: candidate.requestId,
        message: typeof candidate.message === "string" ? candidate.message.slice(0, 256) : "Runtime operation failed",
      };
    }
  }
  return {
    code:
      phase === "confirmation"
        ? "confirmation_failed"
        : phase === "transport"
          ? "transport_unavailable"
          : "runtime_failed",
    category: phase,
    retryability: "retryable",
    phase,
    requestId,
    message: error instanceof Error ? error.message.slice(0, 256) : "Runtime operation failed",
  };
}
