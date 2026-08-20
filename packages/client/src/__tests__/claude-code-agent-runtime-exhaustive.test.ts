import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRunConfiguration,
  AgentRuntimeEvent,
  AgentRuntimePolicy,
  CreateAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import {
  ClaudeCodeAgentRuntimeFactory,
  claudeCodeAgentRuntimeEnvironment,
} from "../providers/claude-code/agent-runtime.js";
import type { ClaudeCodeProcessClient, ClaudeCodeProcessResult } from "../providers/claude-code/process-wire.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const fixture = fileURLToPath(new URL("./fixtures/claude-code-stream.mjs", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("ClaudeCodeAgentRuntime exhaustive behavior", () => {
  it("translates complete and fallback stream shapes without duplicating lifecycle events", async () => {
    const events: AgentRuntimeEvent[] = [];
    const process = new ManualClaudeCodeProcess(comprehensiveMessages());
    const runtime = await factory(process).create(
      createRequest((event) => {
        events.push(event);
      }),
    );

    const result = await runtime.prompt({ runId: "run-1", input: input("exercise every stream shape") });

    expect(result).toMatchObject({ status: "completed", output: [] });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_updated", toolCallId: "tool-stream" }),
        expect.objectContaining({ type: "tool_completed", toolCallId: "tool-failed", status: "failed" }),
        expect.objectContaining({ type: "tool_completed", toolCallId: "tool-denied", status: "declined" }),
        expect.objectContaining({ type: "provider_warning", code: "claude_code_assistant_error" }),
        expect.objectContaining({ type: "usage_updated", usage: { outputTokens: 1 } }),
      ]),
    );
    expect(events.filter((event) => event.type === "message_completed")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "seed" }),
        expect.objectContaining({ text: "" }),
        expect.objectContaining({ text: "fallback" }),
      ]),
    );
    process.emit({ type: "late_event", value: true });
    await runtime.close();
  });

  it("preserves a valid terminal claimed behind blocked event delivery against a following abort", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const process = new ManualClaudeCodeProcess([
      { type: "status", value: "blocked" },
      successResult({ result: "kept" }),
    ]);
    const runtime = await factory(process).create(
      createRequest(async (event) => {
        if (
          event.type === "provider_event" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          !Array.isArray(event.payload) &&
          event.payload.type === "status"
        ) {
          await blocked;
        }
      }),
    );
    const run = runtime.prompt({ runId: "run-1", input: input("race") });
    await vi.waitFor(() => expect(process.emittedTypes).toEqual(["status", "result"]));

    await runtime.abort({ expectedRunId: "run-1", reason: "late" });
    expect(process.interruptCount).toBe(0);
    release();

    await expect(run).resolves.toMatchObject({ status: "completed", output: [{ text: "kept" }] });
    await runtime.close();
  });

  it("handles immediate abort before process creation without damaging the Runtime", async () => {
    const process = new ManualClaudeCodeProcess([], { hold: true });
    const runtime = await factory(process).create(createRequest(() => undefined));
    const run = runtime.prompt({ runId: "run-1", input: input("abort immediately") });

    await runtime.abort({ expectedRunId: "run-1" });

    await expect(run).resolves.toMatchObject({ status: "aborted" });
    await runtime.close();
  });

  it.each([
    { name: "missing terminal", messages: [] },
    { name: "foreign init", messages: [{ type: "system", subtype: "init", session_id: "other" }] },
    { name: "missing type", messages: [{}] },
    { name: "invalid stream envelope", messages: [{ type: "stream_event", event: null }] },
    { name: "invalid message start", messages: [{ type: "stream_event", event: { type: "message_start" } }] },
    {
      name: "invalid content index",
      messages: [
        stream({ type: "message_start", message: { id: "msg" } }),
        stream({ type: "content_block_start", index: -1, content_block: { type: "text" } }),
      ],
    },
    {
      name: "content without message",
      messages: [stream({ type: "content_block_start", index: 0, content_block: { type: "text" } })],
    },
    {
      name: "text delta without block",
      messages: [
        stream({ type: "message_start", message: { id: "msg" } }),
        stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
      ],
    },
    {
      name: "tool delta without block",
      messages: [
        stream({ type: "message_start", message: { id: "msg" } }),
        stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
      ],
    },
    { name: "message stop without start", messages: [stream({ type: "message_stop" })] },
    { name: "invalid assistant", messages: [{ type: "assistant", message: null }] },
    { name: "invalid assistant content", messages: [{ type: "assistant", message: { id: "msg" } }] },
    {
      name: "invalid assistant block",
      messages: [{ type: "assistant", message: { id: "msg", content: [null] } }],
    },
    {
      name: "invalid text block",
      messages: [{ type: "assistant", message: { id: "msg", content: [{ type: "text" }] } }],
    },
    {
      name: "invalid tool block",
      messages: [{ type: "assistant", message: { id: "msg", content: [{ type: "tool_use", id: "tool" }] } }],
    },
    { name: "invalid user", messages: [{ type: "user", message: null }] },
    {
      name: "invalid tool result",
      messages: [
        { type: "assistant", message: { id: "msg", content: [{ type: "tool_use", id: "tool", name: "Read" }] } },
        { type: "user", message: { content: [{ type: "tool_result" }] } },
      ],
    },
    { name: "invalid result uuid", messages: [{ type: "result", session_id: "invalid", subtype: "success" }] },
    { name: "invalid result subtype", messages: [{ type: "result", session_id: SESSION_ID }] },
    {
      name: "invalid result errors",
      messages: [{ type: "result", session_id: SESSION_ID, subtype: "error", errors: [false] }],
    },
    {
      name: "invalid permission denial",
      messages: [{ type: "result", session_id: SESSION_ID, subtype: "success", permission_denials: [null] }],
    },
    { name: "non-json provider event", messages: [{ type: "unknown", value: undefined }] },
  ])("fails closed for $name", async ({ messages }) => {
    const runtime = await factory(new ManualClaudeCodeProcess(messages)).create(createRequest(() => undefined));

    await expect(runtime.prompt({ runId: "run-1", input: input("malformed") })).resolves.toMatchObject({
      status: "failed",
    });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("rejects a resumed foreign init before translating any following Provider events", async () => {
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory(
      new ManualClaudeCodeProcess([
        { type: "system", subtype: "init", session_id: "22222222-2222-4222-8222-222222222222" },
        { type: "foreign_event", value: true },
      ]),
    ).resume({
      ...createRequest((event) => {
        events.push(event);
      }),
      binding: { providerId: "claude-code", schemaVersion: 1, payload: { sessionId: SESSION_ID } },
    });

    await expect(runtime.prompt({ runId: "run-foreign-resume", input: input("continue") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Claude Code initialized another session" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "binding_changed",
      "run_started",
      "run_failed",
      "runtime_closed",
    ]);
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("maps process construction, execution, and close failures without leaking them", async () => {
    const construction = new ClaudeCodeAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      createProcess: () => {
        throw new Error("spawn failed");
      },
    });
    const constructionRuntime = await construction.create(createRequest(() => undefined));
    await expect(constructionRuntime.prompt({ runId: "run-1", input: input("x") })).resolves.toMatchObject({
      status: "failed",
      error: { message: "spawn failed" },
    });
    await vi.waitFor(() => expect(constructionRuntime.state.phase).toBe("closed"));

    const executionRuntime = await factory(new ManualClaudeCodeProcess([], { executeError: 42 })).create(
      createRequest(() => undefined),
    );
    await expect(executionRuntime.prompt({ runId: "run-2", input: input("x") })).resolves.toMatchObject({
      status: "failed",
      error: { message: "Claude Code run failed" },
    });
    await vi.waitFor(() => expect(executionRuntime.state.phase).toBe("closed"));

    const duplicateFailureRuntime = await factory(new ManualClaudeCodeProcess([{}, {}])).create(
      createRequest(() => undefined),
    );
    await duplicateFailureRuntime.prompt({ runId: "run-duplicate-failure", input: input("x") });
    await vi.waitFor(() => expect(duplicateFailureRuntime.state.phase).toBe("closed"));

    const nonErrorSinkRuntime = await factory(new ManualClaudeCodeProcess([{ type: "status" }])).create(
      createRequest((event) => {
        if (event.type === "provider_event") throw 42;
      }),
    );
    await expect(nonErrorSinkRuntime.prompt({ runId: "run-non-error-sink", input: input("x") })).resolves.toMatchObject(
      { status: "failed", error: { code: "event_delivery_failed" } },
    );

    const closeRejectingProcess = new ManualClaudeCodeProcess([successResult()], { closeError: true });
    const closeRejectingRuntime = await factory(closeRejectingProcess).create(createRequest(() => undefined));
    await expect(closeRejectingRuntime.prompt({ runId: "run-close-reject", input: input("x") })).resolves.toMatchObject(
      {
        status: "completed",
      },
    );
    await closeRejectingRuntime.close();
  });

  it("maps all terminal error message fallbacks and partial usage fields", async () => {
    const resultFallback = await runTerminal(
      successResult({
        is_error: true,
        result: "result failure",
        usage: { input_tokens: 1, cache_read_input_tokens: -1, output_tokens: Number.NaN },
      }),
    );
    expect(resultFallback).toMatchObject({
      status: "failed",
      output: [{ text: "result failure" }],
      usage: { inputTokens: 1 },
      error: { message: "result failure" },
    });

    const subtypeFallback = await runTerminal({
      type: "result",
      session_id: SESSION_ID,
      subtype: "error_max_turns",
      permission_denials: [],
    });
    expect(subtypeFallback).toMatchObject({
      status: "failed",
      output: [],
      error: { message: "Claude Code failed: error_max_turns" },
    });

    await expect(
      runTerminal({ type: "result", session_id: SESSION_ID, subtype: "success", is_error: false }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("validates every factory, policy, configuration, binding, and probe boundary", async () => {
    const invalidRequests: Array<{ request: unknown; message: string }> = [
      { request: undefined, message: "eventSink" },
      { request: {}, message: "eventSink" },
      { request: { ...createRequest(() => undefined), workspace: { cwd: "relative" } }, message: "absolute" },
      {
        request: { ...createRequest(() => undefined), workspace: { cwd: "/workspace", writableRoots: ["relative"] } },
        message: "writable roots",
      },
      { request: withPolicy({ approvals: "on-request" }), message: "approvals=never" },
      {
        request: withPolicy({ fileSystem: "read-only" }),
        message: "constrained filesystem",
      },
      {
        request: withPolicy({ fileSystem: "workspace-write" }),
        message: "constrained filesystem",
      },
      { request: withPolicy({ network: "disabled" }), message: "disabled network" },
      {
        request: withPolicy({ tools: { mode: "allow-list", names: ["Read"] } }),
        message: "does not implement the common tool allow-list contract",
      },
      { request: withConfiguration({ model: " " }), message: "model" },
      { request: withConfiguration({ reasoningEffort: "extreme" }), message: "reasoning effort" },
      { request: withConfiguration({ provider: [] }), message: "must be an object" },
      { request: withConfiguration({ provider: { unknown: true } }), message: "unknown" },
      { request: withConfiguration({ provider: { appendSystemPrompt: "" } }), message: "appendSystemPrompt" },
      { request: withConfiguration({ provider: { appendSystemPrompt: 1 } }), message: "appendSystemPrompt" },
      { request: withConfiguration({ provider: { maxBudgetUsd: "1" } }), message: "maxBudgetUsd" },
      { request: withConfiguration({ provider: { maxBudgetUsd: Number.NaN } }), message: "finite JSON" },
      { request: withConfiguration({ provider: { maxBudgetUsd: 0 } }), message: "maxBudgetUsd" },
      { request: withConfiguration({ provider: { maxTurns: 1.5 } }), message: "maxTurns" },
      { request: withConfiguration({ provider: { maxTurns: 0 } }), message: "maxTurns" },
    ];
    for (const { request, message } of invalidRequests) {
      await expect(new ClaudeCodeAgentRuntimeFactory().create(request as CreateAgentRuntimeRequest)).rejects.toThrow(
        message,
      );
    }

    await expect(
      new ClaudeCodeAgentRuntimeFactory().resume({
        ...createRequest(() => undefined),
        binding: { providerId: "claude-code", schemaVersion: 1, payload: [] },
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    await expect(
      new ClaudeCodeAgentRuntimeFactory().resume({
        ...createRequest(() => undefined),
        binding: { providerId: "claude-code", schemaVersion: 1, payload: { sessionId: "bad" } },
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    await expect(
      new ClaudeCodeAgentRuntimeFactory({ createSessionId: () => "bad" }).create(createRequest(() => undefined)),
    ).rejects.toThrow("UUID");
    await expect(
      new ClaudeCodeAgentRuntimeFactory().create(
        createRequest(() => {
          throw new Error("sink failed");
        }),
      ),
    ).rejects.toMatchObject({ code: "create_failed" });
    await expect(
      new ClaudeCodeAgentRuntimeFactory().resume({
        ...createRequest(() => {
          throw new Error("sink failed");
        }),
        binding: { providerId: "claude-code", schemaVersion: 1, payload: { sessionId: SESSION_ID } },
      }),
    ).rejects.toMatchObject({ code: "resume_failed" });

    const probe = new ClaudeCodeAgentRuntimeFactory({
      probeRunner: async () => {
        throw new Error("missing");
      },
    });
    await expect(probe.probe({ configuration: { reasoningEffort: "bad" } })).resolves.toEqual({
      ready: false,
      issues: [
        { code: "configuration_invalid", message: "Claude Code reasoning effort is unsupported" },
        { code: "artifact_missing", message: "Claude Code CLI could not be executed" },
      ],
    });
  });

  it("maps unrestricted policy and configuration override arguments", async () => {
    const cases: Array<{
      request: CreateAgentRuntimeRequest;
      promptConfiguration?: AgentRunConfiguration;
      expected: (args: readonly string[]) => void;
    }> = [
      {
        request: withPolicy({ fileSystem: "unrestricted", network: "enabled" }),
        expected: (args) => {
          expect(argumentAfter(args, "--permission-mode")).toBe("bypassPermissions");
          expect(args).not.toContain("--settings");
          expect(args).not.toContain("--tools");
        },
      },
      {
        request: { ...createRequest(() => undefined), configuration: undefined },
        promptConfiguration: { model: "override", provider: { maxTurns: 2 } },
        expected: (args) => {
          expect(argumentAfter(args, "--model")).toBe("override");
          expect(argumentAfter(args, "--max-turns")).toBe("2");
          expect(args).not.toContain("--effort");
        },
      },
      {
        request: { ...createRequest(() => undefined), configuration: undefined },
        expected: (args) => {
          expect(args).not.toContain("--model");
          expect(args).not.toContain("--effort");
          expect(args).not.toContain("--append-system-prompt");
          expect(args).not.toContain("--max-budget-usd");
          expect(args).not.toContain("--max-turns");
        },
      },
      {
        request: createRequest(() => undefined),
        promptConfiguration: {
          model: "override",
          provider: { appendSystemPrompt: "Override", maxBudgetUsd: 2 },
        },
        expected: (args) => {
          expect(argumentAfter(args, "--model")).toBe("override");
          expect(argumentAfter(args, "--append-system-prompt")).toBe("Override");
          expect(argumentAfter(args, "--max-budget-usd")).toBe("2");
          expect(argumentAfter(args, "--max-turns")).toBe("5");
        },
      },
    ];
    for (const item of cases) {
      const process = new ManualClaudeCodeProcess([successResult()]);
      const runtime = await factory(process).create(item.request);
      await runtime.prompt({
        runId: `run-${processSequence}`,
        input: input("args"),
        configuration: item.promptConfiguration,
      });
      item.expected(process.args);
      await runtime.close();
    }
  });

  it("preserves a typed protocol failure when the real JSONL process is closed after a foreign init", async () => {
    const events: AgentRuntimeEvent[] = [];
    const runtime = await new ClaudeCodeAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      process: {
        command: process.execPath,
        args: [fixture, "foreign-init"],
        env: { PATH: process.env.PATH },
      },
      probeRunner: async () => ({ credential: true, streamJson: true, version: "fixture" }),
    }).create({
      ...createRequest((event) => {
        events.push(event);
      }),
      workspace: { cwd: process.cwd() },
    });

    await expect(runtime.prompt({ runId: "run-wire-foreign-init", input: input("hello") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Claude Code initialized another session" },
    });
    expect(events.some((event) => event.type === "provider_event")).toBe(false);
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("runs the default process adapter and the default local readiness probe against controlled artifacts", async () => {
    const runtime = await new ClaudeCodeAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      process: {
        command: process.execPath,
        args: [fixture],
        env: { PATH: process.env.PATH },
      },
      probeRunner: async () => ({ credential: true, streamJson: true, version: "fixture" }),
    }).create({ ...createRequest(() => undefined), workspace: { cwd: process.cwd() } });
    const defaultProcessResult = await runtime.prompt({ runId: "run-default-process", input: input("hello") });
    expect(defaultProcessResult.status, JSON.stringify(defaultProcessResult)).toBe("completed");
    await runtime.close();

    const directory = await temporaryDirectory("opentag-claude-probe-");
    const command = join(directory, "claude-fixture");
    await writeFile(
      command,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2.1.210 (Claude Code)\\n"; exit 0; fi\nif [ "$1" = "--help" ]; then printf "stream-json --session-id --resume\\n"; exit 0; fi\nif [ -n "$CLAUDE_CODE_SKIP_PROMPT_HISTORY" ]; then printf \'{"loggedIn":false}\\n\'; exit 1; fi\nprintf \'{"loggedIn":true}\\n\'\n',
      "utf8",
    );
    await chmod(command, 0o755);
    const ready = new ClaudeCodeAgentRuntimeFactory({ process: { command, env: { PATH: process.env.PATH } } });
    await expect(ready.probe({})).resolves.toEqual({
      ready: true,
      version: "2.1.210 (Claude Code)",
      issues: [],
    });
    const persistenceSafe = new ClaudeCodeAgentRuntimeFactory({
      process: {
        command,
        env: { PATH: process.env.PATH, CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" },
      },
    });
    await expect(persistenceSafe.probe({})).resolves.toMatchObject({ ready: true });

    for (const credential of [
      { ANTHROPIC_API_KEY: "key" },
      { CLAUDE_CODE_USE_BEDROCK: "1" },
      { CLAUDE_CODE_USE_FOUNDRY: "1" },
      { CLAUDE_CODE_USE_VERTEX: "1" },
    ]) {
      const environmentCredential = new ClaudeCodeAgentRuntimeFactory({
        process: {
          command,
          env: { PATH: process.env.PATH, ...credential },
        },
      });
      await expect(environmentCredential.probe({})).resolves.toMatchObject({ ready: true });
    }

    for (const mode of ["logged-out", "invalid", "empty"]) {
      const missingCommand = join(directory, `claude-${mode}`);
      const authResponse =
        mode === "logged-out"
          ? "printf '{\"loggedIn\":false}\\n'; exit 1"
          : mode === "invalid"
            ? "printf 'not-json\\n'; exit 0"
            : "exit 1";
      await writeFile(
        missingCommand,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2.1.210 (Claude Code)\\n"; exit 0; fi\nif [ "$1" = "--help" ]; then printf "stream-json --session-id --resume\\n"; exit 0; fi\n${authResponse}\n`,
        "utf8",
      );
      await chmod(missingCommand, 0o755);
      const missingCredential = new ClaudeCodeAgentRuntimeFactory({
        process: { command: missingCommand, env: { PATH: process.env.PATH } },
      });
      await expect(missingCredential.probe({})).resolves.toMatchObject({
        ready: false,
        issues: [{ code: "credential_missing" }],
      });
    }

    const vanishingCommand = join(directory, "claude-vanishing");
    await writeFile(
      vanishingCommand,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2.1.210 (Claude Code)\\n"; exit 0; fi\nif [ "$1" = "--help" ]; then printf "stream-json --session-id --resume\\n"; mv "$0" "$0.gone"; exit 0; fi\n',
      "utf8",
    );
    await chmod(vanishingCommand, 0o755);
    await expect(
      new ClaudeCodeAgentRuntimeFactory({
        process: { command: vanishingCommand, env: { PATH: process.env.PATH } },
      }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "credential_missing" }] });

    const brokenCommand = join(directory, "claude-broken");
    await writeFile(
      brokenCommand,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nif [ "$1" = "--help" ]; then printf "old\\n"; exit 0; fi\nprintf \'not-json\\n\'\n',
      "utf8",
    );
    await chmod(brokenCommand, 0o755);
    await expect(
      new ClaudeCodeAgentRuntimeFactory({ process: { command: brokenCommand, env: { PATH: process.env.PATH } } }).probe(
        {},
      ),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "artifact_missing" }] });
    expect(claudeCodeAgentRuntimeEnvironment()).toEqual(expect.any(Object));
  });

  it("keeps the package boundary free of Claude SDK, CLI, and bundled binary dependencies", async () => {
    for (const path of [join(process.cwd(), "../..", "package.json"), join(process.cwd(), "package.json")]) {
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, string>>;
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      };
      expect(Object.keys(dependencies).filter((name) => /anthropic|claude/i.test(name))).toEqual([]);
    }
  });
});

interface ManualOptions {
  readonly closeError?: boolean;
  readonly executeError?: unknown;
  readonly hold?: boolean;
}

let processSequence = 0;

class ManualClaudeCodeProcess implements ClaudeCodeProcessClient {
  readonly instance = ++processSequence;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly options: ManualOptions;
  args: readonly string[] = [];
  emittedTypes: unknown[] = [];
  interruptCount = 0;
  closeCount = 0;
  #listener?: (message: Readonly<Record<string, unknown>>) => void;
  #reject?: (error: Error) => void;

  constructor(messages: readonly Readonly<Record<string, unknown>>[], options: ManualOptions = {}) {
    this.messages = messages;
    this.options = options;
  }

  execute(
    _input: Readonly<Record<string, unknown>>,
    onMessage: (message: Readonly<Record<string, unknown>>) => void,
    signal: AbortSignal,
  ): Promise<ClaudeCodeProcessResult> {
    this.#listener = onMessage;
    if (signal.aborted) return Promise.reject(new Error("aborted"));
    for (const message of this.messages) this.emit(message);
    if (this.options.executeError !== undefined) return Promise.reject(this.options.executeError);
    if (this.options.hold) {
      return new Promise((_, reject) => {
        this.#reject = reject;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return Promise.resolve({ stderr: "" });
  }

  emit(message: Readonly<Record<string, unknown>>): void {
    this.emittedTypes.push(message.type);
    this.#listener?.(message);
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.#reject?.(new Error("closed"));
    this.#reject = undefined;
    if (this.options.closeError) throw new Error("close failed");
  }
}

function factory(process: ManualClaudeCodeProcess): ClaudeCodeAgentRuntimeFactory {
  return new ClaudeCodeAgentRuntimeFactory({
    createSessionId: () => SESSION_ID,
    createProcess: (_cwd, args) => {
      process.args = args;
      return process;
    },
    probeRunner: async () => ({ credential: true, streamJson: true, version: "fixture" }),
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

function withPolicy(
  override: Partial<AgentRuntimePolicy>,
  workspace: Partial<CreateAgentRuntimeRequest["workspace"]> = {},
): CreateAgentRuntimeRequest {
  const request = createRequest(() => undefined);
  return {
    ...request,
    workspace: { ...request.workspace, ...workspace },
    policy: { ...request.policy, ...override },
  };
}

function withConfiguration(configuration: AgentRunConfiguration): CreateAgentRuntimeRequest {
  return { ...createRequest(() => undefined), configuration };
}

function input(text: string) {
  return { items: [{ type: "text" as const, text }] };
}

function stream(event: Record<string, unknown>): Record<string, unknown> {
  return { type: "stream_event", event };
}

function successResult(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    session_id: SESSION_ID,
    is_error: false,
    permission_denials: [],
    usage: {},
    ...override,
  };
}

function comprehensiveMessages(): readonly Record<string, unknown>[] {
  return [
    { type: "system", subtype: "init", session_id: SESSION_ID },
    { type: "status", status: "compacting" },
    stream({ type: "unknown_stream_event", value: true }),
    stream({ type: "message_start", message: { id: "msg-stream-text" } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "seed" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }),
    { type: "assistant", message: { id: "msg-stream-text", content: [{ type: "text", text: "seed" }] } },
    stream({ type: "content_block_stop", index: 0 }),
    stream({ type: "message_delta", usage: { output_tokens: 1 } }),
    stream({ type: "message_delta", usage: {} }),
    stream({ type: "message_stop" }),
    stream({ type: "message_start", message: { id: "msg-stream-tool" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool-stream", name: "Bash", input: {} },
    }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } }),
    stream({ type: "content_block_stop", index: 0 }),
    stream({ type: "content_block_start", index: 2, content_block: { type: "text" } }),
    stream({ type: "content_block_stop", index: 2 }),
    stream({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "x" } }),
    stream({ type: "content_block_stop", index: 1 }),
    stream({ type: "message_stop" }),
    { type: "user", message: { content: "not-an-array" } },
    {
      type: "user",
      message: {
        content: [
          "non-object",
          { type: "other" },
          { type: "tool_result", tool_use_id: "unknown" },
          { type: "tool_result", tool_use_id: "tool-stream", is_error: true },
        ],
      },
    },
    {
      type: "assistant",
      error: "model warning",
      message: {
        id: "msg-fallback-text",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "fallback" },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        id: "msg-tools",
        content: [
          { type: "tool_use", id: "tool-denied", name: "Write" },
          { type: "tool_use", id: "tool-failed", name: "Edit", input: {} },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        id: "msg-tools",
        content: [{ type: "tool_use", id: "tool-denied", name: "Write" }],
      },
    },
    successResult({ permission_denials: [{ tool_use_id: "tool-denied" }, { tool_use_id: 42 }] }),
  ];
}

async function runTerminal(terminal: Record<string, unknown>) {
  const runtime = await factory(new ManualClaudeCodeProcess([terminal])).create(createRequest(() => undefined));
  const result = await runtime.prompt({ runId: `terminal-${processSequence}`, input: input("terminal") });
  await runtime.close();
  return result;
}

function argumentAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
