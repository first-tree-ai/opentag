import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeBinding, AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import { PiAgentRuntime, PiAgentRuntimeFactory, piAgentRuntimeEnvironment } from "../providers/pi/agent-runtime.js";
import { type PiRpcClient, PiRpcError } from "../providers/pi/rpc-wire.js";

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
      usage: { inputTokens: 15, cachedInputTokens: 2, outputTokens: 3 },
      providerDiagnostics: {
        providerSessionId: SESSION_ID,
        stopReason: "stop",
        model: { id: "fixture-model", provider: "fixture" },
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "binding_changed",
      "run_started",
      "model_turn_started",
      "provider_event",
      "message_started",
      "message_delta",
      "message_completed",
      "provider_event",
      "usage_updated",
      "binding_changed",
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

  it("loads the trusted web tools extension explicitly and injects only the endpoint descriptor", async () => {
    const client = new ScriptedPiClient("complete");
    const environments: Array<Readonly<Record<string, string>> | undefined> = [];
    const factory = new PiAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      createClient: (_cwd, args, environment) => {
        client.args = args;
        environments.push(environment);
        return client;
      },
      probeRunner: async () => ({ credential: true, rpc: true, version: "fixture" }),
    });
    const extensionPath = "/opt/opentag/client/dist/pi-extensions/web-tools.mjs";
    const socketPath = "/tmp/opentag-web-abc/web.sock";
    const runtime = await factory.create(
      createRequest(() => undefined, { provider: { webTools: { extensionPath, socketPath } } }),
    );
    await expect(runtime.prompt({ runId: "run-web", input: input("hello") })).resolves.toMatchObject({
      status: "completed",
    });
    expect(client.args).toContain("--no-extensions");
    expect(client.args?.[client.args.indexOf("--extension") + 1]).toBe(extensionPath);
    expect(environments[0]).toEqual({ OPENTAG_WEB_TOOLS_SOCKET: socketPath });
    await runtime.close();
  });

  it("rejects malformed trusted web tools launch facts before spawning anything", async () => {
    const factory = piFactory(new ScriptedPiClient("complete"));
    const invalid: unknown[] = [
      "not-an-object",
      { extensionPath: "/tool.mjs", socketPath: "/tool.sock", extra: true },
      { extensionPath: "relative.mjs", socketPath: "/tool.sock" },
      { extensionPath: "/tool.mjs", socketPath: "relative.sock" },
      { extensionPath: "", socketPath: "/tool.sock" },
    ];
    for (const webTools of invalid) {
      await expect(
        factory.create(createRequest(() => undefined, { provider: { webTools: webTools as never } })),
      ).rejects.toMatchObject({
        code: "configuration_invalid",
      });
    }
  });

  it("passes Agent-scoped skill paths to Pi as explicit --skill arguments", async () => {
    const client = new ScriptedPiClient("complete");
    const factory = new PiAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      createClient: (_cwd, args) => {
        client.args = args;
        return client;
      },
      probeRunner: async () => ({ credential: true, rpc: true, version: "fixture" }),
    });
    const request: CreateAgentRuntimeRequest = {
      ...createRequest(() => undefined),
      skillPaths: ["/workspace/.opentag/skills/alpha", "/workspace/.opentag/skills/beta"],
    };
    const runtime = await factory.create(request);
    await expect(runtime.prompt({ runId: "run-skills", input: input("hello") })).resolves.toMatchObject({
      status: "completed",
    });
    expect(client.args).toEqual(
      expect.arrayContaining([
        "--skill",
        "/workspace/.opentag/skills/alpha",
        "--skill",
        "/workspace/.opentag/skills/beta",
      ]),
    );
    await runtime.close();
  });

  it("resumes the exact binding in a new process and preserves non-prompt overrides", async () => {
    const client = new ScriptedPiClient("complete");
    client.messageCount = 2;
    const runtime = await piFactory(client).resume({
      ...createRequest(() => undefined, { provider: { sessionName: "base" } }),
      binding: materializedBinding(),
    });
    await expect(
      runtime.prompt({
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
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(client.args).toEqual(expect.arrayContaining(["--session-id", SESSION_ID, "--thinking", "max"]));
    expect(client.args).toEqual(
      expect.arrayContaining(["--append-system-prompt", "OpenTag managed system prompt", "--name", "resumed"]),
    );
    expect(client.commands.at(-1)).toEqual({ type: "prompt", message: "one\ntwo" });
    await runtime.close();
  });

  it("fails closed when a materialized session loses history before a later prompt", async () => {
    const sameRuntime = new ScriptedPiClient("complete");
    const sameRuntimeEvents: AgentRuntimeEvent[] = [];
    const runtime = await piFactory(sameRuntime).create(
      createRequest((event) => {
        sameRuntimeEvents.push(event);
      }),
    );
    await expect(runtime.prompt({ runId: "run-kept", input: input("hello") })).resolves.toMatchObject({
      status: "completed",
    });
    expect(sameRuntime.messageCount).toBe(2);
    sameRuntime.messageCount = 0;
    await expect(runtime.prompt({ runId: "run-lost", input: input("again") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Pi session has no conversation history" },
    });
    expect(sameRuntime.commands.filter((command) => command.type === "prompt")).toHaveLength(1);
    expect(sameRuntimeEvents.filter((event) => event.type === "run_completed")).toEqual([
      expect.objectContaining({ type: "run_completed", runId: "run-kept" }),
    ]);
    expect(sameRuntimeEvents.some((event) => event.type === "run_completed" && event.runId === "run-lost")).toBe(false);
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));

    const resumeClient = new ScriptedPiClient("complete");
    const resumeEvents: AgentRuntimeEvent[] = [];
    const resumed = await piFactory(resumeClient).resume({
      ...createRequest((event) => {
        resumeEvents.push(event);
      }),
      binding: materializedBinding(),
    });
    await expect(resumed.prompt({ runId: "run-empty-resume", input: input("hello") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Pi session has no conversation history" },
    });
    expect(resumeClient.commands).toEqual([{ type: "get_state" }]);
    expect(resumeEvents.some((event) => event.type === "run_completed")).toBe(false);
    await vi.waitFor(() => expect(resumed.state.phase).toBe("closed"));
  });

  it("keeps an interrupted first Turn unmaterialized so the next same-runtime Turn can persist", async () => {
    const client = new ScriptedPiClient("complete");
    client.promptError = new PiRpcError("command", "interrupted before assistant");
    const runtime = await piFactory(client).create(createRequest(() => undefined));

    await expect(runtime.prompt({ runId: "run-interrupted", input: input("hello") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "interrupted before assistant" },
    });
    expect(runtime.binding).toEqual(unmaterializedBinding());
    expect(runtime.state.phase).toBe("idle");
    expect(client.commands.filter((command) => command.type === "prompt")).toHaveLength(1);

    client.promptError = undefined;
    await expect(runtime.prompt({ runId: "run-recovered", input: input("hello") })).resolves.toMatchObject({
      status: "completed",
    });
    expect(runtime.binding).toEqual(materializedBinding());
    expect(client.messageCount).toBe(2);
    await runtime.close();
  });

  it("keeps prior history on the same runtime after an interrupt following the first assistant", async () => {
    const client = new ScriptedPiClient("complete");
    client.promptError = new PiRpcError("command", "killed after assistant");
    const runtime = await piFactory(client).create(createRequest(() => undefined));
    await expect(runtime.prompt({ runId: "run-after-assistant", input: input("hello") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "killed after assistant" },
    });
    expect(runtime.binding).toEqual(unmaterializedBinding());
    expect(runtime.state.phase).toBe("idle");

    client.promptError = undefined;
    client.messageCount = 2;
    await expect(runtime.prompt({ runId: "run-kept-history", input: input("continue") })).resolves.toMatchObject({
      status: "completed",
    });
    expect(runtime.binding).toEqual(materializedBinding());
    await runtime.close();
  });

  it("resumes the same UUID after a disk-backed interrupt before the first assistant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentag-pi-binding-before-"));
    try {
      const sessionFile = join(directory, `${SESSION_ID}.jsonl`);
      const sessionFileHash = createHash("sha256").update(sessionFile).digest("hex");
      const bindingPath = join(directory, "binding.json");
      const materialized = {
        providerId: "pi" as const,
        schemaVersion: 1,
        payload: { sessionId: SESSION_ID, sessionFileHash },
      };

      const interrupted = new ScriptedPiClient("complete");
      interrupted.sessionFile = sessionFile;
      interrupted.promptError = new PiRpcError("command", "interrupted before assistant");
      const first = await piFactory(interrupted).create(createRequest(() => undefined));
      await expect(first.prompt({ runId: "run-interrupted", input: input("hello") })).resolves.toMatchObject({
        status: "failed",
        error: { code: "provider_error", message: "interrupted before assistant" },
      });
      expect(first.binding).toEqual(unmaterializedBinding());
      expect(existsSync(sessionFile)).toBe(false);
      await writeFile(bindingPath, JSON.stringify(first.binding));
      await first.close();

      const saved = JSON.parse(await readFile(bindingPath, "utf8")) as AgentRuntimeBinding;
      const recovered = new ScriptedPiClient("complete");
      recovered.sessionFile = sessionFile;
      recovered.persistSession = true;
      const second = await piFactory(recovered).resume({
        ...createRequest(() => undefined),
        binding: saved,
      });
      await expect(second.prompt({ runId: "run-recovered", input: input("hello") })).resolves.toMatchObject({
        status: "completed",
      });
      expect(second.binding).toEqual(materialized);
      expect(existsSync(sessionFile)).toBe(true);
      await writeFile(bindingPath, JSON.stringify(second.binding));
      await second.close();

      const resumedBinding = JSON.parse(await readFile(bindingPath, "utf8")) as AgentRuntimeBinding;
      const resumeClient = new ScriptedPiClient("complete");
      resumeClient.sessionFile = sessionFile;
      resumeClient.messageCount = 2;
      resumeClient.persistSession = true;
      const resumed = await piFactory(resumeClient).resume({
        ...createRequest(() => undefined),
        binding: resumedBinding,
      });
      await expect(resumed.prompt({ runId: "run-resumed", input: input("again") })).resolves.toMatchObject({
        status: "completed",
      });
      expect(resumed.binding).toEqual(materialized);
      await resumed.close();

      const missing = new ScriptedPiClient("complete");
      missing.sessionFile = sessionFile;
      const rejected = await piFactory(missing).resume({
        ...createRequest(() => undefined),
        binding: materialized,
      });
      await expect(rejected.prompt({ runId: "run-missing-history", input: input("hello") })).resolves.toMatchObject({
        status: "failed",
        error: { code: "provider_protocol_error", message: "Pi session has no conversation history" },
      });
      await vi.waitFor(() => expect(rejected.state.phase).toBe("closed"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps prior history when a disk-backed runtime restarts after the first assistant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentag-pi-binding-after-"));
    try {
      const sessionFile = join(directory, `${SESSION_ID}.jsonl`);
      const sessionFileHash = createHash("sha256").update(sessionFile).digest("hex");
      const history = `${JSON.stringify({ type: "session", id: SESSION_ID })}\n${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "tool history" }] },
      })}\n`;
      const interrupted = new ScriptedPiClient("complete");
      interrupted.sessionFile = sessionFile;
      interrupted.persistSession = true;
      interrupted.historyBeforeError = history;
      interrupted.promptError = new PiRpcError("exited", "killed after assistant");
      const first = await piFactory(interrupted).create(createRequest(() => undefined));
      await expect(first.prompt({ runId: "run-after-assistant", input: input("hello") })).resolves.toMatchObject({
        status: "failed",
        error: { code: "provider_error", message: "killed after assistant" },
      });
      expect(first.binding).toEqual(unmaterializedBinding());
      expect(existsSync(sessionFile)).toBe(true);
      expect(await readFile(sessionFile, "utf8")).toContain("tool history");
      const saved = first.binding;
      await first.close();

      const recovered = new ScriptedPiClient("complete");
      recovered.sessionFile = sessionFile;
      recovered.messageCount = 2;
      const second = await piFactory(recovered).resume({
        ...createRequest(() => undefined),
        binding: saved ?? unmaterializedBinding(),
      });
      await expect(second.prompt({ runId: "run-kept-history", input: input("continue") })).resolves.toMatchObject({
        status: "completed",
      });
      expect(second.binding).toEqual({
        providerId: "pi",
        schemaVersion: 1,
        payload: { sessionId: SESSION_ID, sessionFileHash },
      });
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it("resumes an unmaterialized Pi UUID and still rejects incompatible payloads", async () => {
    const client = new ScriptedPiClient("complete");
    const runtime = await piFactory(client).resume({
      ...createRequest(() => undefined),
      binding: unmaterializedBinding(),
    });
    expect(runtime.binding).toEqual(unmaterializedBinding());
    await expect(runtime.prompt({ runId: "run-unmaterialized-resume", input: input("hello") })).resolves.toMatchObject({
      status: "completed",
    });
    expect(runtime.binding).toEqual(materializedBinding());
    await runtime.close();

    const factory = piFactory(new ScriptedPiClient("complete"));
    const rejected: readonly AgentRuntimeBinding[] = [
      { providerId: "codex", schemaVersion: 1, payload: { sessionId: SESSION_ID } },
      { providerId: "pi", schemaVersion: 2, payload: { sessionId: SESSION_ID } },
      { providerId: "pi", schemaVersion: 1, payload: { sessionId: "not-a-uuid" } },
      {
        providerId: "pi",
        schemaVersion: 1,
        payload: { sessionId: SESSION_ID, sessionFileHash: "invalid" },
      },
      {
        providerId: "pi",
        schemaVersion: 1,
        payload: { sessionId: SESSION_ID, extra: true },
      },
    ];
    for (const binding of rejected) {
      await expect(factory.resume({ ...createRequest(() => undefined), binding })).rejects.toMatchObject({
        code: "binding_incompatible",
      });
    }
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
  messageCount = 0;
  persistSession = false;
  historyBeforeError?: string;
  promptError?: Error;
  sessionFile = SESSION_FILE;

  constructor(scenario: Scenario, sessionId = SESSION_ID) {
    this.#scenario = scenario;
    this.#sessionId = sessionId;
  }

  async request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.commands.push(command);
    if (command.type === "get_state") {
      return {
        sessionId: this.#sessionId,
        sessionFile: this.sessionFile,
        messageCount: this.messageCount,
        model: { id: "fixture-model", provider: "fixture" },
      };
    }
    if (command.type === "steer") return undefined;
    if (command.type === "abort") {
      this.#emitRun("aborted");
      return undefined;
    }
    if (command.type !== "prompt") throw new Error(`unexpected Pi command: ${String(command.type)}`);
    if (this.promptError) {
      if (this.persistSession) {
        writeFileSync(
          this.sessionFile,
          this.historyBeforeError ?? `${JSON.stringify({ type: "session", id: this.#sessionId })}\n`,
        );
        this.messageCount = Math.max(this.messageCount, 2);
      }
      throw this.promptError;
    }
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
    this.messageCount = Math.max(this.messageCount, 2);
    if (this.persistSession) {
      writeFileSync(this.sessionFile, `${JSON.stringify({ type: "session", id: this.#sessionId })}\n`);
    }
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
    usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 5 },
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

function unmaterializedBinding() {
  return {
    providerId: "pi" as const,
    schemaVersion: 1,
    payload: { sessionId: SESSION_ID },
  };
}

function materializedBinding() {
  return {
    providerId: "pi" as const,
    schemaVersion: 1,
    payload: { sessionId: SESSION_ID, sessionFileHash: SESSION_FILE_HASH },
  };
}
