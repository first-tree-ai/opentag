import { AgentProviderError, AgentRuntimeError } from "./errors.js";
import type {
  AgentAbortRequest,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentPromptRequest,
  AgentProviderRunContext,
  AgentProviderRunEvent,
  AgentProviderRunResult,
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeBinding,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
  AgentRuntimeManifest,
  AgentRuntimeState,
  AgentSteerRequest,
} from "./types.js";
import {
  assertAgentInput,
  assertBinding,
  assertIdentifier,
  assertJsonValue,
  assertPromptRequest,
  sameBinding,
} from "./validation.js";

export interface BaseAgentRuntimeOptions {
  readonly manifest: AgentRuntimeManifest;
  readonly capabilities: AgentRuntimeCapabilities;
  readonly eventSink: AgentRuntimeEventSink;
  readonly binding?: AgentRuntimeBinding;
}

interface RunRecord {
  readonly request: AgentPromptRequest;
  readonly controller: AbortController;
  readonly promise: Promise<AgentRunResult>;
  readonly resolve: (result: AgentRunResult) => void;
  state: "queued" | "active" | "settled";
  admissionEvent?: Promise<void>;
  signalCleanup?: () => void;
  abortPromise?: Promise<void>;
}

interface OutstandingInteraction {
  readonly kind: AgentInteractionRequest["kind"];
}

export abstract class BaseAgentRuntime implements AgentRuntime {
  readonly manifest: AgentRuntimeManifest;
  readonly capabilities: AgentRuntimeCapabilities;

  readonly #eventSink: AgentRuntimeEventSink;
  readonly #queued: RunRecord[] = [];
  readonly #knownRunIds = new Set<string>();
  readonly #interactions = new Map<string, OutstandingInteraction>();
  readonly #idleWaiters = new Set<() => void>();
  #phase: AgentRuntimeState["phase"] = "idle";
  #active?: RunRecord;
  #binding?: AgentRuntimeBinding;
  #dispatchTail: Promise<void> = Promise.resolve();
  #sinkFailure?: Error;
  #closePromise?: Promise<void>;
  #providerFailureClosing = false;

  protected constructor(options: BaseAgentRuntimeOptions) {
    this.manifest = Object.freeze({ ...options.manifest });
    this.capabilities = Object.freeze({ ...options.capabilities });
    this.#eventSink = options.eventSink;
    if (options.binding) {
      assertBinding(options.binding, options.manifest);
      this.#binding = options.binding;
    }
  }

  get state(): Readonly<AgentRuntimeState> {
    return Object.freeze({
      phase: this.#phase,
      ...(this.#active ? { activeRunId: this.#active.request.runId } : {}),
      queuedRunCount: this.#queued.length,
    });
  }

  get binding(): AgentRuntimeBinding | undefined {
    return this.#binding;
  }

  async prompt(request: AgentPromptRequest): Promise<AgentRunResult> {
    assertPromptRequest(request);
    this.#assertOpen();
    if (this.#phase !== "idle" || this.#active || this.#queued.length > 0) {
      throw new AgentRuntimeError("busy", "prompt requires an idle runtime");
    }
    const record = this.#admit(request, "active");
    this.#phase = "running";
    this.#active = record;
    void this.#execute(record);
    return record.promise;
  }

  async followUp(request: AgentPromptRequest): Promise<AgentRunResult> {
    assertPromptRequest(request);
    this.#assertOpen();
    if (this.#phase !== "running") {
      throw new AgentRuntimeError("busy", "followUp requires an active run or follow-up chain");
    }
    const record = this.#admit(request, "queued");
    this.#queued.push(record);
    record.admissionEvent = this.#dispatch({ type: "run_queued", runId: request.runId, position: this.#queued.length });
    void record.admissionEvent.catch(() => undefined);
    return record.promise;
  }

  async steer(request: AgentSteerRequest): Promise<void> {
    this.#assertOpen();
    if (this.capabilities.steer !== "supported") {
      throw new AgentRuntimeError("unsupported_capability", "this runtime does not support steer");
    }
    if (!request || typeof request !== "object") {
      throw new AgentRuntimeError("invalid_request", "steer request is required");
    }
    assertIdentifier(request.expectedRunId, "expectedRunId");
    assertAgentInput(request.input);
    const active = this.#requireActive(request.expectedRunId);
    await this.steerProvider(request);
    if (active.state !== "active" || this.#active !== active) {
      throw new AgentRuntimeError("run_mismatch", "the active run completed before steer was accepted");
    }
    await this.#dispatch({ type: "input_accepted", runId: active.request.runId, input: request.input });
  }

  async respond(response: AgentInteractionResponse): Promise<void> {
    this.#assertOpen();
    if (this.capabilities.interactions !== "supported") {
      throw new AgentRuntimeError("unsupported_capability", "this runtime does not support interactions");
    }
    if (!response || typeof response !== "object") {
      throw new AgentRuntimeError("invalid_request", "interaction response is required");
    }
    assertIdentifier(response.expectedRunId, "expectedRunId");
    assertIdentifier(response.requestId, "requestId");
    if (response.value !== undefined) assertJsonValue(response.value, "interaction.value");
    const active = this.#requireActive(response.expectedRunId);
    const interaction = this.#interactions.get(response.requestId);
    if (!interaction || interaction.kind !== response.kind) {
      throw new AgentRuntimeError("interaction_not_found", "the interaction is unknown, expired, or has another kind");
    }
    await this.respondProvider(response);
    if (active.state !== "active" || this.#active !== active || !this.#interactions.delete(response.requestId)) {
      throw new AgentRuntimeError("interaction_not_found", "the interaction expired before the response was accepted");
    }
    const event = this.#dispatch({
      type: "interaction_resolved",
      runId: active.request.runId,
      requestId: response.requestId,
      decision: response.decision,
    });
    void event.catch(() => undefined);
  }

  async abort(request: AgentAbortRequest): Promise<void> {
    this.#assertOpen();
    if (!request || typeof request !== "object") {
      throw new AgentRuntimeError("invalid_request", "abort request is required");
    }
    assertIdentifier(request.expectedRunId, "expectedRunId");
    const active = this.#requireActive(request.expectedRunId);
    await this.#requestAbort(active, request.reason ?? "run aborted");
  }

  waitForIdle(): Promise<void> {
    if (this.#phase === "idle" || this.#phase === "closed") return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#closeInternal();
    return this.#closePromise;
  }

  protected abstract executeRun(
    request: AgentPromptRequest,
    context: AgentProviderRunContext,
  ): Promise<AgentProviderRunResult>;

  protected steerProvider(_request: AgentSteerRequest): Promise<void> {
    return Promise.reject(new AgentRuntimeError("unsupported_capability", "this runtime does not support steer"));
  }

  protected respondProvider(_response: AgentInteractionResponse): Promise<void> {
    return Promise.reject(
      new AgentRuntimeError("unsupported_capability", "this runtime does not support interactions"),
    );
  }

  protected abortProvider(_request: AgentAbortRequest): Promise<void> {
    return Promise.resolve();
  }

  protected abstract closeProvider(): Promise<void>;

  protected closeForProviderFailure(): void {
    this.#providerFailureClosing = true;
    void this.close().catch(() => undefined);
  }

  #admit(request: AgentPromptRequest, state: RunRecord["state"]): RunRecord {
    if (this.#knownRunIds.has(request.runId)) {
      throw new AgentRuntimeError("duplicate_run_id", "runId is already active or queued");
    }
    let resolveResult!: (result: AgentRunResult) => void;
    const promise = new Promise<AgentRunResult>((resolve) => {
      resolveResult = resolve;
    });
    const record: RunRecord = {
      request,
      controller: new AbortController(),
      promise,
      resolve: resolveResult,
      state,
    };
    this.#knownRunIds.add(request.runId);
    if (request.signal) {
      const onAbort = () => {
        if (record.state === "queued") void this.#cancelQueued(record, "run signal aborted");
        else if (record.state === "active")
          void this.#requestAbort(record, "run signal aborted").catch(() => undefined);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      record.signalCleanup = () => request.signal?.removeEventListener("abort", onAbort);
    }
    return record;
  }

  async #execute(record: RunRecord): Promise<void> {
    if (record.admissionEvent) {
      await record.admissionEvent;
    }
    let result: AgentRunResult;
    try {
      await this.#dispatch({ type: "run_started", runId: record.request.runId });
      const providerResult = await this.executeRun(record.request, this.#context(record));
      result = this.#providerResult(record.request.runId, providerResult);
    } catch (error) {
      result = this.#resultForThrownError(record, error);
    }
    this.#interactions.clear();
    if (!this.#sinkFailure) {
      try {
        await this.#dispatch(this.#terminalEvent(result));
      } catch {
        result = this.#eventDeliveryFailure(record.request.runId, result);
      }
    } else {
      result = this.#eventDeliveryFailure(record.request.runId, result);
    }
    this.#settle(record, result);
    this.#finishActive();
  }

  #context(record: RunRecord): AgentProviderRunContext {
    const assertCurrent = () => {
      if (record.state !== "active" || this.#active !== record) {
        throw new AgentRuntimeError("run_mismatch", "provider event does not belong to the active run");
      }
    };
    return {
      runId: record.request.runId,
      signal: record.controller.signal,
      emit: async (event: AgentProviderRunEvent) => {
        assertCurrent();
        await this.#dispatch({ ...event, runId: record.request.runId } as AgentRuntimeEvent);
      },
      updateBinding: async (binding: AgentRuntimeBinding) => {
        assertCurrent();
        assertBinding(binding, this.manifest);
        if (sameBinding(this.#binding, binding)) return;
        this.#binding = binding;
        await this.#dispatch({ type: "binding_changed", binding, runId: record.request.runId });
      },
      requestInteraction: async (request: AgentInteractionRequest) => {
        assertCurrent();
        if (this.capabilities.interactions !== "supported") {
          throw new AgentRuntimeError("unsupported_capability", "provider requested an unsupported interaction");
        }
        assertIdentifier(request.requestId, "interaction.requestId");
        if (this.#interactions.has(request.requestId)) {
          throw new AgentRuntimeError("invalid_request", "provider emitted a duplicate interaction requestId");
        }
        this.#interactions.set(request.requestId, { kind: request.kind });
        try {
          await this.#dispatch({ type: "interaction_requested", runId: record.request.runId, request });
        } catch (error) {
          this.#interactions.delete(request.requestId);
          throw error;
        }
      },
      resolveInteraction: async (requestId: string, decision: string) => {
        assertCurrent();
        if (!this.#interactions.delete(requestId)) return;
        await this.#dispatch({
          type: "interaction_resolved",
          runId: record.request.runId,
          requestId,
          decision,
        });
      },
    };
  }

  #providerResult(runId: string, result: AgentProviderRunResult): AgentRunResult {
    const error =
      result.error ??
      (result.status === "failed"
        ? { code: "provider_error" as const, message: "provider run failed" }
        : result.status === "aborted"
          ? { code: "run_aborted" as const, message: "provider run was interrupted" }
          : undefined);
    return {
      runId,
      status: result.status,
      output: result.output ?? [],
      ...(result.usage ? { usage: result.usage } : {}),
      ...(this.#binding ? { binding: this.#binding } : {}),
      ...(error ? { error } : {}),
      ...(result.diagnostics !== undefined ? { providerDiagnostics: result.diagnostics } : {}),
    };
  }

  #resultForThrownError(record: RunRecord, error: unknown): AgentRunResult {
    if (this.#sinkFailure) return this.#eventDeliveryFailure(record.request.runId);
    if (record.controller.signal.aborted) {
      return {
        runId: record.request.runId,
        status: "aborted",
        output: [],
        ...(this.#binding ? { binding: this.#binding } : {}),
        error: { code: "run_aborted", message: "run was interrupted" },
      };
    }
    const providerError = error instanceof AgentProviderError ? error : undefined;
    return {
      runId: record.request.runId,
      status: "failed",
      output: [],
      ...(this.#binding ? { binding: this.#binding } : {}),
      error: {
        code: providerError?.code ?? "provider_error",
        message: providerError?.message ?? (error instanceof Error ? error.message : "provider run failed"),
      },
    };
  }

  #eventDeliveryFailure(runId: string, previous?: AgentRunResult): AgentRunResult {
    return {
      runId,
      status: "failed",
      output: previous?.output ?? [],
      ...(previous?.usage ? { usage: previous.usage } : {}),
      ...(this.#binding ? { binding: this.#binding } : {}),
      error: { code: "event_delivery_failed", message: "the ordered event sink rejected an event" },
      ...(previous?.providerDiagnostics !== undefined ? { providerDiagnostics: previous.providerDiagnostics } : {}),
    };
  }

  #terminalEvent(result: AgentRunResult): AgentRuntimeEvent {
    const type =
      result.status === "completed"
        ? "run_completed"
        : result.status === "failed"
          ? "run_failed"
          : result.status === "aborted"
            ? "run_aborted"
            : "run_cancelled";
    return { type, runId: result.runId, result } as AgentRuntimeEvent;
  }

  #settle(record: RunRecord, result: AgentRunResult): void {
    record.state = "settled";
    record.signalCleanup?.();
    this.#knownRunIds.delete(record.request.runId);
    record.resolve(result);
  }

  #finishActive(): void {
    this.#active = undefined;
    if (this.#phase === "closing" || this.#sinkFailure) return;
    while (this.#queued.length > 0) {
      const next = this.#queued.shift() as RunRecord;
      next.state = "active";
      this.#active = next;
      void this.#execute(next);
      return;
    }
    this.#phase = "idle";
    this.#resolveIdleWaiters();
  }

  async #cancelQueued(record: RunRecord, message: string): Promise<void> {
    const index = this.#queued.indexOf(record);
    this.#queued.splice(index, 1);
    let result: AgentRunResult = {
      runId: record.request.runId,
      status: "cancelled",
      output: [],
      ...(this.#binding ? { binding: this.#binding } : {}),
      error: { code: "run_cancelled", message },
    };
    if (!this.#sinkFailure) {
      try {
        await record.admissionEvent;
        await this.#dispatch(this.#terminalEvent(result));
      } catch {
        result = {
          ...result,
          error: { code: "event_delivery_failed", message: "the ordered event sink rejected an event" },
        };
      }
    }
    this.#settle(record, result);
  }

  #requestAbort(record: RunRecord, reason: string): Promise<void> {
    if (record.abortPromise) return record.abortPromise;
    record.abortPromise = this.abortProvider({ expectedRunId: record.request.runId, reason }).then(() => {
      if (!record.controller.signal.aborted) record.controller.abort(reason);
    });
    return record.abortPromise;
  }

  #requireActive(expectedRunId: string): RunRecord {
    const active = this.#active;
    if (!active || active.request.runId !== expectedRunId || active.state !== "active") {
      throw new AgentRuntimeError("run_mismatch", "expectedRunId does not match the active run");
    }
    return active;
  }

  #assertOpen(): void {
    if (this.#phase === "closing" || this.#phase === "closed") {
      throw new AgentRuntimeError("closed", "runtime is closing or closed");
    }
  }

  #dispatch(event: AgentRuntimeEvent): Promise<void> {
    if (this.#sinkFailure) return Promise.reject(this.#sinkFailure);
    const delivery = this.#dispatchTail.then(async () => {
      if (this.#sinkFailure) throw this.#sinkFailure;
      await this.#eventSink(event);
    });
    this.#dispatchTail = delivery.catch((error: unknown) => {
      this.#breakEventSink(error instanceof Error ? error : new Error("event sink rejected an event"));
    });
    return delivery;
  }

  #breakEventSink(error: Error): void {
    if (this.#sinkFailure) return;
    this.#sinkFailure = error;
    this.#phase = "closing";
    if (this.#active && !this.#active.controller.signal.aborted) {
      this.#active.controller.abort("event delivery failed");
    }
    const queued = this.#queued.splice(0);
    for (const record of queued) {
      this.#settle(record, {
        runId: record.request.runId,
        status: "cancelled",
        output: [],
        ...(this.#binding ? { binding: this.#binding } : {}),
        error: { code: "event_delivery_failed", message: "the ordered event sink rejected an event" },
      });
    }
    void this.close().catch(() => undefined);
  }

  async #closeInternal(): Promise<void> {
    this.#phase = "closing";
    const active = this.#active;
    if (active && !this.#providerFailureClosing && !active.controller.signal.aborted) {
      active.controller.abort("runtime closing");
    }
    const aborting =
      active && !this.#providerFailureClosing
        ? this.#requestAbort(active, "runtime closing").catch(() => undefined)
        : Promise.resolve();
    let closeError: unknown;
    const providerClosing = this.closeProvider().catch((error: unknown) => {
      closeError = error;
    });
    const queued = this.#queued.splice(0);
    let queueSinkHealthy = !this.#sinkFailure;
    for (const record of queued) {
      let result: AgentRunResult = {
        runId: record.request.runId,
        status: "cancelled",
        output: [],
        ...(this.#binding ? { binding: this.#binding } : {}),
        error: {
          code: queueSinkHealthy ? "runtime_closed" : "event_delivery_failed",
          message: queueSinkHealthy ? "runtime closed before the queued run started" : "event delivery failed",
        },
      };
      if (queueSinkHealthy) {
        try {
          await record.admissionEvent;
          await this.#dispatch(this.#terminalEvent(result));
        } catch {
          queueSinkHealthy = false;
          result = {
            ...result,
            error: { code: "event_delivery_failed", message: "the ordered event sink rejected an event" },
          };
        }
      }
      this.#settle(record, result);
    }

    await aborting;
    await providerClosing;
    await active?.promise;
    await this.#dispatchTail;
    if (!this.#sinkFailure) {
      await this.#dispatch({ type: "runtime_closed" }).catch(() => undefined);
    }
    this.#phase = "closed";
    this.#active = undefined;
    this.#interactions.clear();
    this.#resolveIdleWaiters();
    if (closeError) {
      throw new AgentRuntimeError("close_failed", "provider resources could not be closed", {
        cause: closeError,
      });
    }
  }

  #resolveIdleWaiters(): void {
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
