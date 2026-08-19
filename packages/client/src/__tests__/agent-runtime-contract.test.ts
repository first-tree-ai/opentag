import { describe, expect, it, vi } from "vitest";
import { BaseAgentRuntime } from "../agent-runtime/base-agent-runtime.js";
import type {
  AgentAbortRequest,
  AgentInteractionResponse,
  AgentPromptRequest,
  AgentProviderRunContext,
  AgentProviderRunResult,
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

describe("BaseAgentRuntime contract", () => {
  it("settles a run only after its ordered terminal event", async () => {
    const events: string[] = [];
    const runtime = new TestRuntime({
      eventSink: async (event) => {
        await Promise.resolve();
        events.push(event.type);
      },
      execute: async (_request, context) => {
        await context.emit({ type: "message_started", messageId: "message-1" });
        await context.emit({ type: "message_delta", messageId: "message-1", delta: "answer" });
        await context.emit({ type: "message_completed", messageId: "message-1", text: "answer" });
        return { status: "completed", output: [{ type: "text", text: "answer" }] };
      },
    });

    const result = await runtime.prompt(prompt("run-1", "hello"));

    expect(result).toMatchObject({ runId: "run-1", status: "completed", output: [{ text: "answer" }] });
    expect(events).toEqual(["run_started", "message_started", "message_delta", "message_completed", "run_completed"]);
    expect(runtime.state).toEqual({ phase: "idle", queuedRunCount: 0 });
    await expect(runtime.waitForIdle()).resolves.toBeUndefined();
    await runtime.close();
  });

  it("owns a strict FIFO follow-up queue with independent run results", async () => {
    const events: Array<{ type: string; runId?: string }> = [];
    const gates = new Map([
      ["run-1", deferred<void>()],
      ["run-2", deferred<void>()],
      ["run-3", deferred<void>()],
    ]);
    const starts: string[] = [];
    const runtime = new TestRuntime({
      eventSink: (event) => {
        events.push(event);
      },
      execute: async (request) => {
        starts.push(request.runId);
        await gates.get(request.runId)?.promise;
        return { status: "completed", output: [{ type: "text", text: request.runId }] };
      },
    });

    const first = runtime.prompt(prompt("run-1", "one"));
    const second = runtime.followUp(prompt("run-2", "two"));
    const third = runtime.followUp(prompt("run-3", "three"));
    expect(runtime.state).toEqual({ phase: "running", activeRunId: "run-1", queuedRunCount: 2 });

    gates.get("run-1")?.resolve();
    await expect(first).resolves.toMatchObject({ runId: "run-1", status: "completed" });
    await vi.waitFor(() => expect(starts).toEqual(["run-1", "run-2"]));
    gates.get("run-2")?.resolve();
    await expect(second).resolves.toMatchObject({ runId: "run-2", status: "completed" });
    await vi.waitFor(() => expect(starts).toEqual(["run-1", "run-2", "run-3"]));
    gates.get("run-3")?.resolve();
    await expect(third).resolves.toMatchObject({ runId: "run-3", status: "completed" });

    expect(starts).toEqual(["run-1", "run-2", "run-3"]);
    expect(events.filter((event) => event.type === "run_queued").map((event) => event.runId)).toEqual([
      "run-2",
      "run-3",
    ]);
    expect(runtime.state.phase).toBe("idle");
    await runtime.close();
  });

  it("rejects invalid admissions without creating run events", async () => {
    const gate = deferred<void>();
    const events: AgentRuntimeEvent[] = [];
    const runtime = new TestRuntime({
      eventSink: (event) => {
        events.push(event);
      },
      execute: async () => {
        await gate.promise;
        return { status: "completed" };
      },
    });
    const abort = new AbortController();
    abort.abort();

    await expect(runtime.followUp(prompt("idle-follow-up", "no"))).rejects.toMatchObject({ code: "busy" });
    await expect(runtime.prompt({ ...prompt("pre-aborted", "no"), signal: abort.signal })).rejects.toMatchObject({
      code: "invalid_request",
    });
    const active = runtime.prompt(prompt("run-1", "one"));
    await expect(runtime.prompt(prompt("run-2", "two"))).rejects.toMatchObject({ code: "busy" });
    await expect(runtime.followUp(prompt("run-1", "duplicate"))).rejects.toMatchObject({
      code: "duplicate_run_id",
    });
    gate.resolve();
    await active;

    expect(events.some((event) => "runId" in event && event.runId === "idle-follow-up")).toBe(false);
    expect(events.some((event) => "runId" in event && event.runId === "pre-aborted")).toBe(false);
    expect(events.some((event) => "runId" in event && event.runId === "run-2")).toBe(false);
    await runtime.close();
  });

  it("allows respond to be awaited reentrantly from the ordered sink", async () => {
    const eventTypes: string[] = [];
    let runtime: TestRuntime;
    runtime = new TestRuntime({
      eventSink: async (event) => {
        eventTypes.push(event.type);
        if (event.type === "interaction_requested") {
          await runtime.respond({
            kind: "approval",
            expectedRunId: event.runId,
            requestId: event.request.requestId,
            decision: "accept",
          });
        }
      },
      execute: async (_request, context) => {
        await context.requestInteraction({
          requestId: "approval-1",
          kind: "approval",
          title: "Approve",
        });
        return { status: "completed" };
      },
    });

    await expect(runtime.prompt(prompt("run-1", "hello"))).resolves.toMatchObject({ status: "completed" });
    expect(runtime.responses).toHaveLength(1);
    expect(eventTypes).toEqual(["run_started", "interaction_requested", "interaction_resolved", "run_completed"]);
    await runtime.close();
  });

  it("fails the active run and closes when the ordered sink rejects", async () => {
    const delivered: string[] = [];
    const runtime = new TestRuntime({
      eventSink: (event) => {
        delivered.push(event.type);
        if (event.type === "message_started") throw new Error("sink unavailable");
      },
      execute: async (_request, context) => {
        await context.emit({ type: "message_started", messageId: "message-1" });
        return { status: "completed" };
      },
    });

    await expect(runtime.prompt(prompt("run-1", "hello"))).resolves.toMatchObject({
      status: "failed",
      error: { code: "event_delivery_failed" },
    });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
    expect(delivered).toEqual(["run_started", "message_started"]);
    expect(runtime.providerCloses).toBe(1);
  });

  it("keeps provider output in the Promise fallback when terminal event delivery fails", async () => {
    const runtime = new TestRuntime({
      eventSink: (event) => {
        if (event.type === "run_completed") throw new Error("terminal delivery failed");
      },
      execute: async () => ({
        status: "completed",
        output: [{ type: "text", text: "authoritative answer" }],
        usage: { outputTokens: 3 },
      }),
    });

    await expect(runtime.prompt(prompt("run-1", "hello"))).resolves.toMatchObject({
      status: "failed",
      output: [{ type: "text", text: "authoritative answer" }],
      usage: { outputTokens: 3 },
      error: { code: "event_delivery_failed" },
    });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("rejects unsupported capabilities before invoking provider hooks", async () => {
    const gate = deferred<void>();
    const runtime = new TestRuntime({
      capabilities: { steer: "unsupported", interactions: "unsupported" },
      eventSink: () => undefined,
      execute: async () => {
        await gate.promise;
        return { status: "completed" };
      },
    });
    const run = runtime.prompt(prompt("run-1", "hello"));

    await expect(runtime.steer({ expectedRunId: "run-1", input: input("change") })).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    expect(runtime.steers).toHaveLength(0);
    gate.resolve();
    await run;
    await runtime.close();
  });

  it("close aborts the active run, cancels queued runs, and is idempotent", async () => {
    const events: AgentRuntimeEvent[] = [];
    const runtime = new TestRuntime({
      eventSink: (event) => {
        events.push(event);
      },
      execute: async (_request, context) => {
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return { status: "aborted" };
      },
    });
    const active = runtime.prompt(prompt("run-1", "one"));
    const queued = runtime.followUp(prompt("run-2", "two"));

    const closing = runtime.close();
    await expect(active).resolves.toMatchObject({ status: "aborted" });
    await expect(queued).resolves.toMatchObject({ status: "cancelled", error: { code: "runtime_closed" } });
    await closing;
    await runtime.close();

    expect(runtime.aborts).toBe(1);
    expect(runtime.providerCloses).toBe(1);
    expect(runtime.state).toEqual({ phase: "closed", queuedRunCount: 0 });
    expect(events.at(-1)?.type).toBe("runtime_closed");
  });

  it("fences steer and abort against a stale run id", async () => {
    const gate = deferred<void>();
    const runtime = new TestRuntime({
      eventSink: () => undefined,
      execute: async () => {
        await gate.promise;
        return { status: "completed" };
      },
    });
    const run = runtime.prompt(prompt("run-1", "one"));

    await expect(runtime.steer({ expectedRunId: "stale", input: input("change") })).rejects.toMatchObject({
      code: "run_mismatch",
    });
    await expect(runtime.abort({ expectedRunId: "stale" })).rejects.toMatchObject({ code: "run_mismatch" });
    await runtime.steer({ expectedRunId: "run-1", input: input("change") });
    expect(runtime.steers).toHaveLength(1);

    gate.resolve();
    await run;
    await runtime.close();
  });
});

interface TestRuntimeOptions {
  readonly capabilities?: AgentRuntimeCapabilities;
  readonly eventSink: (event: AgentRuntimeEvent) => void | Promise<void>;
  readonly execute: (request: AgentPromptRequest, context: AgentProviderRunContext) => Promise<AgentProviderRunResult>;
}

class TestRuntime extends BaseAgentRuntime {
  readonly #executeHandler: TestRuntimeOptions["execute"];
  readonly responses: AgentInteractionResponse[] = [];
  readonly steers: AgentSteerRequest[] = [];
  aborts = 0;
  providerCloses = 0;

  constructor(options: TestRuntimeOptions) {
    super({
      manifest,
      capabilities: options.capabilities ?? { steer: "supported", interactions: "supported" },
      eventSink: options.eventSink,
    });
    this.#executeHandler = options.execute;
  }

  protected executeRun(request: AgentPromptRequest, context: AgentProviderRunContext): Promise<AgentProviderRunResult> {
    return this.#executeHandler(request, context);
  }

  protected override async steerProvider(request: AgentSteerRequest): Promise<void> {
    this.steers.push(request);
  }

  protected override async respondProvider(response: AgentInteractionResponse): Promise<void> {
    this.responses.push(response);
  }

  protected override async abortProvider(_request: AgentAbortRequest): Promise<void> {
    this.aborts += 1;
  }

  protected async closeProvider(): Promise<void> {
    this.providerCloses += 1;
  }
}

function input(text: string) {
  return { items: [{ type: "text" as const, text }] };
}

function prompt(runId: string, text: string): AgentPromptRequest {
  return { runId, input: input(text) };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  if (!resolveValue) throw new Error("could not create deferred promise");
  return { promise, resolve: (value?: T) => resolveValue?.(value as T) };
}
