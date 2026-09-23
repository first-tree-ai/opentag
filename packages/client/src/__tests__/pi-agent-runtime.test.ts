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

  it("loads only the managed MCP extension and keeps its bearer out of Pi arguments", async () => {
    const client = new ScriptedPiClient("hold");
    let environment: Readonly<Record<string, string>> | undefined;
    const factory = new PiAgentRuntimeFactory({
      mcpAdapterEntry: "/opt/opentag/pi/node_modules/pi-mcp-adapter/index.ts",
      createSessionId: () => SESSION_ID,
      createClient: (_cwd, args, extra) => {
        client.args = args;
        environment = extra;
        return client;
      },
      probeRunner: async () => ({ credential: true, rpc: true, version: "fixture" }),
    });
    const token = "otmg_test_execution_secret";
    const runtime = await factory.create(
      createRequest(() => undefined, {
        provider: {
          mcpGateway: {
            url: "https://opentag.example/api/v1/mcp",
            token,
          },
        },
      }),
    );
    const pending = runtime.prompt({ runId: "run-mcp", input: input("hello") });
    await vi.waitFor(() => expect(client.commands.some((command) => command.type === "prompt")).toBe(true));
    client.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "mcp", statusText: "ready" });
    client.complete();
    await expect(pending).resolves.toMatchObject({ status: "completed" });
    expect(client.args).toContain("--no-extensions");
    expect(client.args.join(" ")).not.toContain(token);
    expect(client.args.filter((arg) => arg === "--extension")).toHaveLength(1);
    expect(client.args[client.args.indexOf("--extension") + 1]).toMatch(/mcp-gateway\.(ts|mjs)$/);
    expect(environment).toMatchObject({
      OPENTAG_MCP_GATEWAY_URL: "https://opentag.example/api/v1/mcp",
      OPENTAG_MCP_GATEWAY_TOKEN: token,
      OPENTAG_PI_MCP_ADAPTER_ENTRY: "/opt/opentag/pi/node_modules/pi-mcp-adapter/index.ts",
    });
    await runtime.close();
  });

  it("accepts MCP adapter status messages without exposing notices or accepting interactive UI", async () => {
    const client = new ScriptedPiClient("hold");
    const events: AgentRuntimeEvent[] = [];
    const runtime = await piFactory(client).create(
      createRequest(
        (event) => {
          events.push(event);
        },
        {
          provider: { mcpGateway: { url: "https://opentag.example/api/v1/mcp", token: "otmg_execution" } },
        },
      ),
    );
    const pending = runtime.prompt({ runId: "run-mcp-ui", input: input("hello") });
    await vi.waitFor(() => expect(client.commands.some((command) => command.type === "prompt")).toBe(true));
    client.emit({ type: "extension_ui_request", method: "setWidget", text: "connected" });
    client.emit({ type: "extension_ui_request", method: "setTitle", title: "MCP" });
    client.emit({ type: "extension_ui_request", method: "notify", message: "secret from server" });
    client.complete();
    await expect(pending).resolves.toMatchObject({ status: "completed" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider_warning",
        code: "pi_mcp_notice",
        message: "Pi MCP adapter reported a notice",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("secret from server");
    await runtime.close();

    const interactiveClient = new ScriptedPiClient("hold");
    const interactiveRuntime = await piFactory(interactiveClient).create(
      createRequest(() => undefined, {
        provider: { mcpGateway: { url: "https://opentag.example/api/v1/mcp", token: "otmg_execution" } },
      }),
    );
    const interactiveRun = interactiveRuntime.prompt({ runId: "run-mcp-interactive", input: input("hello") });
    await vi.waitFor(() => expect(interactiveClient.commands.some((command) => command.type === "prompt")).toBe(true));
    interactiveClient.emit({ type: "extension_ui_request", method: "select", options: ["approve"] });
    await expect(interactiveRun).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error" },
    });
    await interactiveRuntime.close();
  });

  it("rejects malformed MCP descriptors before Pi starts", async () => {
    expect(() => new PiAgentRuntimeFactory({ mcpAdapterEntry: "relative/adapter.ts" })).toThrow(
      "Pi mcpAdapterEntry must be an absolute path",
    );
    const factory = piFactory(new ScriptedPiClient("complete"));
    const invalid: readonly unknown[] = [
      [],
      { token: "otmg_execution" },
      { url: "https://opentag.example/api/v1/mcp", token: "otmg_execution", extra: true },
      { url: "not a URL", token: "otmg_execution" },
      { url: "file:///api/v1/mcp", token: "otmg_execution" },
      { url: "https://opentag.example/wrong", token: "otmg_execution" },
      { url: "https://user@opentag.example/api/v1/mcp", token: "otmg_execution" },
      { url: "https://opentag.example/api/v1/mcp?token=bad", token: "otmg_execution" },
      { url: "https://opentag.example/api/v1/mcp", token: "wrong" },
    ];
    for (const mcpGateway of invalid) {
      await expect(
        factory.create(createRequest(() => undefined, { provider: { mcpGateway: mcpGateway as never } })),
      ).rejects.toMatchObject({ code: "configuration_invalid" });
    }
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

  it("keeps the run in progress through native compaction and folds its usage in exactly once", async () => {
    const client = new ScriptedPiClient("hold");
    const events: AgentRuntimeEvent[] = [];
    const runtime = await piFactory(client).create(
      createRequest((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "run-compaction", input: input("long task") });
    await vi.waitFor(() => expect(client.commands.some((command) => command.type === "prompt")).toBe(true));

    // The business answer completed; Pi runs native threshold compaction BEFORE agent_settled.
    emitAssistantAnswer(client, "final answer");
    client.emit({ type: "compaction_start", reason: "threshold" });
    await vi.waitFor(() => expect(providerEventPayloadTypes(events)).toContain("compaction_start"));
    // Mid-compaction the run stays in progress: no terminal event, the Runtime reports running.
    expect(runtime.state).toMatchObject({ phase: "running", activeRunId: "run-compaction" });
    expect(
      events.some((event) => ["run_completed", "run_failed", "run_aborted", "run_cancelled"].includes(event.type)),
    ).toBe(false);

    client.emit({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        summary: "condensed history",
        firstKeptEntryId: "entry-9",
        tokensBefore: 241_700,
        estimatedTokensAfter: 30_000,
        usage: { input: 240_000, output: 900, cacheRead: 12, cacheWrite: 0 },
      },
    });
    await vi.waitFor(() => expect(events.filter((event) => event.type === "usage_updated")).toHaveLength(2));
    // Still not settled: only agent_settled ends the run.
    expect(runtime.state.phase).toBe("running");
    client.emit({ type: "agent_settled" });
    await expect(run).resolves.toMatchObject({
      status: "completed",
      output: [{ type: "text", text: "final answer" }],
      // The summary request's usage joined the assistant usage exactly once (240,000 + 10 + 5).
      usage: { inputTokens: 240_015, cachedInputTokens: 14, outputTokens: 903 },
    });
    const usageEvents = events.filter((event) => event.type === "usage_updated");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({ usage: { inputTokens: 15, cachedInputTokens: 2, outputTokens: 3 } });
    expect(usageEvents[1]).toMatchObject({ usage: { inputTokens: 240_015, cachedInputTokens: 14, outputTokens: 903 } });
    await runtime.close();
  });

  it("bounds cancellation during native compaction without waiting on the summary request", async () => {
    const client = new ScriptedPiClient("hold");
    const events: AgentRuntimeEvent[] = [];
    const runtime = await piFactory(client).create(
      createRequest((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "run-compaction-cancel", input: input("long task") });
    await vi.waitFor(() => expect(client.commands.some((command) => command.type === "prompt")).toBe(true));
    emitAssistantAnswer(client, "final answer");
    client.emit({ type: "compaction_start", reason: "threshold" });
    await vi.waitFor(() => expect(providerEventPayloadTypes(events)).toContain("compaction_start"));

    // Pinned Pi 0.84.2 cannot abort a native compaction over RPC (session.abort() does not reach
    // it), so the adapter takes the bounded path instead: close the owned Pi process and settle
    // the run as aborted once the process is gone — the cancellation never hangs on the summary
    // request, and the completed business answer stays visible in the result.
    await runtime.abort({ expectedRunId: "run-compaction-cancel", reason: "user stop" });
    expect(client.commands.some((command) => command.type === "abort")).toBe(false);
    expect(client.closed).toBe(true);
    await expect(run).resolves.toMatchObject({
      status: "aborted",
      output: [{ type: "text", text: "final answer" }],
      // The interrupted compaction never reported usage; the assistant usage stands, once.
      usage: { inputTokens: 15, cachedInputTokens: 2, outputTokens: 3 },
      error: { code: "run_aborted" },
    });
    await runtime.close();
  });

  it("survives a failed compaction, the native retry, and settles from the real outcome", async () => {
    const client = new ScriptedPiClient("hold");
    const events: AgentRuntimeEvent[] = [];
    const runtime = await piFactory(client).create(
      createRequest((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "run-compaction-recover", input: input("long task") });
    await vi.waitFor(() => expect(client.commands.some((command) => command.type === "prompt")).toBe(true));

    // The first model answer overflowed the context (the proxy-classified envelope Pi recognizes).
    const overflow = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: '400: {"code":"context_length_exceeded","message":"The request exceeds the model context window"}',
      usage: { input: 250_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    client.emit({ type: "agent_start" });
    client.emit({ type: "turn_start" });
    client.emit({ type: "message_start", message: { role: "user", content: "hello" } });
    client.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    client.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    client.emit({ type: "message_end", message: overflow });
    client.emit({ type: "turn_end", message: overflow, toolResults: [] });
    client.emit({ type: "agent_end", messages: [overflow], willRetry: true });

    // The first summarization attempt fails: a diagnostic, never the run's own verdict.
    client.emit({ type: "compaction_start", reason: "overflow" });
    client.emit({
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: true,
      errorMessage: "Compaction failed: 429 rate limit",
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "provider_warning" && event.code === "pi_compaction_failed")).toBe(
        true,
      ),
    );
    expect(runtime.state.phase).toBe("running");

    // Pi's native recovery: a bounded retry compacts and the agent loop continues to a real answer.
    client.emit({ type: "compaction_start", reason: "overflow" });
    client.emit({
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: true,
      result: {
        summary: "recovered history",
        firstKeptEntryId: "entry-3",
        tokensBefore: 250_100,
        estimatedTokensAfter: 28_000,
        usage: { input: 240_000, output: 800, cacheRead: 0, cacheWrite: 0 },
      },
    });
    const recovered = {
      role: "assistant",
      content: [{ type: "text", text: "recovered answer" }],
      stopReason: "stop",
      usage: { input: 31_000, output: 12, cacheRead: 4, cacheWrite: 6 },
    };
    client.emit({ type: "turn_start" });
    client.emit({ type: "message_start", message: { ...recovered, content: [] } });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "start" } });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered answer" },
    });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "recovered answer" },
    });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "done", reason: "stop" } });
    client.emit({ type: "message_end", message: recovered });
    client.emit({ type: "turn_end", message: recovered, toolResults: [] });
    client.emit({ type: "agent_end", messages: [recovered], willRetry: false });
    client.emit({ type: "agent_settled" });

    await expect(run).resolves.toMatchObject({
      status: "completed",
      output: [{ type: "text", text: "recovered answer" }],
      // Overflow attempt + one summary + recovered answer, each counted exactly once.
      usage: { inputTokens: 521_006, cachedInputTokens: 4, outputTokens: 812 },
    });
    const warnings = events.filter((event) => event.type === "provider_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "pi_compaction_failed",
      message: "Compaction failed: 429 rate limit",
    });
    await runtime.close();
  });

  it("never lets a compaction failure falsify the run's actual outcome", async () => {
    // Case 1: the business output completed; a trailing compaction failure is diagnostic only.
    const completedClient = new ScriptedPiClient("hold");
    const completedEvents: AgentRuntimeEvent[] = [];
    const completedRuntime = await piFactory(completedClient).create(
      createRequest((event) => {
        completedEvents.push(event);
      }),
    );
    const completedRun = completedRuntime.prompt({ runId: "run-compaction-fail-after-stop", input: input("task") });
    await vi.waitFor(() => expect(completedClient.commands.some((command) => command.type === "prompt")).toBe(true));
    emitAssistantAnswer(completedClient, "final answer");
    completedClient.emit({ type: "compaction_start", reason: "threshold" });
    completedClient.emit({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      errorMessage: "Compaction failed: upstream unavailable",
    });
    await vi.waitFor(() =>
      expect(
        completedEvents.some((event) => event.type === "provider_warning" && event.code === "pi_compaction_failed"),
      ).toBe(true),
    );
    expect(completedRuntime.state.phase).toBe("running");
    completedClient.emit({ type: "agent_settled" });
    await expect(completedRun).resolves.toMatchObject({
      status: "completed",
      output: [{ type: "text", text: "final answer" }],
    });
    await completedRuntime.close();

    // Case 2: the model call was interrupted (context overflow) and Pi's one-shot overflow
    // recovery is already exhausted — pinned Pi 0.84.2 reports that with a compaction_end ALONE
    // (no compaction_start on this path). The run fails with the real model error and never
    // "completes"; the recovery diagnostic stays a warning.
    const failedClient = new ScriptedPiClient("hold");
    const failedEvents: AgentRuntimeEvent[] = [];
    const failedRuntime = await piFactory(failedClient).create(
      createRequest((event) => {
        failedEvents.push(event);
      }),
    );
    const failedRun = failedRuntime.prompt({ runId: "run-compaction-exhausted", input: input("task") });
    await vi.waitFor(() => expect(failedClient.commands.some((command) => command.type === "prompt")).toBe(true));
    const overflow = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: '400: {"code":"context_length_exceeded","message":"The request exceeds the model context window"}',
      usage: { input: 250_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    failedClient.emit({ type: "agent_start" });
    failedClient.emit({ type: "turn_start" });
    failedClient.emit({ type: "message_start", message: { role: "user", content: "hello" } });
    failedClient.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    failedClient.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    failedClient.emit({ type: "message_end", message: overflow });
    failedClient.emit({ type: "turn_end", message: overflow, toolResults: [] });
    failedClient.emit({ type: "agent_end", messages: [overflow], willRetry: false });
    failedClient.emit({
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: false,
      errorMessage:
        "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
    });
    await vi.waitFor(() =>
      expect(
        failedEvents.some((event) => event.type === "provider_warning" && event.code === "pi_compaction_failed"),
      ).toBe(true),
    );
    expect(failedRuntime.state.phase).toBe("running");
    failedClient.emit({ type: "agent_settled" });
    await expect(failedRun).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "provider_error",
        message: '400: {"code":"context_length_exceeded","message":"The request exceeds the model context window"}',
      },
    });
    await failedRuntime.close();
  });

  it("fails closed on a malformed compaction envelope instead of guessing", async () => {
    const client = new ScriptedPiClient("hold");
    const runtime = await piFactory(client).create(createRequest(() => undefined));
    const run = runtime.prompt({ runId: "run-compaction-malformed", input: input("task") });
    await vi.waitFor(() => expect(client.commands.some((command) => command.type === "prompt")).toBe(true));
    emitAssistantAnswer(client, "final answer");
    client.emit({ type: "compaction_start", reason: "threshold" });
    client.emit({ type: "compaction_end", reason: "threshold", result: "not-an-object" });
    await expect(run).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Pi compaction_end result is invalid" },
    });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
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

  /** Emit one raw Pi event, for scenarios the canned sequences do not cover (e.g. compaction). */
  emit(message: Readonly<Record<string, unknown>>): void {
    this.#emit(message);
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

/**
 * Emit a complete business answer through `agent_end` WITHOUT `agent_settled`, leaving the run in
 * the exact window where pinned Pi 0.84.2 performs native auto-compaction.
 */
function emitAssistantAnswer(client: ScriptedPiClient, text: string): void {
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 5 },
  };
  client.emit({ type: "agent_start" });
  client.emit({ type: "turn_start" });
  client.emit({ type: "message_start", message: { role: "user", content: "hello" } });
  client.emit({ type: "message_end", message: { role: "user", content: "hello" } });
  client.emit({ type: "message_start", message: { ...assistant, content: [] } });
  client.emit({ type: "message_update", assistantMessageEvent: { type: "start" } });
  client.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  client.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
  client.emit({ type: "message_update", assistantMessageEvent: { type: "done", reason: "stop" } });
  client.emit({ type: "message_end", message: assistant });
  client.emit({ type: "turn_end", message: assistant, toolResults: [] });
  client.emit({ type: "agent_end", messages: [assistant], willRetry: false });
}

/** The payload types of the raw provider diagnostics observed so far (e.g. compaction events). */
function providerEventPayloadTypes(events: readonly AgentRuntimeEvent[]): unknown[] {
  return events
    .filter((event) => event.type === "provider_event")
    .map((event) => (event.payload as { type?: unknown }).type);
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
