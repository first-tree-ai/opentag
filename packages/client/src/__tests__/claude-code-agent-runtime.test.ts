import { readFile, stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import {
  CLAUDE_CODE_AGENT_RUNTIME_MANIFEST,
  ClaudeCodeAgentRuntime,
  ClaudeCodeAgentRuntimeFactory,
  claudeCodeAgentRuntimeEnvironment,
} from "../providers/claude-code/agent-runtime.js";
import { startClaudeCodeHostedToolBridge } from "../providers/claude-code/hosted-tool-bridge.js";
import type { ClaudeCodeProcessClient, ClaudeCodeProcessResult } from "../providers/claude-code/process-wire.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("ClaudeCodeAgentRuntime", () => {
  it.each(["accept", "decline"] as const)(
    "bridges a local permission decision (%s) to the original process",
    async (decision) => {
      const processes: ScriptedClaudeCodeProcess[] = [];
      const events: AgentRuntimeEvent[] = [];
      const request = createRequest((event) => {
        events.push(event);
      });
      const runtime = await claudeFactory(processes, "approval").create({
        ...request,
        policy: { ...request.policy, approvals: "on-request", allowedCommands: ["git status"] },
      });
      const run = runtime.prompt({ runId: "local-run", input: input("work") });
      await vi.waitFor(() => expect(events.some((event) => event.type === "interaction_requested")).toBe(true));
      expect(events).toContainEqual({
        type: "interaction_requested",
        runId: "local-run",
        request: {
          requestId: "permission-1",
          kind: "approval",
          title: "Approve Bash",
          details: { command: "git push" },
        },
      });
      expect(argumentAfter(processes[0]?.args ?? [], "--permission-mode")).toBe("acceptEdits");
      expect(argumentAfter(processes[0]?.args ?? [], "--permission-prompt-tool")).toBe("stdio");
      expect(argumentAfter(processes[0]?.args ?? [], "--setting-sources")).toBe("user,project,local");
      expect(argumentAfter(processes[0]?.args ?? [], "--plugin-dir")).toMatch(/opentag$/);
      expect(processes[0]?.args).not.toContain("--bare");
      expect(JSON.parse(argumentAfter(processes[0]?.args ?? [], "--settings") as string)).toEqual({
        permissions: {
          allow: expect.arrayContaining([
            "Bash(lark-cli im +messages-reply *)",
            "Bash(slack api conversations.history *)",
            "Bash(slack api chat.postMessage *)",
            "Bash(git status *)",
          ]),
        },
      });
      await runtime.respond({
        expectedRunId: "local-run",
        requestId: "permission-1",
        kind: "approval",
        decision,
        scope: "run",
      });
      expect(processes[0]?.sent).toContainEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "permission-1",
          response:
            decision === "accept"
              ? { behavior: "allow", updatedInput: { command: "git push" } }
              : { behavior: "deny", message: "The user declined this action." },
        },
      });
      await expect(run).resolves.toMatchObject({ status: "completed" });
      expect(processes).toHaveLength(1);
      await runtime.close();
    },
  );

  it("passes the quoted managed CLI command into native Bash permissions", async () => {
    const processes: ScriptedClaudeCodeProcess[] = [];
    const request = createRequest(() => undefined);
    const runtime = await claudeFactory(processes, "complete").create({
      ...request,
      policy: { ...request.policy, approvals: "on-request", managedCli: ["/opt/app's bin/opentag-staging"] },
    });
    try {
      await runtime.prompt({ runId: "managed-cli", input: input("continue") });
      const settings = JSON.parse(argumentAfter(processes[0]?.args ?? [], "--settings") as string);
      expect(settings.permissions.allow).toContain(`Bash('/opt/app'"'"'s bin/opentag-staging' *)`);
    } finally {
      await runtime.close();
    }
  });

  it("cancels native permission requests and rejects stale native replies", async () => {
    const processes: ScriptedClaudeCodeProcess[] = [];
    const events: AgentRuntimeEvent[] = [];
    const request = createRequest((event) => {
      events.push(event);
    });
    const runtime = await claudeFactory(processes, "approval").create({
      ...request,
      policy: { ...request.policy, approvals: "on-request" },
    });
    const run = runtime.prompt({ runId: "local-run", input: input("work") });
    await vi.waitFor(() => expect(events.some((event) => event.type === "interaction_requested")).toBe(true));
    processes[0]?.emit({ type: "control_cancel_request", request_id: "permission-1" });
    await vi.waitFor(() => expect(events.some((event) => event.type === "interaction_resolved")).toBe(true));
    await expect(
      (runtime as unknown as { respondProvider(response: unknown): Promise<void> }).respondProvider({
        kind: "approval",
        requestId: "permission-1",
        decision: "accept",
      }),
    ).rejects.toMatchObject({ code: "interaction_not_found" });
    processes[0]?.complete();
    await run;
    await runtime.close();
  });

  it("refuses an unsupported native control request", async () => {
    const processes: ScriptedClaudeCodeProcess[] = [];
    const runtime = await claudeFactory(processes, "approval").create(createRequest(() => undefined));
    const run = runtime.prompt({ runId: "control-run", input: input("work") });
    await vi.waitFor(() => expect(processes[0]?.executing).toBe(true));
    processes[0]?.emit({ type: "control_request", request_id: "unsupported", request: { subtype: "unknown" } });
    processes[0]?.complete();
    await expect(run).resolves.toMatchObject({ status: "failed", error: { code: "provider_protocol_error" } });
    await runtime.close();
  });

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
    expect(runtime.capabilities).toEqual({ steer: "supported", interactions: "supported" });
    expect(runtime.binding).toEqual({
      providerId: "claude-code",
      schemaVersion: 1,
      payload: { sessionId: SESSION_ID },
    });
    expect(result).toMatchObject({
      status: "completed",
      output: [{ type: "text", text: "final answer" }],
      usage: { inputTokens: 110, cachedInputTokens: 2, outputTokens: 3 },
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
    expect(argumentAfter(processes[0]?.args ?? [], "--append-system-prompt")).toBe("OpenTag managed system prompt");
    expect(processes[0]?.args).not.toContain("--strict-mcp-config");
    expect(processes[0]?.args).toContain("--mcp-config");
    expect(processes[0]?.args).not.toContain("--no-chrome");
    const mcpConfig = argumentAfter(processes[0]?.args ?? [], "--mcp-config");
    expect(mcpConfig).toContain("opentag-claude-mcp-");
    await expect(readFile(mcpConfig ?? "", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(processes[0]?.args).not.toContain("--allowedTools");
    expect(JSON.parse(argumentAfter(processes[0]?.args ?? [], "--settings") as string)).toEqual({});
    await runtime.close();
  });

  it("pre-approves only namespaced OpenTag hosted tools alongside native configuration", async () => {
    const processes: ScriptedClaudeCodeProcess[] = [];
    const request = createRequest(() => undefined);
    const runtime = await claudeFactory(processes, "complete").create({
      ...request,
      hostedTools: {
        definitions: [{ name: "example_tool", inputSchema: { type: "object" } }],
        handler: async () => ({ success: true, content: [] }),
      },
    });

    await runtime.prompt({ runId: "run-hosted", input: input("reply") });
    expect(processes[0]?.args).toContain("--allowedTools");
    expect(processes[0]?.args).toContainEqual(expect.stringMatching(/^mcp__h[a-f0-9]{10}__example_tool$/));
    expect(processes[0]?.args).not.toContainEqual(expect.stringMatching(/^mcp__h[a-f0-9]{10}__Read$/));
    expect(argumentAfter(processes[0]?.args ?? [], "--permission-mode")).toBe("bypassPermissions");
    expect(processes[0]?.args).not.toContain("--disallowedTools");
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

  it("reuses names for consecutive Runs but allocates a new identity when the binding is resumed", async () => {
    const captured: { pluginName: string; serverNames: string[]; configPath: string; gatewayToken: string }[] = [];
    const factory = new ClaudeCodeAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      createProcess: (_cwd, args) => new ScriptedClaudeCodeProcess(args, "complete"),
      startHostedToolBridge: async (...args) => {
        const bridge = await startClaudeCodeHostedToolBridge(...args);
        const manifest = JSON.parse(await readFile(`${bridge.pluginPath}/.claude-plugin/plugin.json`, "utf8"));
        const config = JSON.parse(await readFile(bridge.configPath, "utf8"));
        captured.push({
          pluginName: manifest.name,
          serverNames: Object.keys(config.mcpServers),
          configPath: bridge.configPath,
          gatewayToken:
            Object.values(config.mcpServers).map(
              (entry) => (entry as { headers: { Authorization: string } }).headers.Authorization,
            )[0] ?? "",
        });
        return bridge;
      },
    });
    const request = createRequest(() => undefined);
    const configuration = (token: string) => ({
      provider: { mcpGateway: { url: "https://server.example.test/api/v1/mcp", token } },
    });
    const runtime = await factory.create(request);
    try {
      for (const runId of ["one", "two"]) {
        await expect(
          runtime.prompt({ runId, input: input("continue"), configuration: configuration(`otmg_${runId}`) }),
        ).resolves.toMatchObject({ status: "completed" });
      }
      expect(captured[0]?.pluginName).toBe(captured[1]?.pluginName);
      expect(captured[0]?.serverNames).toEqual(captured[1]?.serverNames);
      expect(captured[0]?.gatewayToken).toBe("Bearer otmg_one");
      expect(captured[1]?.gatewayToken).toBe("Bearer otmg_two");
      expect(captured[0]?.configPath).not.toBe(captured[1]?.configPath);
      await runtime.close();
      const binding = runtime.binding;
      if (!binding) throw new Error("Expected a durable binding");
      expect(binding.payload).toEqual({ sessionId: SESSION_ID });
      const resumed = await factory.resume({ ...request, binding });
      try {
        await expect(
          resumed.prompt({ runId: "three", input: input("continue"), configuration: configuration("otmg_three") }),
        ).resolves.toMatchObject({ status: "completed" });
        expect(captured[2]?.pluginName).not.toBe(captured[0]?.pluginName);
        expect(captured[2]?.serverNames).not.toEqual(captured[0]?.serverNames);
        expect(resumed.binding).toEqual(binding);
      } finally {
        await resumed.close();
      }
      for (const entry of captured) await expect(stat(entry.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runtime.close();
    }
  });

  describe("compactContext", () => {
    const BINDING = { providerId: "claude-code", schemaVersion: 1, payload: { sessionId: SESSION_ID } };
    const compacted = [
      { type: "system", subtype: "status", status: "compacting", session_id: SESSION_ID },
      { type: "system", subtype: "compact_boundary", session_id: SESSION_ID },
      { type: "result", subtype: "success", is_error: false, session_id: SESSION_ID, result: "" },
    ];

    function compactionHarness(compactMessages: readonly Record<string, unknown>[], compactFailure?: Error) {
      const processes: ScriptedClaudeCodeProcess[] = [];
      const events: AgentRuntimeEvent[] = [];
      const factory = new ClaudeCodeAgentRuntimeFactory({
        createSessionId: () => SESSION_ID,
        createProcess: (_cwd, args) => {
          const process = new ScriptedClaudeCodeProcess(args, "complete");
          process.onCompact = { messages: compactMessages, failure: compactFailure };
          processes.push(process);
          return process;
        },
      });
      const open = () =>
        factory.resume({
          ...createRequest((event) => {
            events.push(event);
          }),
          binding: BINDING,
        });
      return { processes, events, open, factory };
    }

    it("compacts the same native Session in a separate process before the Run", async () => {
      const { processes, events, open } = compactionHarness(compacted);
      const runtime = await open();
      await expect(runtime.prompt({ runId: "run", input: input("work"), compactContext: true })).resolves.toMatchObject(
        { status: "completed" },
      );
      expect(processes).toHaveLength(2);
      expect(processes[0]?.input).toMatchObject({
        message: { content: [{ type: "text", text: "/compact" }] },
      });
      expect(processes[1]?.input).toMatchObject({ message: { content: [{ type: "text", text: "work" }] } });
      for (const process of processes) {
        expect(process.args[process.args.indexOf("--resume") + 1]).toBe(SESSION_ID);
        expect(process.args).not.toContain("--session-id");
      }
      expect(processes[0]?.closeCount).toBeGreaterThan(0);
      expect(events.some((event) => event.type === "provider_warning")).toBe(false);
      await runtime.close();
    });

    it("does not compact without the request", async () => {
      const { processes, open } = compactionHarness(compacted);
      const runtime = await open();
      await runtime.prompt({ runId: "run", input: input("work") });
      expect(processes).toHaveLength(1);
      await runtime.close();
    });

    it("has nothing to compact in a new conversation", async () => {
      const { processes, factory } = compactionHarness(compacted);
      const runtime = await factory.create(createRequest(() => undefined));
      await runtime.prompt({ runId: "run", input: input("work"), compactContext: true });
      expect(processes).toHaveLength(1);
      await runtime.close();
    });

    it("warns and still runs when no compact boundary arrives", async () => {
      const { processes, events, open } = compactionHarness([
        { type: "result", subtype: "success", is_error: true, session_id: SESSION_ID, result: "Not enough messages" },
      ]);
      const runtime = await open();
      await expect(runtime.prompt({ runId: "run", input: input("work"), compactContext: true })).resolves.toMatchObject(
        { status: "completed" },
      );
      expect(processes).toHaveLength(2);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "provider_warning",
          code: "claude_compaction_failed",
          message: "Not enough messages",
        }),
      );
      await runtime.close();
    });

    it("warns and still runs when the compaction process fails", async () => {
      const { processes, events, open } = compactionHarness([], new Error("compaction exited"));
      const runtime = await open();
      await expect(runtime.prompt({ runId: "run", input: input("work"), compactContext: true })).resolves.toMatchObject(
        { status: "completed" },
      );
      expect(processes).toHaveLength(2);
      expect(events).toContainEqual(
        expect.objectContaining({ code: "claude_compaction_failed", message: "compaction exited" }),
      );
      await runtime.close();
    });

    it("names the failure generically when the compaction process rejects with a non-Error", async () => {
      const { events, open } = compactionHarness([], "exit" as unknown as Error);
      const runtime = await open();
      await runtime.prompt({ runId: "run", input: input("work"), compactContext: true });
      expect(events).toContainEqual(
        expect.objectContaining({
          code: "claude_compaction_failed",
          message: "Claude Code did not compact the conversation",
        }),
      );
      await runtime.close();
    });

    it("still runs when the compaction process does not close cleanly", async () => {
      const { processes, open } = compactionHarness(compacted);
      const runtime = await open();
      await expect(runtime.prompt({ runId: "run", input: input("work"), compactContext: true })).resolves.toMatchObject(
        { status: "completed" },
      );
      expect(processes[0]?.closeCount).toBeGreaterThan(0);
      await runtime.close();
    });

    it("aborts the Run instead of continuing when interrupted during compaction", async () => {
      const processes: ScriptedClaudeCodeProcess[] = [];
      const factory = new ClaudeCodeAgentRuntimeFactory({
        createSessionId: () => SESSION_ID,
        createProcess: (_cwd, args) => {
          const process = new ScriptedClaudeCodeProcess(args, "hold");
          processes.push(process);
          return process;
        },
      });
      const runtime = await factory.resume({ ...createRequest(() => undefined), binding: BINDING });
      const run = runtime.prompt({ runId: "run", input: input("work"), compactContext: true });
      await vi.waitFor(() => expect(processes[0]?.executing).toBe(true));
      await runtime.abort({ expectedRunId: "run" });
      await expect(run).resolves.toMatchObject({ status: "aborted" });
      expect(processes).toHaveLength(1);
      expect(processes[0]?.interruptCount).toBe(1);
      await runtime.close();
    });
  });

  it("removes a fresh bridge when the provider process cannot start", async () => {
    let configPath: string | undefined;
    const factory = new ClaudeCodeAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      createProcess: () => {
        throw new Error("fixture spawn failure");
      },
      startHostedToolBridge: async (...args) => {
        const bridge = await startClaudeCodeHostedToolBridge(...args);
        configPath = bridge.configPath;
        return bridge;
      },
    });
    const runtime = await factory.create(createRequest(() => undefined));
    try {
      await expect(runtime.prompt({ runId: "failure", input: input("work") })).resolves.toMatchObject({
        status: "failed",
        error: { code: "provider_start_failed" },
      });
      if (!configPath) throw new Error("Expected bridge setup before spawn failure");
      await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runtime.close();
    }
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

  it("preserves native plugin environment variables without mutating their source", () => {
    const source = {
      HOME: "/home/provider",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "provider-key",
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
      PLUGIN_API_KEY: "plugin-key",
      CUSTOM_PLUGIN_OPTION: "custom-value",
    };
    const environment = claudeCodeAgentRuntimeEnvironment(source);
    expect(environment).toEqual(source);
    expect(environment).not.toBe(source);
    environment.PLUGIN_API_KEY = "replacement";
    expect(source.PLUGIN_API_KEY).toBe("plugin-key");
    expect(claudeCodeAgentRuntimeEnvironment()).toEqual(process.env);
  });
});

describe("ClaudeCodeAgentRuntime steer", () => {
  it("steers input into the running query and reports one terminal across continued results", async () => {
    const events: AgentRuntimeEvent[] = [];
    const steerable = new SteerableClaudeCodeProcess();
    const runtime = await steerableFactory(steerable).create(createRequest((event) => void events.push(event)));
    try {
      const run = runtime.prompt({ runId: "steer-run", input: input("first") });
      await runtime.steer({ expectedRunId: "steer-run", input: input("second") });
      expect(steerable.steered).toEqual([
        {
          type: "user",
          uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
          message: { role: "user", content: [{ type: "text", text: "second" }] },
          parent_tool_use_id: null,
        },
      ]);
      expect(events).toContainEqual({ type: "input_accepted", runId: "steer-run", input: input("second") });
      // Claude Code answered the first input, then processes the queued steer and answers again.
      steerable.emit(result("first answer", 1, 0.01, 5), false);
      steerable.emit({ type: "system", subtype: "init", session_id: SESSION_ID });
      steerable.emit(result("second answer", 2, 0.02, 7), true);
      steerable.finish();
      await expect(run).resolves.toMatchObject({
        status: "completed",
        output: [
          { type: "text", text: "first answer" },
          { type: "text", text: "second answer" },
        ],
        usage: { inputTokens: 2, outputTokens: 12 },
      });
      expect(events.filter((event) => event.type === "run_completed")).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("reports the latest cumulative cost while summing per-turn usage and turns across steered results", async () => {
    const steerable = new SteerableClaudeCodeProcess();
    const spawned: (readonly string[])[] = [];
    const runtime = await new ClaudeCodeAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      createProcess: (_cwd, args) => {
        spawned.push(args);
        return steerable;
      },
    }).create(createRequest(() => undefined));
    try {
      const run = runtime.prompt({ runId: "cost-run", input: input("first") });
      await runtime.steer({ expectedRunId: "cost-run", input: input("second") });
      // total_cost_usd is the process's running total in streaming-input mode; usage is per turn.
      steerable.emit(result("first answer", 1, 1, 5), false);
      steerable.emit(result("second answer", 2, 2, 7), true);
      steerable.finish();
      await expect(run).resolves.toMatchObject({
        status: "completed",
        usage: { inputTokens: 2, outputTokens: 12 },
        providerDiagnostics: { numTurns: 3, totalCostUsd: 2 },
      });
      // The next Run spawns a fresh resumed process, so its cumulative cost has no in-process baseline.
      const next = runtime.prompt({ runId: "next-run", input: input("third") });
      await vi.waitFor(() => expect(spawned).toHaveLength(2));
      expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
      steerable.emit(result("third answer", 1, 2.5, 3), true);
      steerable.finish();
      await expect(next).resolves.toMatchObject({
        status: "completed",
        usage: { inputTokens: 1, outputTokens: 3 },
        providerDiagnostics: { numTurns: 1, totalCostUsd: 2.5 },
      });
    } finally {
      await runtime.close();
    }
  });

  it("merges continued results that carry partial usage", async () => {
    const steerable = new SteerableClaudeCodeProcess();
    const runtime = await steerableFactory(steerable).create(createRequest(() => undefined));
    try {
      const run = runtime.prompt({ runId: "partial-run", input: input("first") });
      await runtime.steer({ expectedRunId: "partial-run", input: input("second") });
      steerable.emit({ type: "result", subtype: "success", session_id: SESSION_ID, is_error: false }, false);
      steerable.emit(
        {
          type: "result",
          subtype: "success",
          session_id: SESSION_ID,
          is_error: false,
          result: "only answer",
          usage: { cache_read_input_tokens: 4 },
        },
        true,
      );
      steerable.finish();
      await expect(run).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "only answer" }],
        usage: { cachedInputTokens: 4 },
      });
      const empty = runtime.prompt({ runId: "empty-run", input: input("first") });
      await runtime.steer({ expectedRunId: "empty-run", input: input("second") });
      steerable.emit({ type: "result", subtype: "success", session_id: SESSION_ID, is_error: false }, false);
      steerable.emit({ type: "result", subtype: "success", session_id: SESSION_ID, is_error: false }, true);
      steerable.finish();
      await expect(empty).resolves.toMatchObject({ status: "completed", output: [] });
    } finally {
      await runtime.close();
    }
  });

  it("waits for a starting process before writing steer input", async () => {
    const steerable = new SteerableClaudeCodeProcess();
    let releaseBridge!: () => void;
    const bridgeGate = new Promise<void>((resolve) => {
      releaseBridge = resolve;
    });
    const runtime = await steerableFactory(steerable, async (...args) => {
      await bridgeGate;
      return startClaudeCodeHostedToolBridge(...args);
    }).create(createRequest(() => undefined));
    try {
      const run = runtime.prompt({ runId: "starting-run", input: input("first") });
      const steer = runtime.steer({ expectedRunId: "starting-run", input: input("early") });
      expect(steerable.steered).toHaveLength(0);
      releaseBridge();
      await steer;
      expect(steerable.steered).toHaveLength(1);
      steerable.emit(result("done", 1, 0.01, 1), true);
      steerable.finish();
      await expect(run).resolves.toMatchObject({ status: "completed" });
    } finally {
      await runtime.close();
    }
  });

  it("rejects steer after the terminal result or when the process refuses the input", async () => {
    const steerable = new SteerableClaudeCodeProcess();
    const runtime = await steerableFactory(steerable).create(createRequest(() => undefined));
    try {
      const run = runtime.prompt({ runId: "late-run", input: input("first") });
      await vi.waitFor(() => expect(steerable.executing).toBe(true));
      steerable.refuse = true;
      await expect(runtime.steer({ expectedRunId: "late-run", input: input("refused") })).rejects.toMatchObject({
        code: "run_mismatch",
      });
      steerable.refuse = false;
      steerable.emit(result("done", 1, 0.01, 1), true);
      await expect(runtime.steer({ expectedRunId: "late-run", input: input("late") })).rejects.toMatchObject({
        code: "run_mismatch",
      });
      steerable.finish();
      await expect(run).resolves.toMatchObject({ status: "completed", output: [{ type: "text", text: "done" }] });
      // A result that outlives its Run claims nothing.
      steerable.emit(result("stray", 1, 0, 0), true);
    } finally {
      await runtime.close();
    }
  });
});

class SteerableClaudeCodeProcess implements ClaudeCodeProcessClient {
  readonly steered: Readonly<Record<string, unknown>>[] = [];
  executing = false;
  refuse = false;
  #onMessage?: (message: Readonly<Record<string, unknown>>, terminal?: boolean) => void;
  #finish?: () => void;

  execute(
    _input: Readonly<Record<string, unknown>>,
    onMessage: (message: Readonly<Record<string, unknown>>, terminal?: boolean) => void,
  ): Promise<ClaudeCodeProcessResult> {
    this.#onMessage = onMessage;
    this.executing = true;
    onMessage({ type: "system", subtype: "init", session_id: SESSION_ID });
    return new Promise((resolve) => {
      this.#finish = () => resolve({ stderr: "" });
    });
  }

  emit(message: Readonly<Record<string, unknown>>, terminal?: boolean): void {
    this.#onMessage?.(message, terminal);
  }

  finish(): void {
    this.#finish?.();
  }

  async steer(message: Readonly<Record<string, unknown>> & { readonly uuid: string }): Promise<{ started(): boolean }> {
    if (this.refuse) throw new Error("closed");
    this.steered.push(message);
    return { started: () => true };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {
    this.#finish?.();
  }
}

function steerableFactory(
  process: SteerableClaudeCodeProcess,
  startHostedToolBridge?: typeof startClaudeCodeHostedToolBridge,
): ClaudeCodeAgentRuntimeFactory {
  return new ClaudeCodeAgentRuntimeFactory({
    createSessionId: () => SESSION_ID,
    createProcess: () => process,
    ...(startHostedToolBridge ? { startHostedToolBridge } : {}),
  });
}

function result(text: string, numTurns: number, cost: number, outputTokens: number): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    session_id: SESSION_ID,
    is_error: false,
    result: text,
    num_turns: numTurns,
    total_cost_usd: cost,
    permission_denials: [],
    usage: { input_tokens: 1, output_tokens: outputTokens },
  };
}

type Scenario = "complete" | "error" | "foreign" | "hold" | "approval";

class ScriptedClaudeCodeProcess implements ClaudeCodeProcessClient {
  readonly args: readonly string[];
  readonly #scenario: Scenario;
  input?: Readonly<Record<string, unknown>>;
  executing = false;
  interruptCount = 0;
  closeCount = 0;
  #reject?: (error: Error) => void;
  readonly sent: Readonly<Record<string, unknown>>[] = [];
  onCompact?: { messages: readonly Record<string, unknown>[]; failure?: Error | undefined };
  #complete?: () => void;
  #onMessage?: (message: Readonly<Record<string, unknown>>) => void;

  constructor(args: readonly string[], scenario: Scenario) {
    this.args = args;
    this.#scenario = scenario;
  }

  execute(
    inputValue: Readonly<Record<string, unknown>>,
    onMessage: (message: Readonly<Record<string, unknown>>) => void,
    signal: AbortSignal,
  ): Promise<ClaudeCodeProcessResult> {
    this.#onMessage = onMessage;
    this.input = inputValue;
    this.executing = true;
    if (this.onCompact && JSON.stringify(inputValue).includes('"/compact"')) {
      for (const message of this.onCompact.messages) onMessage(message);
      return this.onCompact.failure ? Promise.reject(this.onCompact.failure) : Promise.resolve({ stderr: "" });
    }
    if (this.#scenario === "approval") {
      onMessage({
        type: "control_request",
        request_id: "permission-1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git push" } },
      });
      return new Promise((resolve) => {
        this.#complete = () => {
          for (const message of messages("complete")) onMessage(message);
          resolve({ stderr: "" });
        };
      });
    }
    if (this.#scenario === "hold") {
      return new Promise((_, reject) => {
        this.#reject = reject;
        signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
      });
    }
    for (const message of messages(this.#scenario)) onMessage(message);
    return Promise.resolve({ stderr: "" });
  }

  emit(message: Readonly<Record<string, unknown>>): void {
    this.#onMessage?.(message);
  }
  complete(): void {
    this.#complete?.();
  }
  async send(message: Readonly<Record<string, unknown>>): Promise<void> {
    this.sent.push(message);
    this.#complete?.();
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.#reject?.(new Error("closed"));
    this.#reject = undefined;
    if (this.onCompact && this.closeCount === 1 && this.input && JSON.stringify(this.input).includes('"/compact"')) {
      throw new Error("close failed");
    }
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
    systemPrompt: "OpenTag managed system prompt",
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
      provider: { maxBudgetUsd: 1.5, maxTurns: 5 },
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
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 2,
        output_tokens: 3,
      },
    },
  ];
}
