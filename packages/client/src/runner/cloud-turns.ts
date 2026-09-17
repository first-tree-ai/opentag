import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
  type RunnerClientFrame,
  type RunnerCloudDeliveryQueryFrame,
  type RunnerCloudDeliveryReportAckFrame,
  type RunnerCloudDeliveryRunFrame,
  type RunnerCloudDeliveryVerifiedFrame,
  type RunnerCloudModelGrant,
  RuntimeUsageSchema,
  serializeRunnerCloudTurnWorkerStdin,
  TurnFailureReasonSchema,
  type TurnReportRequest,
  TurnReportRequestSchema,
} from "@opentag/shared";
import { z } from "zod";
import {
  closeBridgeSockets,
  createBridgeSocketResources,
  publishExecutionMaterial,
} from "../cloud-runtime/bridge-material.js";
import { CLOUD_EXECUTION_MOUNT } from "../cloud-runtime/sandbox-entry.js";
import type { TurnCompletion } from "../runtime/agent-turn-runner.js";
import { turnTimeoutMs } from "../runtime/agent-turn-runner.js";
import { RuntimeCredentialRelay, type RuntimeCredentialRelayOptions } from "../runtime/runtime-credential-relay.js";
import { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";
import { type CloudCredentialChannel, CloudCredentialConnection } from "./cloud-credential-connection.js";
import {
  assertCloudJournalScope,
  type CloudJournal,
  type CloudJournalEntry,
  CloudJournalError,
  type CloudJournalScope,
  computeCloudDeliveryInputHash,
} from "./cloud-journal.js";
import { type NativeSandbox, SANDBOX_NODE, SANDBOX_WORKER_ENTRY } from "./native-sandbox.js";

/**
 * Trusted-parent Cloud Turn lifecycle (E4). Owns the durable journal boundary for every delivery
 * the Server dispatches to this Runner's Sandbox: journal+fsync BEFORE the receipt frame, start
 * only after the Server's `delivery:verified` proves durable custody, fsync the report BEFORE the
 * report frame, and retransmit on reconnect until the Server's ack. Execution happens only in the
 * native Sandbox worker — never in this trusted parent process.
 *
 * Crash discipline: a `started` journal entry whose outcome is unknown after a crash is reported
 * exactly once as unknown/turn_state_unknown and NEVER re-executed; a `received` entry resumes
 * through a fresh verified grant; a `reported` entry re-sends until a matching durable ack.
 *
 * Concurrency discipline: every control-state mutation runs through one in-process serial queue
 * and `#startTurn` reserves `#active` synchronously BEFORE its first await, so a burst of
 * duplicate `delivery:verified` frames (or a reconcile racing a live turn) can never launch two
 * workers. The queue never covers the long-running worker itself, so heartbeat, credential
 * replies, and cancellation stay responsive.
 *
 * Reconnect discipline: losing the control channel does NOT abort a live execution and never
 * manufactures an `unknown` outcome. Only a full process restart (a reopened journal with no live
 * `#active` execution) reports `unknown`/`turn_state_unknown` from the durable boundary.
 */

export interface CloudTurnScope {
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly environmentGeneration: number;
  readonly resourceName: string;
  readonly resourceUid?: string | null;
}

export interface CloudTurnRunnerOptions {
  /** The current authenticated Runner scope; set at every welcome. */
  readonly scope: () => CloudTurnScope | undefined;
  /** Trusted Runner state root for per-turn PRIVATE material; never mounted into the Sandbox. */
  readonly stateDirectory: string;
  /**
   * Trusted root published read-only into the Sandbox at `CLOUD_EXECUTION_MOUNT`. Only the public
   * per-turn subtree ever becomes visible; private material never lives beneath this root.
   */
  readonly publicDirectory?: string;
  readonly journal: CloudJournal;
  readonly sandbox: Pick<NativeSandbox, "exec">;
  readonly serverUrl: string;
  readonly send: (frame: RunnerClientFrame) => void;
  /** The #633 tunnel over the current Runner connection. */
  readonly credentialChannel: () => CloudCredentialChannel;
  /** Allocation-stable in-sandbox directory for Pi conversation continuity. */
  readonly piSessionDirectory?: string;
  /**
   * Shared occupation boundary with the E3 acceptance run: while this returns false (e.g. the
   * single native sandbox is mid-acceptance/cleanup) verified turns wait in the Session queue
   * instead of racing a concurrent destroy/relaunch.
   */
  readonly canStart?: () => boolean;
  /**
   * Verified native namespace cleanup (E3 `delete --force` + relaunch + probe). It runs
   * IMMEDIATELY after any non-completed Cloud Turn while the Turn occupation stays reserved, so a
   * stopped Session cannot leave orphan native children and the terminal report is published only
   * after a verified clean namespace. A failure makes the runner unusable (no silent reuse).
   */
  readonly sandboxReset?: () => Promise<void>;
  readonly log?: (message: string) => void;
  /** Unexpected durable-boundary failures that must surface instead of being swallowed. */
  readonly onPersistenceError?: (error: unknown) => void;
  /** Test seam: replace the credential-execution bridge pipeline. */
  readonly openExecution?: (input: CloudTurnExecutionOpenInput) => Promise<CloudTurnExecutionHandle>;
  /** Test seam: replace the in-sandbox worker invocation. */
  readonly runWorker?: (
    input: { stdin: string; timeoutMs: number },
    signal: AbortSignal,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface CloudTurnExecutionOpenInput {
  readonly delivery: DirectImMessageDeliveryRequest;
  readonly scope: CloudTurnScope;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

export interface CloudTurnExecutionHandle {
  /** In-sandbox absolute path of the per-turn public material directory. */
  readonly executionDir: string;
  close(): Promise<void>;
}

interface ActiveTurn {
  readonly deliveryId: string;
  readonly abort: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  execution?: Promise<void>;
}

/** Worker stdout is captured bounded by the native sandbox; still refuse anything larger. */
const CLOUD_TURN_WORKER_STDOUT_MAX_BYTES = 256 * 1024;
/** Bounded Session queue: verified entries beyond this wait at `received` for re-verification. */
const CLOUD_TURN_MAX_QUEUED = 64;

/** Strict validation of the in-sandbox worker completion before it can become a durable report. */
const CloudTurnCompletionSchema = z
  .object({
    errorReason: TurnFailureReasonSchema.optional(),
    executionEffects: z.enum(["completed", "may_have_occurred", "not_started"]),
    finalText: z.string().optional(),
    outcome: z.enum(["completed", "failed", "cancelled", "unknown"]),
    usage: RuntimeUsageSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "completed" && value.errorReason) {
      context.addIssue({ code: "custom", path: ["errorReason"], message: "Completed results cannot include an error" });
    }
    if (value.outcome !== "completed" && !value.errorReason) {
      context.addIssue({ code: "custom", path: ["errorReason"], message: "Non-completed results require an error" });
    }
    if (value.finalText !== undefined && utf8Length(value.finalText) > RUNTIME_FINAL_TEXT_MAX_BYTES) {
      context.addIssue({ code: "custom", path: ["finalText"], message: "Final text exceeds the report bound" });
    }
  });

const UNKNOWN_COMPLETION: TurnCompletion = {
  errorReason: "turn_state_unknown",
  executionEffects: "may_have_occurred",
  outcome: "unknown",
};

export class CloudTurnRunner {
  readonly #options: CloudTurnRunnerOptions;
  readonly #cancelRequested = new Set<string>();
  /** Verified entries waiting for the single Session-serial turn slot, keyed by request id. */
  readonly #queue = new Map<
    string,
    { readonly frame: RunnerCloudDeliveryVerifiedFrame; readonly deliveryId: string }
  >();
  #active?: ActiveTurn;
  #closed = false;
  /**
   * Set for an interrupted Turn until its immediate verified cleanup succeeds. The next start
   * also checks it, so no delivery can ever observe a dirty namespace between turns.
   */
  #needsSandboxReset = false;
  /** Set when native cleanup itself failed: the runner never starts another Cloud Turn. */
  #sandboxUnusable = false;
  #resetInFlight?: Promise<void>;
  /** Serializes control-state mutations only; the worker itself runs outside the queue. */
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: CloudTurnRunnerOptions) {
    this.#options = options;
  }

  get activeDeliveryId(): string | undefined {
    return this.#active?.deliveryId;
  }

  /** True while a turn is running or verified work waits for the single turn slot. */
  get hasPendingWork(): boolean {
    return this.#active !== undefined || this.#queue.size > 0 || this.#needsSandboxReset || this.#sandboxUnusable;
  }

  /** True after a non-completed turn until the native namespace was verified clean again. */
  get needsSandboxReset(): boolean {
    return this.#needsSandboxReset;
  }

  /** The occupation boundary reopened (e.g. native acceptance cleanup finished). */
  notifyAvailable(): void {
    this.#scheduleDrain();
  }

  /* --------------------------------------------------------------------------------------------
   * Server -> Runner frame handlers
   * ------------------------------------------------------------------------------------------ */

  /** Journal + fsync the input, THEN acknowledge receipt. Idempotent across duplicate dispatch. */
  async handleDeliveryRun(frame: RunnerCloudDeliveryRunFrame): Promise<void> {
    await this.#enqueue(async () => {
      const delivery = frame.delivery;
      const scope = this.#options.scope();
      if (!scope || delivery.sessionId !== scope.sessionId) {
        this.#log("ignoring delivery:run outside the current Session scope");
        return;
      }
      const journalScope = this.#requireJournalScope();
      const existing = await this.#options.journal.read(delivery.deliveryId);
      let entry: CloudJournalEntry;
      if (existing) {
        // A journaled delivery may only be re-dispatched with the SAME dispatch identity and
        // content. Changed input under the same ids is a visible conflict, never a second turn.
        try {
          assertCloudJournalScope(existing, journalScope);
        } catch {
          this.#log(`refusing re-dispatch of ${delivery.deliveryId}: journaled under another allocation`);
          return;
        }
        if (
          existing.requestId !== delivery.requestId ||
          existing.inputHash !== computeCloudDeliveryInputHash(delivery)
        ) {
          this.#log(`refusing re-dispatch of ${delivery.deliveryId}: journaled dispatch identity or input differs`);
          return;
        }
        entry = existing;
      } else {
        entry = await this.#options.journal.recordReceived({
          delivery,
          scope: journalScope,
          deliveryId: delivery.deliveryId,
          requestId: delivery.requestId,
          turnId: randomUUID(),
        });
      }
      this.#send({
        type: "delivery:received",
        deliveryId: entry.deliveryId,
        requestId: entry.requestId,
        turnId: entry.turnId,
      });
    });
  }

  /** Server persisted durable custody: execution may start (the model grant rides along). */
  async handleVerified(frame: RunnerCloudDeliveryVerifiedFrame): Promise<void> {
    await this.#enqueue(async () => {
      const entry = await this.#entryByRequestId(frame.requestId);
      if (!entry) return; // Already retired or never received.
      if (frame.status === "rejected") {
        // The Server refused custody before any start. A started/reported entry is real durable
        // state that a late rejection must never erase.
        if (entry.phase === "received") await this.#options.journal.clearRejected(entry.deliveryId, entry.scope);
        else this.#log(`ignoring rejected receipt for ${entry.deliveryId} in phase ${entry.phase}`);
        return;
      }
      if (entry.phase !== "received") return;
      if (this.#cancelRequested.delete(entry.deliveryId)) {
        await this.#reportTerminal(entry, cancelledBeforeStart());
        return;
      }
      const denial = this.#admit(entry.delivery, frame);
      if (denial) {
        await this.#reportTerminal(entry, denial.completion);
        return;
      }
      if (this.#active) {
        if (this.#queue.size >= CLOUD_TURN_MAX_QUEUED) {
          this.#log(
            `cloud turn queue is full; leaving ${entry.deliveryId} at the received boundary for re-verification`,
          );
          return;
        }
        this.#queue.set(entry.requestId, { deliveryId: entry.deliveryId, frame: { ...frame, model: frame.model } });
        return;
      }
      await this.#startTurn(entry, { ...frame, model: frame.model });
    });
  }

  /**
   * Explicit stop. An owned in-sandbox worker is aborted immediately; a not-yet-started delivery
   * settles durably as a `not_started` cancellation instead of silently disappearing.
   */
  handleCancel(deliveryId: string): void {
    const active = this.#active;
    if (active?.deliveryId === deliveryId) {
      active.abort.abort();
      return;
    }
    for (const [requestId, queued] of this.#queue) {
      if (queued.deliveryId === deliveryId) this.#queue.delete(requestId);
    }
    this.#cancelRequested.add(deliveryId);
    void this.#enqueue(async () => {
      if (!this.#cancelRequested.delete(deliveryId)) return;
      const entry = await this.#options.journal.read(deliveryId);
      if (!entry) return;
      this.#assertCurrentScope(entry);
      if (entry.phase === "received") await this.#reportTerminal(entry, cancelledBeforeStart());
    }).catch((error) => this.#reportPersistenceError(error));
  }

  /** The Server durably recorded (or definitively refused) the report: retire the entry. */
  async handleReportAck(frame: RunnerCloudDeliveryReportAckFrame): Promise<void> {
    await this.#enqueue(async () => {
      const entries = await this.#options.journal.list();
      const entry = entries.find((candidate) => candidate.turnId === frame.turnId);
      if (!entry) return;
      this.#assertCurrentScope(entry);
      if (entry.phase !== "reported" || !entry.report) return;
      if (frame.status !== "recorded" && frame.status !== "already_recorded") {
        this.#log(`retaining durable report for ${entry.deliveryId}: ack status ${frame.status}`);
        return;
      }
      if (entry.report.resultHash !== frame.resultHash) {
        this.#log(`retaining durable report for ${entry.deliveryId}: ack result hash mismatch`);
        return;
      }
      await this.#options.journal.clearAcknowledged(entry.deliveryId, entry.scope, {
        resultHash: frame.resultHash,
        status: frame.status,
        turnId: frame.turnId,
      });
    });
  }

  /** Answer a Server recovery query from the durable journal; re-send a journaled report. */
  async handleQuery(frame: RunnerCloudDeliveryQueryFrame): Promise<void> {
    await this.#enqueue(async () => {
      const entry = await this.#options.journal.read(frame.deliveryId);
      if (entry) this.#assertCurrentScope(entry);
      const phase = !entry || entry.turnId !== frame.turnId ? "none" : entry.phase;
      this.#send({
        type: "delivery:query:result",
        deliveryId: frame.deliveryId,
        phase,
        requestId: frame.requestId,
        turnId: frame.turnId,
      });
      if (phase === "reported" && entry?.report) {
        this.#send({ type: "delivery:report", report: entry.report, requestId: randomUUID() });
      }
    });
  }

  /* --------------------------------------------------------------------------------------------
   * Reconnect reconciliation
   * ------------------------------------------------------------------------------------------ */

  /**
   * After every (re)attach: retransmit durable state. Received entries re-announce their receipt
   * (the Server re-verifies idempotently); reported entries re-send until acked; started entries
   * report unknown exactly once and never re-execute — EXCEPT while this process still owns the
   * live execution, in which case only the durable receipt is re-announced.
   *
   * Every entry is scope-checked BEFORE any frame is sent, so a journal reopened under another
   * allocation fails closed without emitting a single stale frame.
   */
  async reconcile(): Promise<void> {
    await this.#enqueue(async () => {
      const scope = this.#requireJournalScope();
      const entries = await this.#options.journal.list();
      for (const entry of entries) assertCloudJournalScope(entry, scope);
      for (const entry of entries) await this.#reconcileEntry(entry);
    });
  }

  async #reconcileEntry(entry: CloudJournalEntry): Promise<void> {
    if (entry.phase === "received") {
      this.#sendReceipt(entry);
      return;
    }
    if (entry.phase === "reported" && entry.report) {
      this.#send({ type: "delivery:report", report: entry.report, requestId: randomUUID() });
      return;
    }
    if (entry.phase !== "started") return;
    if (this.#active?.deliveryId === entry.deliveryId) {
      // A live execution in this process is never rewritten as unknown by a reconnect.
      this.#sendReceipt(entry);
      return;
    }
    await this.#reportTerminal(entry, UNKNOWN_COMPLETION);
  }

  #sendReceipt(entry: CloudJournalEntry): void {
    this.#send({
      type: "delivery:received",
      deliveryId: entry.deliveryId,
      requestId: entry.requestId,
      turnId: entry.turnId,
    });
  }

  /**
   * The control channel dropped. Durable journal state survives and a live in-sandbox execution
   * keeps running; the report stays journaled until the Server acknowledges it. A full process
   * restart is what makes the started entry unknown, not a transient reconnect.
   */
  onChannelClosed(): void {
    this.#log("cloud control channel closed; journaled state survives and live execution continues");
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#active?.abort.abort();
    await this.#active?.settled;
    await this.#serial.catch(() => undefined);
  }

  /* --------------------------------------------------------------------------------------------
   * Turn execution
   * ------------------------------------------------------------------------------------------ */

  /** Reserve the single turn slot synchronously, then fsync the started boundary, then run. */
  async #startTurn(entry: CloudJournalEntry, frame: RunnerCloudDeliveryVerifiedFrame): Promise<void> {
    if (this.#closed || this.#active) return;
    if (!(this.#options.canStart?.() ?? true)) {
      this.#queue.set(entry.requestId, { deliveryId: entry.deliveryId, frame });
      return;
    }
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: ActiveTurn = { abort: new AbortController(), deliveryId: entry.deliveryId, settle, settled };
    this.#active = active;
    try {
      if (this.#sandboxUnusable) {
        throw new CloudJournalError(
          "store_failed",
          "The native sandbox namespace could not be verified clean; the Runner must not start another Turn",
        );
      }
      if (this.#needsSandboxReset) await this.#resetSandboxNamespace();
      const current = await this.#options.journal.read(entry.deliveryId);
      if (current?.phase !== "received" || this.#closed) return;
      const started = await this.#options.journal.markStarted(current.deliveryId, current.scope);
      active.execution = this.#executeTurn(started, frame, active.abort.signal)
        .catch((error) => this.#reportPersistenceError(error))
        .finally(() => {
          this.#completeActive(active);
          this.#scheduleDrain();
        });
    } finally {
      if (!active.execution) {
        this.#completeActive(active);
        this.#scheduleDrain();
      }
    }
  }

  #scheduleDrain(): void {
    void this.#drain().catch((error) => this.#reportPersistenceError(error));
  }

  /**
   * Verify a clean native namespace after an interrupted Turn and before any next start. The reset
   * callback must throw when native `delete --force`/relaunch/probe cannot be verified; a failure
   * permanently disables Cloud Turns in this process instead of silently reusing a namespace that
   * may still own processes.
   */
  async #resetSandboxNamespace(): Promise<void> {
    if (this.#resetInFlight) return this.#resetInFlight;
    const reset = this.#options.sandboxReset;
    if (!reset) {
      this.#needsSandboxReset = false;
      return;
    }
    const run = Promise.resolve().then(async () => {
      try {
        await reset();
        this.#needsSandboxReset = false;
      } catch (error) {
        this.#sandboxUnusable = true;
        throw new CloudJournalError(
          "store_failed",
          `The native sandbox namespace cleanup could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.#resetInFlight = undefined;
      }
    });
    this.#resetInFlight = run;
    return run;
  }

  /** A non-completed Turn may have left namespace processes; require verified cleanup. */
  #markSandboxDirty(): void {
    if (this.#options.sandboxReset) this.#needsSandboxReset = true;
  }

  async #drain(): Promise<void> {
    for (;;) {
      if (this.#closed || this.#active) return;
      const first = this.#queue.values().next().value as
        | { readonly frame: RunnerCloudDeliveryVerifiedFrame; readonly deliveryId: string }
        | undefined;
      if (!first) return;
      this.#queue.delete(first.frame.requestId);
      const outcome = await this.#processQueued(first);
      if (outcome !== "continue") return;
    }
  }

  /** Returns "started" when a turn now occupies the slot, "stop" when the queue must pause. */
  async #processQueued(next: {
    readonly frame: RunnerCloudDeliveryVerifiedFrame;
    readonly deliveryId: string;
  }): Promise<"continue" | "started" | "stop"> {
    if (this.#cancelRequested.delete(next.deliveryId)) {
      await this.#settleCancelled(next.deliveryId);
      return "continue";
    }
    const entry = await this.#entryByRequestId(next.frame.requestId);
    if (entry?.phase !== "received") return "continue";
    if (next.frame.status === "rejected") {
      await this.#options.journal.clearRejected(entry.deliveryId, entry.scope);
      return "continue";
    }
    const denial = this.#admit(entry.delivery, next.frame);
    if (denial) {
      await this.#reportTerminal(entry, denial.completion);
      return "continue";
    }
    if (!(this.#options.canStart?.() ?? true)) {
      // The shared native occupation boundary is busy (acceptance cleanup): wait for its release.
      this.#queue.set(next.frame.requestId, next);
      return "stop";
    }
    await this.#startTurn(entry, next.frame);
    return this.#active ? "started" : "continue";
  }

  async #settleCancelled(deliveryId: string): Promise<void> {
    const entry = await this.#options.journal.read(deliveryId);
    if (!entry) return;
    this.#assertCurrentScope(entry);
    if (entry.phase === "received") await this.#reportTerminal(entry, cancelledBeforeStart());
  }

  #completeActive(active: ActiveTurn): void {
    if (this.#active === active) this.#active = undefined;
    active.settle();
  }

  async #executeTurn(
    entry: CloudJournalEntry,
    frame: RunnerCloudDeliveryVerifiedFrame,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.#options.journal.read(entry.deliveryId);
    if (current?.phase !== "started") return;
    const model = frame.model;
    if (!model) return;
    let completion: TurnCompletion;
    try {
      completion = await this.#runInSandbox(current.delivery, model, current, signal);
    } catch {
      completion = { errorReason: "turn_state_unknown", executionEffects: "may_have_occurred", outcome: "unknown" };
    }
    if (signal.aborted && completion.executionEffects !== "not_started" && completion.outcome !== "completed") {
      completion = { errorReason: "client_shutdown", executionEffects: "may_have_occurred", outcome: "cancelled" };
    }
    // An interrupted/failed/unknown Turn may still own native processes. Clean up IMMEDIATELY,
    // while the occupation stays reserved, and only publish the terminal report after the
    // verified reset: a stopped Session must never leave orphan children behind, and a failed
    // reset must never be reported as a safe cancellation.
    let cleanupFailure: unknown;
    if (isInterrupted(completion) && this.#options.sandboxReset) {
      this.#markSandboxDirty();
      try {
        await this.#resetSandboxNamespace();
      } catch (error) {
        cleanupFailure = error;
        completion = {
          errorReason: "sandbox_unavailable",
          executionEffects: "may_have_occurred",
          outcome: "unknown",
        };
      }
    }
    await this.#reportTerminal(current, completion);
    // Publish the honest report first; then surface the cleanup failure through the existing
    // Runner failure path (serve marks the environment fatal and exits).
    if (cleanupFailure !== undefined) this.#reportPersistenceError(cleanupFailure);
  }

  /** Build the fsynced report and send it; the entry retires only on the Server's durable ack. */
  async #reportTerminal(entry: CloudJournalEntry, completion: TurnCompletion): Promise<void> {
    const report = entry.report ?? this.#buildReport(entry.delivery, entry, completion);
    const recorded = await this.#options.journal.recordReport(entry.deliveryId, entry.scope, report);
    if (!recorded.report) return;
    this.#send({ type: "delivery:report", report: recorded.report, requestId: randomUUID() });
  }

  #buildReport(
    delivery: DirectImMessageDeliveryRequest,
    entry: CloudJournalEntry,
    completion: TurnCompletion,
  ): TurnReportRequest {
    const base = {
      type: "turn:report" as const,
      agentId: delivery.agentId,
      deliveryId: delivery.deliveryId,
      executionEffects: completion.executionEffects,
      placementGeneration: delivery.placementGeneration,
      outcome: completion.outcome,
      requestId: randomUUID(),
      sessionId: delivery.sessionId,
      traceSummary: { droppedEvents: 0, lastSequence: 0 },
      turnId: entry.turnId,
      ...(completion.errorReason ? { errorReason: completion.errorReason } : {}),
      ...(completion.finalText ? { finalText: completion.finalText } : {}),
      ...(completion.usage ? { usage: completion.usage } : {}),
    };
    const report: TurnReportRequest = { ...base, resultHash: computeTurnResultHash(base) };
    const validated = TurnReportRequestSchema.safeParse(report);
    if (!validated.success) {
      throw new CloudJournalError("store_failed", `The Turn report for ${entry.deliveryId} failed schema validation`);
    }
    return validated.data;
  }

  /**
   * Deadline/grant admission BEFORE any native or Pi effect. An expired persisted runtime deadline
   * or an expired/absent model grant settles durably as `not_started` with zero sandbox work and
   * never extends the budget.
   */
  #admit(
    delivery: DirectImMessageDeliveryRequest,
    frame: RunnerCloudDeliveryVerifiedFrame,
  ): { readonly completion: TurnCompletion } | undefined {
    const now = Date.now();
    const model = frame.model;
    if (!model) {
      return {
        completion: {
          errorReason: "credential_unavailable",
          executionEffects: "not_started",
          outcome: "failed",
        },
      };
    }
    if (!Number.isFinite(Date.parse(model.expiresAt)) || Date.parse(model.expiresAt) <= now) {
      return {
        completion: {
          errorReason: "credential_unavailable",
          executionEffects: "not_started",
          outcome: "failed",
        },
      };
    }
    if (delivery.deadlineAt) {
      const deadline = Date.parse(delivery.deadlineAt);
      if (!Number.isFinite(deadline) || deadline <= now) {
        return {
          completion: {
            errorReason: "turn_timeout",
            executionEffects: "not_started",
            outcome: "failed",
          },
        };
      }
    }
    return undefined;
  }

  async #runInSandbox(
    delivery: DirectImMessageDeliveryRequest,
    model: RunnerCloudModelGrant,
    entry: CloudJournalEntry,
    signal: AbortSignal,
  ): Promise<TurnCompletion> {
    const scope = this.#options.scope();
    if (!scope) throw new Error("The Runner scope is not established");
    const openExecution =
      this.#options.openExecution ?? ((input: CloudTurnExecutionOpenInput) => this.#openBridgeExecution(input));
    const execution = await openExecution({ delivery, scope, turnId: entry.turnId, signal });
    try {
      const stdin = serializeRunnerCloudTurnWorkerStdin({
        delivery,
        executionDir: execution.executionDir,
        model,
        ...(this.#options.piSessionDirectory ? { piSessionDirectory: this.#options.piSessionDirectory } : {}),
      });
      const runWorker =
        this.#options.runWorker ??
        ((input: { stdin: string; timeoutMs: number }, workerSignal: AbortSignal) =>
          this.#options.sandbox.exec(SANDBOX_NODE, [SANDBOX_WORKER_ENTRY, "worker"], {
            signal: workerSignal,
            stdin: input.stdin,
            timeoutMs: input.timeoutMs,
          }));
      // The timeout is the ACTUAL remaining budget (including sandbox/Pi startup); there is no
      // lower floor, so an almost-expired turn cannot be extended by a fixed window.
      const timeoutMs = turnTimeoutMs(delivery, Date.now());
      const exec = await runWorker({ stdin, timeoutMs }, signal);
      if (signal.aborted) {
        return { errorReason: "client_shutdown", executionEffects: "may_have_occurred", outcome: "cancelled" };
      }
      const completion = parseWorkerCompletion(exec.stdout);
      // A nonzero worker exit can never be a successful Turn, even when stdout claims one
      // (truncated/forged output). A genuine non-completed completion is still honored.
      if (exec.code !== 0 && completion.outcome === "completed") {
        return { errorReason: "provider_failed", executionEffects: "may_have_occurred", outcome: "failed" };
      }
      return completion;
    } finally {
      await execution.close().catch((error) => this.#reportPersistenceError(error));
    }
  }

  /**
   * Default per-turn credential bridge: open a #633 execution through the Runner channel tunnel,
   * start the trusted loopback adapter, and publish ONLY the per-turn public material the native
   * Sandbox mounts. The private CA/journal/bootstrap material stays in the unmounted private root.
   * Nothing runs in this parent beyond credential relaying; the worker executes inside the Sandbox.
   */
  async #openBridgeExecution(input: CloudTurnExecutionOpenInput): Promise<CloudTurnExecutionHandle> {
    const scope = input.scope;
    if (!scope.resourceUid) throw new Error("The Sandbox allocation UID is not tracked yet");
    const connection = new CloudCredentialConnection(this.#options.credentialChannel());
    const relayOptions: RuntimeCredentialRelayOptions = {
      connection: connection.relayConnection,
      serverUrl: this.#options.serverUrl,
    };
    const relay = await RuntimeCredentialRelay.open(
      relayOptions,
      {
        agentId: input.delivery.agentId,
        placementGeneration: input.delivery.placementGeneration,
        runId: randomUUID(),
        sandbox: {
          environmentGeneration: scope.environmentGeneration,
          resourceUid: scope.resourceUid,
          sandboxId: scope.sandboxId,
        },
        sessionId: input.delivery.sessionId,
        source: { kind: "delivery", deliveryId: input.delivery.deliveryId, turnId: input.turnId },
      },
      input.signal,
    );
    const sockets = createBridgeSocketResources();
    const privateDirectory = await mkdtemp(join(this.#options.stateDirectory, "turn-private-"));
    const publicRoot = this.#options.publicDirectory ?? join(this.#options.stateDirectory, "public");
    await mkdir(publicRoot, { recursive: true, mode: 0o700 });
    const publicDirectory = await mkdtemp(join(publicRoot, "turn-"));
    try {
      const adapter = await RuntimeProxyLoopbackAdapter.start({
        executionId: relay.executionId,
        localHandleFor: (provider) =>
          relay.providers.some((entryPoint) => entryPoint.provider === provider)
            ? relay.localHandleFor(provider)
            : undefined,
        materialDir: join(privateDirectory, "adapter"),
        openStream: (request) => relay.openProviderStream(request),
        verifyHandle: (provider, handle) => relay.verifyLocalHandle(provider, handle),
      });
      const inSandboxExecutionDir = `${CLOUD_EXECUTION_MOUNT}/${basename(publicDirectory)}`;
      await publishExecutionMaterial({ adapter, relay }, sockets, publicDirectory, {
        includeEntryPrograms: false,
        publicMountPath: inSandboxExecutionDir,
      });
      return {
        executionDir: inSandboxExecutionDir,
        close: async () => {
          await closeBridgeSockets(sockets);
          await adapter.close().catch(() => undefined);
          await relay.close("execution_closed").catch(() => undefined);
          connection.close();
          await rm(publicDirectory, { recursive: true, force: true }).catch(() => undefined);
          await rm(privateDirectory, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      await closeBridgeSockets(sockets);
      await relay.close("open_failed").catch(() => undefined);
      connection.close();
      await rm(publicDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(privateDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #entryByRequestId(requestId: string): Promise<CloudJournalEntry | undefined> {
    const entry = (await this.#options.journal.list()).find((candidate) => candidate.requestId === requestId);
    if (!entry) return undefined;
    this.#assertCurrentScope(entry);
    return entry;
  }

  #assertCurrentScope(entry: CloudJournalEntry): void {
    assertCloudJournalScope(entry, this.#requireJournalScope());
  }

  #requireJournalScope(): CloudJournalScope {
    const scope = this.#options.scope();
    if (!scope) {
      throw new CloudJournalError("scope_unbound", "The Runner has no negotiated Cloud allocation scope");
    }
    if (!scope.resourceUid) {
      throw new CloudJournalError("scope_unbound", "The Sandbox allocation UID is not tracked yet");
    }
    return {
      environmentGeneration: scope.environmentGeneration,
      resourceName: scope.resourceName,
      resourceUid: scope.resourceUid,
      sandboxId: scope.sandboxId,
      sessionId: scope.sessionId,
    };
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#serial.then(operation, operation);
    this.#serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #reportPersistenceError(error: unknown): void {
    this.#log(`cloud delivery durable boundary failed: ${error instanceof Error ? error.message : String(error)}`);
    this.#options.onPersistenceError?.(error);
  }

  #send(frame: RunnerClientFrame): void {
    try {
      this.#options.send(frame);
    } catch {
      this.#log("cloud delivery frame could not be sent (channel closed)");
    }
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }
}

/**
 * Remaining legitimate runtime budget for the worker. Reuses the Local turn-budget helper
 * (runtime `budget.maxDurationMs` ∩ persisted deadline, floored at 1ms) so Cloud never invents a
 * longer fixed window than the persisted runtime deadline.
 */
export function turnBudgetMs(delivery: DirectImMessageDeliveryRequest, now = Date.now()): number {
  return turnTimeoutMs(delivery, now);
}

function cancelledBeforeStart(): TurnCompletion {
  return { errorReason: "client_shutdown", executionEffects: "not_started", outcome: "cancelled" };
}

/** A Turn that did not verifiably complete may have left native processes behind. */
function isInterrupted(completion: TurnCompletion): boolean {
  return completion.outcome !== "completed" || completion.executionEffects !== "completed";
}

/** Parse exactly one bounded in-sandbox result line; malformed output is an explicit unknown. */
function parseWorkerCompletion(stdout: string): TurnCompletion {
  if (utf8Length(stdout) > CLOUD_TURN_WORKER_STDOUT_MAX_BYTES) {
    return { errorReason: "output_too_large", executionEffects: "may_have_occurred", outcome: "unknown" };
  }
  const line = stdout
    .split("\n")
    .filter((candidate) => candidate.startsWith("{"))
    .at(-1);
  let parsed: unknown;
  try {
    parsed = line ? JSON.parse(line) : undefined;
  } catch {
    return providerProtocolError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { kind?: unknown }).kind !== "result" ||
    typeof (parsed as { completion?: unknown }).completion !== "object"
  ) {
    return providerProtocolError();
  }
  const completion = CloudTurnCompletionSchema.safeParse((parsed as { completion: unknown }).completion);
  if (!completion.success) return providerProtocolError();
  return completion.data;
}

function providerProtocolError(): TurnCompletion {
  return { errorReason: "provider_protocol_error", executionEffects: "may_have_occurred", outcome: "unknown" };
}

/** UTF-8 byte length without depending on a Shared-internal helper. */
function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
