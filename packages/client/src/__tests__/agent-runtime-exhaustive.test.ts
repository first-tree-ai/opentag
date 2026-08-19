import { describe, expect, it, vi } from "vitest";
import { BaseAgentRuntime } from "../agent-runtime/base-agent-runtime.js";
import { AgentProviderError } from "../agent-runtime/errors.js";
import type {
  AgentAbortRequest,
  AgentInteractionResponse,
  AgentPromptRequest,
  AgentProviderRunContext,
  AgentProviderRunResult,
  AgentRuntimeBinding,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentSteerRequest,
} from "../agent-runtime/types.js";

const manifest = {
  providerId: "test",
  displayName: "Test",
  contractVersion: 1 as const,
  bindingSchemaVersion: 1,
};

interface HarnessOptions {
  readonly abort?: (request: AgentAbortRequest, runtime: HarnessRuntime) => Promise<void>;
  readonly binding?: AgentRuntimeBinding;
  readonly capabilities?: AgentRuntimeCapabilities;
  readonly close?: (runtime: HarnessRuntime) => Promise<void>;
  readonly eventSink?: (event: AgentRuntimeEvent) => void | Promise<void>;
  readonly execute: (
    request: AgentPromptRequest,
    context: AgentProviderRunContext,
    runtime: HarnessRuntime,
  ) => Promise<AgentProviderRunResult>;
  readonly respond?: (response: AgentInteractionResponse, runtime: HarnessRuntime) => Promise<void>;
  readonly steer?: (request: AgentSteerRequest, runtime: HarnessRuntime) => Promise<void>;
}

class HarnessRuntime extends BaseAgentRuntime {
  readonly aborts: AgentAbortRequest[] = [];
  readonly responses: AgentInteractionResponse[] = [];
  readonly steers: AgentSteerRequest[] = [];
  readonly #options: HarnessOptions;
  context?: AgentProviderRunContext;
  closes = 0;

  constructor(options: HarnessOptions) {
    super({
      manifest,
      capabilities: options.capabilities ?? { steer: "supported", interactions: "supported" },
      eventSink: options.eventSink ?? (() => undefined),
      binding: options.binding,
    });
    this.#options = options;
  }

  failProvider(): void {
    this.closeForProviderFailure();
  }

  protected executeRun(request: AgentPromptRequest, context: AgentProviderRunContext): Promise<AgentProviderRunResult> {
    this.context = context;
    return this.#options.execute(request, context, this);
  }

  protected override async steerProvider(request: AgentSteerRequest): Promise<void> {
    this.steers.push(request);
    await this.#options.steer?.(request, this);
  }

  protected override async respondProvider(response: AgentInteractionResponse): Promise<void> {
    this.responses.push(response);
    await this.#options.respond?.(response, this);
  }

  protected override async abortProvider(request: AgentAbortRequest): Promise<void> {
    this.aborts.push(request);
    await this.#options.abort?.(request, this);
  }

  protected async closeProvider(): Promise<void> {
    this.closes += 1;
    await this.#options.close?.(this);
  }
}

class DefaultHooksRuntime extends BaseAgentRuntime {
  context?: AgentProviderRunContext;

  constructor(eventSink: (event: AgentRuntimeEvent) => void | Promise<void>) {
    super({ manifest, capabilities: { steer: "supported", interactions: "supported" }, eventSink });
  }

  protected async executeRun(
    _request: AgentPromptRequest,
    context: AgentProviderRunContext,
  ): Promise<AgentProviderRunResult> {
    this.context = context;
    await context.requestInteraction({ requestId: "approval", kind: "approval", title: "Approve" });
    if (!context.signal.aborted) {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { status: "aborted" };
  }

  protected async closeProvider(): Promise<void> {}
}

describe("BaseAgentRuntime exhaustive behavior", () => {
  it("freezes public metadata, accepts an initial binding, and rejects an incompatible binding", async () => {
    const binding = testBinding("thread-1");
    const runtime = new HarnessRuntime({ binding, execute: async () => ({ status: "completed" }) });
    expect(runtime.manifest).toEqual(manifest);
    expect(runtime.capabilities).toEqual({ steer: "supported", interactions: "supported" });
    expect(Object.isFrozen(runtime.manifest)).toBe(true);
    expect(Object.isFrozen(runtime.capabilities)).toBe(true);
    expect(Object.isFrozen(runtime.state)).toBe(true);
    expect(runtime.binding).toEqual(binding);
    expect(runtime.binding).not.toBe(binding);
    expect(Object.isFrozen(runtime.binding)).toBe(true);
    expect(Object.isFrozen(runtime.binding?.payload)).toBe(true);
    (binding.payload as { threadId: string }).threadId = "caller-mutated";
    expect(runtime.binding).toEqual(testBinding("thread-1"));
    expect(
      () =>
        new HarnessRuntime({
          binding: { ...binding, providerId: "wrong" },
          execute: async () => ({ status: "completed" }),
        }),
    ).toThrowError(expect.objectContaining({ code: "binding_incompatible" }));
    await runtime.close();
    await expect(runtime.waitForIdle()).resolves.toBeUndefined();
    await expect(runtime.prompt(prompt("closed"))).rejects.toMatchObject({ code: "closed" });
    await expect(runtime.followUp(prompt("closed-follow-up"))).rejects.toMatchObject({ code: "closed" });
    await expect(runtime.steer({ expectedRunId: "closed", input: input("x") })).rejects.toMatchObject({
      code: "closed",
    });
    await expect(runtime.respond(approval("closed", "approval"))).rejects.toMatchObject({ code: "closed" });
    await expect(runtime.abort({ expectedRunId: "closed" })).rejects.toMatchObject({ code: "closed" });
  });

  it("snapshots admitted requests, binding updates, events, and terminal results", async () => {
    const release = deferred<void>();
    const events: AgentRuntimeEvent[] = [];
    const updatedBinding = testBinding("thread-updated");
    let providerRequest: AgentPromptRequest | undefined;
    const runtime = new HarnessRuntime({
      eventSink: (event) => {
        events.push(event);
      },
      execute: async (request, context) => {
        providerRequest = request;
        await context.updateBinding(updatedBinding);
        (updatedBinding.payload as { threadId: string }).threadId = "provider-mutated";
        await release.promise;
        return { status: "completed", output: [{ type: "text", text: request.input.items[0]?.text ?? "" }] };
      },
    });
    const request = {
      runId: "stable-run",
      input: { items: [{ type: "text" as const, text: "stable-input" }] },
      configuration: { model: "stable-model", provider: { mode: "stable" } },
    };

    const run = runtime.prompt(request);
    request.runId = "caller-mutated";
    const firstItem = request.input.items[0];
    if (!firstItem) throw new Error("missing request item");
    firstItem.text = "caller-mutated";
    request.configuration.model = "caller-mutated";
    request.configuration.provider.mode = "caller-mutated";
    await vi.waitFor(() => expect(providerRequest).toBeDefined());

    expect(providerRequest).toEqual({
      runId: "stable-run",
      input: { items: [{ type: "text", text: "stable-input" }] },
      configuration: { model: "stable-model", provider: { mode: "stable" } },
    });
    expect(Object.isFrozen(providerRequest)).toBe(true);
    expect(Object.isFrozen(providerRequest?.input.items)).toBe(true);
    expect(runtime.binding).toEqual(testBinding("thread-updated"));
    const bindingEvent = events.find((event) => event.type === "binding_changed");
    if (bindingEvent?.type !== "binding_changed") throw new Error("missing binding event");
    expect(Object.isFrozen(bindingEvent)).toBe(true);
    expect(Object.isFrozen(bindingEvent.binding.payload)).toBe(true);
    expect(() => {
      (bindingEvent.binding.payload as { threadId: string }).threadId = "observer-mutated";
    }).toThrow(TypeError);

    release.resolve();
    const result = await run;
    expect(result).toMatchObject({
      runId: "stable-run",
      status: "completed",
      output: [{ text: "stable-input" }],
      binding: testBinding("thread-updated"),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.output)).toBe(true);
    await runtime.close();
  });

  it("maps all Provider result and thrown-error forms to typed terminal results", async () => {
    const events: AgentRuntimeEvent[] = [];
    const contexts: AgentProviderRunContext[] = [];
    const runtime = new HarnessRuntime({
      eventSink: (event) => {
        events.push(event);
      },
      execute: async (request, context) => {
        contexts.push(context);
        if (request.runId === "completed") {
          await context.updateBinding(testBinding("thread-2"));
          await context.updateBinding(testBinding("thread-2"));
          return { status: "completed", diagnostics: null };
        }
        if (request.runId === "failed-default") return { status: "failed" };
        if (request.runId === "aborted-default") return { status: "aborted" };
        if (request.runId === "failed-explicit") {
          return {
            status: "failed",
            output: [{ type: "text", text: "partial" }],
            usage: { outputTokens: 1 },
            error: { code: "provider_protocol_error", message: "bad wire" },
            diagnostics: { detail: true },
          };
        }
        if (request.runId === "provider-throw") throw new AgentProviderError("provider_protocol_error", "protocol");
        if (request.runId === "error-throw") throw new Error("ordinary");
        throw "non-error";
      },
    });

    await expect(runtime.prompt(prompt("completed"))).resolves.toMatchObject({
      status: "completed",
      output: [],
      binding: testBinding("thread-2"),
      providerDiagnostics: null,
    });
    await expect(runtime.prompt(prompt("failed-default"))).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "provider run failed" },
    });
    await expect(runtime.prompt(prompt("aborted-default"))).resolves.toMatchObject({
      status: "aborted",
      error: { code: "run_aborted", message: "provider run was interrupted" },
    });
    await expect(runtime.prompt(prompt("failed-explicit"))).resolves.toMatchObject({
      status: "failed",
      output: [{ text: "partial" }],
      usage: { outputTokens: 1 },
      providerDiagnostics: { detail: true },
      error: { code: "provider_protocol_error" },
    });
    await expect(runtime.prompt(prompt("provider-throw"))).resolves.toMatchObject({
      error: { code: "provider_protocol_error", message: "protocol" },
    });
    await expect(runtime.prompt(prompt("error-throw"))).resolves.toMatchObject({
      error: { code: "provider_error", message: "ordinary" },
    });
    await expect(runtime.prompt(prompt("other-throw"))).resolves.toMatchObject({
      error: { code: "provider_error", message: "provider run failed" },
    });
    expect(events.filter((event) => event.type === "binding_changed")).toHaveLength(1);
    expect(
      events
        .filter((event) => event.type.startsWith("run_") && event.type !== "run_started")
        .map((event) => event.type),
    ).toEqual(["run_completed", "run_failed", "run_aborted", "run_failed", "run_failed", "run_failed", "run_failed"]);

    const stale = contexts[0];
    if (!stale) throw new Error("missing Provider context");
    await expect(stale.emit({ type: "provider_warning", code: "late", message: "late" })).rejects.toMatchObject({
      code: "run_mismatch",
    });
    await expect(stale.updateBinding(testBinding("late"))).rejects.toMatchObject({ code: "run_mismatch" });
    await expect(
      stale.requestInteraction({ requestId: "late", kind: "question", title: "Late" }),
    ).rejects.toMatchObject({ code: "run_mismatch" });
    await expect(stale.resolveInteraction("late", "expired")).rejects.toMatchObject({ code: "run_mismatch" });
    await runtime.close();
  });

  it("uses the Base default hooks and validates command shapes", async () => {
    const interactions = deferred<void>();
    const runtime = new DefaultHooksRuntime((event) => {
      if (event.type === "interaction_requested") interactions.resolve();
    });
    const run = runtime.prompt(prompt("run-1"));
    await interactions.promise;

    await expect(runtime.steer(undefined as never)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(runtime.steer({ expectedRunId: "run-1", input: { items: [] } })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(runtime.steer({ expectedRunId: "run-1", input: input("steer") })).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    await expect(runtime.respond(undefined as never)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(runtime.respond({ ...approval("run-1", "approval"), value: Number.NaN })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(runtime.respond(approval("run-1", "unknown"))).rejects.toMatchObject({
      code: "interaction_not_found",
    });
    await expect(
      runtime.respond({
        kind: "question",
        expectedRunId: "run-1",
        requestId: "approval",
        decision: "cancel",
      }),
    ).rejects.toMatchObject({ code: "interaction_not_found" });
    await expect(runtime.respond(approval("run-1", "approval"))).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    await expect(runtime.abort(undefined as never)).rejects.toMatchObject({ code: "invalid_request" });
    await runtime.abort({ expectedRunId: "run-1" });
    await expect(run).resolves.toMatchObject({ status: "aborted" });
    await runtime.close();
  });

  it("rejects unsupported interaction commands and Provider interaction requests", async () => {
    const gate = deferred<void>();
    const runtime = new HarnessRuntime({
      capabilities: { steer: "unsupported", interactions: "unsupported" },
      execute: async (_request, context) => {
        await context.requestInteraction({ requestId: "question", kind: "question", title: "Question" });
        await gate.promise;
        return { status: "completed" };
      },
    });
    const run = runtime.prompt(prompt("run-1"));
    await expect(runtime.respond(approval("run-1", "question"))).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    await expect(run).resolves.toMatchObject({
      status: "failed",
      error: { message: "provider requested an unsupported interaction" },
    });
    gate.resolve();
    await runtime.close();
  });

  it("supports Provider-resolved interactions and fences expired responses", async () => {
    const requested = deferred<void>();
    const release = deferred<void>();
    const events: AgentRuntimeEvent[] = [];
    const runtime = new HarnessRuntime({
      eventSink: (event) => {
        events.push(event);
        if (event.type === "interaction_requested" && event.request.requestId === "question") requested.resolve();
      },
      respond: async () => {
        release.resolve();
        await new Promise((resolve) => setImmediate(resolve));
      },
      execute: async (_request, context) => {
        await expect(
          context.requestInteraction({ requestId: "", kind: "question", title: "Invalid" }),
        ).rejects.toMatchObject({ code: "invalid_request" });
        await context.resolveInteraction("missing", "ignored");
        await context.requestInteraction({ requestId: "provider", kind: "question", title: "Provider" });
        await context.resolveInteraction("provider", "provider-expired");
        await context.requestInteraction({ requestId: "question", kind: "question", title: "Question" });
        await expect(
          context.requestInteraction({ requestId: "question", kind: "question", title: "Duplicate" }),
        ).rejects.toMatchObject({ code: "invalid_request" });
        await release.promise;
        return { status: "completed" };
      },
    });
    const run = runtime.prompt(prompt("run-1"));
    await requested.promise;
    await expect(
      runtime.respond({
        kind: "question",
        expectedRunId: "run-1",
        requestId: "question",
        decision: "answer",
        value: { answer: "yes" },
      }),
    ).rejects.toMatchObject({ code: "interaction_not_found" });
    expect(events.some((event) => event.type === "interaction_resolved" && event.decision === "provider-expired")).toBe(
      true,
    );
    await run;
    await runtime.close();
  });

  it("fences a steer whose Provider acceptance loses the completion race", async () => {
    const gate = deferred<void>();
    const runtime = new HarnessRuntime({
      execute: async () => {
        await gate.promise;
        return { status: "completed" };
      },
      steer: async () => {
        gate.resolve();
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    const run = runtime.prompt(prompt("run-1"));
    await expect(runtime.steer({ expectedRunId: "run-1", input: input("late") })).rejects.toMatchObject({
      code: "run_mismatch",
    });
    await run;
    await runtime.close();
  });

  it("handles active and queued caller signals and deduplicates abort requests", async () => {
    const activeStarted = deferred<void>();
    const activeController = new AbortController();
    const runtime = new HarnessRuntime({
      execute: async (request, context) => {
        activeStarted.resolve();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return { status: request.runId === "active" ? "aborted" : "completed" };
      },
    });
    const active = runtime.prompt({ ...prompt("active"), signal: activeController.signal });
    await activeStarted.promise;
    activeController.abort();
    await expect(active).resolves.toMatchObject({ status: "aborted" });
    expect(runtime.aborts).toHaveLength(1);

    const mainGate = deferred<void>();
    const queuedController = new AbortController();
    const queuedEvents: AgentRuntimeEvent[] = [];
    const queueRuntime = new HarnessRuntime({
      eventSink: (event) => {
        queuedEvents.push(event);
      },
      execute: async () => {
        await mainGate.promise;
        return { status: "completed" };
      },
    });
    const main = queueRuntime.prompt(prompt("main"));
    const queued = queueRuntime.followUp({ ...prompt("queued"), signal: queuedController.signal });
    queuedController.abort();
    await expect(queued).resolves.toMatchObject({ status: "cancelled", error: { code: "run_cancelled" } });
    expect(queuedEvents.some((event) => event.type === "run_cancelled" && event.runId === "queued")).toBe(true);
    mainGate.resolve();
    await main;
    await queueRuntime.close();

    const abortGate = deferred<void>();
    const executeGate = deferred<void>();
    const abortRuntime = new HarnessRuntime({
      abort: async () => abortGate.promise,
      execute: async () => {
        await executeGate.promise;
        return { status: "completed" };
      },
    });
    const run = abortRuntime.prompt(prompt("dedupe"));
    const one = abortRuntime.abort({ expectedRunId: "dedupe", reason: "one" });
    const two = abortRuntime.abort({ expectedRunId: "dedupe", reason: "two" });
    expect(abortRuntime.aborts).toHaveLength(1);
    abortGate.resolve();
    await Promise.all([one, two]);
    executeGate.resolve();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    await abortRuntime.close();
  });

  it("fails and closes an active Run when caller-signal Provider interruption fails", async () => {
    const started = deferred<void>();
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    const runtime = new HarnessRuntime({
      abort: async () => {
        throw new Error("interrupt unavailable");
      },
      eventSink: (event) => {
        events.push(event);
      },
      execute: async () => {
        started.resolve();
        return new Promise<AgentProviderRunResult>(() => undefined);
      },
    });
    const run = runtime.prompt({ ...prompt("signal-abort-failure"), signal: controller.signal });
    await started.promise;

    controller.abort();

    await expect(run).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "provider interrupt failed" },
    });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
    expect(events.filter((event) => event.type === "run_failed")).toHaveLength(1);
    expect(runtime.aborts).toHaveLength(1);
    await runtime.close();
  });

  it("keeps an already claimed Provider result when a late interrupt rejects", async () => {
    const abortGate = deferred<void>();
    const finish = deferred<void>();
    const runtime = new HarnessRuntime({
      abort: async () => abortGate.promise,
      execute: async () => {
        await finish.promise;
        return { status: "completed" };
      },
    });
    const run = runtime.prompt(prompt("late-abort-failure"));
    const abort = runtime.abort({ expectedRunId: "late-abort-failure" });
    finish.resolve();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    abortGate.reject(new Error("late interrupt failure"));
    await expect(abort).rejects.toThrow("late interrupt failure");
    expect(runtime.state.phase).toBe("idle");
    await runtime.close();
  });

  it("fails closed when queued admission or concurrent event delivery rejects with a non-Error", async () => {
    const gate = deferred<void>();
    const queueRuntime = new HarnessRuntime({
      eventSink: (event) => {
        if (event.type === "run_queued") throw "queue sink failed";
      },
      execute: async () => {
        await gate.promise;
        return { status: "completed" };
      },
    });
    const active = queueRuntime.prompt(prompt("active"));
    const queued = queueRuntime.followUp(prompt("queued"));
    await expect(queued).resolves.toMatchObject({ status: "cancelled", error: { code: "event_delivery_failed" } });
    gate.resolve();
    await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "event_delivery_failed" } });
    await vi.waitFor(() => expect(queueRuntime.state.phase).toBe("closed"));

    const boundGate = deferred<void>();
    const boundQueueRuntime = new HarnessRuntime({
      binding: testBinding("failed-queue-binding"),
      eventSink: (event) => {
        if (event.type === "run_queued") throw new Error("bound queue sink failed");
      },
      execute: async () => {
        await boundGate.promise;
        return { status: "completed" };
      },
    });
    const boundActive = boundQueueRuntime.prompt(prompt("bound-active"));
    const boundQueued = boundQueueRuntime.followUp(prompt("bound-queued"));
    await expect(boundQueued).resolves.toMatchObject({ binding: testBinding("failed-queue-binding") });
    boundGate.resolve();
    await boundActive;
    await vi.waitFor(() => expect(boundQueueRuntime.state.phase).toBe("closed"));

    const concurrent = new HarnessRuntime({
      eventSink: (event) => {
        if (event.type === "message_started") throw "non-error sink failure";
      },
      execute: async (_request, context) => {
        await Promise.all([
          context.emit({ type: "message_started", messageId: "one" }),
          context.emit({ type: "message_delta", messageId: "one", delta: "x" }),
        ]);
        return { status: "completed" };
      },
    });
    await expect(concurrent.prompt(prompt("concurrent"))).resolves.toMatchObject({
      status: "failed",
      error: { code: "event_delivery_failed" },
    });
    await vi.waitFor(() => expect(concurrent.state.phase).toBe("closed"));

    const immediateFailure = new HarnessRuntime({
      eventSink: (event) => {
        if (event.type === "message_started") throw new Error("first failure");
      },
      execute: async (_request, context) => {
        await context.emit({ type: "message_started", messageId: "one" }).catch(() => undefined);
        await context.emit({ type: "message_delta", messageId: "one", delta: "late" });
        return { status: "completed" };
      },
    });
    await expect(immediateFailure.prompt(prompt("immediate"))).resolves.toMatchObject({
      error: { code: "event_delivery_failed" },
    });
    await vi.waitFor(() => expect(immediateFailure.state.phase).toBe("closed"));
  });

  it("cleans up a rejected interaction event and maps an interrupted Provider throw to aborted", async () => {
    const interactionRuntime = new HarnessRuntime({
      eventSink: (event) => {
        if (event.type === "interaction_requested") throw new Error("cannot deliver interaction");
      },
      execute: async (_request, context) => {
        await context.requestInteraction({ requestId: "approval", kind: "approval", title: "Approve" });
        return { status: "completed" };
      },
    });
    await expect(interactionRuntime.prompt(prompt("interaction"))).resolves.toMatchObject({
      status: "failed",
      error: { code: "event_delivery_failed" },
    });
    await vi.waitFor(() => expect(interactionRuntime.state.phase).toBe("closed"));

    const started = deferred<void>();
    const controller = new AbortController();
    const abortRuntime = new HarnessRuntime({
      binding: testBinding("abort-binding"),
      execute: async (_request, context) => {
        started.resolve();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        throw new Error("interrupted work");
      },
    });
    const run = abortRuntime.prompt({ ...prompt("abort-throw"), signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(run).resolves.toMatchObject({ status: "aborted", error: { code: "run_aborted" } });
    await abortRuntime.close();

    const unboundStarted = deferred<void>();
    const unboundController = new AbortController();
    const unboundRuntime = new HarnessRuntime({
      execute: async (_request, context) => {
        unboundStarted.resolve();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        throw new Error("interrupted unbound work");
      },
    });
    const unboundRun = unboundRuntime.prompt({ ...prompt("unbound-abort"), signal: unboundController.signal });
    await unboundStarted.promise;
    unboundController.abort();
    const unboundResult = await unboundRun;
    expect(unboundResult).toMatchObject({ status: "aborted" });
    expect(unboundResult).not.toHaveProperty("binding");
    await unboundRuntime.close();
  });

  it("returns event-delivery failure when queued signal cancellation loses its terminal sink", async () => {
    const gate = deferred<void>();
    const controller = new AbortController();
    const runtime = new HarnessRuntime({
      binding: testBinding("cancel-binding"),
      eventSink: (event) => {
        if (event.type === "run_cancelled") throw new Error("terminal unavailable");
      },
      execute: async () => {
        await gate.promise;
        return { status: "completed" };
      },
    });
    const active = runtime.prompt(prompt("active"));
    const queued = runtime.followUp({ ...prompt("queued"), signal: controller.signal });
    controller.abort();
    await expect(queued).resolves.toMatchObject({ error: { code: "event_delivery_failed" } });
    gate.resolve();
    await expect(active).resolves.toMatchObject({ error: { code: "event_delivery_failed" } });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("reports close failures and handles queued terminal sink failure without leaking Runs", async () => {
    const closeErrorRuntime = new HarnessRuntime({
      close: async () => {
        throw new Error("close failed");
      },
      execute: async () => ({ status: "completed" }),
    });
    await expect(closeErrorRuntime.close()).rejects.toMatchObject({ code: "close_failed" });
    expect(closeErrorRuntime.state.phase).toBe("closed");

    const events: AgentRuntimeEvent[] = [];
    const runtime = new HarnessRuntime({
      binding: testBinding("close-binding"),
      eventSink: (event) => {
        events.push(event);
        if (event.type === "run_cancelled" && event.runId === "queued-1") throw new Error("terminal failed");
      },
      execute: async (_request, context) => {
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return { status: "aborted" };
      },
      abort: async () => {
        throw new Error("interrupt failed");
      },
    });
    const active = runtime.prompt(prompt("active"));
    const queuedOne = runtime.followUp(prompt("queued-1"));
    const queuedTwo = runtime.followUp(prompt("queued-2"));
    const idle = runtime.waitForIdle();
    const closing = runtime.close();
    await expect(active).resolves.toMatchObject({ status: "aborted" });
    await expect(queuedOne).resolves.toMatchObject({ error: { code: "event_delivery_failed" } });
    await expect(queuedTwo).resolves.toMatchObject({ error: { code: "event_delivery_failed" } });
    await closing;
    await idle;
    expect(runtime.state).toEqual({ phase: "closed", queuedRunCount: 0 });
  });

  it("treats Provider-failure close as failed rather than caller-aborted", async () => {
    const execution = deferred<void>();
    const runtime = new HarnessRuntime({
      execute: async () => {
        await execution.promise;
        throw new Error("provider disconnected");
      },
      close: async () => execution.resolve(),
    });
    const run = runtime.prompt(prompt("run-1"));
    runtime.failProvider();
    await expect(run).resolves.toMatchObject({ status: "failed", error: { message: "provider disconnected" } });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("survives a rejected runtime_closed event because close already owns cleanup", async () => {
    const runtime = new HarnessRuntime({
      eventSink: (event) => {
        if (event.type === "runtime_closed") throw new Error("observer disappeared");
      },
      execute: async () => ({ status: "completed" }),
    });
    await runtime.close();
    expect(runtime.state.phase).toBe("closed");
    await runtime.close();
  });

  it("retains Provider diagnostics when terminal event delivery fails", async () => {
    const runtime = new HarnessRuntime({
      eventSink: (event) => {
        if (event.type === "run_completed") throw new Error("terminal failed");
      },
      execute: async () => ({ status: "completed", diagnostics: { traceId: "trace" } }),
    });
    await expect(runtime.prompt(prompt("diagnostics"))).resolves.toMatchObject({
      status: "failed",
      providerDiagnostics: { traceId: "trace" },
      error: { code: "event_delivery_failed" },
    });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });
});

function input(text = "hello") {
  return { items: [{ type: "text" as const, text }] };
}

function prompt(runId: string): AgentPromptRequest {
  return { runId, input: input() };
}

function approval(expectedRunId: string, requestId: string): AgentInteractionResponse {
  return { kind: "approval", expectedRunId, requestId, decision: "accept" };
}

function testBinding(threadId: string): AgentRuntimeBinding {
  return { providerId: "test", schemaVersion: 1, payload: { threadId } };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value?: T) => void; reject: (error: Error) => void } {
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  if (!resolveValue || !rejectValue) throw new Error("could not create deferred promise");
  return {
    promise,
    resolve: (value?: T) => resolveValue?.(value as T),
    reject: (error) => rejectValue?.(error),
  };
}
