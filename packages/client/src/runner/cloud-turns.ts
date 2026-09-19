import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
  type RunnerClientFrame,
  type RunnerCloudDeliveryQueryFrame,
  type RunnerCloudDeliveryReportAckFrame,
  type RunnerCloudDeliveryRunFrame,
  type RunnerCloudDeliveryVerifiedFrame,
  type RunnerCloudModelGrant,
  type RunnerCloudSessionMessageRunFrame,
  type RunnerCloudSessionMessageSettledAckFrame,
  type RunnerCloudSessionMessageVerifiedFrame,
  RuntimeUsageSchema,
  type SessionCliProofGrant,
  type SessionMessageDeliveryRequest,
  serializeRunnerCloudSessionWorkerStdin,
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
import { truncateUtf8 } from "../runtime/provider-cli/outgoing-reply-process.js";
import { RuntimeCredentialRelay, type RuntimeCredentialRelayOptions } from "../runtime/runtime-credential-relay.js";
import { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";
import { type CloudCredentialChannel, CloudCredentialConnection } from "./cloud-credential-connection.js";
import {
  assertCloudJournalScope,
  type CloudJournal,
  type CloudJournalDeliveryEntry,
  type CloudJournalEntry,
  CloudJournalError,
  type CloudJournalScope,
  type CloudJournalSessionEntry,
  type CloudJournalSettlementOutcome,
  computeCloudDeliveryInputHash,
  computeCloudSessionInputHash,
} from "./cloud-journal.js";
import { CloudWorkspaceError } from "./cloud-workspace.js";
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
  /** E5: quiesce writers and save while the Turn slot is held, before publishing its report. */
  readonly checkpoint?: () => Promise<void>;
  readonly log?: (message: string) => void;
  /** Unexpected durable-boundary failures that must surface instead of being swallowed. */
  readonly onPersistenceError?: (error: unknown) => void;
  /** Test seam: replace the credential-execution bridge pipeline. */
  readonly openExecution?: (input: CloudTurnExecutionOpenInput) => Promise<CloudTurnExecutionHandle>;
  /** Test seam: replace the Session-message credential-execution bridge pipeline. */
  readonly openSessionExecution?: (input: CloudSessionExecutionOpenInput) => Promise<CloudTurnExecutionHandle>;
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

export interface CloudSessionExecutionOpenInput {
  readonly message: SessionMessageDeliveryRequest;
  readonly scope: CloudTurnScope;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

export interface CloudTurnExecutionHandle {
  /** In-sandbox absolute path of the per-turn public material directory. */
  readonly executionDir: string;
  /**
   * E8 Session CLI proof received on the execution-open result. Ephemeral: forwarded to the worker
   * via stdin and cleared with the execution; never journaled, logged, or archived.
   */
  readonly sessionCliProof?: SessionCliProofGrant;
  close(): Promise<void>;
}

interface ActiveTurn {
  readonly kind: "delivery" | "session-message";
  /** The active journal key: the delivery id or the Session message id. */
  readonly entryKey: string;
  readonly abort: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  execution?: Promise<void>;
}

interface QueuedDeliveryVerified {
  readonly kind: "delivery";
  readonly deliveryId: string;
  readonly frame: RunnerCloudDeliveryVerifiedFrame;
  /** Connection generation that received the grant; a newer generation invalidates it. */
  readonly generation: number;
}

interface QueuedSessionVerified {
  readonly kind: "session-message";
  readonly messageId: string;
  readonly frame: RunnerCloudSessionMessageVerifiedFrame;
  readonly generation: number;
}

type QueuedVerified = QueuedDeliveryVerified | QueuedSessionVerified;

/**
 * Result of one start attempt: `started` occupies the turn slot, `settled` resolved the head
 * without starting it (cancel/phase/generation) so the drain must continue, and `wait` keeps the
 * head queued because starting now is impossible (closed/busy/canStart false).
 */
type StartTurnOutcome = "started" | "settled" | "wait";

/** Worker stdout is captured bounded by the native sandbox; still refuse anything larger. */
const CLOUD_TURN_WORKER_STDOUT_MAX_BYTES = 256 * 1024;
/** Bounded Session queue: verified entries beyond this wait at `received` for re-verification. */
const CLOUD_TURN_MAX_QUEUED = 64;
/**
 * Bounded grace on top of the persisted runtime budget for the native exec backstop, so the
 * in-sandbox worker's own deadline reports `turn_timeout` before the parent kills the wrapper.
 */
export const CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS = 5_000;

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
  readonly #queue = new Map<string, QueuedVerified>();
  /** Monotonic control-channel generation; a close invalidates queued connection-scoped grants. */
  #channelGeneration = 0;
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
  readonly #journalListeners = new Set<() => void>();

  constructor(options: CloudTurnRunnerOptions) {
    this.#options = options;
  }

  get activeDeliveryId(): string | undefined {
    return this.#active?.kind === "delivery" ? this.#active.entryKey : undefined;
  }

  get activeMessageId(): string | undefined {
    return this.#active?.kind === "session-message" ? this.#active.entryKey : undefined;
  }

  async waitForActive(): Promise<void> {
    await this.#active?.settled;
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
      // A draining allocation must not acknowledge newly arriving work. The Server retains
      // unaccepted input for delivery; accepting it here would create a new release obligation.
      if (this.#closed) return;
      const delivery = frame.delivery;
      const scope = this.#options.scope();
      if (!scope || delivery.sessionId !== scope.sessionId) {
        this.#log("ignoring delivery:run outside the current Session scope");
        return;
      }
      const journalScope = this.#requireJournalScope();
      const existing = await this.#options.journal.read(delivery.deliveryId);
      const reusable = this.#reuseDeliveryEntry(existing, delivery, journalScope);
      if (existing && !reusable) return;
      // A journaled delivery may only be re-dispatched with the SAME dispatch identity and
      // content. Changed input under the same ids is a visible conflict, never a second turn.
      const entry =
        reusable ??
        (await this.#options.journal.recordReceived({
          delivery,
          scope: journalScope,
          deliveryId: delivery.deliveryId,
          requestId: delivery.requestId,
          turnId: randomUUID(),
        }));
      this.#send({
        type: "delivery:received",
        deliveryId: entry.deliveryId,
        requestId: entry.requestId,
        turnId: entry.turnId,
      });
    });
  }

  /** Reuse one already-journaled delivery, or undefined when the re-dispatch must be refused. */
  #reuseDeliveryEntry(
    existing: CloudJournalEntry | undefined,
    delivery: DirectImMessageDeliveryRequest,
    journalScope: CloudJournalScope,
  ): CloudJournalDeliveryEntry | undefined {
    if (!existing) return undefined;
    if (existing.kind !== "delivery") {
      this.#log(`refusing re-dispatch of ${delivery.deliveryId}: journal key belongs to a Session message`);
      return undefined;
    }
    try {
      assertCloudJournalScope(existing, journalScope);
    } catch {
      this.#log(`refusing re-dispatch of ${delivery.deliveryId}: journaled under another allocation`);
      return undefined;
    }
    if (existing.requestId !== delivery.requestId || existing.inputHash !== computeCloudDeliveryInputHash(delivery)) {
      this.#log(`refusing re-dispatch of ${delivery.deliveryId}: journaled dispatch identity or input differs`);
      this.#reconcileSupersededReceipt(existing, delivery.requestId);
      return undefined;
    }
    return existing;
  }

  /** Ask the Server to retire an expired old receipt before its replacement can be admitted. */
  #reconcileSupersededReceipt(entry: CloudJournalDeliveryEntry, requestId: string): void {
    // Never erase durable state locally; a changed payload under the SAME request remains a conflict.
    if (entry.phase === "received" && entry.requestId !== requestId) this.#sendReceipt(entry);
  }

  /** Server persisted durable custody: execution may start (the model grant rides along). */
  async handleVerified(frame: RunnerCloudDeliveryVerifiedFrame): Promise<void> {
    // Capture BEFORE waiting for the serial queue: a close may happen while this frame is queued
    // behind another operation, and the frame's grant still belongs to the old connection.
    const generation = this.#channelGeneration;
    await this.#enqueue(async () => {
      const entry = await this.#entryByRequestId(frame.requestId);
      if (entry?.kind !== "delivery") return; // Already retired or never received.
      if (generation !== this.#channelGeneration) {
        this.#log(`ignoring delivery ${entry.deliveryId} verified on a closed channel generation`);
        return;
      }
      if (frame.status === "rejected") {
        // The Server refused custody before any start. A started/reported entry is real durable
        // state that a late rejection must never erase.
        if (entry.phase === "received") {
          await this.#options.journal.clearRejected(entry.deliveryId, entry.scope);
          this.#notifyJournalChanged();
        } else this.#log(`ignoring rejected receipt for ${entry.deliveryId} in phase ${entry.phase}`);
        return;
      }
      if (entry.phase !== "received") return;
      if (this.#closed || this.#cancelRequested.delete(entry.deliveryId)) {
        await this.#reportTerminal(entry, cancelledBeforeStart());
        return;
      }
      const denial = this.#admit(entry.delivery, frame);
      if (denial) {
        await this.#reportTerminal(entry, denial.completion);
        return;
      }
      await this.#queueVerified(entry, frame, generation);
    });
  }

  /** Journal + fsync one Session message, THEN acknowledge receipt. Idempotent across redispatch. */
  async handleSessionMessageRun(frame: RunnerCloudSessionMessageRunFrame): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#closed) return;
      const message = frame.message;
      const scope = this.#options.scope();
      if (!scope || message.targetSessionId !== scope.sessionId) {
        this.#log("ignoring session:message:run outside the current Session scope");
        return;
      }
      const journalScope = this.#requireJournalScope();
      const existing = await this.#options.journal.read(message.messageId);
      const reusable = this.#reuseSessionEntry(existing, frame, journalScope);
      if (existing && !reusable) return;
      const entry =
        reusable ??
        (await this.#options.journal.recordSessionReceived({
          message,
          sessionKind: frame.sessionKind,
          ...(frame.outboxContext ? { outboxContext: frame.outboxContext } : {}),
          scope: journalScope,
          requestId: frame.requestId,
          turnId: randomUUID(),
        }));
      this.#sendSessionProgress(entry);
    });
  }

  /** Reuse one already-journaled Session dispatch, or undefined when the re-dispatch must be refused. */
  #reuseSessionEntry(
    existing: CloudJournalEntry | undefined,
    frame: RunnerCloudSessionMessageRunFrame,
    journalScope: CloudJournalScope,
  ): CloudJournalSessionEntry | undefined {
    if (!existing) return undefined;
    const messageId = frame.message.messageId;
    if (existing.kind !== "session-message") {
      this.#log(`refusing re-dispatch of ${messageId}: journal key belongs to a delivery`);
      return undefined;
    }
    try {
      assertCloudJournalScope(existing, journalScope);
    } catch {
      this.#log(`refusing re-dispatch of ${messageId}: journaled under another allocation`);
      return undefined;
    }
    if (existing.requestId !== frame.requestId || existing.inputHash !== computeCloudSessionInputHash(frame)) {
      this.#log(`refusing re-dispatch of ${messageId}: journaled dispatch identity or input differs`);
      if (existing.phase === "received" && existing.requestId !== frame.requestId) this.#sendSessionProgress(existing);
      return undefined;
    }
    return existing;
  }

  /** Server persisted durable custody for one Session message: execution may start. */
  async handleSessionMessageVerified(frame: RunnerCloudSessionMessageVerifiedFrame): Promise<void> {
    const generation = this.#channelGeneration;
    await this.#enqueue(async () => {
      const entry = await this.#entryByRequestId(frame.requestId);
      if (entry?.kind !== "session-message") return;
      if (generation !== this.#channelGeneration) {
        this.#log(`ignoring Session message ${entry.messageId} verified on a closed channel generation`);
        return;
      }
      if (frame.status === "rejected") {
        if (entry.phase === "received") {
          await this.#options.journal.clearSessionRejected(entry.messageId, entry.scope);
          this.#notifyJournalChanged();
        } else this.#log(`ignoring rejected receipt for Session message ${entry.messageId} in phase ${entry.phase}`);
        return;
      }
      if (entry.phase !== "received") return;
      if (this.#closed || this.#cancelRequested.delete(entry.messageId)) {
        await this.#settleSessionTerminal(entry, "cancelled");
        return;
      }
      const denial = this.#admitSession(frame);
      if (denial) {
        await this.#settleSessionTerminal(entry, denial);
        return;
      }
      await this.#queueSessionVerified(entry, frame, generation);
    });
  }

  /**
   * Queue a verified frame in FIFO order, then drain: a later verification can never overtake an
   * earlier queued entry. When this frame is the head and the slot is free, start it before
   * resolving (the established frame contract); otherwise a serialized drain picks it up in order.
   */
  async #queueVerified(
    entry: CloudJournalDeliveryEntry,
    frame: RunnerCloudDeliveryVerifiedFrame,
    generation: number,
  ): Promise<void> {
    if (this.#queue.size >= CLOUD_TURN_MAX_QUEUED) {
      this.#log(`cloud turn queue is full; leaving ${entry.deliveryId} at the received boundary for re-verification`);
      return;
    }
    const queued: QueuedDeliveryVerified = {
      kind: "delivery",
      deliveryId: entry.deliveryId,
      frame: { ...frame, model: frame.model },
      generation,
    };
    this.#queue.set(entry.requestId, queued);
    if (!this.#active && this.#queue.keys().next().value === entry.requestId) {
      await this.#processQueued(queued);
      return;
    }
    this.#scheduleDrain();
  }

  async #queueSessionVerified(
    entry: CloudJournalSessionEntry,
    frame: RunnerCloudSessionMessageVerifiedFrame,
    generation: number,
  ): Promise<void> {
    if (this.#queue.size >= CLOUD_TURN_MAX_QUEUED) {
      this.#log(`cloud turn queue is full; leaving ${entry.messageId} at the received boundary for re-verification`);
      return;
    }
    const queued: QueuedSessionVerified = {
      kind: "session-message",
      messageId: entry.messageId,
      frame: { ...frame },
      generation,
    };
    this.#queue.set(entry.requestId, queued);
    if (!this.#active && this.#queue.keys().next().value === entry.requestId) {
      await this.#processQueued(queued);
      return;
    }
    this.#scheduleDrain();
  }

  /**
   * Explicit stop. An owned in-sandbox worker is aborted immediately; a not-yet-started entry
   * settles durably as a not-started cancellation instead of silently disappearing.
   */
  handleCancel(deliveryId: string): void {
    this.#cancelEntry("delivery", deliveryId);
  }

  /** Explicit stop of one journaled Session message (same FIFO slot and cancellation semantics). */
  handleSessionMessageCancel(messageId: string): void {
    this.#cancelEntry("session-message", messageId);
  }

  #cancelEntry(kind: "delivery" | "session-message", entryKey: string): void {
    const active = this.#active;
    if (active?.kind === kind && active.entryKey === entryKey) {
      active.abort.abort();
      return;
    }
    for (const [requestId, queued] of this.#queue) {
      if (queued.kind !== kind) continue;
      const queuedKey = queued.kind === "delivery" ? queued.deliveryId : queued.messageId;
      if (queuedKey === entryKey) this.#queue.delete(requestId);
    }
    this.#cancelRequested.add(entryKey);
    void this.#enqueue(async () => {
      if (!this.#cancelRequested.delete(entryKey)) return;
      const entry = await this.#options.journal.read(entryKey);
      if (!entry || entry.kind !== kind) return;
      this.#assertCurrentScope(entry);
      if (entry.phase !== "received") return;
      if (entry.kind === "delivery") await this.#reportTerminal(entry, cancelledBeforeStart());
      else await this.#settleSessionTerminal(entry, "cancelled");
    }).catch((error) => this.#reportPersistenceError(error));
  }

  /** The Server durably recorded (or definitively refused) the report: retire the entry. */
  async handleReportAck(frame: RunnerCloudDeliveryReportAckFrame): Promise<void> {
    await this.#enqueue(async () => {
      const entries = await this.#options.journal.list();
      const entry = entries.find((candidate) => candidate.turnId === frame.turnId);
      if (entry?.kind !== "delivery") return;
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
      this.#notifyJournalChanged();
    });
  }

  /** The Server durably committed the exact Session settlement: retire the immutable entry. */
  async handleSessionMessageSettledAck(frame: RunnerCloudSessionMessageSettledAckFrame): Promise<void> {
    await this.#enqueue(async () => {
      const entry = await this.#entryByRequestId(frame.requestId);
      if (entry?.kind !== "session-message") return;
      this.#assertCurrentScope(entry);
      if (entry.phase !== "reported" || !entry.settlement) return;
      if (frame.messageId !== entry.messageId || frame.turnId !== entry.turnId) {
        this.#log(`retaining durable settlement for ${entry.messageId}: ack identity mismatch`);
        return;
      }
      await this.#options.journal.clearSessionAcknowledged(entry.messageId, entry.scope, {
        status: frame.status,
        turnId: frame.turnId,
      });
      this.#notifyJournalChanged();
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
      if (
        phase === "reported" &&
        entry?.kind === "delivery" &&
        entry.report &&
        !this.#isCheckpointing(entry.deliveryId)
      ) {
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
    if (entry.kind === "session-message") {
      await this.#reconcileSessionEntry(entry);
      return;
    }
    if (entry.phase === "received") {
      this.#sendReceipt(entry);
      return;
    }
    if (entry.phase === "reported" && entry.report) {
      if (this.#isCheckpointing(entry.deliveryId)) return;
      this.#send({ type: "delivery:report", report: entry.report, requestId: randomUUID() });
      return;
    }
    if (entry.phase !== "started") return;
    if (this.#active?.kind === "delivery" && this.#active.entryKey === entry.deliveryId) {
      // A live execution in this process is never rewritten as unknown by a reconnect.
      this.#sendReceipt(entry);
      return;
    }
    await this.#reportTerminal(entry, UNKNOWN_COMPLETION);
  }

  async #reconcileSessionEntry(entry: CloudJournalSessionEntry): Promise<void> {
    if (entry.phase === "received") {
      this.#sendSessionProgress(entry);
      return;
    }
    if (entry.phase === "reported") {
      // Immutable terminal settlement: replay until the Server's exact ack retires the entry.
      this.#sendSessionSettled(entry);
      return;
    }
    if (this.#active?.kind === "session-message" && this.#active.entryKey === entry.messageId) {
      // A live execution in this process is never rewritten as unknown by a reconnect.
      this.#sendSessionProgress(entry);
      return;
    }
    // A started Session turn whose worker is gone can never be resumed: report unknown once and
    // keep the immutable settlement for ack-driven replay.
    await this.#settleSessionTerminal(entry, "unknown");
  }

  #isCheckpointing(deliveryId: string): boolean {
    return (
      this.#options.checkpoint !== undefined &&
      this.#active?.kind === "delivery" &&
      this.#active.entryKey === deliveryId
    );
  }

  #sendReceipt(entry: CloudJournalDeliveryEntry): void {
    this.#send({
      type: "delivery:received",
      deliveryId: entry.deliveryId,
      requestId: entry.requestId,
      turnId: entry.turnId,
    });
  }

  /** Re-announce one Session entry: its receipt, or its immutable terminal settlement. */
  #sendSessionProgress(entry: CloudJournalSessionEntry): void {
    if (entry.phase === "reported") {
      this.#sendSessionSettled(entry);
      return;
    }
    this.#send({
      type: "session:message:received",
      requestId: entry.requestId,
      messageId: entry.messageId,
      turnId: entry.turnId,
      status: "accepted",
      phase: entry.phase === "started" ? "started" : "received",
    });
  }

  #sendSessionSettled(entry: CloudJournalSessionEntry): void {
    if (!entry.settlement) return;
    this.#send({
      type: "session:message:settled",
      requestId: entry.requestId,
      messageId: entry.messageId,
      turnId: entry.turnId,
      outcome: entry.settlement.outcome,
    });
  }

  /**
   * The control channel dropped. Connection-scoped grants are revoked by the Server with it, so
   * queued verified frames must never start afterwards; the journaled `received` entries are
   * re-announced by reconcile and re-verified with fresh grants. A live execution is not aborted
   * here (its report stays journaled and honest); only a full process restart reports `unknown`.
   */
  onChannelClosed(): void {
    this.#channelGeneration += 1;
    const dropped = this.#queue.size;
    this.#queue.clear();
    if (dropped > 0) {
      this.#log(`dropped ${dropped} queued delivery grant(s) from the closed channel generation`);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#active?.abort.abort();
    await this.#active?.settled;
    await this.#serial.catch(() => undefined);
  }

  /**
   * Quiesce execution and wait for durable Server report acknowledgments before the parent
   * seals storage. This wait never holds the control queue that must receive those acks.
   */
  async drainForRelease(timeoutMs: number): Promise<void> {
    await this.close();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let notify: () => void = () => undefined;
      const changed = new Promise<void>((resolveChanged) => {
        notify = resolveChanged;
      });
      this.#journalListeners.add(notify);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = await this.#enqueue(async () => {
          const entries = await this.#options.journal.list();
          for (const entry of entries) await this.#drainReleaseEntry(entry);
          return entries.length;
        });
        if (remaining === 0) return;
        const waitMs = deadline - Date.now();
        if (waitMs <= 0) throw new CloudJournalError("store_failed", "Release reports were not acknowledged");
        await Promise.race([
          changed,
          new Promise<void>((resolveRetry) => {
            // A transient Server read failure may leave the channel open without a reply.
            // Reuse the idempotent receipt/report protocol within the original release deadline.
            timer = setTimeout(resolveRetry, Math.min(waitMs, 5_000));
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.#journalListeners.delete(notify);
      }
    }
  }

  #notifyJournalChanged(): void {
    for (const listener of this.#journalListeners) listener();
  }

  /**
   * Re-announce one durable entry while releasing. A still-`received` input is re-announced so an
   * unaccepted attempt is rejected and retired; accepted custody is cancelled and reported.
   * Manufacturing a report before custody would strand the release on a conflict.
   */
  async #drainReleaseEntry(entry: CloudJournalEntry): Promise<void> {
    this.#assertCurrentScope(entry);
    if (entry.kind === "delivery") {
      if (entry.phase === "reported" && entry.report) {
        this.#send({ type: "delivery:report", report: entry.report, requestId: randomUUID() });
      } else if (entry.phase === "received") {
        this.#sendReceipt(entry);
      } else {
        await this.#reportTerminal(entry, UNKNOWN_COMPLETION);
      }
      return;
    }
    if (entry.phase === "reported") {
      this.#sendSessionSettled(entry);
    } else if (entry.phase === "received") {
      this.#sendSessionProgress(entry);
    } else {
      await this.#settleSessionTerminal(entry, "unknown");
    }
  }

  /* --------------------------------------------------------------------------------------------
   * Turn execution
   * ------------------------------------------------------------------------------------------ */

  /** Reserve the single turn slot synchronously, then fsync the started boundary, then run. */
  async #startTurn(
    entry: CloudJournalDeliveryEntry,
    frame: RunnerCloudDeliveryVerifiedFrame,
    generation: number,
  ): Promise<StartTurnOutcome> {
    if (this.#closed || this.#active) return "wait";
    if (!(this.#options.canStart?.() ?? true)) return "wait";
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: ActiveTurn = {
      abort: new AbortController(),
      entryKey: entry.deliveryId,
      kind: "delivery",
      settle,
      settled,
    };
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
      if (this.#closed) return "wait";
      if (current?.kind !== "delivery" || current.phase !== "received") {
        // Another path already settled or started this head; the drain may advance.
        this.#queue.delete(entry.requestId);
        return "settled";
      }
      if (generation !== this.#channelGeneration) {
        // The grant's connection closed while this read was pending: leave `received` for a fresh
        // verification instead of marking started with a revoked grant, and advance the drain.
        this.#queue.delete(entry.requestId);
        return "settled";
      }
      if (active.abort.signal.aborted) {
        // A stop arrived before the started boundary: no native effect happened, so settle an
        // honest not_started result, never mark the entry started, and advance to the next head.
        this.#queue.delete(entry.requestId);
        this.#cancelRequested.delete(entry.deliveryId);
        await this.#reportTerminal(current, cancelledBeforeStart());
        return "settled";
      }
      const started = await this.#options.journal.markStarted(current.deliveryId, current.scope);
      active.execution = this.#executeTurn(started, frame, active.abort.signal, generation)
        .catch((error) => this.#reportPersistenceError(error))
        .finally(() => {
          this.#completeActive(active);
          this.#scheduleDrain();
        });
      return "started";
    } finally {
      if (!active.execution) {
        // Release the reserved slot. The caller advances a settled head; a wait or surfaced
        // journal/namespace failure must not schedule another drain and spin on the same head.
        this.#completeActive(active);
      }
    }
  }

  /**
   * The Session-message counterpart of `#startTurn`: same synchronous slot reservation, namespace
   * reset, cancel re-check, and durable `started` marker, but the terminal evidence is the
   * immutable Session settlement instead of a delivery report.
   */
  async #startSessionTurn(
    entry: CloudJournalSessionEntry,
    frame: RunnerCloudSessionMessageVerifiedFrame,
    generation: number,
  ): Promise<StartTurnOutcome> {
    if (this.#closed || this.#active) return "wait";
    if (!(this.#options.canStart?.() ?? true)) return "wait";
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: ActiveTurn = {
      abort: new AbortController(),
      entryKey: entry.messageId,
      kind: "session-message",
      settle,
      settled,
    };
    this.#active = active;
    try {
      if (this.#sandboxUnusable) {
        throw new CloudJournalError(
          "store_failed",
          "The native sandbox namespace could not be verified clean; the Runner must not start another Turn",
        );
      }
      if (this.#needsSandboxReset) await this.#resetSandboxNamespace();
      const current = await this.#options.journal.read(entry.messageId);
      if (this.#closed) return "wait";
      if (current?.kind !== "session-message" || current.phase !== "received") {
        this.#queue.delete(entry.requestId);
        return "settled";
      }
      if (generation !== this.#channelGeneration) {
        this.#queue.delete(entry.requestId);
        return "settled";
      }
      if (active.abort.signal.aborted) {
        this.#queue.delete(entry.requestId);
        this.#cancelRequested.delete(entry.messageId);
        await this.#settleSessionTerminal(current, "cancelled");
        return "settled";
      }
      const started = await this.#options.journal.markSessionStarted(current.messageId, current.scope);
      active.execution = this.#executeSessionTurn(started, frame, active.abort.signal, generation)
        .catch((error) => this.#reportPersistenceError(error))
        .finally(() => {
          this.#completeActive(active);
          this.#scheduleDrain();
        });
      return "started";
    } finally {
      if (!active.execution) this.#completeActive(active);
    }
  }

  /**
   * Serialized, non-reentrant drain: only this path starts queued work, so a new verification or
   * an extra availability signal can never overtake the FIFO head. Enqueuing from inside a drain
   * (e.g. `#startTurn`'s finally) only chains a later no-op drain; it never awaits itself.
   */
  #scheduleDrain(): void {
    void this.#enqueue(() => this.#drain()).catch((error) => this.#reportPersistenceError(error));
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
      if (this.#closed || this.#active || this.#sandboxUnusable) return;
      const first = this.#queue.values().next().value as QueuedVerified | undefined;
      if (!first) return;
      const outcome = await this.#processQueued(first);
      if (outcome !== "continue") return;
    }
  }

  /**
   * Process the FIFO head. The entry stays queued until it is actually started, so losing the
   * occupation race can never drop verified work, and cancellation is re-checked after every
   * await so a delivery cancelled mid-drain is never started.
   */
  async #processQueued(next: QueuedVerified): Promise<"continue" | "started" | "stop"> {
    return next.kind === "session-message" ? this.#processQueuedSession(next) : this.#processQueuedDelivery(next);
  }

  /**
   * Process the FIFO head. The entry stays queued until it is actually started, so losing the
   * occupation race can never drop verified work, and cancellation is re-checked after every
   * await so a delivery cancelled mid-drain is never started.
   */
  async #processQueuedDelivery(next: QueuedDeliveryVerified): Promise<"continue" | "started" | "stop"> {
    if (this.#cancelRequested.delete(next.deliveryId)) {
      this.#queue.delete(next.frame.requestId);
      await this.#settleCancelled(next.deliveryId);
      return "continue";
    }
    const entry = await this.#entryByRequestId(next.frame.requestId);
    if (entry?.kind !== "delivery" || entry.phase !== "received") {
      this.#queue.delete(next.frame.requestId);
      return "continue";
    }
    if (this.#cancelRequested.delete(next.deliveryId)) {
      this.#queue.delete(next.frame.requestId);
      await this.#settleCancelled(next.deliveryId);
      return "continue";
    }
    if (next.generation !== this.#channelGeneration) {
      // The connection that minted the grant is gone; keep the received entry for re-verification.
      this.#queue.delete(next.frame.requestId);
      return "continue";
    }
    const denial = this.#admit(entry.delivery, next.frame);
    if (denial) {
      this.#queue.delete(next.frame.requestId);
      await this.#reportTerminal(entry, denial.completion);
      return "continue";
    }
    if (!(this.#options.canStart?.() ?? true)) return "stop";
    const outcome = await this.#startTurn(entry, next.frame, next.generation);
    if (outcome === "wait") return "stop";
    this.#queue.delete(next.frame.requestId);
    // A settled head must not stall the FIFO line: continue with the next queued delivery.
    return outcome === "started" ? "started" : "continue";
  }

  /** Session-message FIFO head: identical discipline, terminal evidence is the settlement. */
  async #processQueuedSession(next: QueuedSessionVerified): Promise<"continue" | "started" | "stop"> {
    if (this.#cancelRequested.delete(next.messageId)) {
      this.#queue.delete(next.frame.requestId);
      await this.#settleCancelledSession(next.messageId);
      return "continue";
    }
    const entry = await this.#entryByRequestId(next.frame.requestId);
    if (entry?.kind !== "session-message" || entry.phase !== "received") {
      this.#queue.delete(next.frame.requestId);
      return "continue";
    }
    if (this.#cancelRequested.delete(next.messageId)) {
      this.#queue.delete(next.frame.requestId);
      await this.#settleCancelledSession(next.messageId);
      return "continue";
    }
    if (next.generation !== this.#channelGeneration) {
      this.#queue.delete(next.frame.requestId);
      return "continue";
    }
    const denial = this.#admitSession(next.frame);
    if (denial) {
      this.#queue.delete(next.frame.requestId);
      await this.#settleSessionTerminal(entry, denial);
      return "continue";
    }
    if (!(this.#options.canStart?.() ?? true)) return "stop";
    const outcome = await this.#startSessionTurn(entry, next.frame, next.generation);
    if (outcome === "wait") return "stop";
    this.#queue.delete(next.frame.requestId);
    return outcome === "started" ? "started" : "continue";
  }

  async #settleCancelled(deliveryId: string): Promise<void> {
    const entry = await this.#options.journal.read(deliveryId);
    if (!entry) return;
    this.#assertCurrentScope(entry);
    if (entry.kind === "delivery" && entry.phase === "received") {
      await this.#reportTerminal(entry, cancelledBeforeStart());
    }
  }

  async #settleCancelledSession(messageId: string): Promise<void> {
    const entry = await this.#options.journal.read(messageId);
    if (!entry) return;
    this.#assertCurrentScope(entry);
    if (entry.kind === "session-message" && entry.phase === "received") {
      await this.#settleSessionTerminal(entry, "cancelled");
    }
  }

  #completeActive(active: ActiveTurn): void {
    if (this.#active === active) this.#active = undefined;
    active.settle();
  }

  async #executeTurn(
    entry: CloudJournalDeliveryEntry,
    frame: RunnerCloudDeliveryVerifiedFrame,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    const current = await this.#options.journal.read(entry.deliveryId);
    if (current?.kind !== "delivery" || current.phase !== "started") return;
    if (generation !== this.#channelGeneration) {
      // The connection closed after the durable started marker but before any sandbox work: no
      // execution effect occurred, so settle honestly instead of running with a revoked grant.
      await this.#reportTerminal(current, cancelledBeforeStart());
      return;
    }
    if (signal.aborted) {
      // A stop landed while the started marker was being written or shortly after. Nothing has
      // been opened or executed yet, so this is a known not_started effect, not an unknown.
      await this.#reportTerminal(current, cancelledBeforeStart());
      return;
    }
    const model = frame.model;
    if (!model) return;
    let completion: TurnCompletion;
    try {
      completion = await this.#runInSandbox(current.delivery, model, current, signal, generation);
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
    const cleanup = await this.#cleanupInterrupted(completion);
    await this.#reportTerminal(current, cleanup.completion, true);
    // Publish the honest report first; then surface the cleanup failure through the existing
    // Runner failure path (serve marks the environment fatal and exits).
    if (cleanup.failure !== undefined) this.#reportPersistenceError(cleanup.failure);
  }

  /**
   * Verified namespace cleanup after an interrupted Turn. A failed reset makes the completion an
   * honest unknown and keeps the failure for the caller to surface after the terminal evidence.
   */
  async #cleanupInterrupted(completion: TurnCompletion): Promise<{ completion: TurnCompletion; failure?: unknown }> {
    if (!isInterrupted(completion) || !this.#options.sandboxReset || this.#options.checkpoint) {
      return { completion };
    }
    this.#markSandboxDirty();
    try {
      await this.#resetSandboxNamespace();
      return { completion };
    } catch (error) {
      return {
        completion: { errorReason: "sandbox_unavailable", executionEffects: "may_have_occurred", outcome: "unknown" },
        failure: error,
      };
    }
  }

  /** Build the fsynced report and send it; the entry retires only on the Server's durable ack. */
  async #reportTerminal(
    entry: CloudJournalDeliveryEntry,
    completion: TurnCompletion,
    checkpoint = false,
  ): Promise<void> {
    let checkpointError: unknown;
    if (checkpoint) {
      try {
        await this.#options.checkpoint?.();
      } catch (error) {
        checkpointError = error;
        completion = workspaceSaveFailure(completion);
      }
    }
    // Record exactly one honest result AFTER the save attempt. A crash before this point leaves
    // started/unknown custody (never automatic replay), not a success whose workspace was lost.
    const report = entry.report ?? this.#buildReport(entry.delivery, entry, completion);
    const recorded = await this.#options.journal.recordReport(entry.deliveryId, entry.scope, report);
    if (!recorded.report) return;
    this.#notifyJournalChanged();
    this.#send({ type: "delivery:report", report: recorded.report, requestId: randomUUID() });
    if (
      checkpointError !== undefined &&
      !(checkpointError instanceof CloudWorkspaceError && !checkpointError.retryable)
    ) {
      this.#reportPersistenceError(checkpointError);
    }
  }

  #buildReport(
    delivery: DirectImMessageDeliveryRequest,
    entry: CloudJournalDeliveryEntry,
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
    entry: CloudJournalDeliveryEntry,
    signal: AbortSignal,
    generation: number,
  ): Promise<TurnCompletion> {
    const scope = this.#options.scope();
    if (!scope) throw new Error("The Runner scope is not established");
    // No model/Pi/tool effect exists yet: a stop here must never open credentials or spawn work.
    if (signal.aborted) return cancelledBeforeStart();
    const openExecution =
      this.#options.openExecution ?? ((input: CloudTurnExecutionOpenInput) => this.#openBridgeExecution(input));
    const execution = await openExecution({ delivery, scope, turnId: entry.turnId, signal });
    try {
      // The credential bridge is open, but the worker has not started; close it without calling
      // the worker when a stop or grant revocation landed during the open.
      if (signal.aborted || generation !== this.#channelGeneration) return cancelledBeforeStart();
      const stdin = serializeRunnerCloudTurnWorkerStdin({
        delivery,
        executionDir: execution.executionDir,
        model,
        ...(execution.sessionCliProof
          ? { sessionCollaboration: { proof: execution.sessionCliProof, serverUrl: this.#options.serverUrl } }
          : {}),
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
      // The in-sandbox worker owns the persisted runtime deadline and aborts itself at
      // `turnTimeoutMs(...)`, reporting `turn_timeout`. This parent value is only the exec
      // backstop that stops a wedged wrapper; it adds the bounded reporting grace so the worker's
      // own deadline wins, and it never makes the advertised runtime longer than that grace.
      const timeoutMs = turnTimeoutMs(delivery, Date.now()) + CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS;
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
   * Session-message execution: same durable `started` boundary and namespace discipline as an IM
   * Turn, but the terminal evidence is the immutable Session settlement. The execution-open result
   * carries the ephemeral Session CLI proof, which is forwarded to the worker via stdin.
   */
  async #executeSessionTurn(
    entry: CloudJournalSessionEntry,
    frame: RunnerCloudSessionMessageVerifiedFrame,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    const current = await this.#options.journal.read(entry.messageId);
    if (current?.kind !== "session-message" || current.phase !== "started") return;
    if (generation !== this.#channelGeneration || signal.aborted) {
      // The connection closed or a stop landed after the started marker but before any sandbox
      // work: no execution effect occurred, so settle honestly instead of running.
      await this.#settleSessionTerminal(current, "cancelled");
      return;
    }
    const model = frame.model;
    if (!model) {
      await this.#settleSessionTerminal(current, "failed");
      return;
    }
    let completion: TurnCompletion;
    try {
      completion = await this.#runSessionInSandbox(current.message, model, current, signal, generation);
    } catch {
      completion = { errorReason: "turn_state_unknown", executionEffects: "may_have_occurred", outcome: "unknown" };
    }
    if (signal.aborted && completion.executionEffects !== "not_started" && completion.outcome !== "completed") {
      completion = { errorReason: "client_shutdown", executionEffects: "may_have_occurred", outcome: "cancelled" };
    }
    const cleanup = await this.#cleanupInterrupted(completion);
    await this.#settleSessionTerminal(current, sessionSettlementOutcome(cleanup.completion), true);
    if (cleanup.failure !== undefined) this.#reportPersistenceError(cleanup.failure);
  }

  /** Deadline/grant admission BEFORE any native or Pi effect, mirroring the IM Turn gate. */
  #admitSession(frame: RunnerCloudSessionMessageVerifiedFrame): CloudJournalSettlementOutcome | undefined {
    const model = frame.model;
    if (!model) return "failed";
    if (!Number.isFinite(Date.parse(model.expiresAt)) || Date.parse(model.expiresAt) <= Date.now()) return "failed";
    return undefined;
  }

  /**
   * Record the immutable settlement after the same save boundary as an IM report, then send (or
   * replay) it; the entry retires only on the Server's exact settlement ack.
   */
  async #settleSessionTerminal(
    entry: CloudJournalSessionEntry,
    outcome: CloudJournalSettlementOutcome,
    checkpoint = false,
  ): Promise<void> {
    let effective = outcome;
    let checkpointError: unknown;
    if (checkpoint) {
      try {
        await this.#options.checkpoint?.();
      } catch (error) {
        checkpointError = error;
        effective = "failed";
      }
    }
    const recorded = await this.#options.journal.recordSessionSettled(entry.messageId, entry.scope, effective);
    if (!recorded.settlement) return;
    this.#notifyJournalChanged();
    this.#sendSessionSettled(recorded);
    if (
      checkpointError !== undefined &&
      !(checkpointError instanceof CloudWorkspaceError && !checkpointError.retryable)
    ) {
      this.#reportPersistenceError(checkpointError);
    }
  }

  async #runSessionInSandbox(
    message: SessionMessageDeliveryRequest,
    model: RunnerCloudModelGrant,
    entry: CloudJournalSessionEntry,
    signal: AbortSignal,
    generation: number,
  ): Promise<TurnCompletion> {
    const scope = this.#options.scope();
    if (!scope) throw new Error("The Runner scope is not established");
    if (signal.aborted) return cancelledBeforeStart();
    const openExecution =
      this.#options.openSessionExecution ??
      ((input: CloudSessionExecutionOpenInput) => this.#openSessionBridgeExecution(input));
    const execution = await openExecution({ message, scope, turnId: entry.turnId, signal });
    try {
      if (signal.aborted || generation !== this.#channelGeneration) return cancelledBeforeStart();
      const stdin = serializeRunnerCloudSessionWorkerStdin({
        message,
        executionDir: execution.executionDir,
        model,
        sessionKind: entry.sessionKind,
        ...(entry.outboxContext ? { outboxContext: entry.outboxContext } : {}),
        ...(execution.sessionCliProof
          ? { sessionCollaboration: { proof: execution.sessionCliProof, serverUrl: this.#options.serverUrl } }
          : {}),
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
      const budgetMs = message.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS;
      const timeoutMs = Math.max(1, budgetMs) + CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS;
      const exec = await runWorker({ stdin, timeoutMs }, signal);
      if (signal.aborted) {
        return { errorReason: "client_shutdown", executionEffects: "may_have_occurred", outcome: "cancelled" };
      }
      const completion = parseWorkerCompletion(exec.stdout);
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
    return this.#openRelayExecution({
      agentId: input.delivery.agentId,
      placementGeneration: input.delivery.placementGeneration,
      sessionId: input.delivery.sessionId,
      signal: input.signal,
      source: { kind: "delivery", deliveryId: input.delivery.deliveryId, turnId: input.turnId },
      scope: input.scope,
    });
  }

  async #openSessionBridgeExecution(input: CloudSessionExecutionOpenInput): Promise<CloudTurnExecutionHandle> {
    return this.#openRelayExecution({
      agentId: input.message.agentId,
      placementGeneration: input.message.placementGeneration,
      sessionId: input.message.targetSessionId,
      signal: input.signal,
      source: { kind: "session-message", messageId: input.message.messageId },
      scope: input.scope,
    });
  }

  async #openRelayExecution(input: {
    agentId: string;
    placementGeneration: number;
    sessionId: string;
    signal: AbortSignal;
    scope: CloudTurnScope;
    source: { kind: "delivery"; deliveryId: string; turnId: string } | { kind: "session-message"; messageId: string };
  }): Promise<CloudTurnExecutionHandle> {
    const scope = input.scope;
    if (!scope.resourceUid) throw new Error("The Sandbox allocation UID is not tracked yet");
    const connection = new CloudCredentialConnection(this.#options.credentialChannel());
    let relay: Awaited<ReturnType<typeof RuntimeCredentialRelay.open>> | undefined;
    let adapter: Awaited<ReturnType<typeof RuntimeProxyLoopbackAdapter.start>> | undefined;
    let sockets: ReturnType<typeof createBridgeSocketResources> | undefined;
    let privateDirectory: string | undefined;
    let publicDirectory: string | undefined;
    let cleaned = false;
    /**
     * Idempotent local cleanup: every acquired handle is released exactly once and one failing
     * step never stops the remaining ones. Failures are logged here and returned so the caller
     * can decide whether the original open/close error is the one that surfaces.
     */
    const cleanup = async (reason: "execution_closed" | "open_failed"): Promise<unknown[]> => {
      if (cleaned) return [];
      cleaned = true;
      const failures: unknown[] = [];
      const step = async (operation: () => Promise<void> | void): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      const ownedSockets = sockets;
      const ownedAdapter = adapter;
      const ownedRelay = relay;
      const ownedPublic = publicDirectory;
      const ownedPrivate = privateDirectory;
      if (ownedSockets) await step(() => closeBridgeSockets(ownedSockets));
      if (ownedAdapter) await step(() => ownedAdapter.close());
      if (ownedRelay) await step(() => ownedRelay.close(reason));
      await step(() => connection.close());
      if (ownedPublic) await step(() => rm(ownedPublic, { recursive: true, force: true }));
      if (ownedPrivate) await step(() => rm(ownedPrivate, { recursive: true, force: true }));
      for (const failure of failures) {
        this.#log(`cloud bridge ${reason} cleanup step failed: ${errorMessage(failure)}`);
      }
      return failures;
    };
    try {
      relay = await RuntimeCredentialRelay.open(
        {
          connection: connection.relayConnection,
          serverUrl: this.#options.serverUrl,
        } satisfies RuntimeCredentialRelayOptions,
        {
          agentId: input.agentId,
          placementGeneration: input.placementGeneration,
          runId: randomUUID(),
          sandbox: {
            environmentGeneration: scope.environmentGeneration,
            resourceUid: scope.resourceUid,
            sandboxId: scope.sandboxId,
          },
          sessionId: input.sessionId,
          source: input.source,
        },
        input.signal,
      );
      const openRelay = relay;
      sockets = createBridgeSocketResources();
      privateDirectory = await mkdtemp(join(this.#options.stateDirectory, "turn-private-"));
      const publicRoot = this.#options.publicDirectory ?? join(this.#options.stateDirectory, "public");
      await mkdir(publicRoot, { recursive: true, mode: 0o700 });
      publicDirectory = await mkdtemp(join(publicRoot, "turn-"));
      adapter = await RuntimeProxyLoopbackAdapter.start({
        executionId: openRelay.executionId,
        localHandleFor: (provider) =>
          openRelay.providers.some((entryPoint) => entryPoint.provider === provider)
            ? openRelay.localHandleFor(provider)
            : undefined,
        materialDir: join(privateDirectory, "adapter"),
        openStream: (request) => openRelay.openProviderStream(request),
        verifyHandle: (provider, handle) => openRelay.verifyLocalHandle(provider, handle),
      });
      const inSandboxExecutionDir = `${CLOUD_EXECUTION_MOUNT}/${basename(publicDirectory)}`;
      await publishExecutionMaterial({ adapter, relay: openRelay }, sockets, publicDirectory, {
        includeEntryPrograms: false,
        publicMountPath: inSandboxExecutionDir,
      });
      return {
        executionDir: inSandboxExecutionDir,
        ...(openRelay.sessionCliProof ? { sessionCliProof: openRelay.sessionCliProof } : {}),
        close: async () => {
          const failures = await cleanup("execution_closed");
          if (failures.length > 0) {
            throw new Error(
              `Cloud execution cleanup failed: ${failures.map((failure) => errorMessage(failure)).join("; ")}`,
            );
          }
        },
      };
    } catch (error) {
      const cleanupFailures = await cleanup("open_failed");
      if (cleanupFailures.length > 0) {
        // A leaked credential connection/adapter in the trusted parent is surfaced through the
        // existing failure hook instead of being only logged; the original open error still wins.
        this.#reportPersistenceError(
          new Error(
            `Cloud bridge open-failure cleanup left ${cleanupFailures.length} unresolved step(s): ${cleanupFailures
              .map((failure) => errorMessage(failure))
              .join("; ")}`,
          ),
        );
      }
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

function cancelledBeforeStart(): TurnCompletion {
  return { errorReason: "client_shutdown", executionEffects: "not_started", outcome: "cancelled" };
}

/**
 * One conservative Session settlement outcome. A Turn may only be reported `completed` when the
 * worker reported complete execution effects; anything else stays distinguishable as failed,
 * cancelled, or unknown.
 */
function sessionSettlementOutcome(completion: TurnCompletion): CloudJournalSettlementOutcome {
  if (completion.outcome === "cancelled") return "cancelled";
  if (completion.outcome === "unknown") return "unknown";
  if (completion.outcome === "completed") {
    return completion.executionEffects === "completed" ? "completed" : "unknown";
  }
  return "failed";
}

function workspaceSaveFailure(completion: TurnCompletion): TurnCompletion {
  const message =
    "Workspace save failed. Execution effects may already exist, but these files are not durably saved. " +
    "Further execution is blocked. If saving cannot recover, explicitly discard unsaved changes to release the environment. " +
    "Do not repeat completed external actions.\n\n";
  return {
    ...completion,
    outcome: "failed",
    errorReason: "workspace_failed",
    finalText:
      message +
      truncateUtf8(completion.finalText ?? "", RUNTIME_FINAL_TEXT_MAX_BYTES - Buffer.byteLength(message)).text,
  };
}

/** A Turn that did not verifiably complete may have left native processes behind. */
function isInterrupted(completion: TurnCompletion): boolean {
  return completion.outcome !== "completed" || completion.executionEffects !== "completed";
}

/** One-line error text for logs and aggregate cleanup errors. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
