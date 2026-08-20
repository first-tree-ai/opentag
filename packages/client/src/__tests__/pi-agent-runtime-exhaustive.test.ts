import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import { PiAgentRuntimeFactory, piAgentRuntimeEnvironment } from "../providers/pi/agent-runtime.js";
import { type PiRpcClient, PiRpcError } from "../providers/pi/rpc-wire.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_FILE = `/sessions/${SESSION_ID}.jsonl`;
const SESSION_FILE_HASH = createHash("sha256").update(SESSION_FILE).digest("hex");
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
      message: assistant({ content: [{ type: "text", text: "" }], usage: { input: -1 } }),
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
      { ...request(() => undefined), configuration: { provider: { appendSystemPrompt: "" } } },
      { ...request(() => undefined), configuration: { provider: { appendSystemPrompt: 1 } } },
      { ...request(() => undefined), configuration: { provider: { sessionName: "x".repeat(4097) } } },
    ];
    const piFactory = factory(new ManualPiClient());
    for (const invalid of invalidRequests) {
      await expect(piFactory.create(invalid as CreateAgentRuntimeRequest)).rejects.toMatchObject({
        code: "configuration_invalid",
      });
    }

    expect(() => new PiAgentRuntimeFactory({ process: { sessionDirectory: "relative" } })).toThrow("sessionDirectory");
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
    await expect(
      piFactory.resume({
        ...request(() => undefined),
        binding: { providerId: "pi", schemaVersion: 1, payload: { sessionId: SESSION_ID } },
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
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
  });

  it("runs the local probe against controlled CLI artifacts", async () => {
    const readyCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.80.6"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--mode rpc --session-id --session-dir --offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --tools --model --thinking --append-system-prompt --name"; exit 0; fi
printf 'provider model\\nfixture configured\\n'
`);
    await expect(new PiAgentRuntimeFactory({ process: { command: readyCli, env: {} } }).probe({})).resolves.toEqual({
      ready: true,
      version: "0.80.6",
      issues: [],
    });

    for (const version of ["0.80.3", "0.80.5"]) {
      const oldCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--mode rpc --session-id --session-dir --offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --tools --model --thinking --append-system-prompt --name"; exit 0; fi
printf 'provider model\\nfixture configured\\n'
`);
      await expect(
        new PiAgentRuntimeFactory({ process: { command: oldCli, env: {} } }).probe({}),
      ).resolves.toMatchObject({
        ready: false,
        version,
        issues: [{ code: "version_incompatible" }],
      });
    }

    const extensionOnlyCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "1.2.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--mode rpc --session-id --session-dir --offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --tools --model --thinking --append-system-prompt --name"; exit 0; fi
case " $* " in *" --no-extensions "*) printf 'provider model\\n' ;; *) printf 'provider model\\nextension only\\n' ;; esac
`);
    await expect(
      new PiAgentRuntimeFactory({ process: { command: extensionOnlyCli, env: {} } }).probe({}),
    ).resolves.toMatchObject({ ready: false, version: "1.2.3", issues: [{ code: "credential_missing" }] });

    const unsafeVersionCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "999999999999999999999999.0.0"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--mode rpc --session-id --session-dir --offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --tools --model --thinking --append-system-prompt --name"; exit 0; fi
printf 'provider model\\nfixture configured\\n'
`);
    await expect(
      new PiAgentRuntimeFactory({ process: { command: unsafeVersionCli, env: {} } }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "version_incompatible" }] });

    const limitedCli = await probeCli(`
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "--help" ]; then echo "no rpc"; exit 0; fi
exit 1
`);
    await expect(
      new PiAgentRuntimeFactory({ process: { command: limitedCli, env: {} } }).probe({}),
    ).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "version_incompatible" }, { code: "credential_missing" }],
    });

    const noModelsCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "1"; exit 0; fi
if [ "$1" = "--help" ]; then echo "none"; exit 0; fi
exit 1
`);
    await expect(
      new PiAgentRuntimeFactory({ process: { command: noModelsCli, env: {} } }).probe({
        configuration: { reasoningEffort: "bad" },
      }),
    ).resolves.toMatchObject({
      ready: false,
      version: "1",
      issues: [{ code: "configuration_invalid" }, { code: "version_incompatible" }, { code: "credential_missing" }],
    });

    const brokenHelpCli = await probeCli(`
if [ "$1" = "--version" ]; then echo "1"; exit 0; fi
if [ "$1" = "--help" ]; then exit 1; fi
printf 'provider model\\nfixture configured\\n'
`);
    await expect(
      new PiAgentRuntimeFactory({ process: { command: brokenHelpCli, env: {} } }).probe({}),
    ).resolves.toMatchObject({ ready: false, version: "1", issues: [{ code: "version_incompatible" }] });

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
if [ "$1" = "--help" ]; then printf started > '${helpStarted}'; exec '${process.execPath}' -e 'setInterval(() => undefined, 1000)'; fi
exit 1
`);
    const helpAbort = new AbortController();
    const helpProbe = new PiAgentRuntimeFactory({ process: { command: hangingHelp, env: {} } }).probe({
      signal: helpAbort.signal,
    });
    await vi.waitFor(async () => expect(await readFile(helpStarted, "utf8")).toBe("started"));
    helpAbort.abort(new Error("stop"));
    await expect(helpProbe).rejects.toBeDefined();

    const modelsStarted = join(directory, "models-started");
    const hangingModels = await probeCli(`
if [ "$1" = "--version" ]; then echo "0.80.6"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--mode rpc --session-id --session-dir --offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --tools --model --thinking --append-system-prompt --name"; exit 0; fi
printf started > '${modelsStarted}'
exec '${process.execPath}' -e 'setInterval(() => undefined, 1000)'
`);
    const modelsAbort = new AbortController();
    const modelsProbe = new PiAgentRuntimeFactory({ process: { command: hangingModels, env: {} } }).probe({
      signal: modelsAbort.signal,
    });
    await vi.waitFor(async () => expect(await readFile(modelsStarted, "utf8")).toBe("started"));
    modelsAbort.abort(new Error("stop"));
    await expect(modelsProbe).rejects.toBeDefined();
  }, 10_000);

  it("uses the default local Pi process boundary without adding a package dependency", async () => {
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
            normalized.includes("pi-coding-agent") ||
            normalized.includes("pi-agent") ||
            /^@(earendil-works|mariozechner)\/pi(?:-|$)/.test(normalized)
          );
        }),
      ),
    );
    expect(forbiddenDependencies).toEqual([]);

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
  readonly #messageCount: number;
  model: unknown = { id: "fixture", provider: "fixture" };

  constructor(
    options: { messageCount?: number; requestFailure?: unknown; sessionFile?: string; sessionId?: string } = {},
  ) {
    this.#requestFailure = options.requestFailure;
    this.#sessionId = options.sessionId ?? SESSION_ID;
    this.#sessionFile = options.sessionFile ?? SESSION_FILE;
    this.#messageCount = options.messageCount ?? 0;
  }

  async request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.commands.push(command);
    if (this.#requestFailure !== undefined) throw this.#requestFailure;
    if (command.type === "get_state") {
      return {
        sessionId: this.#sessionId,
        sessionFile: this.#sessionFile,
        messageCount: this.#messageCount,
        model: this.model,
      };
    }
    return undefined;
  }

  subscribe(listener: (message: Readonly<Record<string, unknown>>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {}

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
  return { eventSink, workspace: { cwd: "/workspace" }, policy: readOnlyPolicy() };
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
  await writeFile(path, `#!/bin/sh\n${body}`, "utf8");
  await chmod(path, 0o755);
  return path;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}
