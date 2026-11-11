import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TurnActivityResult } from "@opentag/shared";
import {
  computeRuntimeImSteerInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  MCP_GATEWAY_PATH,
  ProviderFailureReasonSchema,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
  RUNTIME_MAX_FRAME_BYTES,
  type RunnerClientFrame,
  type RunnerCloudDeliveryQueryFrame,
  type RunnerCloudDeliveryReportAckFrame,
  type RunnerCloudDeliveryRunFrame,
  type RunnerCloudDeliveryVerifiedFrame,
  type RunnerCloudModelGrant,
  type RunnerCloudSessionMessageRunFrameV2,
  type RunnerCloudSessionMessageSettledAckFrame,
  type RunnerCloudSessionMessageVerifiedFrame,
  type RunnerCloudSteerAckFrame,
  type RunnerCloudSteerFrame,
  type RuntimeImOutboxContext,
  type RuntimeImSteerResult,
  RuntimeImSteerResultSchema,
  RuntimeUsageSchema,
  type SessionCliProofGrant,
  type SessionMessageDeliveryRequestV3,
  serializeRunnerCloudSessionWorkerStdin,
  serializeRunnerCloudTurnWorkerStdin,
  TurnFailureReasonSchema,
  type TurnReportRequest,
  TurnReportRequestSchema,
} from "@opentag/shared";
import { z } from "zod";
import { publishExecutionMaterial } from "../cloud-runtime/bridge-material.js";
import {
  CLOUD_CONNECT_PROXY_PORT,
  CLOUD_CONTEXT_TREE_PORT,
  CLOUD_EXECUTION_MOUNT,
  CLOUD_SANDBOX_CA_FILE,
} from "../cloud-runtime/sandbox-entry.js";
import { createPiDiagnosticReader, type PiDiagnosticContext } from "../observability/pi-diagnostics.js";
import type { TurnCompletion } from "../runtime/agent-turn-runner.js";
import { turnTimeoutMs } from "../runtime/agent-turn-runner.js";
import { resolveContextTreePackage } from "../runtime/context-tree.js";
import { ContextTreeCommandGateway } from "../runtime/context-tree-commands.js";
import { managedAgentSlug } from "../runtime/managed-instructions.js";
import { truncateUtf8 } from "../runtime/provider-cli/outgoing-reply-process.js";
import { RuntimeCredentialRelay, type RuntimeCredentialRelayOptions } from "../runtime/runtime-credential-relay.js";
import { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";
import { providerRoutingEnvironment, runtimeProxyOutboxContext } from "../runtime/runtime-proxy-material.js";
import { TurnActivityReporter } from "../runtime/turn-activity-reporter.js";
import { WebToolsServerClient } from "../runtime/web-tools-client.js";
import { createExecutionWebDispatch } from "../runtime/web-tools-dispatch.js";
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
  steerNeverStarted,
} from "./cloud-journal.js";
import {
  CLOUD_SESSION_STEER_LIMIT,
  CLOUD_STEER_RELAY_SOURCE,
  type CloudImJoinRequest,
  type CloudSessionSteerRequest,
  type CloudSessionSteerResult,
  CloudSessionSteerResultSchema,
  cloudSteerResult,
  cloudSteerSocketPath,
} from "./cloud-steer-control.js";
import type { CloudWorkerCompletion } from "./cloud-turn-worker.js";
import { CloudWorkspaceError } from "./cloud-workspace.js";
import { CONTEXT_TREE_COMMAND_WORKER_SOURCE } from "./context-tree-command-worker.js";
import { createSandboxContextTreeSessionHints } from "./context-tree-session-hints.js";
import { NativeProviderBridge } from "./native-provider-bridge.js";
import { type NativeSandbox, NativeSandboxError, SANDBOX_NODE, SANDBOX_WORKER_ENTRY } from "./native-sandbox.js";
import type { NativeSandboxWebGateway, NativeWebExecutionChannel } from "./web-gateway.js";

const startupClockId = randomUUID();

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
  readonly sandbox: Pick<NativeSandbox, "exec" | "openDuplex" | "name">;
  readonly serverUrl: string;
  /**
   * Native web gateway for this Sandbox. A Cloud execution that the Server granted the `web`
   * service opens exactly one channel here; without a grant no channel, socket, listener, or Pi
   * extension exists. Absent (Local/test composition) keeps web tools fully off.
   */
  readonly webGateway?: NativeSandboxWebGateway;
  /**
   * Fixed packaged Pi web-tools extension path inside the Sandbox. Nonsecret, resolved by the
   * trusted Runner at startup from the packaged Client artifact; absent keeps web tools off.
   */
  readonly webExtensionPath?: string;
  /** Test seam for the trusted Server web client; production uses the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Test seam: relay transport injection for local fixtures (the data channel is a separate
   * transport with its own suites). Production always dials the real ticket-authenticated data
   * WebSocket; nothing else about the relay is replaceable.
   */
  readonly relayOptions?: Pick<RuntimeCredentialRelayOptions, "dataConnectionFactory">;
  readonly send: (frame: RunnerClientFrame) => void;
  readonly turnActivityEnabled?: () => boolean;
  readonly steeringEnabled?: () => boolean;
  readonly sessionSteeringEnabled?: () => boolean;
  readonly steerWorker?: (
    input: { request: import("@opentag/shared").RuntimeImSteerRequest; token: string },
    signal: AbortSignal,
  ) => Promise<RuntimeImSteerResult>;
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
  readonly checkpoint?: (options?: { readonly executionEffects?: TurnCompletion["executionEffects"] }) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly onStartupDiagnostic?: (record: Readonly<Record<string, unknown>>) => void;
  readonly onDiagnostic?: (record: Readonly<Record<string, unknown>>) => void;
  /** Unexpected durable-boundary failures that must surface instead of being swallowed. */
  readonly onPersistenceError?: (error: unknown) => void;
  /** Test seam: replace the credential-execution bridge pipeline. */
  readonly openExecution?: (input: CloudTurnExecutionOpenInput) => Promise<CloudTurnExecutionHandle>;
  /** Test seam: replace the Session-message credential-execution bridge pipeline. */
  readonly openSessionExecution?: (input: CloudSessionExecutionOpenInput) => Promise<CloudTurnExecutionHandle>;
  /** Test seam: replace the in-sandbox worker invocation. */
  readonly runWorker?: (
    input: { stdin: string; timeoutMs: number; onStderr?: (chunk: Buffer) => void },
    signal: AbortSignal,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function workerStopDiagnostic(
  exitCode: number | undefined,
  failed: boolean,
  error: unknown,
  aborted: boolean,
  bridgeFailed: boolean,
) {
  let stopType = "worker_exit";
  if (aborted) stopType = "client_shutdown";
  else if (bridgeFailed) stopType = "bridge_failure";
  else if (error instanceof NativeSandboxError && error.message === "Sandbox execution deadline exceeded")
    stopType = "exec_timeout";
  else if (failed) stopType = "exec_rejected";
  const expectedShutdown = aborted && !bridgeFailed;
  return {
    severity: !expectedShutdown && (failed || exitCode !== 0) ? "ERROR" : "INFO",
    workerExitCode: exitCode,
    errorCode: !expectedShutdown && error instanceof NativeSandboxError ? error.code : undefined,
    stopType,
  };
}

export interface CloudTurnExecutionOpenInput {
  readonly delivery: DirectImMessageDeliveryRequest;
  readonly scope: CloudTurnScope;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

export interface CloudSessionExecutionOpenInput {
  readonly message: SessionMessageDeliveryRequestV3;
  readonly scope: CloudTurnScope;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

export interface CloudTurnExecutionHandle {
  /** In-sandbox absolute path of the per-turn public material directory. */
  readonly executionDir: string;
  readonly mcpGateway?: { readonly url: string; readonly token: string };
  /**
   * Nonsecret web tools facts for the worker: the fixed extension path and this execution's
   * private socket descriptor. The execution bearer that fronts the socket stays in this trusted
   * parent process and is deliberately absent here.
   */
  readonly webTools?: { readonly extensionPath: string; readonly socketPath: string };
  /** Nonsecret outbox context of the execution's IM grant, naming the Session's own kind. */
  readonly outboxContext?: RuntimeImOutboxContext;
  /**
   * E8 Session CLI proof received on the execution-open result. Ephemeral: forwarded to the worker
   * via stdin and cleared with the execution; never journaled, logged, or archived.
   */
  readonly sessionCliProof?: SessionCliProofGrant;
  /**
   * Unexpected death of this execution's in-Sandbox provider bridge, when it happened. A Turn
   * that claims success while its provider transport died cannot be trusted as completed.
   */
  readonly bridgeFailure?: () => Error | undefined;
  readonly bridgeFailureSignal?: AbortSignal;
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
  steering?: { token: string; turnId: string };
  readonly sessionSteers: Map<string, { entry: CloudJournalSessionEntry; queued: QueuedSessionVerified }>;
  /** IM deliveries that joined this visible Session message Turn instead of waiting behind it. */
  readonly imJoins: Map<string, { entry: CloudJournalDeliveryEntry; queued: QueuedDeliveryVerified }>;
  /** Session steers and IM joins in arrival order, so a fallback keeps their FIFO order. */
  readonly joinOrder: string[];
  sessionSteerRetry?: ReturnType<typeof setTimeout>;
  sessionSteeringBlocked?: boolean;
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

interface CloudTurnWork<Entry extends CloudJournalEntry> {
  readonly kind: Entry["kind"];
  readonly key: string;
  readonly requestId: string;
  readonly generation: number;
  readonly model: RunnerCloudModelGrant | undefined;
  readonly matches: (entry: CloudJournalEntry | undefined) => entry is Entry;
  readonly markStarted: (entry: Entry) => Promise<Entry>;
  readonly admit: (entry: Entry) => TurnCompletion | undefined;
  readonly run: (entry: Entry, model: RunnerCloudModelGrant, signal: AbortSignal) => Promise<CloudWorkerCompletion>;
  readonly settle: (
    entry: Entry,
    completion: TurnCompletion,
    checkpoint?: boolean,
  ) => Promise<CloudJournalSettlementOutcome>;
  readonly missingModel: (entry: Entry) => Promise<unknown>;
}

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
    sessionSteers: z
      .record(z.string().uuid(), z.enum(["processed", "not_started", "interrupted"]))
      .refine((outcomes) => Object.keys(outcomes).length <= CLOUD_SESSION_STEER_LIMIT)
      .optional(),
    imJoins: z
      .record(z.string().min(1).max(256), z.enum(["processed", "not_started", "interrupted"]))
      .refine((outcomes) => Object.keys(outcomes).length <= CLOUD_SESSION_STEER_LIMIT)
      .optional(),
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

interface CloudRelayExecutionInput {
  agentId: string;
  contextTrees: readonly import("@opentag/shared").ContextTreeConnection[];
  agentSlug?: string;
  placementGeneration: number;
  sessionId: string;
  signal: AbortSignal;
  scope: CloudTurnScope;
  source: { kind: "delivery"; deliveryId: string; turnId: string } | { kind: "session-message"; messageId: string };
}

export class CloudTurnRunner {
  readonly #options: CloudTurnRunnerOptions;
  readonly #activity: TurnActivityReporter;
  readonly #cancelRequested = new Set<string>();
  /** Verified entries waiting for the single Session-serial turn slot, keyed by request id. */
  #queue = new Map<string, QueuedVerified>();
  /** Monotonic control-channel generation; a close invalidates queued connection-scoped grants. */
  #channelGeneration = 0;
  #active?: ActiveTurn;
  #admission: "open" | "draining" | "drained" | "closed" = "open";
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
  readonly #steerJobs = new Map<string, Promise<void>>();

  constructor(options: CloudTurnRunnerOptions) {
    this.#options = options;
    this.#activity = new TurnActivityReporter({
      send: options.send,
      enabled: () => options.turnActivityEnabled?.() === true,
    });
  }

  get #closed(): boolean {
    return this.#admission !== "open";
  }

  resumeAfterFailedRelease(): boolean {
    if (this.#admission === "closed" || this.#admission === "draining" || this.#sandboxUnusable) return false;
    if (this.#admission === "drained") {
      this.onChannelClosed();
      this.#admission = "open";
    }
    return true;
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
      const reusable = await this.#reuseDeliveryEntry(existing, delivery, journalScope);
      if (existing && !reusable) return;
      // A journaled delivery may only be re-dispatched with the SAME dispatch identity and
      // content. Changed input under the same ids is a visible conflict, never a second turn.
      const retained = reusable === "replace-steer" ? undefined : reusable;
      const entry =
        retained ??
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

  /** Reuse direct input or allow atomic replacement of a steer that never started. */
  async #reuseDeliveryEntry(
    existing: CloudJournalEntry | undefined,
    delivery: DirectImMessageDeliveryRequest,
    journalScope: CloudJournalScope,
  ): Promise<CloudJournalDeliveryEntry | "replace-steer" | undefined> {
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
    if (existing.steer) {
      if (steerNeverStarted(existing) && existing.requestId !== delivery.requestId) return "replace-steer";
      await this.#reconcileSteer(existing);
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

  async handleSteer(frame: RunnerCloudSteerFrame): Promise<void> {
    const generation = this.#channelGeneration;
    await this.#enqueue(async () => {
      if (this.#closed || generation !== this.#channelGeneration || !this.#options.steeringEnabled?.()) return;
      const request = frame.steer;
      const scope = this.#requireJournalScope();
      if (request.sessionId !== scope.sessionId) return;
      const existing = await this.#existingSteer(request, scope);
      if (typeof existing === "string") {
        if (existing === "conflict")
          this.#sendSteerWithoutJournal(request, cloudSteerResult(request, "rejected", "input_conflict"));
        return;
      }
      if (existing && (await this.#replaySteer(existing))) return;
      const prepared = await this.#prepareSteer(request, scope, existing);
      if (prepared) await this.#startSteer(prepared.entry, prepared.root, generation);
    });
  }

  async #prepareSteer(
    request: import("@opentag/shared").RuntimeImSteerRequest,
    scope: CloudJournalScope,
    existing: CloudJournalDeliveryEntry | undefined,
  ) {
    const root = await this.#steerRoot(request, scope);
    if (!root) {
      const result = cloudSteerResult(request, "deferred", "turn_not_running");
      if (existing)
        this.#sendSteerResult(await this.#options.journal.recordSteerResult(existing.deliveryId, scope, result));
      else this.#sendSteerWithoutJournal(request, result);
      return;
    }
    const entry = existing ?? (await this.#receiveSteer(request, root));
    if (!entry) return;
    return { entry, root };
  }

  async #existingSteer(
    request: import("@opentag/shared").RuntimeImSteerRequest,
    scope: CloudJournalScope,
  ): Promise<CloudJournalDeliveryEntry | "conflict" | "retiring" | undefined> {
    const entry = await this.#options.journal.read(request.deliveryId);
    if (!entry) return undefined;
    assertCloudJournalScope(entry, scope);
    if (entry.kind !== "delivery" || !entry.steer) return "conflict";
    if (entry.requestId === request.requestId && entry.inputHash === computeRuntimeImSteerInputHash(request))
      return entry;
    if (steerNeverStarted(entry) && entry.requestId !== request.requestId) return undefined;
    if (entry.requestId !== request.requestId && differentSteerTarget(entry.steer, request)) {
      await this.#reconcileSteer(entry);
      this.#sendSteerWithoutJournal(request, cloudSteerResult(request, "retry", "turn_starting"));
      return "retiring";
    }
    return "conflict";
  }

  async #replaySteer(entry: CloudJournalDeliveryEntry): Promise<boolean> {
    if (entry.steerResult) {
      this.#sendSteerResult(entry);
      return true;
    }
    if (this.#steerJobs.has(entry.deliveryId)) return true;
    if (entry.phase === "started") {
      await this.#reconcileSteer(entry);
      return true;
    }
    return false;
  }

  #sendSteerWithoutJournal(
    request: import("@opentag/shared").RuntimeImSteerRequest,
    result: RuntimeImSteerResult,
  ): void {
    this.#send({
      type: "delivery:steer:result",
      requestId: request.requestId,
      inputHash: computeRuntimeImSteerInputHash(request),
      result,
    });
  }

  async #steerRoot(request: import("@opentag/shared").RuntimeImSteerRequest, scope: CloudJournalScope) {
    const root = await this.#options.journal.read(request.rootDeliveryId);
    if (root?.kind !== "delivery" || root.steer || root.turnId !== request.expectedTurnId) return undefined;
    assertCloudJournalScope(root, scope);
    return root;
  }

  async #receiveSteer(request: import("@opentag/shared").RuntimeImSteerRequest, root: CloudJournalDeliveryEntry) {
    try {
      return await this.#options.journal.recordSteerReceived(request, root);
    } catch (error) {
      if (error instanceof CloudJournalError && error.code === "conflict") return undefined;
      throw error;
    }
  }

  async #startSteer(
    entry: CloudJournalDeliveryEntry,
    root: CloudJournalDeliveryEntry,
    generation: number,
  ): Promise<void> {
    const request = entry.steer;
    if (!request) return;
    const scope = entry.scope;
    if (request.deadlineAt && Date.parse(request.deadlineAt) <= Date.now()) {
      this.#sendSteerResult(
        await this.#options.journal.recordSteerResult(
          entry.deliveryId,
          scope,
          cloudSteerResult(request, "rejected", "invalid_input"),
        ),
      );
      return;
    }
    const active = this.#active;
    if (!active || active.entryKey !== root.deliveryId || !active.steering) {
      const result =
        root.phase === "received" || active?.entryKey === root.deliveryId
          ? cloudSteerResult(request, "retry", "turn_starting")
          : cloudSteerResult(request, "deferred", "turn_not_running");
      this.#sendSteerResult(await this.#options.journal.recordSteerResult(entry.deliveryId, scope, result));
      return;
    }
    if (generation !== this.#channelGeneration) return;
    entry = await this.#options.journal.markSteerStarted(entry.deliveryId, scope);
    if (generation !== this.#channelGeneration) {
      this.#sendSteerResult(
        await this.#options.journal.recordSteerResult(
          entry.deliveryId,
          scope,
          cloudSteerResult(request, "retry", "turn_starting"),
        ),
      );
      return;
    }
    const job = this.#injectSteer(entry, active)
      .catch((error) => this.#reportPersistenceError(error))
      .finally(() => this.#steerJobs.delete(entry.deliveryId));
    this.#steerJobs.set(entry.deliveryId, job);
  }

  async #injectSteer(entry: CloudJournalDeliveryEntry, active: ActiveTurn): Promise<void> {
    const request = entry.steer;
    if (!request || !active.steering) return;
    let result: RuntimeImSteerResult;
    try {
      if (this.#options.steerWorker)
        result = await this.#options.steerWorker({ request, token: active.steering.token }, active.abort.signal);
      else {
        const response = await this.#options.sandbox.exec(
          SANDBOX_NODE,
          ["-e", CLOUD_STEER_RELAY_SOURCE, cloudSteerSocketPath(request.rootDeliveryId)],
          {
            stdin: JSON.stringify({ token: active.steering.token, request }),
            timeoutMs: 3_000,
            signal: active.abort.signal,
          },
        );
        if (response.code !== 0) throw new Error("CLOUD_STEER_CONTROL_UNAVAILABLE");
        result = RuntimeImSteerResultSchema.parse(JSON.parse(response.stdout));
      }
    } catch {
      result = cloudSteerResult(request, "deferred", "steer_state_unknown");
    }
    await this.#enqueue(async () => {
      const recorded = await this.#options.journal.recordSteerResult(entry.deliveryId, entry.scope, result);
      this.#sendSteerResult(recorded);
      this.#notifyJournalChanged();
    });
  }

  async #reconcileSteer(entry: CloudJournalDeliveryEntry): Promise<void> {
    if (!entry.steer || this.#steerJobs.has(entry.deliveryId)) return;
    if (!entry.steerResult) {
      const result =
        entry.phase === "received"
          ? cloudSteerResult(entry.steer, "retry", "turn_starting")
          : cloudSteerResult(entry.steer, "deferred", "steer_state_unknown");
      entry = await this.#options.journal.recordSteerResult(entry.deliveryId, entry.scope, result);
    }
    this.#sendSteerResult(entry);
  }

  #sendSteerResult(entry: CloudJournalDeliveryEntry): void {
    if (entry.steerResult)
      this.#send({
        type: "delivery:steer:result",
        requestId: entry.requestId,
        inputHash: entry.inputHash,
        result: entry.steerResult,
      });
  }

  async handleSteerAck(frame: RunnerCloudSteerAckFrame): Promise<void> {
    await this.#enqueue(async () => {
      const entry = await this.#options.journal.read(frame.deliveryId);
      if (
        entry?.kind !== "delivery" ||
        !entry.steerResult ||
        frame.requestId !== entry.requestId ||
        frame.inputHash !== entry.inputHash
      )
        return;
      this.#assertCurrentScope(entry);
      await this.#options.journal.clearSteerAcknowledged(
        entry.deliveryId,
        entry.scope,
        frame.requestId,
        frame.inputHash,
      );
      this.#notifyJournalChanged();
    });
  }

  /** Server persisted durable custody: execution may start (the model grant rides along). */
  async handleVerified(frame: RunnerCloudDeliveryVerifiedFrame): Promise<void> {
    // Capture BEFORE waiting for the serial queue: a close may happen while this frame is queued
    // behind another operation, and the frame's grant still belongs to the old connection.
    const generation = this.#channelGeneration;
    await this.#enqueue(async () => {
      const entry = await this.#entryByRequestId(frame.requestId);
      if (entry?.kind !== "delivery" || entry.steer) return; // Already retired or never received.
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
      this.#startup(entry, "verified");
      await this.#queueVerified(entry, frame, generation);
    });
  }

  /** Journal + fsync one Session message, THEN acknowledge receipt. Idempotent across redispatch. */
  async handleSessionMessageRun(frame: RunnerCloudSessionMessageRunFrameV2): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#closed) return;
      const message = frame.message;
      const scope = this.#options.scope();
      if (!scope || message.targetSessionId !== scope.sessionId) {
        this.#log("ignoring session:message:run outside the current Session scope");
        return;
      }
      const entry = await this.#journalSessionDispatch(frame, this.#requireJournalScope());
      if (!entry) return;
      if (entry.phase === "reported") {
        // The immutable settlement is the only answer to a redispatch of completed custody.
        this.#sendSessionSettled(entry);
        return;
      }
      // The receipt always correlates THIS dispatch attempt by its unique request id; the
      // journaled Turn identity stays stable across retries of the same logical message.
      this.#send({
        type: "session:message:received",
        requestId: frame.requestId,
        messageId: entry.messageId,
        turnId: entry.turnId,
        status: "accepted",
        phase: entry.phase === "started" ? "started" : "received",
      });
    });
  }

  /**
   * Journal (or reuse) the entry for one Session run frame; undefined when the dispatch is
   * refused. Every write is fsynced before the caller may send the receipt.
   */
  async #journalSessionDispatch(
    frame: RunnerCloudSessionMessageRunFrameV2,
    journalScope: CloudJournalScope,
  ): Promise<CloudJournalSessionEntry | undefined> {
    const message = frame.message;
    const existing = await this.#options.journal.read(message.messageId);
    const decision = this.#sessionDispatchDecision(existing, frame, journalScope);
    if (decision.kind === "refuse") return undefined;
    if (decision.kind === "reuse") return decision.entry;
    if (decision.kind === "rekey") {
      const updated = await this.#options.journal.updateSessionRequestId(
        message.messageId,
        journalScope,
        frame.requestId,
      );
      this.#retainSessionQueueSlot(decision.entry.requestId, updated.requestId);
      return updated;
    }
    const input = {
      message,
      sessionKind: frame.sessionKind,
      ...(frame.outboxContext ? { outboxContext: frame.outboxContext } : {}),
      scope: journalScope,
      requestId: frame.requestId,
      turnId: randomUUID(),
    };
    if (decision.kind === "replace") {
      const updated = await this.#options.journal.replaceSessionReceived(input);
      this.#retainSessionQueueSlot(decision.entry.requestId, updated.requestId);
      return updated;
    }
    return this.#options.journal.recordSessionReceived(input);
  }

  #retainSessionQueueSlot(previous: string, replacement: string): void {
    if (previous === replacement || !this.#queue.has(previous)) return;
    this.#queue = new Map(
      [...this.#queue].map(([key, queued]) =>
        key === previous ? [replacement, { ...queued, generation: -1 }] : [key, queued],
      ),
    );
  }

  /**
   * How one Session run frame relates to the journaled entry, if any. The request id is the
   * per-attempt identity and the input hash ignores it, so a retry of the same logical message
   * reuses its entry. Ordinary messages may supersede a changed snapshot before execution;
   * scheduled messages have a fixed occurrence identity and reject every changed snapshot.
   * Any started or reported entry is left to converge through its own settlement.
   */
  #sessionDispatchDecision(
    existing: CloudJournalEntry | undefined,
    frame: RunnerCloudSessionMessageRunFrameV2,
    journalScope: CloudJournalScope,
  ):
    | { kind: "fresh" }
    | { kind: "refuse" }
    | { kind: "replace"; entry: CloudJournalSessionEntry }
    | { kind: "rekey"; entry: CloudJournalSessionEntry }
    | { kind: "reuse"; entry: CloudJournalSessionEntry } {
    const messageId = frame.message.messageId;
    if (!existing) return { kind: "fresh" };
    if (existing.kind !== "session-message") {
      this.#log(`refusing re-dispatch of ${messageId}: journal key belongs to a delivery`);
      return { kind: "refuse" };
    }
    try {
      assertCloudJournalScope(existing, journalScope);
    } catch {
      this.#log(`refusing re-dispatch of ${messageId}: journaled under another allocation`);
      return { kind: "refuse" };
    }
    const sameAttempt = existing.requestId === frame.requestId;
    const sameInput = existing.inputHash === computeCloudSessionInputHash(frame);
    // A journaled dispatch may only be re-sent with the SAME dispatch identity and content.
    // Changed input under the same attempt identity is a visible conflict, never a second turn.
    if (sameAttempt && !sameInput) {
      this.#log(`refusing re-dispatch of ${messageId}: journaled input differs for the same dispatch`);
      return { kind: "refuse" };
    }
    if (sameInput) {
      // A new attempt for identical input reuses the entry. A still-`received` entry is first
      // re-correlated to the new attempt; a started/reported entry keeps its settlement identity.
      return existing.phase === "received" ? { kind: "rekey", entry: existing } : { kind: "reuse", entry: existing };
    }
    if (existing.message.scheduledOrigin !== undefined || frame.message.scheduledOrigin !== undefined) {
      // A schedule message ID is derived from its occurrence. Replacing the same ID with another
      // origin, target, runtime, or outbox would turn a conflict into an unauthorized new Turn.
      this.#log(`refusing re-dispatch of ${messageId}: scheduled message snapshot differs`);
      return { kind: "refuse" };
    }
    if (existing.phase === "received") {
      // The journaled input is outdated and the Turn never started: retire the stale entry and
      // journal this attempt (the Server replaces the never-executed custody record in step).
      return { kind: "replace", entry: existing };
    }
    this.#log(
      `refusing re-dispatch of ${messageId}: a ${existing.phase} entry with changed input settles through its own path`,
    );
    return { kind: "refuse" };
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
          this.#queue.delete(entry.requestId);
          this.#notifyJournalChanged();
          this.#scheduleDrain();
        } else this.#log(`ignoring rejected receipt for Session message ${entry.messageId} in phase ${entry.phase}`);
        return;
      }
      if (entry.phase !== "received") return;
      const denial =
        this.#closed || this.#cancelRequested.delete(entry.messageId) ? "cancelled" : this.#admitSession(frame);
      if (denial) {
        this.#queue.delete(entry.requestId);
        await this.#settleSessionTerminal(entry, denial);
        this.#scheduleDrain();
        return;
      }
      this.#startup(entry, "verified");
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
    if (!this.#queue.has(entry.requestId) && this.#queue.size >= CLOUD_TURN_MAX_QUEUED) {
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
    if (!this.#queue.has(entry.requestId) && this.#queue.size >= CLOUD_TURN_MAX_QUEUED) {
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
    void this.#enqueue(() => this.#settleEntryCancellation(kind, entryKey)).catch((error) =>
      this.#reportPersistenceError(error),
    );
  }

  async #settleEntryCancellation(kind: CloudJournalEntry["kind"], entryKey: string): Promise<void> {
    if (!this.#cancelRequested.has(entryKey)) return;
    const entry = await this.#options.journal.read(entryKey);
    if (
      entry?.phase === "started" &&
      (this.#active?.sessionSteers.has(entryKey) || this.#active?.imJoins.has(entryKey))
    )
      return;
    this.#cancelRequested.delete(entryKey);
    if (entry?.kind !== kind || entry.phase !== "received") return;
    this.#assertCurrentScope(entry);
    this.#queue.delete(entry.requestId);
    if (entry.kind === "delivery" && entry.steer) {
      await this.#reconcileSteer(entry);
      return;
    }
    if (entry.kind === "delivery") await this.#reportTerminal(entry, cancelledBeforeStart());
    else await this.#settleSessionTerminal(entry, "cancelled");
    this.#scheduleDrain();
  }

  handleActivityResult(result: TurnActivityResult): void {
    this.#activity.acknowledge(result);
  }

  /** The Server durably recorded (or definitively refused) the report: retire the entry. */
  async handleReportAck(frame: RunnerCloudDeliveryReportAckFrame): Promise<void> {
    await this.#enqueue(async () => {
      const entries = await this.#options.journal.list();
      const entry = entries.find(
        (candidate) => candidate.kind === "delivery" && !candidate.steer && candidate.turnId === frame.turnId,
      );
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
    if (entry.kind === "delivery" && entry.steer) {
      await this.#reconcileSteer(entry);
      return;
    }
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
    if (
      (this.#active?.kind === "delivery" && this.#active.entryKey === entry.deliveryId) ||
      this.#active?.imJoins.has(entry.deliveryId)
    ) {
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
    if (
      this.#active?.sessionSteers.has(entry.messageId) ||
      (this.#active?.kind === "session-message" && this.#active.entryKey === entry.messageId)
    ) {
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
      // Stripped by the channel for a Server that negotiated collaboration below version 3.
      ...(entry.settlement.reason ? { reason: entry.settlement.reason } : {}),
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
    this.#admission = "closed";
    await this.#quiesce();
  }

  async #quiesce(): Promise<void> {
    this.#active?.abort.abort();
    await this.#active?.settled;
    await Promise.all(this.#steerJobs.values());
    await this.#serial.catch(() => undefined);
  }

  /**
   * Quiesce execution and wait for durable Server report acknowledgments before the parent
   * seals storage. This wait never holds the control queue that must receive those acks.
   */
  async drainForRelease(timeoutMs: number): Promise<void> {
    if (this.#admission !== "closed") this.#admission = "draining";
    await this.#quiesce();
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
        if (remaining === 0) {
          if (this.#admission !== "closed") this.#admission = "drained";
          return;
        }
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
    if (entry.kind === "delivery" && entry.steer) {
      await this.#reconcileSteer(entry);
      return;
    }
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

  #deliveryWork(next: QueuedDeliveryVerified): CloudTurnWork<CloudJournalDeliveryEntry> {
    return {
      kind: "delivery",
      key: next.deliveryId,
      requestId: next.frame.requestId,
      generation: next.generation,
      model: next.frame.model,
      matches: (entry): entry is CloudJournalDeliveryEntry => entry?.kind === "delivery",
      markStarted: (entry) => this.#options.journal.markStarted(entry.deliveryId, entry.scope),
      admit: (entry) => this.#admit(entry.delivery, next.frame)?.completion,
      run: (entry, model, signal) => this.#runInSandbox(entry.delivery, model, entry, signal, next.generation),
      settle: (entry, completion, checkpoint) => this.#reportTerminal(entry, completion, checkpoint),
      missingModel: async () => undefined,
    };
  }

  #sessionWork(next: QueuedSessionVerified): CloudTurnWork<CloudJournalSessionEntry> {
    return {
      kind: "session-message",
      key: next.messageId,
      requestId: next.frame.requestId,
      generation: next.generation,
      model: next.frame.model,
      matches: (entry): entry is CloudJournalSessionEntry => entry?.kind === "session-message",
      markStarted: (entry) => this.#options.journal.markSessionStarted(entry.messageId, entry.scope),
      admit: () =>
        this.#admitSession(next.frame) ? { outcome: "failed", executionEffects: "not_started" } : undefined,
      run: (entry, model, signal) => this.#runSessionInSandbox(entry.message, model, entry, signal, next.generation),
      settle: (entry, completion, checkpoint) =>
        checkpoint
          ? this.#settleSessionTerminal(
              entry,
              sessionSettlementOutcome(completion),
              true,
              completion.executionEffects,
              completion.errorReason,
            )
          : this.#settleSessionTerminal(entry, sessionSettlementOutcome(completion)),
      missingModel: (entry) => this.#settleSessionTerminal(entry, "failed"),
    };
  }

  /** Reserve the single turn slot synchronously, then fsync the started boundary, then run. */
  async #startTurn<Entry extends CloudJournalEntry>(
    entry: Entry,
    work: CloudTurnWork<Entry>,
  ): Promise<StartTurnOutcome> {
    if (this.#closed || this.#active) return "wait";
    if (!(this.#options.canStart?.() ?? true)) return "wait";
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: ActiveTurn = {
      abort: new AbortController(),
      entryKey: work.key,
      kind: work.kind,
      settle,
      settled,
      sessionSteers: new Map(),
      imJoins: new Map(),
      joinOrder: [],
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
      const current = await this.#options.journal.read(work.key);
      if (this.#closed) return "wait";
      if (!work.matches(current) || current.phase !== "received") {
        this.#queue.delete(entry.requestId);
        return "settled";
      }
      if (work.generation !== this.#channelGeneration) {
        // A revoked grant leaves the received entry available for fresh verification.
        this.#queue.delete(entry.requestId);
        return "settled";
      }
      if (active.abort.signal.aborted) {
        this.#queue.delete(entry.requestId);
        this.#cancelRequested.delete(work.key);
        await work.settle(current, cancelledBeforeStart());
        return "settled";
      }
      await work.markStarted(current);
      active.execution = this.#executeTurn(work, active)
        .catch((error) => this.#reportPersistenceError(error))
        .finally(() => {
          this.#completeActive(active);
          this.#scheduleDrain();
        });
      return "started";
    } finally {
      // A wait or surfaced journal/namespace failure must not spin on the same FIFO head.
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
      if (this.#closed || this.#sandboxUnusable) return;
      const active = this.#active;
      if (active) {
        if (!(await this.#steerSessionQueueHead(active))) return;
        continue;
      }
      const first = this.#queue.values().next().value;
      if (!first || first.generation !== this.#channelGeneration) return;
      const outcome = await this.#processQueued(first);
      if (outcome !== "continue") return;
    }
  }

  async #steerSessionQueueHead(active: ActiveTurn): Promise<boolean> {
    const steering = active.steering;
    if (
      !steering ||
      !this.#options.sessionSteeringEnabled?.() ||
      active.abort.signal.aborted ||
      active.sessionSteeringBlocked ||
      active.sessionSteerRetry ||
      active.sessionSteers.size + active.imJoins.size >= CLOUD_SESSION_STEER_LIMIT
    )
      return false;
    // Joined entries keep their queue slots until the Run settles. Only the unjoined FIFO head
    // may steer, so a refusal cannot let a later message pass it.
    const next = [...this.#queue.values()].find((queued) =>
      queued.kind === "delivery" ? !active.imJoins.has(queued.deliveryId) : !active.sessionSteers.has(queued.messageId),
    );
    if (next?.kind === "delivery" && next.generation === this.#channelGeneration)
      return this.#joinDeliveryQueueHead(active, next, steering);
    if (next?.kind !== "session-message" || next.generation !== this.#channelGeneration) return false;
    const entry = await this.#options.journal.read(next.messageId);
    if (entry?.kind !== "session-message" || entry.phase !== "received" || entry.requestId !== next.frame.requestId) {
      this.#queue.delete(next.frame.requestId);
      return true;
    }
    this.#assertCurrentScope(entry);
    // Scheduled occurrences retain their own execution context and grant.
    if (entry.message.scheduledOrigin || this.#admitSession(next.frame)) return false;
    if (active.steering !== steering || this.#cancelRequested.has(entry.messageId)) return false;
    const request: CloudSessionSteerRequest = {
      type: "session:message:steer",
      expectedTurnId: steering.turnId,
      sessionKind: entry.sessionKind,
      outboxContext: entry.outboxContext,
      message: entry.message,
    };
    if (Buffer.byteLength(JSON.stringify(request)) > RUNTIME_MAX_FRAME_BYTES) return false;
    return this.#trySessionSteer(active, entry, next, request, steering);
  }

  async #trySessionSteer(
    active: ActiveTurn,
    entry: CloudJournalSessionEntry,
    next: QueuedSessionVerified,
    request: CloudSessionSteerRequest,
    steering: NonNullable<ActiveTurn["steering"]>,
  ): Promise<boolean> {
    // Reconnect and process loss must see a potentially started input before it can reach Pi.
    const started = await this.#options.journal.markSessionStarted(entry.messageId, entry.scope);
    active.sessionSteers.set(entry.messageId, { entry: started, queued: next });
    active.joinOrder.push(entry.messageId);
    const stillAuthorized =
      !this.#closed &&
      active.steering === steering &&
      !active.abort.signal.aborted &&
      !this.#cancelRequested.has(entry.messageId) &&
      next.generation === this.#channelGeneration;
    const result = stillAuthorized ? await this.#relaySessionSteer(active, steering.token, request) : "refused";
    if (result === "accepted") return true;
    if (result === "uncertain") {
      active.sessionSteeringBlocked = true;
      return false;
    }
    const received = await this.#options.journal.requeueUnstartedSessionSteer(started);
    active.sessionSteers.delete(entry.messageId);
    forgetJoin(active, entry.messageId);
    if (next.generation !== this.#channelGeneration) {
      this.#reverifyJoined([{ kind: "session-message", entry: received, queued: next }]);
    } else if (result === "retry" && active.steering === steering) {
      active.sessionSteerRetry = setTimeout(() => {
        active.sessionSteerRetry = undefined;
        this.#scheduleDrain();
      }, 1_000).unref();
    } else {
      active.sessionSteeringBlocked = true;
    }
    return false;
  }

  /**
   * An IM delivery at the FIFO head joins a running visible Session message Turn of the same Session instead of
   * waiting behind it, so its own window never runs out unexecuted. It is reported with that Turn's outcome when the
   * Turn settles. Any other running Turn keeps today's order.
   */
  async #joinDeliveryQueueHead(
    active: ActiveTurn,
    next: QueuedDeliveryVerified,
    steering: NonNullable<ActiveTurn["steering"]>,
  ): Promise<boolean> {
    const entry = await this.#joinableDelivery(active, next, steering);
    if (entry === "dropped") return true;
    if (!entry) return false;
    const request: CloudImJoinRequest = { type: "im:join", expectedTurnId: steering.turnId, delivery: entry.delivery };
    if (Buffer.byteLength(JSON.stringify(request)) > RUNTIME_MAX_FRAME_BYTES) return false;
    // Reconnect and process loss must see a potentially started input before it can reach Pi.
    const started = await this.#options.journal.markStarted(entry.deliveryId, entry.scope);
    active.imJoins.set(entry.deliveryId, { entry: started, queued: next });
    active.joinOrder.push(entry.deliveryId);
    const stillAuthorized =
      !this.#closed &&
      active.steering === steering &&
      !active.abort.signal.aborted &&
      !this.#cancelRequested.has(entry.deliveryId) &&
      next.generation === this.#channelGeneration;
    const result = stillAuthorized ? await this.#relayControl(active, steering.token, request) : "refused";
    if (result === "accepted") return true;
    if (result === "uncertain") {
      active.sessionSteeringBlocked = true;
      return false;
    }
    const received = await this.#options.journal.requeueUnstartedJoin(started);
    active.imJoins.delete(entry.deliveryId);
    forgetJoin(active, entry.deliveryId);
    if (next.generation !== this.#channelGeneration)
      this.#reverifyJoined([{ kind: "delivery", entry: received, queued: next }]);
    else this.#afterRefusedJoin(active, steering, next, result);
    return false;
  }

  /** The received delivery that may join the active Turn, `dropped` for a stale queue slot, or nothing. */
  async #joinableDelivery(
    active: ActiveTurn,
    next: QueuedDeliveryVerified,
    steering: NonNullable<ActiveTurn["steering"]>,
  ): Promise<CloudJournalDeliveryEntry | "dropped" | undefined> {
    if (active.kind !== "session-message" || !this.#options.steeringEnabled?.()) return undefined;
    const root = await this.#options.journal.read(active.entryKey);
    if (root?.kind !== "session-message" || root.sessionKind !== "visible") return undefined;
    const entry = await this.#options.journal.read(next.deliveryId);
    if (entry?.kind !== "delivery" || entry.phase !== "received" || entry.requestId !== next.frame.requestId) {
      this.#queue.delete(next.frame.requestId);
      return "dropped";
    }
    this.#assertCurrentScope(entry);
    if (entry.steer || this.#admit(entry.delivery, next.frame)) return undefined;
    if (active.steering !== steering || this.#cancelRequested.has(entry.deliveryId)) return undefined;
    return entry;
  }

  #afterRefusedJoin(
    active: ActiveTurn,
    steering: NonNullable<ActiveTurn["steering"]>,
    next: QueuedDeliveryVerified,
    result: CloudSessionSteerResult,
  ): void {
    if (result === "retry" && active.steering === steering && next.generation === this.#channelGeneration) {
      active.sessionSteerRetry = setTimeout(() => {
        active.sessionSteerRetry = undefined;
        this.#scheduleDrain();
      }, 1_000).unref();
    } else {
      active.sessionSteeringBlocked = true;
    }
  }

  /** Report one joined IM delivery with the Turn's effective outcome, or hand back an unstarted one. */
  async #settleImJoin(
    active: ActiveTurn,
    join: { entry: CloudJournalDeliveryEntry; queued: QueuedDeliveryVerified },
    completion: CloudWorkerCompletion,
    effective: TurnCompletion,
  ): Promise<JoinedSlot | undefined> {
    const { entry, queued } = join;
    const cancelled = this.#cancelRequested.delete(entry.deliveryId) || active.abort.signal.aborted;
    const receipt = completion.imJoins?.[entry.deliveryId];
    if (!cancelled && !this.#closed && receipt === "not_started") {
      // Its queue slot is still in place on the same channel; a closed channel needs a fresh grant.
      const received = await this.#options.journal.requeueUnstartedJoin(entry);
      return queued.generation !== this.#channelGeneration ? { kind: "delivery", entry: received, queued } : undefined;
    }
    this.#queue.delete(entry.requestId);
    await this.#reportTerminal(entry, cancelled ? JOIN_CANCELLED : joinedCompletion(receipt, effective));
    return undefined;
  }

  /** Settle Session steers and IM joins in arrival order; slots that need a new grant go back in that order. */
  async #settleJoined(
    active: ActiveTurn,
    completion: CloudWorkerCompletion,
    rootOutcome: CloudJournalSettlementOutcome,
    effective: TurnCompletion,
  ): Promise<void> {
    const reverify: JoinedSlot[] = [];
    for (const key of active.joinOrder) {
      const steer = active.sessionSteers.get(key);
      const join = active.imJoins.get(key);
      const slot = steer
        ? await this.#settleSessionSteer(active, steer, completion, rootOutcome)
        : join
          ? await this.#settleImJoin(active, join, completion, effective)
          : undefined;
      if (slot) reverify.push(slot);
    }
    // A disconnected channel revoked these slots' grants, but later work must still wait its turn.
    this.#reverifyJoined(reverify);
  }

  #reverifyJoined(slots: JoinedSlot[]): void {
    if (slots.length === 0) return;
    this.#queue = new Map([...slots.map((slot) => [slot.entry.requestId, slot.queued] as const), ...this.#queue]);
    for (const slot of slots) {
      if (slot.kind === "delivery") this.#sendReceipt(slot.entry);
      else this.#sendSessionProgress(slot.entry);
    }
  }

  async #relaySessionSteer(
    active: ActiveTurn,
    token: string,
    request: CloudSessionSteerRequest,
  ): Promise<CloudSessionSteerResult> {
    return this.#relayControl(active, token, request);
  }

  async #relayControl(
    active: ActiveTurn,
    token: string,
    request: CloudSessionSteerRequest | CloudImJoinRequest,
  ): Promise<CloudSessionSteerResult> {
    try {
      const response = await this.#options.sandbox.exec(
        SANDBOX_NODE,
        ["-e", CLOUD_STEER_RELAY_SOURCE, cloudSteerSocketPath(active.entryKey)],
        { stdin: JSON.stringify({ token, request }), timeoutMs: 3_000, signal: active.abort.signal },
      );
      if (response.code === 0) return CloudSessionSteerResultSchema.parse(JSON.parse(response.stdout));
    } catch (error) {
      const key = request.type === "im:join" ? request.delivery.deliveryId : request.message.messageId;
      this.#log(
        `Cloud ${request.type} was unconfirmed for ${key}: ${error instanceof Error ? error.name : "unknown error"}`,
      );
    }
    return "uncertain";
  }

  async #settleSessionSteer(
    active: ActiveTurn,
    steer: { entry: CloudJournalSessionEntry; queued: QueuedSessionVerified },
    completion: CloudWorkerCompletion,
    rootOutcome: CloudJournalSettlementOutcome,
  ): Promise<JoinedSlot | undefined> {
    const { entry, queued } = steer;
    const cancelled = this.#cancelRequested.delete(entry.messageId) || active.abort.signal.aborted;
    const receipt = completion.sessionSteers?.[entry.messageId];
    if (!cancelled && !this.#closed && receipt === "not_started") {
      const received = await this.#options.journal.requeueUnstartedSessionSteer(entry);
      return queued.generation !== this.#channelGeneration
        ? { kind: "session-message", entry: received, queued }
        : undefined;
    }
    this.#queue.delete(entry.requestId);
    const outcome = cancelled ? "cancelled" : sessionSteerSettlement(receipt, rootOutcome);
    await this.#settleSessionTerminal(entry, outcome, false, undefined, completion.errorReason);
    return undefined;
  }

  /**
   * Process the FIFO head. The entry stays queued until it is actually started, so losing the
   * occupation race can never drop verified work, and cancellation is re-checked after every
   * await so a delivery cancelled mid-drain is never started.
   */
  async #processQueued(next: QueuedVerified): Promise<"continue" | "started" | "stop"> {
    return next.kind === "delivery"
      ? this.#processQueuedWork(this.#deliveryWork(next))
      : this.#processQueuedWork(this.#sessionWork(next));
  }

  async #processQueuedWork<Entry extends CloudJournalEntry>(
    work: CloudTurnWork<Entry>,
  ): Promise<"continue" | "started" | "stop"> {
    if (this.#cancelRequested.delete(work.key)) {
      this.#queue.delete(work.requestId);
      await this.#settleCancelled(work);
      return "continue";
    }
    const entry = await this.#entryByRequestId(work.requestId);
    if (!work.matches(entry) || entry.phase !== "received") {
      this.#queue.delete(work.requestId);
      return "continue";
    }
    if (this.#cancelRequested.delete(work.key)) {
      this.#queue.delete(work.requestId);
      await this.#settleCancelled(work);
      return "continue";
    }
    if (work.generation !== this.#channelGeneration) {
      this.#queue.delete(work.requestId);
      return "continue";
    }
    const denial = work.admit(entry);
    if (denial) {
      this.#queue.delete(work.requestId);
      await work.settle(entry, denial);
      return "continue";
    }
    if (!(this.#options.canStart?.() ?? true)) return "stop";
    const outcome = await this.#startTurn(entry, work);
    if (outcome === "wait") return "stop";
    this.#queue.delete(work.requestId);
    return outcome === "started" ? "started" : "continue";
  }

  async #settleCancelled<Entry extends CloudJournalEntry>(work: CloudTurnWork<Entry>): Promise<void> {
    const entry = await this.#options.journal.read(work.key);
    if (!entry) return;
    this.#assertCurrentScope(entry);
    if (work.matches(entry) && entry.phase === "received") await work.settle(entry, cancelledBeforeStart());
  }

  #completeActive(active: ActiveTurn): void {
    clearTimeout(active.sessionSteerRetry);
    if (this.#active === active) this.#active = undefined;
    active.settle();
  }

  async #executeTurn<Entry extends CloudJournalEntry>(work: CloudTurnWork<Entry>, active: ActiveTurn): Promise<void> {
    const signal = active.abort.signal;
    const current = await this.#options.journal.read(work.key);
    if (!work.matches(current) || current.phase !== "started") return;
    if (work.generation !== this.#channelGeneration || signal.aborted) {
      await work.settle(current, cancelledBeforeStart());
      return;
    }
    if (!work.model) {
      await work.missingModel(current);
      return;
    }
    let completion: CloudWorkerCompletion;
    try {
      completion = await work.run(current, work.model, signal);
    } catch {
      completion = { errorReason: "turn_state_unknown", executionEffects: "may_have_occurred", outcome: "unknown" };
    }
    if (signal.aborted && completion.executionEffects !== "not_started" && completion.outcome !== "completed") {
      completion = { errorReason: "client_shutdown", executionEffects: "may_have_occurred", outcome: "cancelled" };
    }
    active.steering = undefined;
    // Hold occupation through namespace cleanup, checkpoint and durable terminal evidence.
    const cleanup = await this.#cleanupInterrupted(completion);
    const rootOutcome = await work.settle(current, cleanup.completion, true);
    if (active.joinOrder.length > 0) {
      // Joined IM deliveries share the outcome the root settled with, including a failed checkpoint.
      const effective =
        rootOutcome !== sessionSettlementOutcome(cleanup.completion) &&
        cleanup.completion.executionEffects !== "not_started"
          ? workspaceSaveFailure(cleanup.completion)
          : cleanup.completion;
      await this.#enqueue(() => this.#settleJoined(active, completion, rootOutcome, effective));
    }
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
  ): Promise<CloudJournalSettlementOutcome> {
    const saved = checkpoint ? await this.#checkpoint(completion.executionEffects) : undefined;
    const checkpointError = saved?.error;
    if (saved?.failed && completion.executionEffects !== "not_started") completion = workspaceSaveFailure(completion);
    // Record exactly one honest result AFTER the save attempt. A crash before this point leaves
    // started/unknown custody (never automatic replay), not a success whose workspace was lost.
    const report = entry.report ?? this.#buildReport(entry.delivery, entry, completion);
    const recorded = await this.#options.journal.recordReport(entry.deliveryId, entry.scope, report);
    if (recorded.report) {
      this.#notifyJournalChanged();
      this.#send({ type: "delivery:report", report: recorded.report, requestId: randomUUID() });
    }
    if (checkpointError !== undefined) this.#reportCheckpointError(checkpointError);
    return sessionSettlementOutcome(completion);
  }

  #buildReport(
    delivery: DirectImMessageDeliveryRequest,
    entry: CloudJournalDeliveryEntry,
    completion: TurnCompletion,
  ): TurnReportRequest {
    // Cloud delivery v1 has no capability for the newer runtime failure vocabulary.
    const errorReason = ProviderFailureReasonSchema.safeParse(completion.errorReason).success
      ? "provider_failed"
      : completion.errorReason;
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
      ...(errorReason ? { errorReason } : {}),
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
    // The deadline comes first: the model grant expires thirty seconds after it and is never reissued past
    // it, so an expired grant is a Turn that waited past its deadline, and reports as a timeout.
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
    return undefined;
  }

  async #runInSandbox(
    delivery: DirectImMessageDeliveryRequest,
    model: RunnerCloudModelGrant,
    entry: CloudJournalDeliveryEntry,
    signal: AbortSignal,
    generation: number,
  ): Promise<CloudWorkerCompletion> {
    const scope = this.#options.scope();
    if (!scope) throw new Error("The Runner scope is not established");
    // No model/Pi/tool effect exists yet: a stop here must never open credentials or spawn work.
    if (signal.aborted) return cancelledBeforeStart();
    const openExecution =
      this.#options.openExecution ??
      ((input: CloudTurnExecutionOpenInput) => this.#openWorkBridgeExecution(entry, input.scope, input.signal));
    const { execution, credentialOpenMs } = await this.#traceCredentialOpen(entry, () =>
      openExecution({ delivery, scope, turnId: entry.turnId, signal }),
    );
    try {
      // The credential bridge is open, but the worker has not started; close it without calling
      // the worker when a stop or grant revocation landed during the open.
      if (signal.aborted || generation !== this.#channelGeneration) return cancelledBeforeStart();
      const steering = this.#armSteering(entry, this.#options.steeringEnabled?.());
      const stdin = serializeRunnerCloudTurnWorkerStdin({
        delivery,
        ...(steering ? { steering } : {}),
        ...(execution.outboxContext ? { outboxContext: execution.outboxContext } : {}),
        executionDir: execution.executionDir,
        ...(execution.mcpGateway ? { mcpGateway: execution.mcpGateway } : {}),
        ...(execution.webTools ? { webTools: execution.webTools } : {}),
        model,
        ...(execution.sessionCliProof
          ? { sessionCollaboration: { proof: execution.sessionCliProof, serverUrl: this.#options.serverUrl } }
          : {}),
        ...(this.#options.piSessionDirectory ? { piSessionDirectory: this.#options.piSessionDirectory } : {}),
      });
      const timeoutMs = turnTimeoutMs(delivery, Date.now()) + CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS;
      this.#activity.start(delivery, entry.turnId);
      return await this.#runWorker({ stdin, timeoutMs, credentialOpenMs }, signal, execution, {
        ...scope,
        turnId: entry.turnId,
        deliveryId: delivery.deliveryId,
        dispatchRequestId: entry.requestId,
      });
    } finally {
      this.#activity.end(entry.turnId);
      await execution.close().catch((error) => this.#reportPersistenceError(error));
    }
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
    executionEffects?: TurnCompletion["executionEffects"],
    reason?: TurnCompletion["errorReason"],
  ): Promise<CloudJournalSettlementOutcome> {
    const saved = checkpoint ? await this.#checkpoint(executionEffects) : undefined;
    const checkpointError = saved?.error;
    const effective = saved?.failed && executionEffects !== "not_started" ? "failed" : outcome;
    // A checkpoint failure replaces the outcome, so the worker's reason no longer describes it.
    const effectiveReason = effective === outcome ? reason : undefined;
    const recorded = await this.#options.journal.recordSessionSettled(
      entry.messageId,
      entry.scope,
      effective,
      effectiveReason,
    );
    if (recorded.settlement) {
      this.#notifyJournalChanged();
      this.#sendSessionSettled(recorded);
    }
    if (checkpointError !== undefined) this.#reportCheckpointError(checkpointError);
    return effective;
  }

  async #checkpoint(
    executionEffects?: TurnCompletion["executionEffects"],
  ): Promise<{ failed: boolean; error?: unknown }> {
    try {
      await this.#options.checkpoint?.(executionEffects ? { executionEffects } : undefined);
      return { failed: false };
    } catch (error) {
      let failure = error;
      if (executionEffects === "not_started" && this.#options.sandboxReset) {
        this.#markSandboxDirty();
        await this.#resetSandboxNamespace().catch((resetError) => {
          failure = resetError;
        });
      }
      return { failed: true, error: failure };
    }
  }

  async #runSessionInSandbox(
    message: SessionMessageDeliveryRequestV3,
    model: RunnerCloudModelGrant,
    entry: CloudJournalSessionEntry,
    signal: AbortSignal,
    generation: number,
  ): Promise<CloudWorkerCompletion> {
    const scope = this.#options.scope();
    if (!scope) throw new Error("The Runner scope is not established");
    if (signal.aborted) return cancelledBeforeStart();
    // The single execution deadline for this Turn, anchored only now — after the Session queue
    // wait — so legitimate queue wait is never charged against the runtime budget. The in-sandbox
    // worker derives its own timeout from the same absolute deadline and the parent exec backstop
    // adds only the bounded reporting grace, so the worker's `turn_timeout` always wins over the
    // backstop and a slow bridge/worker startup can never record a real timeout as `unknown`.
    const budgetMs = Math.max(1, message.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS);
    const deadlineAt = new Date(Date.now() + budgetMs).toISOString();
    const openExecution =
      this.#options.openSessionExecution ??
      ((input: CloudSessionExecutionOpenInput) => this.#openWorkBridgeExecution(entry, input.scope, input.signal));
    const { execution, credentialOpenMs } = await this.#traceCredentialOpen(entry, () =>
      openExecution({ message, scope, turnId: entry.turnId, signal }),
    );
    try {
      if (signal.aborted || generation !== this.#channelGeneration) return cancelledBeforeStart();
      const steering = this.#armSteering(entry);
      const stdin = serializeRunnerCloudSessionWorkerStdin({
        message,
        ...(steering ? { steering } : {}),
        executionDir: execution.executionDir,
        ...(execution.mcpGateway ? { mcpGateway: execution.mcpGateway } : {}),
        ...(execution.webTools ? { webTools: execution.webTools } : {}),
        model,
        sessionKind: entry.sessionKind,
        deadlineAt,
        ...(entry.outboxContext ? { outboxContext: entry.outboxContext } : {}),
        ...(execution.sessionCliProof
          ? { sessionCollaboration: { proof: execution.sessionCliProof, serverUrl: this.#options.serverUrl } }
          : {}),
        ...(this.#options.piSessionDirectory ? { piSessionDirectory: this.#options.piSessionDirectory } : {}),
      });
      const timeoutMs = Math.max(1, Date.parse(deadlineAt) - Date.now()) + CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS;
      return await this.#runWorker({ stdin, timeoutMs, credentialOpenMs }, signal, execution, {
        ...scope,
        turnId: entry.turnId,
        messageId: message.messageId,
        dispatchRequestId: entry.requestId,
      });
    } finally {
      await execution.close().catch((error) => this.#reportPersistenceError(error));
    }
  }

  #armSteering(entry: CloudJournalEntry, imEnabled = false): ActiveTurn["steering"] {
    if (!imEnabled && !this.#options.sessionSteeringEnabled?.()) return undefined;
    const active = this.#active;
    if (!active) return undefined;
    active.steering = { turnId: entry.turnId, token: randomUUID() };
    this.#scheduleDrain();
    return active.steering;
  }

  /** Both execution paths use the same transport-failure and completion boundary. */
  async #runWorker(
    input: { stdin: string; timeoutMs: number; credentialOpenMs?: number },
    signal: AbortSignal,
    execution: CloudTurnExecutionHandle,
    context: PiDiagnosticContext,
  ): Promise<CloudWorkerCompletion> {
    const workerSignal = execution.bridgeFailureSignal
      ? AbortSignal.any([signal, execution.bridgeFailureSignal])
      : signal;
    this.#startupRecord("native_exec", context);
    const diagnostics = createPiDiagnosticReader({ ...context, clockId: startupClockId }, (record) =>
      this.#options.onDiagnostic?.(record),
    );
    let workerExitCode: number | undefined;
    let execFailed = false;
    let execError: unknown;
    const runWorker =
      this.#options.runWorker ??
      ((input, workerSignal) =>
        this.#options.sandbox.exec(SANDBOX_NODE, [SANDBOX_WORKER_ENTRY, "worker"], {
          signal: workerSignal,
          stdin: input.stdin,
          timeoutMs: input.timeoutMs,
          onStderr: input.onStderr,
        }));
    try {
      // The worker owns its runtime deadline; the exec backstop includes the reporting grace.
      const exec = await runWorker({ ...input, onStderr: diagnostics.consume }, workerSignal);
      workerExitCode = exec.code;
      if (signal.aborted) {
        return { errorReason: "client_shutdown", executionEffects: "may_have_occurred", outcome: "cancelled" };
      }
      if (execution.bridgeFailure?.()) {
        return { errorReason: "turn_state_unknown", executionEffects: "may_have_occurred", outcome: "unknown" };
      }
      const completion = parseWorkerCompletion(exec.stdout);
      // A nonzero exit cannot corroborate success, even when stdout claims completion.
      if (exec.code !== 0 && completion.outcome === "completed") {
        return { errorReason: "provider_failed", executionEffects: "may_have_occurred", outcome: "failed" };
      }
      return completion;
    } catch (error) {
      execFailed = true;
      execError = error;
      if (execution.bridgeFailure?.() && !signal.aborted) {
        return { errorReason: "turn_state_unknown", executionEffects: "may_have_occurred", outcome: "unknown" };
      }
      throw error;
    } finally {
      diagnostics.finish({
        ...workerStopDiagnostic(
          workerExitCode,
          execFailed,
          execError,
          signal.aborted,
          Boolean(execution.bridgeFailure?.()),
        ),
        execTimeoutMs: input.timeoutMs,
        ...(input.credentialOpenMs !== undefined ? { credentialOpenMs: input.credentialOpenMs } : {}),
      });
    }
  }

  /**
   * Default per-turn credential bridge: open a #633 execution through the Runner channel tunnel,
   * start the trusted loopback adapter, publish ONLY the per-turn public material the native
   * Sandbox mounts, and open the per-execution HTTP/2 provider bridge (`sandbox exec` duplex)
   * whose in-Sandbox helper owns the two fixed loopback entry ports. The parent side of the
   * bridge dials exactly two enumerated targets — this execution's own adapter ports — and no
   * parent Unix socket is ever mounted. The private CA/journal/bootstrap material stays in the
   * unmounted private root. Nothing runs in this parent beyond credential relaying; the worker
   * executes inside the Sandbox.
   */
  async #openWorkBridgeExecution(
    entry: CloudJournalEntry,
    scope: CloudTurnScope,
    signal: AbortSignal,
  ): Promise<CloudTurnExecutionHandle> {
    const message = entry.kind === "delivery" ? entry.delivery : entry.message;
    return this.#openRelayExecution({
      agentId: message.agentId,
      placementGeneration: message.placementGeneration,
      sessionId: entry.kind === "delivery" ? entry.delivery.sessionId : entry.message.targetSessionId,
      signal,
      source:
        entry.kind === "delivery"
          ? { kind: "delivery", deliveryId: entry.deliveryId, turnId: entry.turnId }
          : { kind: "session-message", messageId: entry.messageId },
      scope,
      contextTrees: message.runtime.contextTrees,
      agentSlug: managedAgentSlug(message.runtime.instructions.platform),
    });
  }

  async #openContextTreeGateway(
    input: CloudRelayExecutionInput,
    openRelay: RuntimeCredentialRelay,
    inSandboxExecutionDir: string,
  ): Promise<ContextTreeCommandGateway | undefined> {
    if (!input.contextTrees.length || !openRelay.services?.some((service) => service.service === "context-tree"))
      return undefined;
    const pack = resolveContextTreePackage();
    if (!pack) {
      // The Turn still runs; without a gateway URL the worker reports each source unavailable.
      this.#log("Context Tree package is unavailable; opening the execution without the command gateway");
      return undefined;
    }
    const treeHome = "/workspace/.opentag/context-tree/home";
    const contextTreeGateway = new ContextTreeCommandGateway({
      parent: openRelay,
      workspace: "/workspace",
      sources: input.contextTrees,
      stateDirectory: join(this.#options.stateDirectory, "context-tree-command-sessions", input.agentId),
      sessionHints: createSandboxContextTreeSessionHints(this.#options.sandbox, "/workspace"),
      environment: () => {
        const routing = {
          OPENTAG_PROVIDER_PROXY_URL: `http://127.0.0.1:${CLOUD_CONNECT_PROXY_PORT}`,
          OPENTAG_PROVIDER_CA_PATH: `${inSandboxExecutionDir}/${CLOUD_SANDBOX_CA_FILE}`,
        };
        return {
          ...routing,
          ...providerRoutingEnvironment(routing),
          HOME: treeHome,
          GIT_AUTHOR_NAME: input.agentSlug ?? "opentag-cloud-agent",
          GIT_AUTHOR_EMAIL: `${input.agentSlug ?? "opentag-cloud-agent"}@localhost`,
          GIT_COMMITTER_NAME: input.agentSlug ?? "opentag-cloud-agent",
          GIT_COMMITTER_EMAIL: `${input.agentSlug ?? "opentag-cloud-agent"}@localhost`,
        };
      },
      execute: async (args, environment, commandSignal) => {
        const result = await this.#options.sandbox.exec(
          SANDBOX_NODE,
          ["--input-type=module", "-e", CONTEXT_TREE_COMMAND_WORKER_SOURCE],
          {
            timeoutMs: 122_000,
            signal: commandSignal,
            stdin: JSON.stringify({ cli: pack.cliPath, args, environment, cwd: "/workspace" }),
          },
        );
        const parsed = z
          .object({ code: z.number().int(), stdout: z.string(), stderr: z.string() })
          .strict()
          .parse(JSON.parse(result.stdout));
        return parsed;
      },
    });
    try {
      await contextTreeGateway.listen("tcp");
      return contextTreeGateway;
    } catch (error) {
      await contextTreeGateway.close();
      throw error;
    }
  }

  async #openRelayExecution(input: CloudRelayExecutionInput): Promise<CloudTurnExecutionHandle> {
    const scope = input.scope;
    if (!scope.resourceUid) throw new Error("The Sandbox allocation UID is not tracked yet");
    const connection = new CloudCredentialConnection(this.#options.credentialChannel());
    let relay: Awaited<ReturnType<typeof RuntimeCredentialRelay.open>> | undefined;
    let adapter: Awaited<ReturnType<typeof RuntimeProxyLoopbackAdapter.start>> | undefined;
    let bridge: NativeProviderBridge | undefined;
    let contextTreeGateway: ContextTreeCommandGateway | undefined;
    let webChannel: NativeWebExecutionChannel | undefined;
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
      await step(() => contextTreeGateway?.close());
      await releaseRelayExecutionResources({
        step,
        connection,
        reason,
        onBridgeCloseFailure: () => {
          this.#sandboxUnusable = true;
        },
        webChannel,
        bridge,
        adapter,
        relay,
        publicDirectory,
        privateDirectory,
      });
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
          ...(this.#options.relayOptions ?? {}),
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
          /*
           * Web and MCP are both requested on every real IM and internal Session execution. The
           * Server grants each per its own policy — web is deployment-wide, MCP depends on the
           * Agent's mounts — and withholds silently when it does not. A request is not an
           * authorization: without a grant on the open result neither channel below is opened.
           */
          services: ["mcp", "web", "context-tree"],
        },
        input.signal,
      );
      const openRelay = relay;
      const mcpGranted = openRelay.services?.some(
        (service) => service.service === "mcp" && service.scopes.includes("mcp:tools"),
      );
      const mcpGrant = mcpGranted ? await openRelay.acquireMcpGatewayToken(input.signal) : undefined;
      privateDirectory = await mkdtemp(join(this.#options.stateDirectory, "turn-private-"));
      const publicRoot = this.#options.publicDirectory ?? join(this.#options.stateDirectory, "public");
      await mkdir(publicRoot, { recursive: true, mode: 0o700 });
      publicDirectory = await mkdtemp(join(publicRoot, "turn-"));
      adapter = await RuntimeProxyLoopbackAdapter.start({
        executionId: openRelay.executionId,
        localHandleFor: (provider) => {
          const owner = provider === "github" ? contextTreeGateway?.relayFor(provider) : openRelay;
          return owner?.providers.some((entryPoint) => entryPoint.provider === provider)
            ? owner.localHandleFor(provider)
            : undefined;
        },
        materialDir: join(privateDirectory, "adapter"),
        openStream: (request) => {
          const owner =
            request.provider === "github"
              ? contextTreeGateway?.relayFor(request.provider, request.localHandle)
              : openRelay;
          if (!owner) throw new Error("Provider unavailable");
          return owner.openProviderStream(request);
        },
        verifyHandle: (provider, handle) =>
          (provider === "github" ? contextTreeGateway?.relayFor(provider, handle) : openRelay)?.verifyLocalHandle(
            provider,
            handle,
          ) ?? false,
      });
      const inSandboxExecutionDir = `${CLOUD_EXECUTION_MOUNT}/${basename(publicDirectory)}`;
      contextTreeGateway = await this.#openContextTreeGateway(input, openRelay, inSandboxExecutionDir);
      // Public files only: the native Sandbox never receives a parent socket. The HTTP/2 bridge
      // helper opened next owns the two loopback entry ports the published environment names.
      await publishExecutionMaterial({ adapter, relay: openRelay }, publicDirectory, {
        includeEntryPrograms: false,
        publicMountPath: inSandboxExecutionDir,
        ...(contextTreeGateway ? { contextTreeUrl: `http://127.0.0.1:${CLOUD_CONTEXT_TREE_PORT}` } : {}),
      });
      const openAdapter = adapter;
      bridge = await NativeProviderBridge.open({
        sandbox: this.#options.sandbox,
        signal: input.signal,
        targets: {
          connect: loopbackPortOf(openAdapter.connectProxyUrl),
          slack: loopbackPortOf(openAdapter.slackApiHost),
          ...(contextTreeGateway?.port ? { contextTree: contextTreeGateway.port } : {}),
        },
      });
      const openBridge = bridge;
      // Web is a platform default when granted. A missing local artifact or channel must surface as
      // a failed execution, not silently remove the tools from an otherwise successful Agent turn.
      const webTools = await this.#openGrantedWebChannel({
        relay: openRelay,
        signal: input.signal,
        onOpened: (channel) => {
          webChannel = channel;
        },
      });
      return {
        executionDir: inSandboxExecutionDir,
        ...executionOutboxContext(openRelay),
        ...(mcpGrant
          ? {
              mcpGateway: { url: new URL(MCP_GATEWAY_PATH, this.#options.serverUrl).toString(), token: mcpGrant.token },
            }
          : {}),
        ...(webTools ? { webTools } : {}),
        ...(openRelay.sessionCliProof ? { sessionCliProof: openRelay.sessionCliProof } : {}),
        bridgeFailure: () => openBridge.failure,
        bridgeFailureSignal: openBridge.failureSignal,
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
      if (error instanceof NativeSandboxError && error.code === "delete_failed") {
        this.#sandboxUnusable = true;
        this.#reportPersistenceError(error);
      }
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

  /** A withheld grant leaves web off; a granted service must be usable or fail this execution. */
  async #openGrantedWebChannel(input: {
    relay: RuntimeCredentialRelay;
    signal: AbortSignal;
    onOpened: (channel: NativeWebExecutionChannel) => void;
  }): Promise<{ extensionPath: string; socketPath: string } | undefined> {
    const granted = input.relay.services?.some((service) => service.service === "web" && service.scopes.length > 0);
    if (!granted) return undefined;
    // The bearer is fetched separately from the open result and stays in this trusted parent.
    const token = await input.relay.acquireWebGatewayToken(input.signal);
    if (!token) throw new Error("The granted Cloud web service did not provide an execution credential");
    return this.#openExecutionWebChannel({
      executionId: input.relay.executionId,
      signal: input.signal,
      token: token.token,
      onOpened: input.onOpened,
    });
  }

  /** Open the native channel after a grant; missing Runner components fail the execution. */
  async #openExecutionWebChannel(input: {
    executionId: string;
    signal: AbortSignal;
    token: string;
    onOpened: (channel: NativeWebExecutionChannel) => void;
  }): Promise<{ extensionPath: string; socketPath: string }> {
    const gateway = this.#options.webGateway;
    const extensionPath = this.#options.webExtensionPath;
    if (!gateway || !extensionPath) throw new Error("The Cloud web tools extension or gateway is unavailable");
    const client = new WebToolsServerClient({
      serverUrl: this.#options.serverUrl,
      bearerToken: input.token,
      ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
    });
    try {
      const channel = await gateway.openExecution({
        sandbox: this.#options.sandbox,
        authority: {
          executionIdentity: input.executionId,
          signal: input.signal,
          dispatch: createExecutionWebDispatch({ client, executionId: input.executionId }),
        },
      });
      input.onOpened(channel);
      return { extensionPath, socketPath: channel.socketPath };
    } catch (error) {
      // The outer execution cleanup revokes this bearer before a successor can open.
      this.#log(`cloud web channel did not open: ${errorMessage(error)}`);
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

  #reportCheckpointError(error: unknown): void {
    if (error instanceof CloudWorkspaceError && !error.retryable && error.archiveErrorCode !== undefined) {
      this.#log(`cloud workspace checkpoint failed: ${error.message}`);
      return;
    }
    this.#reportPersistenceError(error);
  }

  #reportPersistenceError(error: unknown): void {
    this.#log(`cloud delivery durable boundary failed: ${error instanceof Error ? error.message : String(error)}`);
    this.#options.onPersistenceError?.(error);
  }

  async #traceCredentialOpen(entry: CloudJournalEntry, open: () => Promise<CloudTurnExecutionHandle>) {
    const started = performance.now();
    try {
      const execution = await open();
      const credentialOpenMs = performance.now() - started;
      this.#startup(entry, "credential_open", { durationMs: credentialOpenMs, outcome: "completed" });
      return { execution, credentialOpenMs };
    } catch (error) {
      this.#startup(entry, "credential_open", { durationMs: performance.now() - started, outcome: "failed" });
      throw error;
    }
  }

  #startup(
    entry: CloudJournalEntry,
    event: "verified" | "credential_open",
    timing?: { durationMs: number; outcome: "completed" | "failed" },
  ): void {
    this.#startupRecord(
      event,
      {
        ...entry.scope,
        turnId: entry.turnId,
        dispatchRequestId: entry.requestId,
        ...(entry.kind === "delivery" ? { deliveryId: entry.deliveryId } : { messageId: entry.messageId }),
      },
      timing,
    );
  }

  #startupRecord(
    event: "received" | "verified" | "credential_open" | "native_exec",
    context: PiDiagnosticContext,
    timing?: { durationMs: number; outcome: "completed" | "failed" },
  ): void {
    try {
      this.#options.onStartupDiagnostic?.({
        ...context,
        module: "cloud-runner",
        operation: "runner.turn.startup",
        event,
        timestamp: new Date().toISOString(),
        clockId: startupClockId,
        monotonicMs: performance.now(),
        ...timing,
      });
    } catch {
      // Startup diagnostics must never affect custody or execution.
    }
  }

  #send(frame: RunnerClientFrame): void {
    try {
      this.#options.send(frame);
      if (
        frame.type === "delivery:received" ||
        (frame.type === "session:message:received" && frame.status === "accepted")
      ) {
        const scope = this.#options.scope();
        if (scope)
          this.#startupRecord("received", {
            ...scope,
            turnId: frame.turnId,
            dispatchRequestId: frame.requestId,
            ...(frame.type === "delivery:received" ? { deliveryId: frame.deliveryId } : { messageId: frame.messageId }),
          });
      }
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

/** The Session's own kind reaches the worker through this, because a delivery does not carry it. */
export function executionOutboxContext(relay: Pick<RuntimeCredentialRelay, "providers" | "cliMetadataFor">): {
  outboxContext?: RuntimeImOutboxContext;
} {
  const im = relay.providers.find((entry) => entry.provider === "feishu" || entry.provider === "slack");
  const outboxContext = im && runtimeProxyOutboxContext(relay.cliMetadataFor(im.provider));
  return outboxContext ? { outboxContext } : {};
}

/**
 * Release every resource one relay execution acquired, in the order the teardown requires.
 *
 * The web channel goes first: its in-Sandbox bridge process and its request listener are removed
 * while the trusted parent still owns the execution, so no successor execution can observe a stale
 * socket or an inherited authority. Then the provider bridge, whose helper and every in-flight
 * parent connection stop before the trusted adapter/relay they dialed. One failing step never stops
 * the remaining ones; the caller records the failures.
 */
async function releaseRelayExecutionResources(input: {
  readonly step: (operation: () => Promise<void> | void) => Promise<void>;
  readonly connection: CloudCredentialConnection;
  readonly reason: "execution_closed" | "open_failed";
  readonly onBridgeCloseFailure: () => void;
  readonly webChannel?: NativeWebExecutionChannel;
  readonly bridge?: NativeProviderBridge;
  readonly adapter?: RuntimeProxyLoopbackAdapter;
  readonly relay?: RuntimeCredentialRelay;
  readonly publicDirectory?: string;
  readonly privateDirectory?: string;
}): Promise<void> {
  if (input.webChannel) await input.step(() => input.webChannel?.close());
  if (input.bridge) {
    const bridge = input.bridge;
    await input.step(async () => {
      try {
        await bridge.close();
      } catch (error) {
        input.onBridgeCloseFailure();
        throw error;
      }
    });
  }
  if (input.adapter) await input.step(() => input.adapter?.close());
  if (input.relay) await input.step(() => input.relay?.close(input.reason));
  await input.step(() => input.connection.close());
  if (input.publicDirectory) {
    const directory = input.publicDirectory;
    await input.step(() => rm(directory, { recursive: true, force: true }));
  }
  if (input.privateDirectory) {
    const directory = input.privateDirectory;
    await input.step(() => rm(directory, { recursive: true, force: true }));
  }
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

type JoinedSlot =
  | { kind: "session-message"; entry: CloudJournalSessionEntry; queued: QueuedSessionVerified }
  | { kind: "delivery"; entry: CloudJournalDeliveryEntry; queued: QueuedDeliveryVerified };

function forgetJoin(active: ActiveTurn, key: string): void {
  const index = active.joinOrder.indexOf(key);
  if (index >= 0) active.joinOrder.splice(index, 1);
}

const JOIN_CANCELLED: TurnCompletion = {
  errorReason: "client_shutdown",
  executionEffects: "may_have_occurred",
  outcome: "cancelled",
};

/**
 * A joined IM delivery shares the Turn it joined: processed input completes with it, and any other end is that
 * Turn's failure. Its final text belongs to the Session message, so the IM report carries none.
 */
function joinedCompletion(
  receipt: import("../agent-runtime/types.js").AgentSteerOutcome | undefined,
  root: TurnCompletion,
): TurnCompletion {
  if (receipt === undefined) return UNKNOWN_COMPLETION;
  if (root.outcome !== "completed") {
    const { finalText: _text, ...failed } = root;
    return failed;
  }
  return receipt === "processed"
    ? { executionEffects: "completed", outcome: "completed" }
    : { errorReason: "turn_state_unknown", executionEffects: "may_have_occurred", outcome: "unknown" };
}

function sessionSteerSettlement(
  receipt: import("../agent-runtime/types.js").AgentSteerOutcome | undefined,
  rootOutcome: CloudJournalSettlementOutcome,
): CloudJournalSettlementOutcome {
  if (receipt === undefined) return "unknown";
  if (rootOutcome !== "completed") return rootOutcome;
  return receipt === "processed" ? "completed" : "failed";
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

/**
 * Enumerated bridge target extraction: the parent maps the two bridge entries to exactly the two
 * loopback TCP ports of its own per-execution adapter. Anything that is not a numeric 127.0.0.1
 * port is a composition bug and fails before any helper is spawned; no address or path is ever
 * taken from the Sandbox or from a caller.
 */
function loopbackPortOf(endpoint: string): number {
  const url = new URL(endpoint);
  if (url.hostname !== "127.0.0.1") {
    throw new Error("The execution adapter endpoint is not a fixed loopback address");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("The execution adapter endpoint has no valid loopback port");
  }
  return port;
}

/** One-line error text for logs and aggregate cleanup errors. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse exactly one bounded in-sandbox result line; malformed output is an explicit unknown. */
function parseWorkerCompletion(stdout: string): CloudWorkerCompletion {
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

function differentSteerTarget(
  left: import("@opentag/shared").RuntimeImSteerRequest,
  right: import("@opentag/shared").RuntimeImSteerRequest,
): boolean {
  return left.rootDeliveryId !== right.rootDeliveryId || left.expectedTurnId !== right.expectedTurnId;
}
