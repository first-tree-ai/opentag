import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import { PiAgentRuntime, PiAgentRuntimeFactory, piAgentRuntimeEnvironment } from "../providers/pi/agent-runtime.js";
import type { PiRpcClient } from "../providers/pi/rpc-wire.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_FILE = `/sessions/${SESSION_ID}.jsonl`;
const SESSION_FILE_HASH = createHash("sha256").update(SESSION_FILE).digest("hex");

describe("PiAgentRuntime", () => {
  it("creates a persistent session and translates a complete Pi RPC run", async () => {
    const client = new ScriptedPiClient("complete");
    const events: AgentRuntimeEvent[] = [];
    const runtime = await piFactory(client).create(
      createRequest(
        (event) => {
          events.push(event);
        },
        {
          model: "deepseek/deepseek-v4-flash",
          reasoningEffort: "high",
          provider: { sessionName: "runtime-test" },
        },
      ),
    );

    const result = await runtime.prompt({ runId: "run-1", input: input("hello") });

    expect(runtime).toBeInstanceOf(PiAgentRuntime);
    expect(runtime.binding).toEqual(materializedBinding());
    expect(result).toMatchObject({
      status: "completed",
      output: [{ type: "text", text: "final answer" }],
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
      providerDiagnostics: {
        providerSessionId: SESSION_ID,
        stopReason: "stop",
        model: { id: "fixture-model", provider: "fixture" },
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "binding_changed",
      "run_started",
      "binding_changed",
      "model_turn_started",
      "provider_event",
      "message_started",
      "message_delta",
      "message_completed",
      "provider_event",
      "usage_updated",
      "tool_started",
      "tool_updated",
      "tool_completed",
      "model_turn_completed",
      "provider_event",
      "run_completed",
    ]);
    expect(client.args).toEqual(
      expect.arrayContaining([
        "--mode",
        "rpc",
        "--session-id",
        SESSION_ID,
        "--tools",
        "read,grep,find,ls",
        "--model",
        "deepseek/deepseek-v4-flash",
        "--thinking",
        "high",
        "--append-system-prompt",
        "OpenTag managed system prompt",
        "--name",
        "runtime-test",
      ]),
    );
    expect(client.commands).toEqual([{ type: "get_state" }, { type: "prompt", message: "hello" }]);
    expect(client.closed).toBe(true);
    await runtime.close();
  });

  it("resumes the exact binding in a new process and preserves non-prompt overrides", async () => {
    const client = new ScriptedPiClient("complete");
    const runtime = await piFactory(client).resume({
      ...createRequest(() => undefined, { provider: { sessionName: "base" } }),
      binding: materializedBinding(),
    });
    await runtime.prompt({
      runId: "run-resume",
      input: {
        items: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
      configuration: {
        reasoningEffort: "max",
        provider: { sessionName: "resumed" },
      },
    });
    expect(client.args).toEqual(expect.arrayContaining(["--session-id", SESSION_ID, "--thinking", "max"]));
    expect(client.args).toEqual(
      expect.arrayContaining(["--append-system-prompt", "OpenTag managed system prompt", "--name", "resumed"]),
    );
    expect(client.commands.at(-1)).toEqual({ type: "prompt", message: "one\ntwo" });
    await runtime.close();
  });

  it("supports same-Run steer only after Pi accepts the prompt", async () => {
    const client = new ScriptedPiClient("hold");
    const events: AgentRuntimeEvent[] = [];
    const runtime = await piFactory(client).create(
      createRequest((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "run-steer", input: input("start") });
    await vi.waitFor(() => expect(client.commands.some((command) => command.type === "prompt")).toBe(true));

    await runtime.steer({ expectedRunId: "run-steer", input: input("focus tests") });
    expect(client.commands).toContainEqual({ type: "steer", message: "focus tests" });
    expect(events.map((event) => event.type)).toContain("input_accepted");

    client.complete();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    await runtime.close();
  });

  it("maps Pi abort and model errors to typed terminal results", async () => {
    const heldClient = new ScriptedPiClient("hold");
    const heldRuntime = await piFactory(heldClient).create(createRequest(() => undefined));
    const heldRun = heldRuntime.prompt({ runId: "run-abort", input: input("long task") });
    await vi.waitFor(() => expect(heldClient.commands.some((command) => command.type === "prompt")).toBe(true));
    await heldRuntime.abort({ expectedRunId: "run-abort", reason: "stop" });
    await expect(heldRun).resolves.toMatchObject({ status: "aborted", error: { code: "run_aborted" } });
    expect(heldClient.commands.at(-1)).toEqual({ type: "abort" });
    await heldRuntime.close();

    const failedRuntime = await piFactory(new ScriptedPiClient("error")).create(createRequest(() => undefined));
    await expect(failedRuntime.prompt({ runId: "run-error", input: input("fail") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "model unavailable" },
    });
    await failedRuntime.close();
  });

  it("fails closed for crossed sessions and process failure", async () => {
    const crossed = await piFactory(new ScriptedPiClient("complete", "22222222-2222-4222-8222-222222222222")).create(
      createRequest(() => undefined),
    );
    await expect(crossed.prompt({ runId: "run-crossed", input: input("hello") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Pi opened another session" },
    });
    await vi.waitFor(() => expect(crossed.state.phase).toBe("closed"));

    const failed = await piFactory(new ScriptedPiClient("failure")).create(createRequest(() => undefined));
    await expect(failed.prompt({ runId: "run-failure", input: input("hello") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "process exited" },
    });
    await vi.waitFor(() => expect(failed.state.phase).toBe("closed"));
  });

  it("rejects policies Pi cannot enforce and incompatible bindings", async () => {
    const factory = piFactory(new ScriptedPiClient("complete"));
    for (const policy of [
      { ...basePolicy(), approvals: "on-request" as const },
      { ...basePolicy(), fileSystem: "workspace-write" as const },
      {
        ...basePolicy(),
        fileSystem: "unrestricted" as const,
        tools: { mode: "provider-default" as const },
      },
      { ...basePolicy(), tools: { mode: "allow-list" as const, names: ["bash"] } },
    ]) {
      await expect(factory.create({ ...createRequest(() => undefined), policy })).rejects.toMatchObject({
        code: "configuration_invalid",
      });
    }
    await expect(
      factory.resume({
        ...createRequest(() => undefined),
        binding: { providerId: "codex", schemaVersion: 1, payload: { sessionId: SESSION_ID } },
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
  });

  it("reports readiness and filters the process environment", async () => {
    const ready = new PiAgentRuntimeFactory({
      probeRunner: async () => ({ credential: true, rpc: true, version: "0.83.0" }),
    });
    await expect(ready.probe({})).resolves.toEqual({ ready: true, version: "0.83.0", issues: [] });
    const unavailable = new PiAgentRuntimeFactory({
      probeRunner: async () => ({ credential: false, rpc: false, version: "old" }),
    });
    await expect(unavailable.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "version_incompatible" }, { code: "credential_missing" }],
    });
    const controller = new AbortController();
    const hanging = new PiAgentRuntimeFactory({
      probeRunner: async () => new Promise<never>(() => undefined),
    }).probe({ signal: controller.signal });
    controller.abort(new Error("stop Pi probe"));
    await expect(hanging).rejects.toThrow("stop Pi probe");
    expect(
      piAgentRuntimeEnvironment({
        HOME: "/home/provider",
        PATH: "/bin",
        DEEPSEEK_API_KEY: "provider-key",
        AWS_PROFILE: "bedrock",
        PI_CODING_AGENT_DIR: "/pi",
        OPENTAG_ACCESS_TOKEN: "opentag-secret",
        RANDOM_SECRET: "other-secret",
      }),
    ).toEqual({
      HOME: "/home/provider",
      PATH: "/bin",
      DEEPSEEK_API_KEY: "provider-key",
      AWS_PROFILE: "bedrock",
      PI_CODING_AGENT_DIR: "/pi",
    });
  });
});

type Scenario = "complete" | "error" | "failure" | "hold";

class ScriptedPiClient implements PiRpcClient {
  args: readonly string[] = [];
  readonly commands: Readonly<Record<string, unknown>>[] = [];
  readonly #listeners = new Set<(message: Readonly<Record<string, unknown>>) => void>();
  readonly #scenario: Scenario;
  readonly #sessionId: string;
  closed = false;

  constructor(scenario: Scenario, sessionId = SESSION_ID) {
    this.#scenario = scenario;
    this.#sessionId = sessionId;
  }

  async request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.commands.push(command);
    if (command.type === "get_state") {
      return {
        sessionId: this.#sessionId,
        sessionFile: SESSION_FILE,
        messageCount: 0,
        model: { id: "fixture-model", provider: "fixture" },
      };
    }
    if (command.type === "steer") return undefined;
    if (command.type === "abort") {
      this.#emitRun("aborted");
      return undefined;
    }
    if (command.type !== "prompt") throw new Error(`unexpected Pi command: ${String(command.type)}`);
    if (this.#scenario === "complete") this.#emitRun("stop", true);
    if (this.#scenario === "error") this.#emitRun("error");
    if (this.#scenario === "failure") this.#emit({ type: "opentag/process_error", error: new Error("process exited") });
    return undefined;
  }

  subscribe(listener: (message: Readonly<Record<string, unknown>>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  complete(): void {
    this.#emitRun("stop", true);
  }

  #emitRun(stopReason: "aborted" | "error" | "stop", includeTool = false): void {
    const assistant = assistantMessage(stopReason);
    this.#emit({ type: "agent_start" });
    this.#emit({ type: "turn_start" });
    this.#emit({ type: "message_start", message: { role: "user", content: "hello" } });
    this.#emit({ type: "message_end", message: { role: "user", content: "hello" } });
    this.#emit({ type: "message_start", message: { ...assistant, content: [] } });
    this.#emit({ type: "message_update", assistantMessageEvent: { type: "start" } });
    this.#emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    this.#emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "final answer" },
    });
    this.#emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "final answer" },
    });
    this.#emit({ type: "message_update", assistantMessageEvent: { type: "done", reason: stopReason } });
    this.#emit({ type: "message_end", message: assistant });
    if (includeTool) {
      this.#emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "x" } });
      this.#emit({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        partialResult: { content: [{ type: "text", text: "partial" }] },
      });
      this.#emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      });
    }
    this.#emit({ type: "turn_end", message: assistant, toolResults: [] });
    this.#emit({ type: "agent_end", messages: [assistant], willRetry: false });
    this.#emit({ type: "agent_settled" });
  }

  #emit(message: Readonly<Record<string, unknown>>): void {
    for (const listener of this.#listeners) listener(message);
  }
}

function assistantMessage(stopReason: "aborted" | "error" | "stop"): Readonly<Record<string, unknown>> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "final answer" }],
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "model unavailable" } : {}),
    usage: { input: 10, output: 3, cacheRead: 2 },
  };
}

function piFactory(client: ScriptedPiClient): PiAgentRuntimeFactory {
  return new PiAgentRuntimeFactory({
    createSessionId: () => SESSION_ID,
    createClient: (_cwd, args) => {
      client.args = args;
      return client;
    },
    probeRunner: async () => ({ credential: true, rpc: true, version: "fixture" }),
  });
}

function createRequest(
  eventSink: CreateAgentRuntimeRequest["eventSink"],
  configuration?: CreateAgentRuntimeRequest["configuration"],
): CreateAgentRuntimeRequest {
  return {
    eventSink,
    systemPrompt: "OpenTag managed system prompt",
    workspace: { cwd: "/workspace" },
    policy: basePolicy(),
    ...(configuration ? { configuration } : {}),
  };
}

function basePolicy(): CreateAgentRuntimeRequest["policy"] {
  return {
    fileSystem: "read-only",
    network: "disabled",
    approvals: "never",
    tools: { mode: "provider-default" },
  };
}

function input(text: string): { items: [{ type: "text"; text: string }] } {
  return { items: [{ type: "text", text }] };
}

function materializedBinding() {
  return {
    providerId: "pi" as const,
    schemaVersion: 1,
    payload: { sessionId: SESSION_ID, sessionFileHash: SESSION_FILE_HASH },
  };
}
