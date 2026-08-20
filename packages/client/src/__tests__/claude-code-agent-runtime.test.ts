import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import {
  CLAUDE_CODE_AGENT_RUNTIME_MANIFEST,
  ClaudeCodeAgentRuntime,
  ClaudeCodeAgentRuntimeFactory,
  claudeCodeAgentRuntimeEnvironment,
} from "../providers/claude-code/agent-runtime.js";
import type { ClaudeCodeProcessClient, ClaudeCodeProcessResult } from "../providers/claude-code/process-wire.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("ClaudeCodeAgentRuntime", () => {
  it("creates a bound session and maps streamed text, tools, usage, and the terminal result", async () => {
    const events: AgentRuntimeEvent[] = [];
    const processes: ScriptedClaudeCodeProcess[] = [];
    const factory = claudeFactory(processes, "complete");
    const runtime = await factory.create(
      createRequest((event) => {
        events.push(event);
      }),
    );

    const result = await runtime.prompt({ runId: "run-1", input: input("hello") });

    expect(runtime).toBeInstanceOf(ClaudeCodeAgentRuntime);
    expect(runtime.manifest).toEqual(CLAUDE_CODE_AGENT_RUNTIME_MANIFEST);
    expect(runtime.capabilities).toEqual({ steer: "unsupported", interactions: "unsupported" });
    expect(runtime.binding).toEqual({
      providerId: "claude-code",
      schemaVersion: 1,
      payload: { sessionId: SESSION_ID },
    });
    expect(result).toMatchObject({
      status: "completed",
      output: [{ type: "text", text: "final answer" }],
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
      providerDiagnostics: {
        providerSessionId: SESSION_ID,
        resultSubtype: "success",
        numTurns: 2,
        totalCostUsd: 0.01,
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "binding_changed",
      "run_started",
      "provider_event",
      "model_turn_started",
      "message_started",
      "message_delta",
      "message_completed",
      "model_turn_completed",
      "model_turn_started",
      "tool_started",
      "model_turn_completed",
      "tool_completed",
      "usage_updated",
      "run_completed",
    ]);
    expect(processes[0]?.input).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
      parent_tool_use_id: null,
    });
    expect(processes[0]?.args).toContain("--session-id");
    expect(processes[0]?.args).toContain(SESSION_ID);
    expect(argumentAfter(processes[0]?.args ?? [], "--permission-mode")).toBe("bypassPermissions");
    expect(processes[0]?.args).not.toContain("--settings");
    await runtime.close();
  });

  it("resumes the exact binding and uses --resume for every resumed run", async () => {
    const processes: ScriptedClaudeCodeProcess[] = [];
    const runtime = await claudeFactory(processes, "complete").resume({
      ...createRequest(() => undefined),
      binding: { providerId: "claude-code", schemaVersion: 1, payload: { sessionId: SESSION_ID } },
    });

    await expect(runtime.prompt({ runId: "run-1", input: input("continue") })).resolves.toMatchObject({
      status: "completed",
    });
    expect(argumentAfter(processes[0]?.args ?? [], "--resume")).toBe(SESSION_ID);
    expect(processes[0]?.args).not.toContain("--session-id");
    await runtime.close();
  });

  it("switches a newly created runtime to exact resume after its first initialized run", async () => {
    const processes: ScriptedClaudeCodeProcess[] = [];
    const runtime = await claudeFactory(processes, "complete").create(createRequest(() => undefined));

    await runtime.prompt({ runId: "run-1", input: input("first") });
    await runtime.prompt({ runId: "run-2", input: input("second") });

    expect(argumentAfter(processes[0]?.args ?? [], "--session-id")).toBe(SESSION_ID);
    expect(argumentAfter(processes[1]?.args ?? [], "--resume")).toBe(SESSION_ID);
    await runtime.close();
  });

  it("interrupts the active local process and settles the run as aborted", async () => {
    const processes: ScriptedClaudeCodeProcess[] = [];
    const runtime = await claudeFactory(processes, "hold").create(createRequest(() => undefined));
    const run = runtime.prompt({ runId: "run-1", input: input("wait") });
    await vi.waitFor(() => expect(processes[0]?.executing).toBe(true));

    await runtime.abort({ expectedRunId: "run-1", reason: "stop" });

    await expect(run).resolves.toMatchObject({ status: "aborted", error: { code: "run_aborted" } });
    expect(processes[0]?.interruptCount).toBe(1);
    await runtime.close();
  });

  it("maps a Claude Code error result to a typed failed Run", async () => {
    const processes: ScriptedClaudeCodeProcess[] = [];
    const runtime = await claudeFactory(processes, "error").create(createRequest(() => undefined));

    await expect(runtime.prompt({ runId: "run-1", input: input("fail") })).resolves.toMatchObject({
      status: "failed",
      output: [],
      error: { code: "provider_error", message: "model unavailable" },
      providerDiagnostics: { resultSubtype: "error_during_execution" },
    });
    await runtime.close();
  });

  it("fails closed when the terminal belongs to another Claude Code session", async () => {
    const processes: ScriptedClaudeCodeProcess[] = [];
    const runtime = await claudeFactory(processes, "foreign").create(createRequest(() => undefined));

    await expect(runtime.prompt({ runId: "run-1", input: input("fail") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Claude Code result belongs to another session" },
    });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("probes the installed CLI boundary without a Provider network request", async () => {
    const ready = new ClaudeCodeAgentRuntimeFactory({
      probeRunner: async () => ({ credential: true, streamJson: true, version: "2.1.210 (Claude Code)" }),
    });
    await expect(ready.probe({})).resolves.toEqual({
      ready: true,
      version: "2.1.210 (Claude Code)",
      issues: [],
    });

    const unavailable = new ClaudeCodeAgentRuntimeFactory({
      probeRunner: async () => ({ credential: false, streamJson: false, version: "old" }),
    });
    await expect(unavailable.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "version_incompatible" }, { code: "credential_missing" }],
    });

    const controller = new AbortController();
    const hanging = new ClaudeCodeAgentRuntimeFactory({
      probeRunner: async () => new Promise<never>(() => undefined),
    }).probe({ signal: controller.signal });
    controller.abort(new Error("stop Claude probe"));
    await expect(hanging).rejects.toThrow("stop Claude probe");
  });

  it("passes only system and Claude provider environment variables", () => {
    expect(
      claudeCodeAgentRuntimeEnvironment({
        HOME: "/home/provider",
        PATH: "/bin",
        HTTPS_PROXY: "https://proxy.example",
        NODE_EXTRA_CA_CERTS: "/certificate.pem",
        ANTHROPIC_API_KEY: "provider-key",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: "provider",
        GOOGLE_APPLICATION_CREDENTIALS: "/credential.json",
        OPENTAG_ACCESS_TOKEN: "opentag-secret",
        RANDOM_SECRET: "other-secret",
      }),
    ).toEqual({
      HOME: "/home/provider",
      PATH: "/bin",
      HTTPS_PROXY: "https://proxy.example",
      NODE_EXTRA_CA_CERTS: "/certificate.pem",
      ANTHROPIC_API_KEY: "provider-key",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: "provider",
      GOOGLE_APPLICATION_CREDENTIALS: "/credential.json",
    });
  });
});

type Scenario = "complete" | "error" | "foreign" | "hold";

class ScriptedClaudeCodeProcess implements ClaudeCodeProcessClient {
  readonly args: readonly string[];
  readonly #scenario: Scenario;
  input?: Readonly<Record<string, unknown>>;
  executing = false;
  interruptCount = 0;
  closeCount = 0;
  #reject?: (error: Error) => void;

  constructor(args: readonly string[], scenario: Scenario) {
    this.args = args;
    this.#scenario = scenario;
  }

  execute(
    inputValue: Readonly<Record<string, unknown>>,
    onMessage: (message: Readonly<Record<string, unknown>>) => void,
    signal: AbortSignal,
  ): Promise<ClaudeCodeProcessResult> {
    this.input = inputValue;
    this.executing = true;
    if (this.#scenario === "hold") {
      return new Promise((_, reject) => {
        this.#reject = reject;
        signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
      });
    }
    for (const message of messages(this.#scenario)) onMessage(message);
    return Promise.resolve({ stderr: "" });
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.#reject?.(new Error("closed"));
    this.#reject = undefined;
  }
}

function claudeFactory(processes: ScriptedClaudeCodeProcess[], scenario: Scenario): ClaudeCodeAgentRuntimeFactory {
  return new ClaudeCodeAgentRuntimeFactory({
    createSessionId: () => SESSION_ID,
    createProcess: (_cwd, args) => {
      const process = new ScriptedClaudeCodeProcess(args, scenario);
      processes.push(process);
      return process;
    },
  });
}

function createRequest(eventSink: CreateAgentRuntimeRequest["eventSink"]): CreateAgentRuntimeRequest {
  return {
    eventSink,
    workspace: { cwd: "/workspace" },
    policy: {
      fileSystem: "unrestricted",
      network: "enabled",
      approvals: "never",
      tools: { mode: "provider-default" },
    },
    configuration: {
      model: "claude-test",
      reasoningEffort: "high",
      provider: { appendSystemPrompt: "Be concise", maxBudgetUsd: 1.5, maxTurns: 5 },
    },
  };
}

function input(text: string) {
  return { items: [{ type: "text" as const, text }] };
}

function argumentAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function messages(scenario: Exclude<Scenario, "hold">): ReadonlyArray<Record<string, unknown>> {
  const sessionId = scenario === "foreign" ? "22222222-2222-4222-8222-222222222222" : SESSION_ID;
  if (scenario === "error") {
    return [
      { type: "system", subtype: "init", session_id: SESSION_ID },
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: SESSION_ID,
        is_error: true,
        errors: ["model unavailable"],
        permission_denials: [],
        usage: {},
      },
    ];
  }
  return [
    {
      type: "system",
      subtype: "init",
      session_id: SESSION_ID,
      model: "claude-test",
      claude_code_version: "2.1.210",
    },
    {
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg-1" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "final answer" } },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_stop" } },
    {
      type: "assistant",
      message: {
        id: "msg-2",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents", is_error: false }],
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      is_error: false,
      result: "final answer",
      stop_reason: "end_turn",
      num_turns: 2,
      total_cost_usd: 0.01,
      permission_denials: [],
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3 },
    },
  ];
}
