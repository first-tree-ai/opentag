import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import { PiAgentRuntimeFactory, piAgentRuntimeEnvironment } from "../providers/pi/agent-runtime.js";
import { type PiRpcClient, PiRpcError } from "../providers/pi/rpc-wire.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_FILE = `/sessions/${SESSION_ID}.jsonl`;
const SESSION_FILE_HASH = createHash("sha256").update(SESSION_FILE).digest("hex");
const PI_RESOURCE_DISABLE_ARGUMENTS = [
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
] as const;
const PI_HELP_TOKENS =
  "--mode rpc --session-id --session-dir --offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --tools --model --thinking --append-system-prompt --name";
const PI_LIST_MODELS_TABLE = [
  "provider  model            context  max-out  thinking  images",
  "fixture   configured-model  128K     8K       no        no",
].join("\n");
const PI_LIST_MODELS_HEADER = "provider  model  context  max-out  thinking  images";
const PI_NO_MODELS_MESSAGE = [
  "No models available. Use /login to log into a provider via OAuth or API key. See:",
  "  /docs/providers.md",
  "  /docs/models.md",
].join("\n");
const fixture = fileURLToPath(new URL("./fixtures/pi-rpc.mjs", import.meta.url));
const directories: string[] = [];
const PI_TURN_CHILD_EVENTS = new Set([
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PiAgentRuntime exhaustive behavior", () => {
  it("maps all enforceable policy and configuration variants to Pi arguments", async () => {
    const cases: readonly {
      readonly policy: CreateAgentRuntimeRequest["policy"];
      readonly expectedTools?: string;
    }[] = [
      {
        policy: {
          fileSystem: "read-only",
          network: "disabled",
          approvals: "never",
          tools: { mode: "provider-default" },
        },
        expectedTools: "read,grep,find,ls",
      },
      {
        policy: {
          fileSystem: "unrestricted",
          network: "enabled",
          approvals: "never",
          tools: { mode: "provider-default" },
        },
      },
    ];

    for (const [index, item] of cases.entries()) {
      const client = new ManualPiClient();
      const runtime = await factory(client).create({
        ...request(() => undefined),
        policy: item.policy,
        configuration: index === 0 ? undefined : { provider: {} },
      });
      if (index === 1) client.model = null;
      const result = runtime.prompt({
        runId: `policy-${index}`,
        input: input("work"),
        ...(index === 1 ? { configuration: { model: "prompt-model", provider: { sessionName: "run" } } } : {}),
      });
      await client.called("prompt");
      client.complete({ content: [], usage: undefined });
      await expect(result).resolves.toMatchObject({ status: "completed", output: [] });
      const toolsIndex = client.args.indexOf("--tools");
      if (item.expectedTools) expect(client.args[toolsIndex + 1]).toBe(item.expectedTools);
      else expect(toolsIndex).toBe(-1);
      await runtime.close();
    }
  });

  it("translates the complete event surface and accumulates partial usage", async () => {
    const client = new ManualPiClient();
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory(client).create(
      request((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "events", input: input("events") });
    await client.called("prompt");

    client.emit({ type: "agent_start" });
    client.emit({ type: "extension_error", error: "extension broke" });
    client.emit({ type: "extension_error" });
    client.emit({ type: "auto_retry_start", errorMessage: "retry now" });
    client.emit({ type: "auto_retry_start" });
    client.emit({ type: "auto_compaction_start", reason: "threshold" });
    client.emit({ type: "agent_end", willRetry: true });
    client.emit({ type: "turn_start" });
    client.emit({ type: "message_start", message: { role: "user", content: "ignored" } });
    client.emit({ type: "message_end", message: { role: "user", content: "ignored" } });
    client.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hidden" },
    });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "hidden" },
    });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"."}' },
    });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { name: "ls" } },
    });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "error", error: { errorMessage: "official warning" } },
    });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "error", partial: { errorMessage: "partial warning" } },
    });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "done", reason: "stop" } });
    client.emit({
      type: "message_end",
      message: assistant({ content: [{ type: "text", text: "" }], usage: { input: -1, cacheWrite: -1 } }),
    });
    client.emit({ type: "turn_end" });
    client.emit({ type: "turn_start" });
    client.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    client.emit({
      type: "message_end",
      message: assistant({
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "fallback" },
        ],
        usage: { input: -1, cacheRead: 3, output: 4 },
      }),
    });
    client.emit({ type: "tool_execution_start", toolCallId: "one", toolName: "ls" });
    client.emit({ type: "tool_execution_update", toolCallId: "one", partialResult: undefined });
    client.emit({ type: "tool_execution_end", toolCallId: "one", isError: true });
    client.emit({ type: "turn_end" });
    client.emit({ type: "turn_start" });
    client.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" },
    });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ok" },
    });
    client.emit({
      type: "message_end",
      message: assistant({ content: [{ type: "text", text: "ok" }], usage: { input: 2 } }),
    });
    client.emit({ type: "tool_execution_start", toolCallId: "two", toolName: "read", args: null });
    client.emit({ type: "tool_execution_update", toolCallId: "two", partialResult: { value: 1 } });
    client.emit({ type: "tool_execution_end", toolCallId: "two", result: null, isError: false });
    client.emit({ type: "turn_end" });
    client.emit({ type: "turn_start" });
    client.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    client.emit({
      type: "message_end",
      message: assistant({ content: [{ type: "text", text: "ok" }], usage: { cacheRead: 1 } }),
    });
    client.emit({ type: "turn_end" });
    client.emit({ type: "agent_end", willRetry: false });
    client.emit({ type: "agent_settled" });

    await expect(run).resolves.toMatchObject({
      status: "completed",
      output: [{ text: "ok" }],
      usage: { inputTokens: 2, cachedInputTokens: 4, outputTokens: 4 },
    });
    expect(events.filter((event) => event.type === "provider_warning")).toHaveLength(4);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider_event",
          payload: { type: "auto_compaction_start", reason: "threshold" },
        }),
        expect.objectContaining({ type: "tool_completed", status: "failed" }),
        expect.objectContaining({ type: "tool_updated", update: {} }),
      ]),
    );
    await runtime.close();
  });

  it("folds cacheWrite into inputTokens across assistant turns", async () => {
    const client = new ManualPiClient();
    const runtime = await factory(client).create(request(() => undefined));
    const run = runtime.prompt({ runId: "cache-write", input: input("usage") });
    await client.called("prompt");
    client.emit({ type: "agent_start" });
    client.emit({ type: "turn_start" });
    client.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    client.emit({
      type: "message_end",
      message: assistant({
        content: [{ type: "text", text: "one" }],
        usage: { input: 10, cacheRead: 2, cacheWrite: 4, output: 3 },
      }),
    });
    client.emit({ type: "turn_end" });
    client.emit({ type: "turn_start" });
    client.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    client.emit({
      type: "message_end",
      message: assistant({
        content: [{ type: "text", text: "two" }],
        usage: { input: 5, cacheRead: 1, cacheWrite: 7, output: 2 },
      }),
    });
    client.emit({ type: "turn_end" });
    client.emit({ type: "agent_end", willRetry: false });
    client.emit({ type: "agent_settled" });
    await expect(run).resolves.toMatchObject({
      status: "completed",
      output: [{ text: "two" }],
      usage: { inputTokens: 26, cachedInputTokens: 3, outputTokens: 5 },
    });
    await runtime.close();
  });

  it("fails closed for every malformed event-state transition", async () => {
    const outsideTurnEvents: readonly Readonly<Record<string, unknown>>[] = [
      { type: "message_start", message: { role: "user", content: "x" } },
      { type: "message_update", assistantMessageEvent: { type: "start" } },
      { type: "message_end", message: { role: "user", content: "x" } },
      { type: "tool_execution_start", toolCallId: "tool", toolName: "read" },
      { type: "tool_execution_update", toolCallId: "tool", partialResult: {} },
      { type: "tool_execution_end", toolCallId: "tool", result: {} },
    ];
    for (const [index, event] of outsideTurnEvents.entries()) {
      const client = new ManualPiClient();
      const runtime = await factory(client).create(request(() => undefined));
      const run = runtime.prompt({ runId: `outside-turn-${index}`, input: input("bad") });
      await client.called("prompt");
      client.emit(event);
      await expect(run).resolves.toMatchObject({
        status: "failed",
        error: { code: "provider_protocol_error" },
      });
      await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
    }

    const invalidSequences: readonly (readonly Readonly<Record<string, unknown>>[])[] = [
      [{ type: "extension_ui_request" }],
      [{ type: "opentag/process_error" }],
      [{ type: 1 }],
      [{ type: "turn_start" }, { type: "turn_start" }],
      [{ type: "turn_end" }],
      [{ type: "turn_start" }, { type: "message_start", message: { role: "assistant" } }, { type: "turn_end" }],
      [
        { type: "turn_start" },
        { type: "tool_execution_start", toolCallId: "tool", toolName: "read" },
        { type: "turn_end" },
      ],
      [{ type: "message_start" }],
      [{ type: "message_update" }],
      [{ type: "message_end" }],
      [{ type: "message_start", message: [] }],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_start", message: { role: "assistant" } },
      ],
      [{ type: "message_update", assistantMessageEvent: { type: "start" } }],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "unknown" } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "done" } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "done", reason: "unknown" } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_unknown", contentIndex: 0 } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "toolcall_unknown", contentIndex: 0 } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0 } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: -1 } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0 } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x" } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
        { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "y" } },
      ],
      [{ type: "message_end", message: { role: "assistant" } }],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_end", message: { role: "assistant", content: {} } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_end", message: { role: "assistant", content: [null] } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_end", message: { role: "assistant", content: [{ type: "text" }] } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_end", message: { role: "assistant", content: [] } },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
        { type: "message_end", message: assistant({ content: [{ type: "text", text: "x" }] }) },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_end",
          message: assistant({ content: [], usage: { input: Number.MAX_SAFE_INTEGER } }),
        },
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_end", message: assistant({ content: [], usage: { input: 1 } }) },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_end",
          message: assistant({
            content: [],
            usage: { input: Number.MAX_SAFE_INTEGER, cacheWrite: 1 },
          }),
        },
      ],
      [
        { type: "message_start", message: { role: "assistant" } },
        {
          type: "message_end",
          message: assistant({ content: [], usage: { cacheWrite: Number.MAX_SAFE_INTEGER } }),
        },
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_end", message: assistant({ content: [], usage: { cacheWrite: 1 } }) },
      ],
      [{ type: "tool_execution_start" }],
      [
        { type: "tool_execution_start", toolCallId: "tool", toolName: "read" },
        { type: "tool_execution_start", toolCallId: "tool", toolName: "read" },
      ],
      [{ type: "tool_execution_start", toolCallId: "tool" }],
      [{ type: "tool_execution_update" }],
      [{ type: "tool_execution_update", toolCallId: "tool" }],
      [{ type: "tool_execution_end" }],
      [{ type: "tool_execution_end", toolCallId: "tool" }],
      [{ type: "agent_settled" }],
      [{ type: "turn_start" }, { type: "agent_settled" }],
      [{ type: "message_start", message: { role: "assistant" } }, { type: "agent_settled" }],
      [{ type: "tool_execution_start", toolCallId: "tool", toolName: "read" }, { type: "agent_settled" }],
    ];

    for (const [index, sequence] of invalidSequences.entries()) {
      const client = new ManualPiClient();
      const runtime = await factory(client).create(request(() => undefined));
      const run = runtime.prompt({ runId: `invalid-${index}`, input: input("bad") });
      await client.called("prompt");
      const firstType = sequence[0]?.type;
      const events =
        typeof firstType === "string" && PI_TURN_CHILD_EVENTS.has(firstType)
          ? [{ type: "turn_start" }, ...sequence]
          : sequence;
      for (const event of events) client.emit(event);
      await expect(run).resolves.toMatchObject({
        status: "failed",
        error: { code: index === 1 ? "provider_error" : "provider_protocol_error" },
      });
      await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
    }
  }, 10_000);

  it("maps terminal defaults, absent model and usage, and command failures", async () => {
    for (const [index, stopReason] of ["aborted", "error"].entries()) {
      const client = new ManualPiClient();
      client.model = index === 0 ? undefined : null;
      const runtime = await factory(client).create(request(() => undefined));
      const run = runtime.prompt({ runId: `terminal-${index}`, input: input("terminal") });
      await client.called("prompt");
      client.complete({ stopReason, content: [], usage: undefined });
      await expect(run).resolves.toMatchObject({
        status: stopReason === "aborted" ? "aborted" : "failed",
        error: {
          message: stopReason === "aborted" ? "Pi run was aborted" : "Pi model request failed",
        },
      });
      await runtime.close();
    }

    for (const failure of [
      new PiRpcError("protocol", "bad protocol"),
      new PiRpcError("command", "command rejected"),
      42,
    ]) {
      const client = new ManualPiClient({ requestFailure: failure });
      const runtime = await factory(client).create(request(() => undefined));
      await expect(runtime.prompt({ runId: `failure-${String(failure)}`, input: input("x") })).resolves.toMatchObject({
        status: "failed",
        error: {
          code:
            failure instanceof PiRpcError && failure.code === "protocol" ? "provider_protocol_error" : "provider_error",
        },
      });
      if (failure instanceof PiRpcError && failure.code === "protocol") {
        await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
      } else {
        expect(runtime.state.phase).toBe("idle");
        await runtime.close();
      }
    }
  });

  it("honors terminal ingress while draining late provider failures", async () => {
    const abortClient = new ManualPiClient();
    const abortRuntime = await factory(abortClient).create(request(() => undefined));
    const abortRun = abortRuntime.prompt({ runId: "terminal-abort-race", input: input("done") });
    await abortClient.called("prompt");
    abortClient.complete({ content: [], usage: { input: 1 } });
    await abortRuntime.abort({ expectedRunId: "terminal-abort-race" });
    await abortRun;
    await abortRuntime.close();

    const failureClient = new ManualPiClient();
    const failureRuntime = await factory(failureClient).create(request(() => undefined));
    const failureRun = failureRuntime.prompt({ runId: "terminal-failure-race", input: input("done") });
    await failureClient.called("prompt");
    failureClient.complete({ content: [], usage: { cacheRead: 1 } });
    failureClient.emit({ type: "opentag/process_error", error: new Error("late process failure") });
    await expect(failureRun).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "late process failure" },
    });
    await vi.waitFor(() => expect(failureRuntime.state.phase).toBe("closed"));
  });

  it("normalizes non-Error event sink failures at the Provider boundary", async () => {
    const client = new ManualPiClient();
    const runtime = await factory(client).create(
      request((event) => {
        if (event.type === "provider_event") throw 42;
      }),
    );
    const run = runtime.prompt({ runId: "non-error-sink", input: input("event") });
    await client.called("prompt");
    client.emit({ type: "unknown_event" });
    await expect(run).resolves.toMatchObject({ status: "failed", error: { code: "event_delivery_failed" } });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("validates all factory, policy, binding, and Provider configuration boundaries", async () => {
    const invalidRequests: readonly unknown[] = [
      undefined,
      {},
      { ...request(() => undefined), systemPrompt: undefined },
      { ...request(() => undefined), systemPrompt: " " },
      { ...request(() => undefined), systemPrompt: "x".repeat(1024 * 1024 + 1) },
      { ...request(() => undefined), workspace: { cwd: "relative" } },
      { ...request(() => undefined), workspace: { cwd: "/workspace", writableRoots: ["relative"] } },
      { ...request(() => undefined), workspace: { cwd: "/workspace", writableRoots: ["/write"] } },
      { ...request(() => undefined), policy: { ...readOnlyPolicy(), tools: { mode: "allow-list", names: [] } } },
      {
        ...request(() => undefined),
        policy: { ...readOnlyPolicy(), tools: { mode: "allow-list", names: ["unknown"] } },
      },
      {
        ...request(() => undefined),
        policy: { ...readOnlyPolicy(), tools: { mode: "allow-list", names: ["write"] } },
      },
      {
        ...request(() => undefined),
        policy: {
          fileSystem: "unrestricted",
          network: "disabled",
          approvals: "never",
          tools: { mode: "allow-list", names: ["bash"] },
        },
      },
      {
        ...request(() => undefined),
        hostedTools: {
          definitions: [],
          handler: async () => ({ success: true, content: [] }),
        },
      },
      { ...request(() => undefined), configuration: { model: " " } },
      { ...request(() => undefined), configuration: { reasoningEffort: "ultra" } },
      { ...request(() => undefined), configuration: { provider: [] } },
      { ...request(() => undefined), configuration: { provider: { unknown: true } } },
      { ...request(() => undefined), configuration: { provider: { appendSystemPrompt: "removed" } } },
      { ...request(() => undefined), configuration: { provider: { sessionName: "x".repeat(4097) } } },
    ];
    const piFactory = factory(new ManualPiClient());
    for (const invalid of invalidRequests) {
      await expect(piFactory.create(invalid as CreateAgentRuntimeRequest)).rejects.toMatchObject({
        code: "configuration_invalid",
      });
    }

    expect(() => new PiAgentRuntimeFactory({ process: { sessionDirectory: "relative" } })).toThrow("sessionDirectory");
    for (const probeTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
      expect(() => new PiAgentRuntimeFactory({ process: { probeTimeoutMs } })).toThrow("probeTimeoutMs");
    }
    expect(() => new PiAgentRuntimeFactory({ process: { probeTimeoutMs: 30_000 } })).not.toThrow();
    await expect(
      new PiAgentRuntimeFactory({ createSessionId: () => "not-a-uuid" }).create(request(() => undefined)),
    ).rejects.toMatchObject({ code: "provider_protocol_error" });
    await expect(
      piFactory.resume({
        ...request(() => undefined),
        binding: { providerId: "pi", schemaVersion: 1, payload: null },
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    await expect(
      piFactory.resume({
        ...request(() => undefined),
        binding: { providerId: "pi", schemaVersion: 1, payload: { sessionId: "bad" } },
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    const unmaterialized = await piFactory.resume({
      ...request(() => undefined),
      binding: { providerId: "pi", schemaVersion: 1, payload: { sessionId: SESSION_ID } },
    });
    expect(unmaterialized.binding).toEqual({
      providerId: "pi",
      schemaVersion: 1,
      payload: { sessionId: SESSION_ID },
    });
    await unmaterialized.close();
    await expect(
      piFactory.resume({
        ...request(() => undefined),
        binding: {
          providerId: "pi",
          schemaVersion: 1,
          payload: { sessionId: SESSION_ID, sessionFileHash: "invalid" },
        },
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    await expect(
      piFactory.resume({
        ...request(() => undefined),
        binding: {
          providerId: "pi",
          schemaVersion: 1,
          payload: { sessionId: SESSION_ID, sessionFileHash: SESSION_FILE_HASH, unknown: true },
        },
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    await expect(
      factory(new ManualPiClient()).create(
        request(() => {
          throw new Error("sink rejected binding");
        }),
      ),
    ).rejects.toMatchObject({ code: "create_failed" });
    await expect(
      factory(new ManualPiClient()).resume({
        ...request(() => {
          throw new Error("sink rejected binding");
        }),
        binding: materializedBinding(),
      }),
    ).rejects.toMatchObject({ code: "resume_failed" });
  });

  it("fails closed when Pi materializes or resumes the wrong session state", async () => {
    for (const [index, client] of [
      new ManualPiClient({ messageCount: 1 }),
      new ManualPiClient({ messageCount: -1 }),
      new ManualPiClient({ sessionFile: "relative/session.jsonl" }),
    ].entries()) {
      const runtime = await factory(client).create(request(() => undefined));
      await expect(runtime.prompt({ runId: `invalid-state-${index}`, input: input("x") })).resolves.toMatchObject({
        status: "failed",
        error: { code: "provider_protocol_error" },
      });
      await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
    }

    const resumedClient = new ManualPiClient({ sessionFile: "/sessions/another.jsonl" });
    const resumed = await factory(resumedClient).resume({
      ...request(() => undefined),
      binding: materializedBinding(),
    });
    await expect(resumed.prompt({ runId: "wrong-session-file", input: input("x") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Pi opened another session file" },
    });
    await vi.waitFor(() => expect(resumed.state.phase).toBe("closed"));

    const emptyResumeEvents: AgentRuntimeEvent[] = [];
    const emptyResumeClient = new ManualPiClient();
    const emptyResume = await factory(emptyResumeClient).resume({
      ...request((event) => {
        emptyResumeEvents.push(event);
      }),
      binding: materializedBinding(),
    });
    await expect(emptyResume.prompt({ runId: "empty-resume", input: input("x") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Pi session has no conversation history" },
    });
    expect(emptyResumeClient.commands.some((command) => command.type === "prompt")).toBe(false);
    expect(emptyResumeEvents.some((event) => event.type === "run_completed")).toBe(false);
    await vi.waitFor(() => expect(emptyResume.state.phase).toBe("closed"));
  });

  it("fails length, toolUse, and error terminals without emitting completed", async () => {
    const cases = [
      {
        stopReason: "stop",
        status: "completed",
        event: "run_completed",
        error: undefined,
      },
      {
        stopReason: "aborted",
        status: "aborted",
        event: "run_aborted",
        error: { code: "run_aborted", message: "Pi run was aborted" },
      },
      {
        stopReason: "error",
        status: "failed",
        event: "run_failed",
        error: { code: "provider_error", message: "Pi model request failed" },
      },
      {
        stopReason: "length",
        status: "failed",
        event: "run_failed",
        error: { code: "provider_error", message: "Pi stopped because the model reached its output limit" },
      },
      {
        stopReason: "toolUse",
        status: "failed",
        event: "run_failed",
        error: { code: "provider_error", message: "Pi stopped with unfinished tool use" },
      },
    ] as const;

    for (const item of cases) {
      const events: AgentRuntimeEvent[] = [];
      const client = new ManualPiClient();
      const runtime = await factory(client).create(
        request((event) => {
          events.push(event);
        }),
      );
      const run = runtime.prompt({ runId: `stop-${item.stopReason}`, input: input("partial") });
      await client.called("prompt");
      client.complete({
        stopReason: item.stopReason,
        content: [{ type: "text", text: "partial" }],
        usage: { output: 1 },
      });
      await expect(run).resolves.toMatchObject({
        status: item.status,
        output: [{ type: "text", text: "partial" }],
        ...(item.error ? { error: item.error } : {}),
        providerDiagnostics: { stopReason: item.stopReason },
      });
      expect(events.some((event) => event.type === "run_completed")).toBe(item.event === "run_completed");
      expect(events.some((event) => event.type === item.event)).toBe(true);
      await runtime.close();
    }
  });

  it("fails the run when process-tree cleanup rejects", async () => {
    const successfulEvents: AgentRuntimeEvent[] = [];
    const successfulClient = new ManualPiClient({ closeError: new Error("process tree still running") });
    const successfulRuntime = await factory(successfulClient).create(
      request((event) => {
        successfulEvents.push(event);
      }),
    );
    const successfulRun = successfulRuntime.prompt({ runId: "cleanup-after-stop", input: input("done") });
    await successfulClient.called("prompt");
    successfulClient.complete({ content: [{ type: "text", text: "ok" }] });
    await expect(successfulRun).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "process tree still running" },
    });
    expect(successfulEvents.some((event) => event.type === "run_completed")).toBe(false);
    expect(successfulEvents.some((event) => event.type === "run_failed")).toBe(true);
    await expect(
      successfulRuntime.prompt({ runId: "cleanup-after-stop-next", input: input("again") }),
    ).rejects.toMatchObject({ code: "closed" });
    await vi.waitFor(() => expect(successfulRuntime.state.phase).toBe("closed"));

    const protocolEvents: AgentRuntimeEvent[] = [];
    const protocolClient = new ManualPiClient({ closeError: new Error("process tree still running") });
    const protocolRuntime = await factory(protocolClient).create(
      request((event) => {
        protocolEvents.push(event);
      }),
    );
    const protocolRun = protocolRuntime.prompt({ runId: "cleanup-after-protocol", input: input("bad") });
    await protocolClient.called("prompt");
    protocolClient.emit({ type: "agent_settled" });
    await expect(protocolRun).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Pi settled without an assistant result" },
    });
    expect(protocolEvents.some((event) => event.type === "run_completed")).toBe(false);
    await expect(
      protocolRuntime.prompt({ runId: "cleanup-after-protocol-next", input: input("again") }),
    ).rejects.toMatchObject({ code: "closed" });
    await vi.waitFor(() => expect(protocolRuntime.state.phase).toBe("closed"));
  });

  it("preserves a model failure and partial output when cleanup also fails", async () => {
    const events: AgentRuntimeEvent[] = [];
    const client = new ManualPiClient({ closeError: new Error("cleanup unavailable") });
    const runtime = await factory(client).create(
      request((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "model-and-cleanup-failure", input: input("work") });
    await client.called("prompt");
    client.complete({ stopReason: "length", content: [{ type: "text", text: "partial answer" }] });
    await expect(run).resolves.toMatchObject({
      status: "failed",
      output: [{ type: "text", text: "partial answer" }],
      error: { code: "provider_error", message: "Pi stopped because the model reached its output limit" },
      providerDiagnostics: { stopReason: "length" },
    });
    expect(events.some((event) => event.type === "run_completed")).toBe(false);
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("normalizes non-Error cleanup rejection and rejects further work", async () => {
    const client = new ManualPiClient({ closeError: "untyped cleanup rejection" });
    const runtime = await factory(client).create(request(() => undefined));
    const run = runtime.prompt({ runId: "untyped-cleanup-failure", input: input("work") });
    await client.called("prompt");
    client.complete();
    await expect(run).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "Pi provider close failed" },
    });
    await expect(runtime.prompt({ runId: "next-after-cleanup-failure", input: input("again") })).rejects.toMatchObject({
      code: "closed",
    });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("settles a synchronous process spawn failure without a client to clean up", async () => {
    const events: AgentRuntimeEvent[] = [];
    const runtime = await new PiAgentRuntimeFactory({
      createClient: () => {
        throw new PiRpcError("spawn", "fixture process could not start");
      },
    }).create(
      request((event) => {
        events.push(event);
      }),
    );
    await expect(runtime.prompt({ runId: "spawn-failure", input: input("work") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "fixture process could not start" },
    });
    expect(events.some((event) => event.type === "run_completed")).toBe(false);
    await runtime.close();
  });

  it("runs the local probe against controlled CLI artifacts", async () => {
    const recordedDirectory = await temporaryDirectory("opentag-pi-probe-record-");
    const recordedCommand = join(recordedDirectory, "pi");
    const recordedLog = join(recordedDirectory, "invocations.jsonl");
    await writeFile(
      recordedCommand,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(recordedLog)}, JSON.stringify(args) + "\\n");
const disable = ${JSON.stringify([...PI_RESOURCE_DISABLE_ARGUMENTS])};
const hasDisable = disable.every((flag) => args.includes(flag));
if (args[0] === "--version") {
  console.log("0.84.2");
  process.exit(0);
}
if (args.includes("--help")) {
  if (!hasDisable) process.exit(1);
  console.log(${JSON.stringify(PI_HELP_TOKENS)});
  process.exit(0);
}
if (args.includes("--list-models")) {
  if (!hasDisable) process.exit(1);
  console.log(${JSON.stringify(PI_LIST_MODELS_TABLE)});
  process.exit(0);
}
process.exit(1);
`,
      "utf8",
    );
    await chmod(recordedCommand, 0o755);
    await expect(localProbe(recordedCommand).probe({})).resolves.toEqual({
      ready: true,
      version: "0.84.2",
      issues: [],
    });
    expect(
      (await readFile(recordedLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    ).toEqual([
      ["--version"],
      [...PI_RESOURCE_DISABLE_ARGUMENTS, "--help"],
      [...PI_RESOURCE_DISABLE_ARGUMENTS, "--list-models"],
    ]);

    const readyCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.80.6"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
cat <<'EOF'
${PI_LIST_MODELS_TABLE}
EOF
`);
    await expect(localProbe(readyCli).probe({})).resolves.toEqual({
      ready: true,
      version: "0.80.6",
      issues: [],
    });

    for (const version of ["0.80.3", "0.80.5"]) {
      const oldCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
cat <<'EOF'
${PI_LIST_MODELS_TABLE}
EOF
`);
      await expect(localProbe(oldCli).probe({})).resolves.toMatchObject({
        ready: false,
        version,
        issues: [{ code: "version_incompatible" }],
      });
    }

    const extensionOnlyCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "1.2.3"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
if has_flag --no-extensions "$@"; then
cat <<'EOF'
${PI_LIST_MODELS_HEADER}
EOF
else
cat <<'EOF'
${PI_LIST_MODELS_TABLE}
EOF
fi
`);
    await expect(localProbe(extensionOnlyCli).probe({})).resolves.toMatchObject({
      ready: false,
      version: "1.2.3",
      issues: [{ code: "credential_missing" }],
    });

    const emptyModelsCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.84.2"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
exit 0
`);
    await expect(localProbe(emptyModelsCli).probe({})).resolves.toMatchObject({
      ready: false,
      version: "0.84.2",
      issues: [{ code: "credential_missing" }],
    });

    const noModelMessageCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.84.2"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
cat <<'EOF'
${PI_NO_MODELS_MESSAGE}
EOF
`);
    await expect(localProbe(noModelMessageCli).probe({})).resolves.toMatchObject({
      ready: false,
      version: "0.84.2",
      issues: [{ code: "credential_missing" }],
    });

    const headerOnlyCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.84.2"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
cat <<'EOF'
${PI_LIST_MODELS_HEADER}
EOF
`);
    await expect(localProbe(headerOnlyCli).probe({})).resolves.toMatchObject({
      ready: false,
      version: "0.84.2",
      issues: [{ code: "credential_missing" }],
    });

    const malformedModelsCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.84.2"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
printf 'not a model table\\nstill not a table\\nand a third line\\n'
`);
    await expect(localProbe(malformedModelsCli).probe({})).resolves.toMatchObject({
      ready: false,
      version: "0.84.2",
      issues: [{ code: "credential_missing" }],
    });

    const headerWithBadRowCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.84.2"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
cat <<'EOF'
${PI_LIST_MODELS_HEADER}
five columns only a b
EOF
`);
    await expect(localProbe(headerWithBadRowCli).probe({})).resolves.toMatchObject({
      ready: false,
      version: "0.84.2",
      issues: [{ code: "credential_missing" }],
    });

    const unsafeVersionCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "999999999999999999999999.0.0"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
cat <<'EOF'
${PI_LIST_MODELS_TABLE}
EOF
`);
    await expect(localProbe(unsafeVersionCli).probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "version_incompatible" }],
    });

    const limitedCli = await probeCli(`
if [ "$1" = "--version" ]; then exit 0; fi
if has_flag --help "$@"; then echo "no rpc"; exit 0; fi
exit 1
`);
    await expect(localProbe(limitedCli).probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "version_incompatible" }, { code: "credential_missing" }],
    });

    const noModelsCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "1"; exit 0; fi
if has_flag --help "$@"; then echo "none"; exit 0; fi
exit 1
`);
    await expect(
      localProbe(noModelsCli).probe({
        configuration: { reasoningEffort: "bad" },
      }),
    ).resolves.toMatchObject({
      ready: false,
      version: "1",
      issues: [{ code: "configuration_invalid" }, { code: "version_incompatible" }, { code: "credential_missing" }],
    });

    const brokenHelpCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "1"; exit 0; fi
if has_flag --help "$@"; then exit 1; fi
cat <<'EOF'
${PI_LIST_MODELS_TABLE}
EOF
`);
    await expect(localProbe(brokenHelpCli).probe({})).resolves.toMatchObject({
      ready: false,
      version: "1",
      issues: [{ code: "version_incompatible" }],
    });

    await expect(
      new PiAgentRuntimeFactory({
        probeRunner: async () => {
          throw new Error("missing");
        },
      }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "artifact_missing" }] });

    const directory = await temporaryDirectory("opentag-pi-probe-abort-");
    const helpStarted = join(directory, "help-started");
    const hangingHelp = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.80.6"; exit 0; fi
if has_flag --help "$@"; then printf started > '${helpStarted}'; exec '${process.execPath}' -e 'setInterval(() => undefined, 1000)'; fi
exit 1
`);
    const helpAbort = new AbortController();
    const helpProbe = localProbe(hangingHelp, 30_000).probe({
      signal: helpAbort.signal,
    });
    await vi.waitFor(async () => expect(await readFile(helpStarted, "utf8")).toBe("started"));
    helpAbort.abort(new Error("stop"));
    await expect(helpProbe).rejects.toBeDefined();

    const modelsStarted = join(directory, "models-started");
    const hangingModels = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.80.6"; exit 0; fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
printf started > '${modelsStarted}'
exec '${process.execPath}' -e 'setInterval(() => undefined, 1000)'
`);
    const modelsAbort = new AbortController();
    const modelsProbe = localProbe(hangingModels).probe({
      signal: modelsAbort.signal,
    });
    await vi.waitFor(async () => expect(await readFile(modelsStarted, "utf8")).toBe("started"));
    modelsAbort.abort(new Error("stop"));
    await expect(modelsProbe).rejects.toBeDefined();
  }, 15_000);

  it("bounds probe commands by the 5s default and a configured budget", async () => {
    const slowCli = await delayedProbeCli(5_200);
    const [defaultProbe, boundedProbe, tightProbe] = await Promise.all([
      localProbe(slowCli).probe({}),
      localProbe(slowCli, 30_000).probe({}),
      localProbe(slowCli, 2_000).probe({}),
    ]);
    // Default stays 5s: a 5.2s startup times out and fails closed as a missing artifact.
    expect(defaultProbe).toMatchObject({ ready: false, issues: [{ code: "artifact_missing" }] });
    // A validated 30s budget accepts the same delayed startup without skipping probes.
    expect(boundedProbe).toEqual({ ready: true, version: "0.84.2", issues: [] });
    // The budget still governs: 2s kills the 5.2s startup.
    expect(tightProbe).toMatchObject({ ready: false, issues: [{ code: "artifact_missing" }] });
  }, 20_000);

  it("uses the local Pi process boundary with only the pinned MCP adapter closure", async () => {
    const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
    const manifests = await Promise.all(
      [new URL("../../../../package.json", import.meta.url), new URL("../../package.json", import.meta.url)].map(
        async (url) => JSON.parse(await readFile(url, "utf8")) as PackageManifest,
      ),
    );
    const forbiddenDependencies = manifests.flatMap((manifest) =>
      dependencyFields.flatMap((field) =>
        Object.keys(manifest[field] ?? {}).filter((name) => {
          const normalized = name.toLowerCase();
          return (
            normalized === "pi-mcp-adapter" ||
            normalized.includes("pi-coding-agent") ||
            normalized.includes("pi-agent") ||
            /^@(earendil-works|mariozechner)\/pi(?:-|$)/.test(normalized)
          );
        }),
      ),
    );
    expect(forbiddenDependencies.sort()).toEqual(["@earendil-works/pi-coding-agent", "pi-mcp-adapter"]);
    const clientManifest = manifests[1];
    expect(clientManifest?.dependencies).toMatchObject({
      "@earendil-works/pi-coding-agent": "0.84.2",
      "pi-mcp-adapter": "2.36.0",
    });

    const localArtifactCwd = await temporaryDirectory("opentag-pi-local-artifact-");
    const launches: Array<{ command: string; args: readonly string[]; path: string | undefined }> = [];
    const localArtifactRuntime = await new PiAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      process: {
        env: { PATH: process.env.PATH, PI_RPC_FIXTURE_SCENARIO: "must-be-filtered" },
        requestTimeoutMs: 2_000,
        spawnProcess: (command, args, options) => {
          launches.push({ command, args: [...args], path: options.env.PATH });
          return spawn(process.execPath, [fixture], { ...options, stdio: "pipe" });
        },
      },
      probeRunner: async () => ({ credential: true, rpc: true, version: "fixture" }),
    }).create({ ...request(() => undefined), workspace: { cwd: localArtifactCwd } });
    await localArtifactRuntime.prompt({ runId: "local-artifact", input: input("hello") });
    await localArtifactRuntime.close();
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ command: "pi", path: process.env.PATH });
    expect(launches[0]?.args).toEqual(expect.arrayContaining(["--mode", "rpc", "--session-id", SESSION_ID]));

    const sessionDirectory = await temporaryDirectory("opentag-pi-sessions-");
    const runtime = await new PiAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      process: {
        command: process.execPath,
        args: [fixture],
        env: { PATH: process.env.PATH, PI_RPC_FIXTURE_SCENARIO: "must-be-filtered" },
        maxLineBytes: 16 * 1024,
        maxStderrBytes: 1024,
        requestTimeoutMs: 2_000,
        sessionDirectory,
      },
      probeRunner: async () => ({ credential: true, rpc: true, version: "fixture" }),
    }).create({ ...request(() => undefined), workspace: { cwd: sessionDirectory } });
    const result = await runtime.prompt({ runId: "real-wire", input: input("hello") });
    expect(result).toMatchObject({ status: "completed", output: [{ text: "fixture answer" }] });
    await runtime.close();

    const eventFailureRuntime = await new PiAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      process: {
        command: process.execPath,
        args: [fixture, "event-failure-before-response", SESSION_ID, SESSION_FILE],
        env: { PATH: process.env.PATH },
        requestTimeoutMs: 2_000,
      },
      probeRunner: async () => ({ credential: true, rpc: true, version: "fixture" }),
    }).create({ ...request(() => undefined), workspace: { cwd: sessionDirectory } });
    await expect(
      eventFailureRuntime.prompt({ runId: "event-failure-before-response", input: input("hello") }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Pi ended a turn that was not active" },
    });
    await vi.waitFor(() => expect(eventFailureRuntime.state.phase).toBe("closed"));

    expect(piAgentRuntimeEnvironment({ AWS_REGION: "test", RANDOM_SECRET: "drop", PATH: undefined })).toEqual({
      AWS_REGION: "test",
    });
    expect(piAgentRuntimeEnvironment()).toHaveProperty("PATH");
  }, 15_000);
});

class ManualPiClient implements PiRpcClient {
  args: readonly string[] = [];
  readonly commands: Readonly<Record<string, unknown>>[] = [];
  readonly #listeners = new Set<(message: Readonly<Record<string, unknown>>) => void>();
  readonly #requestFailure?: unknown;
  readonly #sessionId: string;
  readonly #sessionFile: string;
  readonly #closeError?: unknown;
  messageCount: number;
  model: unknown = { id: "fixture", provider: "fixture" };

  constructor(
    options: {
      closeError?: unknown;
      messageCount?: number;
      requestFailure?: unknown;
      sessionFile?: string;
      sessionId?: string;
    } = {},
  ) {
    this.#requestFailure = options.requestFailure;
    this.#sessionId = options.sessionId ?? SESSION_ID;
    this.#sessionFile = options.sessionFile ?? SESSION_FILE;
    this.#closeError = options.closeError;
    this.messageCount = options.messageCount ?? 0;
  }

  async request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.commands.push(command);
    if (this.#requestFailure !== undefined) throw this.#requestFailure;
    if (command.type === "get_state") {
      return {
        sessionId: this.#sessionId,
        sessionFile: this.#sessionFile,
        messageCount: this.messageCount,
        model: this.model,
      };
    }
    return undefined;
  }

  subscribe(listener: (message: Readonly<Record<string, unknown>>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closeError !== undefined) throw this.#closeError;
  }

  emit(message: Readonly<Record<string, unknown>>): void {
    for (const listener of this.#listeners) listener(message);
  }

  complete(
    options: {
      content?: readonly Readonly<Record<string, unknown>>[];
      model?: unknown;
      stopReason?: string;
      usage?: unknown;
    } = {},
  ): void {
    if ("model" in options) this.model = options.model;
    const message = assistant(options);
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    this.emit({ type: "message_end", message });
    this.emit({ type: "turn_end" });
    this.emit({ type: "agent_end", willRetry: false });
    this.emit({ type: "agent_settled" });
  }

  async called(type: string): Promise<void> {
    await vi.waitFor(() => expect(this.commands.some((command) => command.type === type)).toBe(true));
  }
}

function factory(client: ManualPiClient): PiAgentRuntimeFactory {
  return new PiAgentRuntimeFactory({
    createSessionId: () => SESSION_ID,
    createClient: (_cwd, args) => {
      client.args = args;
      return client;
    },
    probeRunner: async () => ({ credential: true, rpc: true, version: "fixture" }),
  });
}

function request(eventSink: CreateAgentRuntimeRequest["eventSink"]): CreateAgentRuntimeRequest {
  return {
    eventSink,
    systemPrompt: "OpenTag managed system prompt",
    workspace: { cwd: "/workspace" },
    policy: readOnlyPolicy(),
  };
}

function readOnlyPolicy(): CreateAgentRuntimeRequest["policy"] {
  return {
    fileSystem: "read-only",
    network: "disabled",
    approvals: "never",
    tools: { mode: "provider-default" },
  };
}

function materializedBinding() {
  return {
    providerId: "pi",
    schemaVersion: 1,
    payload: { sessionId: SESSION_ID, sessionFileHash: SESSION_FILE_HASH },
  } as const;
}

function input(text: string): { items: [{ type: "text"; text: string }] } {
  return { items: [{ type: "text", text }] };
}

function assistant(
  options: { content?: readonly Readonly<Record<string, unknown>>[]; stopReason?: string; usage?: unknown } = {},
): Readonly<Record<string, unknown>> {
  return {
    role: "assistant",
    content: options.content ?? [],
    stopReason: options.stopReason ?? "stop",
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
}

async function probeCli(body: string): Promise<string> {
  const directory = await temporaryDirectory("opentag-pi-probe-");
  const path = join(directory, "pi");
  await writeFile(
    path,
    `#!/bin/sh
has_flag() {
  needle=$1
  shift
  for arg in "$@"; do
    [ "$arg" = "$needle" ] && return 0
  done
  return 1
}
${body}`,
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

/** A probe CLI whose `--version` startup is delayed, like native Cloud Run Pi startup. */
async function delayedProbeCli(delayMs: number): Promise<string> {
  return probeCli(`
if [ "$1" = "--version" ]; then
  exec '${process.execPath}' -e 'setTimeout(() => { console.log("0.84.2"); }, ${delayMs})'
fi
if has_flag --help "$@"; then echo ${JSON.stringify(PI_HELP_TOKENS)}; exit 0; fi
cat <<'EOF'
${PI_LIST_MODELS_TABLE}
EOF
`);
}

function probeHome(command: string): string {
  return dirname(command);
}

function localProbe(command: string, probeTimeoutMs?: number): PiAgentRuntimeFactory {
  return new PiAgentRuntimeFactory({
    process: {
      command,
      env: { HOME: probeHome(command) },
      ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }),
    },
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

it.each(["visible", "internal"])(
  "preserves bundled Context Tree in the actual %s process environment",
  async (kind) => {
    const paths: Array<string | undefined> = [];
    const basePath = `/opentag/context-tree/bin${delimiter}/provider/bin${delimiter}/usr/bin`;
    const runtime = await new PiAgentRuntimeFactory({
      createSessionId: () => SESSION_ID,
      process: {
        env: { PATH: basePath },
        spawnProcess: (_command, _args, options) => {
          paths.push(options.env?.PATH);
          return spawn(process.execPath, [fixture], { ...options, stdio: "pipe" });
        },
      },
    }).create({
      ...request(() => undefined),
      workspace: {
        cwd: process.cwd(),
        environment: { OPENTAG_HOME: "/opentag" },
        ...(kind === "visible" ? { pathPrepend: "/session/tools" } : {}),
      },
    });
    await runtime.prompt({ runId: "path-check", input: input("hello") });
    await runtime.close();
    expect(paths).toEqual([kind === "visible" ? `/session/tools${delimiter}${basePath}` : basePath]);
  },
);

describe("Pi compaction integration boundaries", () => {
  it("accepts cancellation before the Pi client is created", async () => {
    const client = new ManualPiClient();
    const controller = new AbortController();
    const original = client.request.bind(client);
    client.request = async (command) => {
      if (controller.signal.aborted) throw new PiRpcError("aborted", "cancelled before startup");
      return original(command);
    };
    const runtime = await factory(client).create(
      request((event) => {
        if (event.type === "run_started") controller.abort();
      }),
    );
    await expect(
      runtime.prompt({ runId: "abort-before-client", input: input("work"), signal: controller.signal }),
    ).resolves.toMatchObject({ status: "aborted" });
    expect(client.commands.some((command) => command.type === "prompt")).toBe(false);
    await runtime.close();
  });

  it.each([new PiRpcError("timeout", "late abort"), new PiRpcError("aborted", "abort deadline")])(
    "stops the owned process after an unresponsive abort (%s)",
    async (failure) => {
      const client = new ManualPiClient();
      const original = client.request.bind(client);
      client.request = async (command) => {
        if (command.type === "abort") throw failure;
        return original(command);
      };
      const close = vi.spyOn(client, "close");
      const runtime = await factory(client).create(request(() => undefined));
      const run = runtime.prompt({ runId: "abort-timeout", input: input("work") });
      await client.called("prompt");
      await runtime.abort({ expectedRunId: "abort-timeout" });
      expect(close).toHaveBeenCalled();
      await expect(run).resolves.toMatchObject({ status: "aborted" });
      await runtime.close();
    },
  );

  it.each([new PiRpcError("protocol", "invalid abort"), new Error("transport fault")])(
    "preserves non-timeout abort failures (%s)",
    async (failure) => {
      const client = new ManualPiClient();
      const original = client.request.bind(client);
      client.request = async (command) => {
        if (command.type === "abort") throw failure;
        return original(command);
      };
      const runtime = await factory(client).create(request(() => undefined));
      const run = runtime.prompt({ runId: "abort-fault", input: input("work") });
      await client.called("prompt");
      await expect(runtime.abort({ expectedRunId: "abort-fault" })).rejects.toThrow(failure.message);
      await expect(run).resolves.toMatchObject({ status: "failed" });
      await runtime.close();
    },
  );

  it("does not report cancellation until compaction process cleanup succeeds", async () => {
    const client = new ManualPiClient({ closeError: new Error("process remains alive") });
    const runtime = await factory(client).create(request(() => undefined));
    const run = runtime.prompt({ runId: "compaction-close-fault", input: input("work") });
    await client.called("prompt");
    client.emit({ type: "compaction_start", reason: "threshold" });
    await expect(runtime.abort({ expectedRunId: "compaction-close-fault" })).rejects.toThrow("process remains alive");
    await expect(run).resolves.toMatchObject({ status: "failed" });
    await expect(runtime.close()).rejects.toMatchObject({ code: "close_failed" });
  });

  it("honors agent_settled racing with compaction process cleanup", async () => {
    const client = new ManualPiClient();
    const runtime = await factory(client).create(request(() => undefined));
    const run = runtime.prompt({ runId: "compaction-settle-race", input: input("work") });
    await client.called("prompt");
    client.emit({ type: "compaction_start", reason: "threshold" });
    const close = vi.spyOn(client, "close").mockImplementationOnce(async () => client.complete());
    await runtime.abort({ expectedRunId: "compaction-settle-race" });
    expect(close).toHaveBeenCalled();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    await runtime.close();
  });

  it("uses one bounded local event reference for a long native tool ID", async () => {
    const client = new ManualPiClient();
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory(client).create(
      request((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "long-tool", input: input("work") });
    await client.called("prompt");
    const id = "signed_" + "x".repeat(4200);
    client.emit({ type: "turn_start" });
    client.emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} });
    client.emit({ type: "tool_execution_update", toolCallId: id, partialResult: {} });
    client.emit({ type: "tool_execution_end", toolCallId: id, result: {} });
    client.emit({ type: "turn_end" });
    client.complete();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    const refs = events.filter(
      (event) => event.type === "tool_started" || event.type === "tool_updated" || event.type === "tool_completed",
    );
    expect(refs).toHaveLength(3);
    for (const event of refs)
      expect(event).toHaveProperty("toolCallId", `pi-tool-${createHash("sha256").update(id).digest("hex")}`);
    await runtime.close();
  });

  it.each([{ aborted: true }, { errorMessage: " " }, { errorMessage: "x".repeat(4000) }, { result: {} }])(
    "keeps bounded compaction diagnostics without fabricated usage (%j)",
    async (detail) => {
      const client = new ManualPiClient();
      const events: AgentRuntimeEvent[] = [];
      const runtime = await factory(client).create(
        request((event) => {
          events.push(event);
        }),
      );
      const run = runtime.prompt({ runId: "compaction-diagnostic", input: input("work") });
      await client.called("prompt");
      client.emit({ type: "compaction_end", ...detail });
      client.complete({ usage: { input: 3, output: 1 } });
      await expect(run).resolves.toMatchObject({ status: "completed", usage: { inputTokens: 3, outputTokens: 1 } });
      const warnings = events.filter((event) => event.type === "provider_warning");
      expect(warnings).toHaveLength("result" in detail ? 0 : 1);
      for (const event of warnings) expect(Buffer.byteLength(event.message)).toBeLessThan(2100);
      await runtime.close();
    },
  );
});
