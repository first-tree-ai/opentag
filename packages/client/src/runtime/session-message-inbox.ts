import {
  hashTuple,
  type InputRejectReason,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  type RuntimeImOutboxContext,
  type SessionMessageDeliveryRequest,
  SessionMessageDeliveryRequestSchema,
  type SessionMessageDeliveryResult,
} from "@opentag/shared";
import type { AgentInput } from "../agent-runtime/types.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { AdmissionController } from "./admission-controller.js";
import type { ImCredentialEnvironmentManager } from "./im-credential-environment-manager.js";
import type { ProviderCliTurnPlanPrepareInput } from "./provider-cli/turn-plan-manager.js";
import { buildProviderOutboxInstructions } from "./provider-outbox-instructions.js";
import {
  DEFAULT_RUNTIME_RETRY_POLICY,
  type DurableFailure,
  type DurableWorkRecord,
  defaultRuntimeRetryScheduler,
  durableFailureFromUnknown,
  type RuntimeDurabilityMetrics,
  type RuntimeDurabilityStore,
  type RuntimeRetryPolicy,
  type RuntimeRetryScheduler,
  retryDelay,
  retryExhausted,
} from "./runtime-durability.js";
import type { SessionReconciler } from "./session-reconciler.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";

interface QueuedMessage {
  request: SessionMessageDeliveryRequest;
  hash: string;
}

interface RememberedMessage {
  hash: string;
  status: "accepted" | "rejected" | "retryable" | "succeeded" | "failed" | "dead-letter";
  reason?: InputRejectReason;
}

export interface SessionMessageInboxOptions {
  admission: AdmissionController;
  cliCommand?: string;
  credentialEnvironment: Pick<ImCredentialEnvironmentManager, "cleanup" | "prepare">;
  turnPlan?: {
    cleanup(input: ProviderCliTurnPlanPrepareInput): Promise<void>;
    prepare(input: ProviderCliTurnPlanPrepareInput): Promise<unknown>;
  };
  imCredentialGrantVersion(): number | undefined;
  logger?: Pick<ClientLogger, "warn">;
  maxQueuedPerSession?: number;
  maxQueuedTotal?: number;
  maxRememberedMessages?: number;
  metrics?: RuntimeDurabilityMetrics;
  now?: () => number;
  onFailure?(failure: DurableFailure): void;
  persistence?: RuntimeDurabilityStore;
  retryPolicy?: Partial<RuntimeRetryPolicy>;
  scheduler?: RuntimeRetryScheduler;
  timeoutScheduler?: RuntimeRetryScheduler;
  reconciler: Pick<
    SessionReconciler,
    "checkSessionMessageDelivery" | "clearActivity" | "setActivity" | "withAgentLock"
  >;
  runtimeManager: Pick<SessionRuntimeManager, "ensureRuntime" | "sessionKind">;
}

export class SessionMessageInbox {
  readonly #admission: AdmissionController;
  readonly #cliCommand: string;
  readonly #credentialEnvironment: SessionMessageInboxOptions["credentialEnvironment"];
  readonly #turnPlan: SessionMessageInboxOptions["turnPlan"];
  readonly #imCredentialGrantVersion: SessionMessageInboxOptions["imCredentialGrantVersion"];
  readonly #logger: Pick<ClientLogger, "warn">;
  readonly #maxQueuedPerSession: number;
  readonly #maxQueuedTotal: number;
  readonly #maxRememberedMessages: number;
  readonly #metrics?: RuntimeDurabilityMetrics;
  readonly #now: () => number;
  readonly #onFailure?: SessionMessageInboxOptions["onFailure"];
  readonly #persistence?: RuntimeDurabilityStore;
  readonly #retryPolicy: RuntimeRetryPolicy;
  readonly #scheduler: RuntimeRetryScheduler;
  readonly #timeoutScheduler: RuntimeRetryScheduler;
  readonly #reconciler: SessionMessageInboxOptions["reconciler"];
  readonly #runtimeManager: SessionMessageInboxOptions["runtimeManager"];
  readonly #queues = new Map<string, QueuedMessage[]>();
  readonly #drains = new Map<string, Promise<void>>();
  readonly #records = new Map<string, DurableWorkRecord<SessionMessageDeliveryRequest>>();
  readonly #remembered = new Map<string, RememberedMessage>();
  readonly #abort = new AbortController();
  readonly #retryTimers = new Map<string, { cancel(): void }>();
  readonly #readyPromise: Promise<void>;
  #queuedTotal = 0;

  constructor(options: SessionMessageInboxOptions) {
    this.#admission = options.admission;
    this.#cliCommand = options.cliCommand ?? "opentag";
    this.#credentialEnvironment = options.credentialEnvironment;
    this.#turnPlan = options.turnPlan;
    this.#imCredentialGrantVersion = options.imCredentialGrantVersion;
    this.#logger = options.logger ?? createLogger("session-message-inbox");
    this.#maxQueuedPerSession = positive(options.maxQueuedPerSession ?? 64, "maxQueuedPerSession");
    this.#maxQueuedTotal = positive(options.maxQueuedTotal ?? 256, "maxQueuedTotal");
    this.#maxRememberedMessages = positive(options.maxRememberedMessages ?? 512, "maxRememberedMessages");
    this.#metrics = options.metrics;
    this.#now = options.now ?? Date.now;
    this.#onFailure = options.onFailure;
    this.#persistence = options.persistence;
    this.#retryPolicy = normalizeRetryPolicy(options.retryPolicy);
    this.#scheduler = options.scheduler ?? defaultRuntimeRetryScheduler;
    this.#timeoutScheduler = options.timeoutScheduler ?? defaultRuntimeRetryScheduler;
    this.#reconciler = options.reconciler;
    this.#runtimeManager = options.runtimeManager;
    this.#readyPromise = this.#hydrate();
  }

  ready(): Promise<void> {
    return this.#readyPromise;
  }

  getState(messageId: string): DurableWorkRecord<SessionMessageDeliveryRequest> | undefined {
    return [...this.#records.values()].find((record) => record.payload.messageId === messageId);
  }

  metricsSnapshot(): ReturnType<RuntimeDurabilityMetrics["snapshot"]> | undefined {
    return this.#metrics?.snapshot();
  }

  async accept(input: SessionMessageDeliveryRequest): Promise<SessionMessageDeliveryResult> {
    await this.#readyPromise;
    const request = SessionMessageDeliveryRequestSchema.parse(input);
    const key = `${request.targetSessionId}:${request.messageId}`;
    const hash = hashTuple([request.sourceSessionId, request.targetSessionId, request.agentId, request.content]);
    return this.#reconciler.withAgentLock(request.agentId, () => this.#acceptLocked(request, key, hash));
  }

  async #acceptLocked(
    request: SessionMessageDeliveryRequest,
    key: string,
    hash: string,
  ): Promise<SessionMessageDeliveryResult> {
    const remembered = this.#rememberedResult(request, key, hash);
    if (remembered) return remembered;
    if (this.#abort.signal.aborted) return deliveryResult(request, "rejected", "client_busy");
    const reason = this.#acceptanceReason(request);
    if (reason) {
      this.#remember(
        key,
        retryableAuthorityReason(reason) ? { hash, status: "retryable" } : { hash, status: "rejected", reason },
      );
      return deliveryResult(request, "rejected", reason);
    }
    return this.#enqueueAccepted(request, key, hash);
  }

  #rememberedResult(
    request: SessionMessageDeliveryRequest,
    key: string,
    hash: string,
  ): SessionMessageDeliveryResult | undefined {
    const remembered = this.#remembered.get(key);
    if (!remembered) return undefined;
    if (remembered.hash !== hash) return deliveryResult(request, "rejected", "input_conflict");
    if (remembered.status === "dead-letter" || remembered.status === "failed") {
      return deliveryResult(request, "rejected", remembered.reason ?? "provider_unavailable");
    }
    return remembered.status === "retryable" ? undefined : deliveryResult(request, "accepted");
  }

  #acceptanceReason(request: SessionMessageDeliveryRequest): InputRejectReason | undefined {
    const authorityReason = this.#reconciler.checkSessionMessageDelivery(request);
    if (authorityReason) return authorityReason;
    if (
      this.#runtimeManager.sessionKind(request.targetSessionId) === "visible" &&
      this.#imCredentialGrantVersion() !== 2
    ) {
      return "session_not_ready";
    }
    return undefined;
  }

  async #enqueueAccepted(
    request: SessionMessageDeliveryRequest,
    key: string,
    hash: string,
  ): Promise<SessionMessageDeliveryResult> {
    const queue = this.#queues.get(request.targetSessionId) ?? [];
    if (queue.length >= this.#maxQueuedPerSession || this.#queuedTotal >= this.#maxQueuedTotal) {
      return deliveryResult(request, "rejected", "client_busy");
    }
    queue.push({ request, hash });
    this.#queues.set(request.targetSessionId, queue);
    this.#queuedTotal += 1;
    try {
      await this.#persist({
        acceptedAt: this.#now(),
        attempts: 0,
        key,
        kind: "session-message",
        payload: request,
        status: "accepted",
        updatedAt: this.#now(),
      });
    } catch {
      queue.pop();
      this.#queuedTotal -= 1;
      this.#remember(key, { hash, status: "rejected", reason: "provider_unavailable" });
      this.#logger.warn(
        { code: "SESSION_MESSAGE_PERSISTENCE_FAILED", messageId: request.messageId },
        "Session message persistence failed",
      );
      return deliveryResult(request, "rejected", "provider_unavailable");
    }
    this.#remember(key, { hash, status: "accepted" });
    this.#startDrain(request.targetSessionId);
    return deliveryResult(request, "accepted");
  }

  stop(): void {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort(new Error("Session message inbox stopped"));
    for (const timer of this.#retryTimers.values()) timer.cancel();
    this.#retryTimers.clear();
    this.#queues.clear();
    this.#queuedTotal = 0;
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#drains.values()]);
  }

  #startDrain(sessionId: string): void {
    if (this.#drains.has(sessionId) || this.#abort.signal.aborted) return;
    const drain = this.#drain(sessionId).finally(() => {
      if (this.#drains.get(sessionId) === drain) this.#drains.delete(sessionId);
      if ((this.#queues.get(sessionId)?.length ?? 0) > 0) this.#startDrain(sessionId);
    });
    this.#drains.set(sessionId, drain);
    void drain.catch(() => undefined);
  }

  async #drain(sessionId: string): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const queue = this.#queues.get(sessionId);
      const next = queue?.[0];
      if (!next) {
        this.#queues.delete(sessionId);
        return;
      }
      let reservation = this.#admission.reserve(sessionId, next.request.agentId);
      while (!reservation.accepted) {
        await this.#admission.waitForRelease(this.#abort.signal);
        reservation = this.#admission.reserve(sessionId, next.request.agentId);
      }
      queue?.shift();
      this.#queuedTotal -= 1;
      reservation.reservation.markActive();
      await this.#runMessage(sessionId, next, reservation.reservation);
    }
  }

  async #runMessage(
    sessionId: string,
    next: QueuedMessage,
    reservation: { release(): void; markActive(): void },
  ): Promise<void> {
    const runId = `session-message-${next.request.messageId}`;
    const key = `${next.request.targetSessionId}:${next.request.messageId}`;
    let current = this.#records.get(key);
    let credentialPrepared = false;
    let turnPlanInput: ProviderCliTurnPlanPrepareInput | undefined;
    let phase = "runtime";
    try {
      if (current) current = await this.#transition(current, "running");
      await this.#reconciler.withAgentLock(next.request.agentId, async () => {
        this.#reconciler.setActivity(sessionId, {
          phase: "running",
          deliveryId: next.request.messageId,
          turnId: runId,
        });
      });
      const sessionKind = this.#runtimeManager.sessionKind(sessionId);
      let outboxContext: RuntimeImOutboxContext | undefined;
      if (sessionKind === "visible") {
        phase = "credential";
        const prepared = await this.#prepareCredentials(sessionId, next.request);
        credentialPrepared = true;
        if (!prepared.outboxContext) {
          this.#logger.warn(
            { code: "SESSION_MESSAGE_OUTBOX_PREPARATION_FAILED", messageId: next.request.messageId, sessionId },
            "Visible Session collaboration outbox context was missing",
          );
          throw new Error("The credential grant did not include visible Session outbox context");
        }
        outboxContext = prepared.outboxContext;
        if (this.#turnPlan) {
          turnPlanInput = {
            provider: prepared.provider,
            sessionId,
            runId,
            ...(prepared.slackConfigDir ? { configDir: prepared.slackConfigDir } : {}),
          };
          await this.#turnPlan.prepare(turnPlanInput);
        }
      }
      phase = "runtime";
      const runtime = await this.#runtimeManager.ensureRuntime(sessionId, this.#abort.signal);
      await runtime.waitForIdle();
      phase = "prompt";
      const timeout = new AbortController();
      const timer = this.#timeoutScheduler.schedule(
        next.request.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS,
        () => timeout.abort(new Error("Session message Run timed out")),
      );
      try {
        const result = await runtime.prompt({
          runId,
          input: buildSessionMessageInput(
            next.request,
            this.#cliCommand,
            sessionKind === "visible"
              ? { sessionKind, outboxContext: requireOutboxContext(outboxContext) }
              : { sessionKind },
          ),
          signal: AbortSignal.any([this.#abort.signal, timeout.signal]),
        });
        if (result.status !== "completed") {
          throw new Error(result.error?.message ?? `Session message Run ended with status ${result.status}`);
        }
      } finally {
        timer.cancel();
      }
      if (current && !this.#abort.signal.aborted) {
        await this.#transition(current, "succeeded");
        this.#remember(key, { hash: next.hash, status: "succeeded" });
      }
    } catch (error) {
      if (current) await this.#handleFailure(current, next.hash, phase, error);
    } finally {
      if (turnPlanInput) await this.#turnPlan?.cleanup(turnPlanInput).catch(() => undefined);
      if (credentialPrepared) await this.#credentialEnvironment.cleanup(sessionId).catch(() => undefined);
      await this.#reconciler.withAgentLock(next.request.agentId, async () => {
        this.#reconciler.clearActivity(sessionId, runId);
        reservation.release();
      });
    }
  }

  async #prepareCredentials(sessionId: string, request: SessionMessageDeliveryRequest) {
    try {
      return await this.#credentialEnvironment.prepare(
        { sessionId, agentId: request.agentId, placementGeneration: request.placementGeneration },
        this.#abort.signal,
      );
    } catch (error) {
      this.#logger.warn(
        {
          code: "SESSION_MESSAGE_OUTBOX_PREPARATION_FAILED",
          errorCode: error instanceof Error && "code" in error ? error.code : undefined,
          messageId: request.messageId,
          sessionId,
        },
        "Visible Session collaboration outbox preparation failed",
      );
      throw error;
    }
  }

  async #hydrate(): Promise<void> {
    if (!this.#persistence) return;
    const records = await this.#persistence.list<SessionMessageDeliveryRequest>("session-message");
    for (const stored of records) {
      const request = SessionMessageDeliveryRequestSchema.safeParse(stored.payload);
      if (!request.success) continue;
      const hash = hashTuple([
        request.data.sourceSessionId,
        request.data.targetSessionId,
        request.data.agentId,
        request.data.content,
      ]);
      const key = stored.key;
      let record = { ...stored, payload: request.data } as DurableWorkRecord<SessionMessageDeliveryRequest>;
      this.#records.set(key, record);
      if (record.status === "succeeded") {
        this.#remember(key, { hash, status: "succeeded" });
        continue;
      }
      if (record.status === "dead-letter" || record.status === "failed") {
        this.#remember(key, { hash, status: record.status, reason: "provider_unavailable" });
        continue;
      }
      if (retryExhausted(this.#retryPolicy, record, this.#now())) {
        record = await this.#transition(record, "dead-letter", { nextAttemptAt: undefined });
        this.#remember(key, { hash, status: "dead-letter", reason: "provider_unavailable" });
        continue;
      }
      if (record.status === "running") {
        record = { ...record, status: "retryable", nextAttemptAt: this.#now(), updatedAt: this.#now() };
        await this.#persist(record);
      }
      this.#remember(key, { hash, status: "retryable" });
      this.#enqueue(record.payload, hash);
    }
  }

  #enqueue(request: SessionMessageDeliveryRequest, hash: string): void {
    const queue = this.#queues.get(request.targetSessionId) ?? [];
    if (queue.some((candidate) => candidate.request.messageId === request.messageId)) return;
    if (queue.length >= this.#maxQueuedPerSession || this.#queuedTotal >= this.#maxQueuedTotal) {
      this.#logger.warn(
        { messageId: request.messageId, sessionId: request.targetSessionId },
        "Durable inbox capacity delayed recovery",
      );
      return;
    }
    queue.push({ request, hash });
    this.#queues.set(request.targetSessionId, queue);
    this.#queuedTotal += 1;
    this.#startDrain(request.targetSessionId);
  }

  async #transition(
    record: DurableWorkRecord<SessionMessageDeliveryRequest>,
    status: DurableWorkRecord["status"],
    fields: Partial<DurableWorkRecord<SessionMessageDeliveryRequest>> = {},
  ): Promise<DurableWorkRecord<SessionMessageDeliveryRequest>> {
    const next = { ...record, ...fields, status, updatedAt: this.#now() };
    this.#records.set(record.key, next);
    this.#metrics?.transition("session-message", record.status, status);
    await this.#persist(next);
    return next;
  }

  async #handleFailure(
    record: DurableWorkRecord<SessionMessageDeliveryRequest>,
    hash: string,
    phase: string,
    error: unknown,
  ): Promise<void> {
    const failure = durableFailureFromUnknown(
      record.payload.requestId,
      phase,
      error,
      phase === "credential" ? "credential_unavailable" : phase === "prompt" ? "provider_failed" : "runtime_failed",
    );
    this.#emitFailure(failure);
    const attempts = record.attempts + 1;
    const now = this.#now();
    const candidate = { ...record, attempts, lastError: failure, updatedAt: now };
    if (failure.retryability === "never") {
      await this.#transition(candidate, "failed", { nextAttemptAt: undefined }).catch(() => undefined);
      this.#remember(record.key, { hash, status: "failed", reason: "provider_unavailable" });
      this.#logger.warn(
        { code: failure.code, messageId: record.payload.messageId, phase, status: "failed" },
        "Session message failed permanently",
      );
      return;
    }
    if (retryExhausted(this.#retryPolicy, candidate, now)) {
      await this.#transition(candidate, "dead-letter", { nextAttemptAt: undefined }).catch(() => undefined);
      this.#remember(record.key, { hash, status: "dead-letter", reason: "provider_unavailable" });
      this.#logger.warn(
        { code: failure.code, messageId: record.payload.messageId, phase, status: "dead-letter" },
        "Session message moved to dead letter",
      );
      return;
    }
    const nextAttemptAt = now + retryDelay(this.#retryPolicy, attempts);
    let retryable: DurableWorkRecord<SessionMessageDeliveryRequest>;
    try {
      retryable = await this.#transition(candidate, "retryable", { nextAttemptAt });
    } catch {
      this.#logger.warn(
        { code: "SESSION_MESSAGE_PERSISTENCE_FAILED", messageId: record.payload.messageId, status: "retryable" },
        "Session message retry state could not be persisted",
      );
      return;
    }
    this.#remember(record.key, { hash, status: "retryable" });
    this.#scheduleRetry(retryable, hash);
  }

  #emitFailure(failure: DurableFailure): void {
    try {
      this.#onFailure?.(failure);
    } catch {
      // Observers cannot alter the durable inbox state machine.
    }
  }

  #scheduleRetry(record: DurableWorkRecord<SessionMessageDeliveryRequest>, hash: string): void {
    if (this.#abort.signal.aborted || this.#retryTimers.has(record.key)) return;
    const delay = Math.max(0, (record.nextAttemptAt ?? this.#now()) - this.#now());
    const timer = this.#scheduler.schedule(delay, () => {
      this.#retryTimers.delete(record.key);
      if (this.#abort.signal.aborted) return;
      const current = this.#records.get(record.key);
      if (current?.status !== "retryable") return;
      void this.#transition(current, "accepted")
        .then(() => this.#enqueue(current.payload, hash))
        .catch(() => undefined);
    });
    this.#retryTimers.set(record.key, timer);
  }

  async #persist(record: DurableWorkRecord<SessionMessageDeliveryRequest>): Promise<void> {
    this.#records.set(record.key, record);
    await this.#persistence?.write(record);
  }

  #remember(key: string, value: RememberedMessage): void {
    this.#remembered.set(key, value);
    while (this.#remembered.size > this.#maxRememberedMessages) {
      const oldest = this.#remembered.keys().next().value;
      if (oldest === undefined) break;
      this.#remembered.delete(oldest);
    }
  }
}

function retryableAuthorityReason(reason: InputRejectReason): boolean {
  return (
    reason === "stale_generation" ||
    reason === "session_not_ready" ||
    reason === "stale_configuration" ||
    reason === "session_recovery_required"
  );
}

function normalizeRetryPolicy(overrides: Partial<RuntimeRetryPolicy> | undefined): RuntimeRetryPolicy {
  const policy = { ...DEFAULT_RUNTIME_RETRY_POLICY, ...overrides };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Runtime retry ${name} must be a positive safe integer`);
  }
  return policy;
}

export type SessionMessageTurnContext =
  | { readonly sessionKind: "internal" }
  | { readonly outboxContext: RuntimeImOutboxContext; readonly sessionKind: "visible" };

export function buildSessionMessageInput(
  request: SessionMessageDeliveryRequest,
  cliCommand = "opentag",
  turnContext: SessionMessageTurnContext = { sessionKind: "internal" },
): AgentInput {
  const managedContext =
    turnContext.sessionKind === "visible"
      ? [
          '<opentag-session-message-context source="managed">',
          "OpenTag internal collaboration message continuing the visible Session's existing work.",
          `Message ID: ${request.messageId}`,
          `Source Session: ${request.sourceSessionId}`,
          `Target Session: ${request.targetSessionId}`,
          "This message is not an IM provider event, but the target visible Session retains its IM outbox authority.",
          ...buildProviderOutboxInstructions({
            actionInstruction:
              "When this collaboration message contains a user-visible result, question, or blocker, synthesize it and deliver it through the provider CLI in this Turn before ending. Do not wait for another IM message. Do not automatically forward the source text verbatim.",
            provider: turnContext.outboxContext.provider,
            target: turnContext.outboxContext,
            targetLabel: "Default provider outbox context",
          }),
          ...(turnContext.outboxContext.sessionKind === "thread"
            ? turnContext.outboxContext.provider === "slack"
              ? ["Keep this collaboration continuation in the supplied Slack threadTs scope."]
              : [
                  "Keep this collaboration continuation in the supplied Feishu threadId scope. Use lark-cli to inspect the thread when a native message reply target is required.",
                ]
            : []),
          `Use ${cliCommand} session send <target-session-id> to continue Session collaboration when needed.`,
          "Ordinary final text remains Runtime console output and is not published automatically.",
          "</opentag-session-message-context>",
        ]
      : [
          '<opentag-session-message-context source="managed">',
          "OpenTag internal collaboration message.",
          `Message ID: ${request.messageId}`,
          `Source Session: ${request.sourceSessionId}`,
          `Target Session: ${request.targetSessionId}`,
          "This message is not an IM provider event.",
          "Your final text is not returned automatically.",
          `Use ${cliCommand} session send <target-session-id> to report progress or results, ask a question, or continue collaboration.`,
          "No IM provider reference or credential is attached to this message.",
          "</opentag-session-message-context>",
        ];
  return {
    items: [
      {
        type: "text",
        text: managedContext.join("\n"),
      },
      { type: "text", text: request.content.text },
    ],
  };
}

function requireOutboxContext(context: RuntimeImOutboxContext | undefined): RuntimeImOutboxContext {
  if (!context) throw new Error("Visible Session collaboration requires outbox context");
  return context;
}

function deliveryResult(
  request: SessionMessageDeliveryRequest,
  status: "accepted" | "rejected",
  reason?: InputRejectReason,
): SessionMessageDeliveryResult {
  return {
    type: "session:message:deliver:result",
    requestId: request.requestId,
    messageId: request.messageId,
    targetSessionId: request.targetSessionId,
    placementGeneration: request.placementGeneration,
    status,
    ...(reason ? { reason } : {}),
  };
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}
