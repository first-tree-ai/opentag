import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real child-process lifecycle cases need headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

import { AgentRuntimeError } from "../agent-runtime/errors.js";
import type {
  AgentApprovalResponse,
  AgentInteractionResponse,
  AgentQuestionResponse,
  AgentRuntime,
  AgentRuntimeEvent,
  CreateAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import {
  CODEX_AGENT_RUNTIME_APP_SERVER_ARGS,
  CodexAgentRuntimeFactory,
  codexAgentRuntimeEnvironment,
  codexBindingRequiresHostedToolReplacement,
} from "../providers/codex/agent-runtime.js";
import type {
  CodexAppServerMessage,
  CodexAppServerRequest,
  CodexDynamicToolCall,
  CodexDynamicToolHandler,
  CodexDynamicToolResult,
  InteractiveCodexAppServerClient,
} from "../providers/codex/app-server-wire.js";
import { CodexAppServerError } from "../providers/codex/app-server-wire.js";

const fixture = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexAgentRuntime exhaustive behavior", () => {
  it("bridges only canonical hosted tools for the active Run and settles each call once", async () => {
    const client = new ManualCodexClient();
    const handler = vi.fn(async (request: { input: unknown }) => {
      const mode = (request.input as { mode?: string }).mode;
      if (mode === "throw") throw new Error("handler failed");
      if (mode === "throw-non-error") throw "handler failed";
      if (mode === "invalid") return null as never;
      if (mode === "invalid-content") return { success: true, content: [{}] } as never;
      if (mode === "invalid-error") return { success: false, content: [], error: {} } as never;
      if (mode === "error") {
        return { success: false, content: [], error: { code: "denied", message: "denied" } };
      }
      return { success: true, content: [{ type: "text" as const, text: "sent" }] };
    });
    const definition = {
      name: "example_tool",
      description: "Send a message.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    } as const;
    const definitionWithoutDescription = {
      name: "example_failure",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    } as const;
    const runtime = await factory(client).create({
      ...createRequest(() => undefined),
      policy: {
        fileSystem: "workspace-write",
        network: "disabled",
        approvals: "never",
        tools: { mode: "provider-default" },
      },
      hostedTools: { definitions: [definition, definitionWithoutDescription], handler },
    });
    expect(client.call("thread/start")?.params).toMatchObject({
      ephemeral: false,
      dynamicTools: [
        {
          type: "function",
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
        },
        {
          type: "function",
          name: definitionWithoutDescription.name,
          inputSchema: definitionWithoutDescription.inputSchema,
        },
      ],
    });

    const run = runtime.prompt({ runId: "hosted-run", input: input("send") });
    await client.called("turn/start");
    const call = {
      arguments: { text: "hello" },
      callId: "tool-call-1",
      namespace: null,
      threadId: "thread-1",
      tool: definition.name,
      turnId: "turn-1",
    } satisfies CodexDynamicToolCall;
    await expect(client.callDynamicTool(call)).resolves.toEqual({ success: true, text: "sent" });
    await expect(client.callDynamicTool(call)).resolves.toEqual({ success: true, text: "sent" });
    await expect(client.callDynamicTool({ ...call, arguments: { text: "different" } })).resolves.toMatchObject({
      success: false,
      text: expect.stringContaining("conflicting reuse"),
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "hosted-run", toolCallId: "tool-call-1", name: definition.name }),
    );
    await expect(client.callDynamicTool({ ...call, callId: "unknown", tool: "unknown" })).resolves.toMatchObject({
      success: false,
    });
    for (const mode of ["throw", "throw-non-error", "invalid", "invalid-content", "invalid-error"] as const) {
      await expect(client.callDynamicTool({ ...call, callId: mode, arguments: { mode } })).resolves.toMatchObject({
        success: false,
      });
    }
    await expect(client.callDynamicTool({ ...call, callId: "error", arguments: { mode: "error" } })).resolves.toEqual({
      success: false,
      text: "denied: denied",
    });
    client.complete();
    await run;
    await expect(client.callDynamicTool({ ...call, callId: "late" })).resolves.toMatchObject({ success: false });
    await runtime.close();

    const legacyBinding = { providerId: "codex", schemaVersion: 1, payload: { threadId: "existing-thread" } } as const;
    const hostedTools = { definitions: [definition], handler };
    expect(codexBindingRequiresHostedToolReplacement(legacyBinding, hostedTools)).toBe(true);
    const incompatibleClient = new ManualCodexClient();
    await expect(
      factory(incompatibleClient).resume({
        ...createRequest(() => undefined),
        binding: legacyBinding,
        policy: {
          fileSystem: "workspace-write",
          network: "disabled",
          approvals: "never",
          tools: { mode: "provider-default" },
        },
        hostedTools,
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    expect(incompatibleClient.call("thread/resume")).toBeUndefined();
    expect(incompatibleClient.call("thread/start")).toBeUndefined();

    const replacementClient = new ManualCodexClient();
    const replacement = await factory(replacementClient).create({
      ...createRequest(() => undefined),
      policy: {
        fileSystem: "workspace-write",
        network: "disabled",
        approvals: "never",
        tools: { mode: "provider-default" },
      },
      hostedTools,
    });
    expect(replacementClient.call("thread/resume")).toBeUndefined();
    expect(replacementClient.call("thread/start")?.params).toMatchObject({
      ephemeral: false,
      dynamicTools: [
        {
          type: "function",
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
        },
      ],
    });
    expect(replacementClient.call("thread/start")?.params).not.toHaveProperty("tools");
    expect(replacement.binding?.payload).toMatchObject({
      threadId: "thread-1",
      hostedToolsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const upgradedBinding = replacement.binding;
    await replacement.close();

    if (!upgradedBinding) throw new Error("Expected the upgraded Codex binding");
    expect(codexBindingRequiresHostedToolReplacement(upgradedBinding, hostedTools)).toBe(false);
    const upgradedClient = new ManualCodexClient();
    const resumedAgain = await factory(upgradedClient).resume({
      ...createRequest(() => undefined),
      binding: upgradedBinding,
      policy: {
        fileSystem: "workspace-write",
        network: "disabled",
        approvals: "never",
        tools: { mode: "provider-default" },
      },
      hostedTools,
    });
    expect(upgradedClient.call("thread/start")).toBeUndefined();
    expect(upgradedClient.call("thread/resume")?.params).toMatchObject({ threadId: "thread-1" });
    expect(upgradedClient.call("thread/resume")?.params).not.toHaveProperty("dynamicTools");
    expect(upgradedClient.call("thread/resume")?.params).not.toHaveProperty("tools");
    expect(resumedAgain.binding).toEqual(upgradedBinding);
    await resumedAgain.close();

    expect(codexBindingRequiresHostedToolReplacement(upgradedBinding, undefined)).toBe(true);
    const incompatibleDisabledClient = new ManualCodexClient();
    await expect(
      factory(incompatibleDisabledClient).resume({
        ...createRequest(() => undefined),
        binding: upgradedBinding,
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    expect(incompatibleDisabledClient.call("thread/resume")).toBeUndefined();
    expect(incompatibleDisabledClient.call("thread/start")).toBeUndefined();

    const disabledClient = new ManualCodexClient();
    const disabled = await factory(disabledClient).create(createRequest(() => undefined));
    expect(disabledClient.call("thread/resume")).toBeUndefined();
    expect(disabledClient.call("thread/start")?.params).toMatchObject({ ephemeral: false });
    expect(disabledClient.call("thread/start")?.params).not.toHaveProperty("dynamicTools");
    expect(disabled.binding).toEqual({
      providerId: "codex",
      schemaVersion: 1,
      payload: { threadId: "thread-1" },
    });
    const disabledBinding = disabled.binding;
    await disabled.close();

    if (!disabledBinding) throw new Error("Expected the capability-disabled Codex binding");
    expect(codexBindingRequiresHostedToolReplacement(disabledBinding, undefined)).toBe(false);
    const disabledAgainClient = new ManualCodexClient();
    const disabledAgain = await factory(disabledAgainClient).resume({
      ...createRequest(() => undefined),
      binding: disabledBinding,
    });
    expect(disabledAgainClient.call("thread/start")).toBeUndefined();
    expect(disabledAgainClient.call("thread/resume")?.params).toMatchObject({ threadId: "thread-1" });
    expect(disabledAgainClient.call("thread/resume")?.params).not.toHaveProperty("dynamicTools");
    await disabledAgain.close();

    const allowListClient = new ManualCodexClient();
    const allowListRuntime = await factory(allowListClient).create({
      ...createRequest(() => undefined),
      policy: {
        fileSystem: "workspace-write",
        network: "disabled",
        approvals: "never",
        tools: { mode: "allow-list", names: [definition.name] },
      },
      hostedTools: { definitions: [definition], handler },
    });
    const allowListRun = allowListRuntime.prompt({ runId: "allow-list-run", input: input("send") });
    await allowListClient.called("turn/start");
    await expect(
      allowListClient.callDynamicTool({
        ...call,
        callId: "allow-list-tool",
        threadId: "thread-1",
        tool: definition.name,
        turnId: "turn-1",
      }),
    ).resolves.toEqual({ success: true, text: "sent" });
    allowListClient.complete();
    await allowListRun;
    await allowListRuntime.close();
  });

  it("replaces an old Codex binding that has threadId but no hostedToolsHash", async () => {
    const hostedTools = exampleHostedTools();
    const legacyBinding = { providerId: "codex", schemaVersion: 1, payload: { threadId: "existing-thread" } } as const;
    expect(codexBindingRequiresHostedToolReplacement(legacyBinding, hostedTools)).toBe(true);

    const incompatibleClient = new ManualCodexClient();
    await expect(
      factory(incompatibleClient).resume({
        ...createRequest(() => undefined),
        binding: legacyBinding,
        hostedTools,
      }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    expect(incompatibleClient.call("thread/resume")).toBeUndefined();
    expect(incompatibleClient.call("thread/start")).toBeUndefined();

    const replacementClient = new ManualCodexClient();
    const replacement = await factory(replacementClient).create({
      ...createRequest(() => undefined),
      hostedTools,
    });
    expect(replacementClient.call("thread/resume")).toBeUndefined();
    expect(replacementClient.call("thread/start")?.params).toMatchObject({
      ephemeral: false,
      dynamicTools: hostedTools.definitions.map((definition) => ({
        type: "function",
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      })),
    });
    expect(replacement.binding?.payload).toMatchObject({
      threadId: "thread-1",
      hostedToolsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const upgradedBinding = replacement.binding;
    await replacement.close();
    if (!upgradedBinding) throw new Error("Expected the upgraded Codex binding");
    expect(codexBindingRequiresHostedToolReplacement(upgradedBinding, hostedTools)).toBe(false);
  });

  it("maps all supported factory, Turn, policy, and Provider configuration variants", async () => {
    const client = new ManualCodexClient();
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory(client).create({
      ...createRequest((event) => {
        events.push(event);
      }),
      workspace: { cwd: "/workspace", writableRoots: ["/workspace/one", "/workspace/two"] },
      policy: {
        fileSystem: "workspace-write",
        network: "enabled",
        approvals: "unless-trusted",
        tools: { mode: "provider-default" },
      },
      configuration: {
        model: "base-model",
        reasoningEffort: "xhigh",
        provider: { personality: "friendly", serviceName: "opentag", summary: "concise" },
      },
    });
    expect(client.call("thread/start")?.params).toEqual({
      cwd: "/workspace",
      developerInstructions: "OpenTag managed system prompt",
      approvalPolicy: "unlessTrusted",
      sandbox: "workspace-write",
      model: "base-model",
      personality: "friendly",
      serviceName: "opentag",
      ephemeral: false,
    });

    const first = runtime.prompt({
      runId: "configured",
      input: input("hello"),
      configuration: {
        model: "override-model",
        reasoningEffort: "minimal",
        provider: { summary: "detailed" },
      },
    });
    await client.called("turn/start");
    expect(client.lastCall("turn/start")?.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      cwd: "/workspace",
      approvalPolicy: "unlessTrusted",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace/one", "/workspace/two"],
        networkAccess: true,
      },
      model: "override-model",
      effort: "minimal",
      personality: "friendly",
      summary: "detailed",
    });
    client.complete({ items: [] });
    await expect(first).resolves.toMatchObject({ status: "completed", output: [] });

    const second = runtime.prompt({ runId: "base-only", input: input("again") });
    await vi.waitFor(() => expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(2));
    expect(client.lastCall("turn/start")?.params).toMatchObject({ model: "base-model", effort: "xhigh" });
    client.complete({ id: "turn-2", items: [] });
    await second;
    await runtime.close();

    const readOnlyClient = new ManualCodexClient();
    const readOnly = await factory(readOnlyClient).create({
      ...createRequest(() => undefined),
      policy: {
        fileSystem: "read-only",
        network: "disabled",
        approvals: "never",
        tools: { mode: "provider-default" },
      },
    });
    expect(readOnlyClient.call("thread/start")?.params).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const readRun = readOnly.prompt({
      runId: "read-only",
      input: input("read"),
      configuration: { model: "prompt-model", provider: { personality: "pragmatic" } },
    });
    await readOnlyClient.called("turn/start");
    expect(readOnlyClient.lastCall("turn/start")?.params).toMatchObject({
      sandboxPolicy: { type: "readOnly" },
      model: "prompt-model",
      personality: "pragmatic",
    });
    readOnlyClient.complete();
    await readRun;
    await readOnly.close();

    const unrestrictedClient = new ManualCodexClient();
    const unrestricted = await factory(unrestrictedClient).create({
      ...createRequest(() => undefined),
      policy: {
        fileSystem: "unrestricted",
        network: "enabled",
        approvals: "never",
        tools: { mode: "provider-default" },
      },
    });
    expect(unrestrictedClient.call("thread/start")?.params).toMatchObject({ sandbox: "danger-full-access" });
    const unrestrictedRun = unrestricted.prompt({ runId: "unrestricted", input: input("work") });
    await unrestrictedClient.called("turn/start");
    expect(unrestrictedClient.lastCall("turn/start")?.params).toMatchObject({
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    unrestrictedClient.complete();
    await unrestrictedRun;
    await unrestricted.close();
    expect(events.some((event) => event.type === "binding_changed")).toBe(true);
  });

  it("translates the complete Codex notification and item event surface", async () => {
    const client = new ManualCodexClient();
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory(client).create(
      createRequest((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "events", input: input("events") });
    await client.called("turn/start");

    client.emit({ method: "turn/started", params: { turn: activeTurn() } });
    client.emit({ method: "warning", params: { message: "warning message" } });
    client.emit({ method: "configWarning", params: { summary: "config summary" } });
    client.emit({ method: "serverRequest/resolved", params: { requestId: "missing" } });
    client.emit({ method: "thread/closed", params: { threadId: "another-thread" } });
    client.emit({
      method: "thread/tokenUsage/updated",
      params: { turnId: "another-turn", tokenUsage: { total: { inputTokens: 999 } } },
    });
    client.emit({
      method: "thread/tokenUsage/updated",
      params: { turnId: "turn-1", tokenUsage: { total: { inputTokens: 8, cachedInputTokens: 2, outputTokens: 4 } } },
    });
    client.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "delta" },
    });
    client.emit({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command", delta: "stdout" },
    });
    client.emitItem("item/started", { id: "message-1", type: "agentMessage" });
    client.emitItem("item/completed", { id: "message-1", type: "agentMessage", text: "fallback" });
    client.emitItem("item/completed", {
      id: "commentary",
      type: "agentMessage",
      phase: "commentary",
      text: "thinking",
    });
    client.emitItem("item/started", { id: "ignored", type: "unknown" });
    client.emitItem("item/started", { id: "collab", type: "collabToolCall" });
    client.emitItem("item/completed", { id: "collab", type: "collabToolCall", status: "declined" });
    client.emitItem("item/started", { id: "dynamic", type: "dynamicToolCall", tool: "custom" });
    client.emitItem("item/completed", { id: "dynamic", type: "dynamicToolCall", status: "failed" });
    client.emitItem("item/started", { id: "dynamic-default", type: "dynamicToolCall" });
    client.emitItem("item/completed", { id: "file", type: "fileChange" });
    client.emitItem("item/completed", { id: "image", type: "imageView" });
    client.emitItem("item/started", { id: "mcp", type: "mcpToolCall", server: "server", tool: "tool" });
    client.emitItem("item/completed", { id: "mcp-default", type: "mcpToolCall" });
    client.emitItem("item/completed", { id: "web", type: "webSearch" });
    client.emit({ method: "error", params: { error: { message: "turn warning" } } });
    client.emit({ method: "error", params: {} });
    client.emit({ method: "turn/plan/updated", params: { plan: [] } });
    client.emit({ method: "turn/diff/updated", params: { diff: "" } });
    client.emit({ method: "model/rerouted", params: null });
    client.emit({ method: "unhandled/notification", params: {} });
    client.complete({
      items: [
        { id: "bad", type: "other", text: "ignored" },
        { id: "terminal", type: "agentMessage", phase: "final_answer", text: "terminal answer" },
      ],
    });

    const runResult = await run;
    expect(runResult, JSON.stringify(runResult)).toMatchObject({
      status: "completed",
      output: [{ text: "terminal answer" }],
      usage: { inputTokens: 8, cachedInputTokens: 2, outputTokens: 4 },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "provider_warning",
        "usage_updated",
        "message_started",
        "message_delta",
        "message_completed",
        "tool_started",
        "tool_updated",
        "tool_completed",
        "provider_event",
      ]),
    );
    expect(events.filter((event) => event.type === "tool_completed").map((event) => event.status)).toEqual(
      expect.arrayContaining(["declined", "failed", "completed"]),
    );
    await runtime.close();
  });

  it("maps completed fallback, interrupted, and failed Turn terminal forms", async () => {
    const client = new ManualCodexClient();
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory(client).create(
      createRequest((event) => {
        events.push(event);
      }),
    );

    const fallback = runtime.prompt({ runId: "fallback", input: input("one") });
    await client.called("turn/start");
    client.emitItem("item/completed", { id: "commentary", type: "agentMessage", phase: "commentary", text: "no" });
    client.emitItem("item/completed", { id: "answer", type: "agentMessage", phase: "answer", text: "fallback answer" });
    client.emit({ method: "thread/tokenUsage/updated", params: { tokenUsage: { inputTokens: 1, outputTokens: -1 } } });
    client.complete({ items: [] });
    await expect(fallback).resolves.toMatchObject({ output: [{ text: "fallback answer" }], usage: { inputTokens: 1 } });

    const interrupted = runtime.prompt({ runId: "interrupted", input: input("two") });
    await vi.waitFor(() => expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(2));
    client.emit({
      method: "thread/tokenUsage/updated",
      params: { turnId: "turn-2", tokenUsage: { total: { inputTokens: 1, outputTokens: 1 } } },
    });
    client.complete({ id: "turn-2", status: "interrupted", items: [] });
    await expect(interrupted).resolves.toMatchObject({
      status: "aborted",
      usage: { inputTokens: 1, outputTokens: 1 },
      error: { code: "run_aborted" },
    });

    const failed = runtime.prompt({ runId: "failed", input: input("three") });
    await vi.waitFor(() => expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(3));
    client.emit({
      method: "thread/tokenUsage/updated",
      params: { turnId: "turn-3", tokenUsage: { last: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } } },
    });
    client.complete({ id: "turn-3", status: "failed", error: { message: "model failed" }, items: [] });
    await expect(failed).resolves.toMatchObject({
      status: "failed",
      usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 },
      error: { message: "model failed" },
    });

    const failedDefault = runtime.prompt({ runId: "failed-default", input: input("four") });
    await vi.waitFor(() => expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(4));
    client.complete({ id: "turn-4", status: "failed", error: {}, items: [] });
    await expect(failedDefault).resolves.toMatchObject({ status: "failed", error: { message: "Codex turn failed" } });

    const openMessage = runtime.prompt({ runId: "open-message", input: input("five") });
    await vi.waitFor(() => expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(5));
    client.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-5", itemId: "open", delta: "partial" },
    });
    client.complete({
      id: "turn-5",
      items: [{ id: "open", type: "agentMessage", phase: "final_answer", text: "terminal text" }],
    });
    await expect(openMessage).resolves.toMatchObject({ status: "completed", output: [{ text: "terminal text" }] });

    const openDelta = runtime.prompt({ runId: "open-delta", input: input("six") });
    await vi.waitFor(() => expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(6));
    client.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-6", itemId: "delta-only", delta: "partial" },
    });
    client.complete({ id: "turn-6", items: [] });
    await expect(openDelta).resolves.toMatchObject({ status: "completed" });

    for (const [index, terminalStatus, itemStatus] of [
      [7, "completed", "declined"],
      [8, "completed", "failed"],
      [9, "failed", "completed"],
      [10, "interrupted", "completed"],
      [11, "completed", "completed"],
    ] as const) {
      const toolRun = runtime.prompt({ runId: `open-tool-${index}`, input: input("tool") });
      await vi.waitFor(() => expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(index));
      client.emitItem("item/started", { id: `tool-${index}`, type: "commandExecution" });
      client.complete({
        id: `turn-${index}`,
        status: terminalStatus,
        items: [{ id: `tool-${index}`, type: "commandExecution", status: itemStatus }],
      });
      await expect(toolRun).resolves.toMatchObject({
        status: terminalStatus === "completed" ? "completed" : terminalStatus === "failed" ? "failed" : "aborted",
      });
    }
    expect(events.find((event) => event.type === "tool_completed" && event.toolCallId === "tool-10")).toMatchObject({
      status: "failed",
    });

    const missingTool = runtime.prompt({ runId: "open-tool-12", input: input("tool") });
    await vi.waitFor(() => expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(12));
    client.emitItem("item/started", { id: "tool-12", type: "commandExecution" });
    client.complete({ id: "turn-12", status: "completed", items: [] });
    await expect(missingTool).resolves.toMatchObject({ status: "completed" });
    expect(events.find((event) => event.type === "tool_completed" && event.toolCallId === "tool-12")).toMatchObject({
      status: "failed",
    });
    await runtime.close();
  });

  it("translates every supported approval and question interaction response", async () => {
    const client = new ManualCodexClient();
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory(client).create(
      createRequest((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "interactions", input: input("interact") });
    await client.called("turn/start");

    await interact(runtime, client, events, 1, "item/commandExecution/requestApproval", {
      kind: "approval",
      decision: "accept",
      scope: "run",
    });
    await interact(runtime, client, events, 2, "item/fileChange/requestApproval", {
      kind: "approval",
      decision: "decline",
    });
    await interact(
      runtime,
      client,
      events,
      11,
      "item/commandExecution/requestApproval",
      {
        kind: "approval",
        decision: "cancel",
      },
      false,
    );
    await interact(runtime, client, events, 3, "item/permissions/requestApproval", {
      kind: "approval",
      decision: "accept",
      scope: "runtime",
      value: { permissions: ["network"] },
    });
    await interact(runtime, client, events, 4, "item/permissions/requestApproval", {
      kind: "approval",
      decision: "accept",
      value: null,
    });
    await interact(runtime, client, events, 5, "item/permissions/requestApproval", {
      kind: "approval",
      decision: "cancel",
    });
    await interact(runtime, client, events, 6, "item/tool/requestUserInput", {
      kind: "question",
      decision: "answer",
      value: { answer: "yes" },
    });
    await interact(runtime, client, events, 7, "item/tool/requestUserInput", {
      kind: "question",
      decision: "cancel",
    });
    await interact(runtime, client, events, 12, "item/tool/requestUserInput", {
      kind: "question",
      decision: "answer",
    });
    await interact(runtime, client, events, 8, "mcpServer/elicitation/request", {
      kind: "question",
      decision: "answer",
      value: { field: "value" },
    });
    await interact(runtime, client, events, 9, "mcpServer/elicitation/request", {
      kind: "question",
      decision: "answer",
    });
    await interact(runtime, client, events, 10, "mcpServer/elicitation/request", {
      kind: "question",
      decision: "cancel",
    });

    expect(client.serverResponses.map((response) => response.result)).toEqual([
      { decision: "accept" },
      { decision: "decline" },
      { decision: "cancel" },
      { permissions: ["network"], scope: "session" },
      { permissions: [], scope: "turn" },
      { permissions: [], scope: "turn" },
      { answers: { answer: "yes" } },
      { answers: {} },
      { answers: {} },
      { action: "accept", content: { field: "value" } },
      { action: "accept", content: null },
      { action: "cancel", content: null },
    ]);
    client.complete();
    await run;
    await runtime.close();
  });

  it("expires interactions and rejects unsupported, duplicate, and foreign server requests", async () => {
    const expiringClient = new ManualCodexClient();
    const events: AgentRuntimeEvent[] = [];
    const expiring = await factory(expiringClient).create(
      createRequest((event) => {
        events.push(event);
      }),
    );
    const expiringRun = expiring.prompt({ runId: "expire", input: input("expire") });
    await expiringClient.called("turn/start");
    expiringClient.emitRequest({
      id: "expire",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", message: "Question" },
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === "interaction_requested")).toBe(true));
    expiringClient.emit({ method: "serverRequest/resolved", params: { requestId: "expire" } });
    await vi.waitFor(() => expect(events.some((event) => event.type === "interaction_resolved")).toBe(true));
    await expect(
      expiring.respond({
        kind: "question",
        expectedRunId: "expire",
        requestId: "string:expire",
        decision: "cancel",
      }),
    ).rejects.toMatchObject({ code: "interaction_not_found" });
    expiringClient.complete();
    await expiringRun;
    await expiring.close();

    for (const request of [
      { id: "bad", method: "unsupported/request", params: {} },
      {
        id: "foreign-thread",
        method: "item/tool/requestUserInput",
        params: { threadId: "foreign", turnId: "turn-1" },
      },
      {
        id: "foreign-turn",
        method: "item/tool/requestUserInput",
        params: { threadId: "thread-1", turnId: "foreign" },
      },
      { id: "invalid", method: "item/tool/requestUserInput", params: null },
    ] satisfies CodexAppServerRequest[]) {
      const client = new ManualCodexClient();
      const runtime = await factory(client).create(createRequest(() => undefined));
      const run = runtime.prompt({ runId: request.id, input: input("bad") });
      await client.called("turn/start");
      client.emitRequest(request);
      await expect(run).resolves.toMatchObject({ status: "failed", error: { code: "provider_protocol_error" } });
      await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
    }

    const duplicateClient = new ManualCodexClient();
    const duplicate = await factory(duplicateClient).create(createRequest(() => undefined));
    const duplicateRun = duplicate.prompt({ runId: "duplicate", input: input("duplicate") });
    await duplicateClient.called("turn/start");
    const duplicateRequest = {
      id: 42,
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1" },
    } as const;
    duplicateClient.emitRequest(duplicateRequest);
    duplicateClient.emitRequest(duplicateRequest);
    await expect(duplicateRun).resolves.toMatchObject({ status: "failed" });
    await vi.waitFor(() => expect(duplicate.state.phase).toBe("closed"));
  });

  it("fails active Runs for malformed, crossed, and fatal Codex notifications", async () => {
    const cases: Array<{ name: string; message: CodexAppServerMessage }> = [
      { name: "process error fallback", message: { method: "opentag/processError", params: {} } },
      { name: "missing method", message: { params: {} } },
      { name: "closed thread", message: { method: "thread/closed", params: { threadId: "thread-1" } } },
      { name: "wrong started turn", message: { method: "turn/started", params: { turn: activeTurn("wrong") } } },
      {
        name: "active completed notification",
        message: { method: "turn/completed", params: { turn: activeTurn() } },
      },
      {
        name: "wrong message thread",
        message: {
          method: "item/agentMessage/delta",
          params: { threadId: "wrong", turnId: "turn-1", itemId: "message", delta: "x" },
        },
      },
      {
        name: "wrong message turn",
        message: {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "wrong", itemId: "message", delta: "x" },
        },
      },
      {
        name: "invalid usage",
        message: { method: "thread/tokenUsage/updated", params: { tokenUsage: null } },
      },
      {
        name: "invalid item",
        message: { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: null } },
      },
      {
        name: "invalid Provider event JSON",
        message: { method: "turn/plan/updated", params: { value: Number.NaN } },
      },
    ];
    for (const entry of cases) {
      const client = new ManualCodexClient();
      const runtime = await factory(client).create(createRequest(() => undefined));
      const run = runtime.prompt({ runId: entry.name, input: input("fail") });
      await client.called("turn/start");
      client.emit(entry.message);
      await expect(run, entry.name).resolves.toMatchObject({ status: "failed" });
      await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
    }
  });

  it("rejects wire lifecycles that reuse messages or rename active tools", async () => {
    const duplicateClient = new ManualCodexClient();
    const duplicate = await factory(duplicateClient).create(createRequest(() => undefined));
    const duplicateRun = duplicate.prompt({ runId: "duplicate-message", input: input("fail") });
    await duplicateClient.called("turn/start");
    duplicateClient.emitItem("item/completed", { id: "message", type: "agentMessage", text: "done" });
    duplicateClient.emitItem("item/started", { id: "message", type: "agentMessage" });
    await expect(duplicateRun).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Codex reused a completed agent message ID" },
    });
    await vi.waitFor(() => expect(duplicate.state.phase).toBe("closed"));

    const renamedClient = new ManualCodexClient();
    const renamed = await factory(renamedClient).create(createRequest(() => undefined));
    const renamedRun = renamed.prompt({ runId: "renamed-tool", input: input("fail") });
    await renamedClient.called("turn/start");
    renamedClient.emit({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "tool", delta: "output" },
    });
    renamedClient.emitItem("item/started", { id: "tool", type: "mcpToolCall", server: "server", tool: "read" });
    await expect(renamedRun).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: "Codex changed a tool name during its lifecycle" },
    });
    await vi.waitFor(() => expect(renamed.state.phase).toBe("closed"));
  });

  it("fails when a trailing notification breaks after Codex emits terminal", async () => {
    const client = new ManualCodexClient();
    const runtime = await factory(client).create(createRequest(() => undefined));
    const run = runtime.prompt({ runId: "trailing-failure", input: input("fail late") });
    await client.called("turn/start");
    client.complete();
    queueMicrotask(() => client.emit({ method: "turn/plan/updated", params: { invalid: Number.NaN } }));
    await expect(run).resolves.toMatchObject({ status: "failed", error: { code: "provider_error" } });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
  });

  it("claims a Codex terminal at ingress before a following interrupt error while a prior event is blocked", async () => {
    const interruptResponse = deferred<void>();
    const releaseWarning = deferred<void>();
    const client = new ManualCodexClient({ interruptResponse: interruptResponse.promise });
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory(client).create(
      createRequest(async (event) => {
        events.push(event);
        if (event.type === "provider_warning" && event.message === "before terminal") {
          await releaseWarning.promise;
        }
      }),
    );
    const run = runtime.prompt({ runId: "terminal-before-interrupt-error", input: input("finish") });
    await client.called("turn/start");
    client.emit({ method: "warning", params: { message: "before terminal" } });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "provider_warning" && event.message === "before terminal")).toBe(
        true,
      ),
    );
    const aborting = runtime.abort({ expectedRunId: "terminal-before-interrupt-error" });
    await vi.waitFor(() => expect(client.interrupts).toHaveLength(1));
    client.complete();
    interruptResponse.reject(new Error("turn is already terminal"));

    await expect(aborting).rejects.toThrow("turn is already terminal");
    expect(runtime.state.phase).toBe("running");
    expect(client.closed).toBe(false);
    releaseWarning.resolve();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    expect(runtime.state.phase).toBe("idle");
    await runtime.close();
  });

  it("rejects malformed turn/start responses and accepts buffered notifications", async () => {
    for (const response of [
      null,
      {},
      { turn: null },
      { turn: { status: "inProgress", items: [] } },
      { turn: { id: "turn-1", status: "unknown", items: [] } },
      { turn: { id: "turn-1", status: "completed", items: [] } },
      { turn: { id: "turn-1", status: "inProgress", items: [null] } },
    ]) {
      const client = new ManualCodexClient({ turnStartResponse: response });
      const runtime = await factory(client).create(createRequest(() => undefined));
      await expect(
        runtime.prompt({ runId: `invalid-${client.instanceId}`, input: input("bad") }),
      ).resolves.toMatchObject({
        status: "failed",
      });
      await runtime.close().catch(() => undefined);
    }

    const bufferedClient = new ManualCodexClient({
      beforeTurnStartResponse: (client) => {
        client.emit({ method: "warning", params: { message: "buffered warning" } });
      },
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory(bufferedClient).create(
      createRequest((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "buffered", input: input("buffer") });
    await bufferedClient.called("turn/start");
    bufferedClient.complete();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    expect(events.some((event) => event.type === "provider_warning")).toBe(true);
    await runtime.close();

    const noItemsClient = new ManualCodexClient({
      turnStartResponse: { turn: { id: "turn-1", status: "inProgress" } },
    });
    const noItems = await factory(noItemsClient).create(createRequest(() => undefined));
    const noItemsRun = noItems.prompt({ runId: "no-items", input: input("none") });
    await noItemsClient.called("turn/start");
    noItemsClient.emit({
      method: "turn/completed",
      params: {
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ id: "fallback", type: "agentMessage", text: "terminal fallback" }],
        },
      },
    });
    await expect(noItemsRun).resolves.toMatchObject({ output: [{ text: "terminal fallback" }] });
    await noItems.close();
  });

  it("rejects undeliverable interactions back to Codex and handles non-Error stream failures", async () => {
    const client = new ManualCodexClient();
    const runtime = await factory(client).create(
      createRequest((event) => {
        if (event.type === "interaction_requested") throw new Error("sink rejected interaction");
      }),
    );
    const run = runtime.prompt({ runId: "interaction-sink", input: input("interact") });
    await client.called("turn/start");
    client.emitRequest({
      id: "approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await expect(run).resolves.toMatchObject({ status: "failed", error: { code: "event_delivery_failed" } });
    expect(client.serverRejections).toEqual([
      { id: "approval", code: -32000, message: "OpenTag could not deliver the interaction" },
    ]);
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));

    const nonErrorClient = new ManualCodexClient();
    const nonError = await factory(nonErrorClient).create(
      createRequest((event) => {
        if (event.type === "provider_warning") throw "non-error sink failure";
      }),
    );
    nonErrorClient.emit({ method: "warning", params: { message: "outside run" } });
    await Promise.resolve();
    const nonErrorRun = nonError.prompt({ runId: "non-error", input: input("fail") });
    await nonErrorClient.called("turn/start");
    nonErrorClient.emit({ method: "warning", params: { message: "inside run" } });
    nonErrorClient.emit({ method: "warning", params: { message: "second failure" } });
    await expect(nonErrorRun).resolves.toMatchObject({ status: "failed", error: { code: "event_delivery_failed" } });
    await vi.waitFor(() => expect(nonError.state.phase).toBe("closed"));

    const rejectionFailureClient = new ManualCodexClient({ rejectServerRequestError: true });
    const rejectionFailure = await factory(rejectionFailureClient).create(
      createRequest((event) => {
        if (event.type === "interaction_requested") throw new Error("sink rejected interaction");
      }),
    );
    const rejectionFailureRun = rejectionFailure.prompt({
      runId: "interaction-rejection-failure",
      input: input("interact"),
    });
    await rejectionFailureClient.called("turn/start");
    rejectionFailureClient.emitRequest({
      id: "approval-failure",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await expect(rejectionFailureRun).resolves.toMatchObject({
      status: "failed",
      error: { code: "event_delivery_failed" },
    });
    await vi.waitFor(() => expect(rejectionFailure.state.phase).toBe("closed"));
  });

  it("queues steer and abort until turn/start returns and rejects a crossed steer", async () => {
    const turnResponse = deferred<unknown>();
    const client = new ManualCodexClient({ turnStartResponse: turnResponse.promise });
    const runtime = await factory(client).create(createRequest(() => undefined));
    const run = runtime.prompt({ runId: "control", input: input("start") });
    await client.called("turn/start");
    const steering = runtime.steer({ expectedRunId: "control", input: input("steer") });
    const aborting = runtime.abort({ expectedRunId: "control", reason: "stop" });
    expect(client.call("turn/steer")).toBeUndefined();
    turnResponse.resolve({ turn: activeTurn() });
    await steering;
    await aborting;
    expect(client.call("turn/steer")?.params).toMatchObject({ expectedTurnId: "turn-1" });
    expect(client.interrupts).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
    client.complete({ status: "interrupted" });
    await run;
    await runtime.close();

    const crossedClient = new ManualCodexClient({ steerTurnId: "another-turn" });
    const crossed = await factory(crossedClient).create(createRequest(() => undefined));
    const crossedRun = crossed.prompt({ runId: "crossed", input: input("start") });
    await crossedClient.called("turn/start");
    await expect(crossed.steer({ expectedRunId: "crossed", input: input("steer") })).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
    crossedClient.complete();
    await crossedRun;
    await crossed.close();

    const immediateClient = new ManualCodexClient();
    const immediate = await factory(immediateClient).create(createRequest(() => undefined));
    const immediateRun = immediate.prompt({ runId: "immediate", input: input("start") });
    await expect(immediate.abort({ expectedRunId: "immediate" })).rejects.toMatchObject({ code: "run_mismatch" });
    await immediateClient.called("turn/start");
    immediateClient.complete();
    await immediateRun;
    await immediate.close();
  });

  it("validates all factory request, policy, configuration, binding, and probe failures", async () => {
    const client = new ManualCodexClient();
    const runtimeFactory = factory(client);
    const valid = createRequest(() => undefined);
    const invalidRequests: unknown[] = [
      undefined,
      { ...valid, eventSink: undefined },
      { ...valid, systemPrompt: undefined },
      { ...valid, systemPrompt: " " },
      { ...valid, systemPrompt: "x".repeat(1024 * 1024 + 1) },
      { ...valid, workspace: undefined },
      { ...valid, workspace: { cwd: "relative" } },
      { ...valid, workspace: { cwd: "/workspace", writableRoots: ["relative"] } },
      { ...valid, policy: { ...valid.policy, tools: { mode: "allow-list", names: ["read"] } } },
      {
        ...valid,
        workspace: { cwd: "/workspace", writableRoots: ["/workspace"] },
        policy: { ...valid.policy, fileSystem: "read-only" },
      },
      { ...valid, policy: { ...valid.policy, fileSystem: "read-only", network: "enabled" } },
      { ...valid, policy: { ...valid.policy, fileSystem: "unrestricted", network: "disabled" } },
      { ...valid, configuration: { model: " " } },
      { ...valid, configuration: { reasoningEffort: "extreme" } },
      { ...valid, configuration: { provider: "not-object" } },
      { ...valid, configuration: { provider: { unknown: true } } },
      { ...valid, configuration: { provider: { personality: "" } } },
      { ...valid, configuration: { provider: { serviceName: 1 } } },
    ];
    for (const request of invalidRequests) {
      await expect(runtimeFactory.create(request as never)).rejects.toMatchObject({ code: "configuration_invalid" });
    }

    await expect(
      runtimeFactory.resume({ ...valid, binding: { providerId: "other", schemaVersion: 1, payload: {} } }),
    ).rejects.toMatchObject({ code: "binding_incompatible" });
    for (const payload of [
      [],
      {},
      { threadId: "" },
      { threadId: 1 },
      { threadId: "x".repeat(1024 * 1024 + 1) },
      { threadId: "thread", hostedToolsHash: "not-a-hash" },
    ]) {
      await expect(
        runtimeFactory.resume({
          ...valid,
          binding: { providerId: "codex", schemaVersion: 1, payload: payload as never },
        }),
      ).rejects.toMatchObject({ code: "binding_incompatible" });
    }

    const invalidProviderProbe = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      probeRunner: async () => ({ appServer: false, credential: false, experimentalTools: false, version: "version" }),
    });
    await expect(invalidProviderProbe.probe({ configuration: { model: " " } })).resolves.toMatchObject({
      ready: false,
      version: "version",
      issues: [{ code: "configuration_invalid" }, { code: "version_incompatible" }, { code: "credential_missing" }],
    });
    const missing = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      probeRunner: async () => {
        throw new Error("missing");
      },
    });
    await expect(missing.probe({})).rejects.toThrow("missing");
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw "bare-string";
        },
      }).probe({}),
    ).rejects.toBe("bare-string");
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw null;
        },
      }).probe({}),
    ).rejects.toBeNull();
    const transientCases = [
      { code: "ETIMEDOUT" },
      { code: "EAGAIN" },
      { code: "ENOMEM" },
      { killed: true, signal: "SIGKILL" },
    ];
    for (const extra of transientCases) {
      const transient = new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw Object.assign(new Error("busy"), extra);
        },
      });
      await expect(transient.probe({})).resolves.toMatchObject({
        ready: false,
        issues: [{ code: "temporarily_unavailable" }],
      });
    }
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw Object.assign(new Error("crash-killed"), { killed: true, signal: "SIGSEGV" });
        },
      }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "artifact_missing" }] });
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw new CodexAppServerError("spawn", "missing");
        },
      }).probe({}),
    ).rejects.toMatchObject({ code: "spawn", message: "missing" });
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw new CodexAppServerError("spawn", "enoent", { errno: "ENOENT" });
        },
      }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "artifact_missing" }] });
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw new CodexAppServerError("exited", "clean", { exitCode: 0, signal: null });
        },
      }).probe({}),
    ).rejects.toMatchObject({ code: "exited", exitCode: 0 });
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw new CodexAppServerError("exited", "timeout-kill", { killed: true, signal: "SIGKILL" });
        },
      }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "temporarily_unavailable" }] });
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw new CodexAppServerError("spawn", "busy", { errno: "EAGAIN" });
        },
      }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "temporarily_unavailable" }] });
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw new CodexAppServerError("exited", "dead", { exitCode: 1, signal: null });
        },
      }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "version_incompatible" }] });
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw new CodexAppServerError("exited", "fault", { exitCode: null, signal: "SIGABRT" });
        },
      }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "artifact_missing" }] });
    await expect(
      new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw new CodexAppServerError("exited", "host", { signal: "SIGUSR1" });
        },
      }).probe({}),
    ).resolves.toMatchObject({ ready: false, issues: [{ code: "temporarily_unavailable" }] });
    const crashCases = [
      { signal: "SIGSEGV" },
      { signal: "SIGABRT" },
      { signal: "SIGILL" },
      { signal: "SIGBUS" },
      { signal: "SIGFPE" },
      { code: 1 },
    ];
    for (const extra of crashCases) {
      const crashed = new CodexAgentRuntimeFactory({
        clientVersion: "test",
        probeRunner: async () => {
          throw Object.assign(new Error("broken"), extra);
        },
      });
      await expect(crashed.probe({})).resolves.toMatchObject({
        ready: false,
        issues: [{ code: "artifact_missing" }],
      });
    }
    const incompatibleProtocol = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      probeRunner: async () => {
        throw new CodexAppServerError("protocol", "bad response");
      },
    });
    await expect(incompatibleProtocol.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "version_incompatible", message: expect.stringContaining("bad response") }],
    });
    const temporaryFailure = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      probeRunner: async () => {
        throw new CodexAppServerError("timeout", "slow response");
      },
    });
    await expect(temporaryFailure.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "temporarily_unavailable", message: expect.stringContaining("slow response") }],
    });
    const missingExperimental = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: false, version: "version" }),
    });
    await expect(missingExperimental.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "version_incompatible", message: expect.stringContaining("dynamic tools") }],
    });

    const missingTransport = new ManualCodexClient();
    Object.defineProperty(missingTransport, "setDynamicToolHandler", { value: undefined });
    await expect(
      factory(missingTransport).create({
        ...valid,
        policy: { ...valid.policy, tools: { mode: "allow-list", names: ["tool"] } },
        hostedTools: {
          definitions: [{ name: "tool", inputSchema: { type: "object" } }],
          handler: async () => ({ success: true, content: [] }),
        },
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(missingTransport.closed).toBe(true);
  });

  it("cleans up factory failures without hiding typed errors", async () => {
    const valid = createRequest(() => undefined);
    const typedClient = new ManualCodexClient({
      initializeError: new AgentRuntimeError("configuration_invalid", "typed"),
    });
    await expect(factory(typedClient).create(valid)).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(typedClient.closed).toBe(true);

    const initializeClient = new ManualCodexClient({
      initializeError: new Error("initialize failed"),
      closeError: true,
    });
    await expect(factory(initializeClient).create(valid)).rejects.toMatchObject({ code: "create_failed" });

    for (const response of [null, {}, { thread: null }, { thread: {} }, { thread: { id: "" } }]) {
      const client = new ManualCodexClient({ threadStartResponse: response });
      await expect(factory(client).create(valid)).rejects.toMatchObject({ code: "create_failed" });
      expect(client.closed).toBe(true);
    }

    const nonErrorClient = new ManualCodexClient({ turnStartResponse: Promise.reject("non-error turn failure") });
    const nonError = await factory(nonErrorClient).create(valid);
    await expect(nonError.prompt({ runId: "non-error", input: input("fail") })).resolves.toMatchObject({
      status: "failed",
      error: { message: "Codex run failed" },
    });
    await nonError.close();
  });

  it("uses only the user-installed local Codex executable boundary", async () => {
    const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
    const manifestUrls = [
      new URL("../../../../package.json", import.meta.url),
      new URL("../../package.json", import.meta.url),
    ];
    const manifests = await Promise.all(
      manifestUrls.map(async (url) => JSON.parse(await readFile(url, "utf8")) as PackageManifest),
    );
    const codexDependencies = manifests.flatMap((manifest) =>
      dependencyFields.flatMap((field) =>
        Object.keys(manifest[field] ?? {}).filter((name) => name.toLowerCase().includes("codex")),
      ),
    );
    expect(codexDependencies).toEqual([]);

    const cwd = await temporaryDirectory("opentag-codex-local-artifact-");
    const launches: Array<{ command: string; args: readonly string[]; path: string | undefined }> = [];
    const runtimeFactory = new CodexAgentRuntimeFactory({
      clientVersion: "0.0.1-test",
      process: {
        env: { PATH: process.env.PATH, CODEX_FIXTURE_SCENARIO: "normal" },
        requestTimeoutMs: 2_000,
        spawnProcess: (command, args, options) => {
          launches.push({ command, args: [...args], path: options.env?.PATH });
          return spawn(process.execPath, [fixture], { ...options, stdio: "pipe" });
        },
      },
      probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "fixture" }),
    });
    const runtime = await runtimeFactory.create({ ...createRequest(() => undefined), workspace: { cwd } });
    await runtime.close();

    expect(launches).toEqual([
      { command: "codex", args: [...CODEX_AGENT_RUNTIME_APP_SERVER_ARGS], path: process.env.PATH },
    ]);
  });

  it("runs the full Provider through a real offline App Server process", async () => {
    const cwd = await temporaryDirectory("opentag-codex-provider-process-");
    const runtimeFactory = new CodexAgentRuntimeFactory({
      clientVersion: "0.0.1-test",
      process: {
        command: process.execPath,
        args: [fixture],
        env: { PATH: process.env.PATH, CODEX_FIXTURE_SCENARIO: "normal" },
        requestTimeoutMs: 2_000,
      },
      probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "fixture" }),
    });
    const runtime = await runtimeFactory.create({ ...createRequest(() => undefined), workspace: { cwd } });
    await expect(runtime.prompt({ runId: "process", input: input("hello") })).resolves.toMatchObject({
      status: "completed",
      output: [{ text: "fixture answer" }],
    });
    const binding = runtime.binding;
    await runtime.close();
    if (!binding) throw new Error("fixture did not create a binding");
    const resumed = await runtimeFactory.resume({
      ...createRequest(() => undefined),
      workspace: { cwd },
      binding,
    });
    expect(resumed.binding).toEqual(binding);
    await resumed.close();

    const defaultArgsFactory = new CodexAgentRuntimeFactory({
      clientVersion: "0.0.1-test",
      process: {
        command: "ignored-by-test-spawn",
        env: { PATH: process.env.PATH, CODEX_FIXTURE_SCENARIO: "normal" },
        requestTimeoutMs: 2_000,
        spawnProcess: (_command, _args, options) => spawn(process.execPath, [fixture], { ...options, stdio: "pipe" }),
      },
      probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "fixture" }),
    });
    const defaultArgs = await defaultArgsFactory.create({ ...createRequest(() => undefined), workspace: { cwd } });
    await defaultArgs.close();
  });

  it("runs the default local probe against controlled CLI artifacts and credential sources", async () => {
    const directory = await temporaryDirectory("opentag-codex-probe-");
    const command = join(directory, "codex-fixture");
    await writeFile(
      command,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'codex-cli test\'; exit 0; fi\nif [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ] && [ "$CODEX_FIXTURE_LOGIN_VALID" = "1" ]; then exit 0; fi\nexit 1\n',
      "utf8",
    );
    await chmod(command, 0o755);
    const codexHome = join(directory, "codex-home");
    await mkdir(codexHome);
    await writeFile(join(codexHome, "auth.json"), "{}", "utf8");

    const promptSurfaceClients = [
      new ManualCodexClient(),
      new ManualCodexClient({ threadResumeResponse: { thread: { id: "bootstrap-thread" } } }),
      new ManualCodexClient(),
    ];
    let promptSurfaceClientIndex = 0;
    let isolatedProbeHome: string | undefined;
    const withFile = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      createClient: (_cwd, probeEnvironment) => {
        isolatedProbeHome = probeEnvironment?.CODEX_HOME;
        const client = promptSurfaceClients[promptSurfaceClientIndex];
        promptSurfaceClientIndex += 1;
        if (!client) throw new Error("unexpected prompt-surface client creation");
        return client;
      },
      process: {
        command,
        env: { PATH: process.env.PATH, CODEX_HOME: codexHome, CODEX_FIXTURE_LOGIN_VALID: "1" },
        expectedCodexHome: codexHome,
      },
    });
    await expect(withFile.probe({})).resolves.toEqual({ ready: true, version: "codex-cli test", issues: [] });
    expect(promptSurfaceClients[0]?.call("thread/start")?.params).toMatchObject({
      ephemeral: false,
      developerInstructions: "OpenTag Provider prompt-surface capability probe.",
    });
    expect(promptSurfaceClients[1]?.call("thread/resume")?.params).toMatchObject({
      threadId: "thread-1",
      developerInstructions: "OpenTag Provider prompt-surface capability probe.",
      history: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "OpenTag capability probe history." }],
        },
      ],
    });
    expect(promptSurfaceClients[2]?.call("thread/resume")?.params).toEqual({
      threadId: "bootstrap-thread",
      cwd: process.cwd(),
      developerInstructions: "OpenTag Provider prompt-surface capability probe.",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(isolatedProbeHome).toContain("opentag-codex-capability-");
    await expect(stat(isolatedProbeHome ?? "")).rejects.toMatchObject({ code: "ENOENT" });

    for (const clients of [
      [new ManualCodexClient({ threadStartResponse: {} })],
      [new ManualCodexClient(), new ManualCodexClient({ threadResumeResponse: {} })],
      [new ManualCodexClient(), new ManualCodexClient(), new ManualCodexClient({ threadResumeResponse: {} })],
      [
        new ManualCodexClient(),
        new ManualCodexClient(),
        new ManualCodexClient({ threadResumeResponse: { thread: { id: "replacement-thread" } } }),
      ],
    ]) {
      let clientIndex = 0;
      const incompatiblePromptSurface = new CodexAgentRuntimeFactory({
        clientVersion: "test",
        createClient: () => {
          const client = clients[clientIndex];
          clientIndex += 1;
          if (!client) throw new Error("unexpected incompatible prompt-surface client creation");
          return client;
        },
        process: {
          command,
          env: { PATH: process.env.PATH, CODEX_FIXTURE_LOGIN_VALID: "1" },
        },
      });
      await expect(incompatiblePromptSurface.probe({})).resolves.toMatchObject({
        ready: false,
        issues: [{ code: "version_incompatible" }],
      });
      expect(clients.every((client) => client.closed)).toBe(true);
    }

    const withKey = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      createClient: () => new ManualCodexClient(),
      process: {
        command,
        env: { PATH: process.env.PATH, OPENAI_API_KEY: "test-key", CODEX_FIXTURE_LOGIN_VALID: "1" },
      },
    });
    await expect(withKey.probe({})).resolves.toMatchObject({ ready: true });

    const invalidPersistedCredential = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      process: { command, env: { PATH: process.env.PATH, CODEX_HOME: codexHome }, expectedCodexHome: codexHome },
    });
    await expect(invalidPersistedCredential.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "credential_missing" }],
    });
    const noHome = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      process: { command, env: { PATH: process.env.PATH } },
    });
    await expect(noHome.probe({})).resolves.toMatchObject({ ready: false, issues: [{ code: "credential_missing" }] });

    const emptyVersionCommand = join(directory, "codex-empty-version");
    await writeFile(
      emptyVersionCommand,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nif [ "$1" = "app-server" ]; then exit 0; fi\n',
      "utf8",
    );
    await chmod(emptyVersionCommand, 0o755);
    const emptyVersion = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      process: { command: emptyVersionCommand, env: { PATH: process.env.PATH, OPENAI_API_KEY: "key" } },
    });
    await expect(emptyVersion.probe({})).rejects.toThrow("Codex CLI returned no version");

    const loginStarted = join(directory, "login-started");
    const hangingLoginCommand = join(directory, "codex-hanging-login");
    await writeFile(
      hangingLoginCommand,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli test'; exit 0; fi\nif [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then printf started > '${loginStarted}'; exec '${process.execPath}' -e 'setInterval(() => undefined, 1000)'; fi\nexit 1\n`,
      "utf8",
    );
    await chmod(hangingLoginCommand, 0o755);
    const hangingLogin = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      process: { command: hangingLoginCommand, env: { PATH: process.env.PATH } },
    });
    const loginAbort = new AbortController();
    const loginProbe = hangingLogin.probe({ signal: loginAbort.signal });
    await vi.waitFor(async () => expect(await readFile(loginStarted, "utf8")).toBe("started"));
    loginAbort.abort(new Error("stop"));
    await expect(loginProbe).rejects.toBeDefined();
    expect(codexAgentRuntimeEnvironment()).toEqual(expect.any(Object));
  });

  it("aborts a hanging real App Server readiness probe and closes its process", async () => {
    const directory = await temporaryDirectory("opentag-codex-probe-abort-");
    const command = join(directory, "codex-fixture");
    const pidFile = join(directory, "app-server.pid");
    const codexHome = join(directory, "codex-home");
    await mkdir(codexHome);
    await writeFile(
      command,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli test'; exit 0; fi\nif [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi\nexec '${process.execPath}' '${fixture}'\n`,
      "utf8",
    );
    await chmod(command, 0o755);
    const runtimeFactory = new CodexAgentRuntimeFactory({
      clientVersion: "test",
      process: {
        command,
        env: {
          PATH: process.env.PATH,
          CODEX_HOME: codexHome,
          CODEX_FIXTURE_SCENARIO: "probe-hang",
          CODEX_FIXTURE_PID_FILE: pidFile,
        },
        expectedCodexHome: codexHome,
        requestTimeoutMs: 60_000,
      },
    });
    const controller = new AbortController();
    const probing = runtimeFactory.probe({ signal: controller.signal });
    await vi.waitFor(async () => expect(Number(await readFile(pidFile, "utf8"))).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    const pid = Number(await readFile(pidFile, "utf8"));

    controller.abort(new Error("stop"));
    await expect(probing).rejects.toBeDefined();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
});

let clientSequence = 0;

interface ManualClientOptions {
  readonly beforeTurnStartResponse?: (client: ManualCodexClient) => void;
  readonly closeError?: boolean;
  readonly initializeError?: Error;
  readonly rejectServerRequestError?: boolean;
  readonly interruptResponse?: Promise<void>;
  readonly steerTurnId?: string;
  readonly threadStartResponse?: unknown;
  readonly threadResumeResponse?: unknown;
  readonly turnStartResponse?: unknown | Promise<unknown>;
}

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

class ManualCodexClient implements InteractiveCodexAppServerClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly serverRejections: Array<{ id: number | string; code: number; message: string }> = [];
  readonly serverResponses: Array<{ id: number | string; result: unknown }> = [];
  readonly instanceId = ++clientSequence;
  readonly #notifications = new Set<(message: CodexAppServerMessage) => void>();
  readonly #requests = new Set<(request: CodexAppServerRequest) => void>();
  readonly #options: ManualClientOptions;
  #dynamicToolHandler?: CodexDynamicToolHandler;
  closed = false;
  turn = 0;

  constructor(options: ManualClientOptions = {}) {
    this.#options = options;
  }

  async initialize(clientVersion: string): Promise<void> {
    this.calls.push({ method: "initialize", params: { clientVersion } });
    if (this.#options.initializeError) throw this.#options.initializeError;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      return Object.hasOwn(this.#options, "threadStartResponse")
        ? this.#options.threadStartResponse
        : { thread: { id: "thread-1" } };
    }
    if (method === "thread/resume") {
      if (Object.hasOwn(params as object, "dynamicTools")) {
        throw new Error("thread/resume does not accept dynamicTools");
      }
      return Object.hasOwn(this.#options, "threadResumeResponse")
        ? this.#options.threadResumeResponse
        : { thread: { id: (params as { threadId: string }).threadId } };
    }
    if (method === "turn/steer") return { turnId: this.#options.steerTurnId ?? `turn-${this.turn}` };
    if (method !== "turn/start") throw new Error(`unexpected request: ${method}`);
    this.turn += 1;
    this.#options.beforeTurnStartResponse?.(this);
    return Object.hasOwn(this.#options, "turnStartResponse")
      ? await this.#options.turnStartResponse
      : { turn: activeTurn(`turn-${this.turn}`) };
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.calls.push({ method, params });
  }

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  subscribeServerRequests(listener: (request: CodexAppServerRequest) => void): () => void {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }

  setDynamicToolHandler(handler: CodexDynamicToolHandler | undefined): void {
    this.#dynamicToolHandler = handler;
  }

  callDynamicTool(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult> {
    if (!this.#dynamicToolHandler) throw new Error("dynamic tool handler is unavailable");
    return this.#dynamicToolHandler(call);
  }

  async respondServerRequest(id: number | string, result: unknown): Promise<void> {
    this.serverResponses.push({ id, result });
  }

  async rejectServerRequest(id: number | string, code: number, message: string): Promise<void> {
    if (this.#options.rejectServerRequestError) throw new Error("server request rejection failed");
    this.serverRejections.push({ id, code, message });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
    await this.#options.interruptResponse;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.#options.closeError) throw new Error("close failed");
  }

  call(method: string): { method: string; params: unknown } | undefined {
    return this.calls.find((call) => call.method === method);
  }

  lastCall(method: string): { method: string; params: unknown } | undefined {
    return this.calls.filter((call) => call.method === method).at(-1);
  }

  async called(method: string): Promise<void> {
    await vi.waitFor(() => expect(this.call(method)).toBeDefined());
  }

  emit(message: CodexAppServerMessage): void {
    for (const listener of this.#notifications) listener(message);
  }

  emitRequest(request: CodexAppServerRequest): void {
    for (const listener of this.#requests) listener(request);
  }

  emitItem(method: "item/started" | "item/completed", item: Record<string, unknown>): void {
    this.emit({ method, params: { threadId: "thread-1", turnId: `turn-${this.turn}`, item } });
  }

  complete(
    turn: {
      id?: string;
      status?: "completed" | "failed" | "inProgress" | "interrupted";
      items?: unknown[];
      error?: unknown;
    } = {},
  ): void {
    this.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: turn.id ?? `turn-${this.turn}`,
          status: turn.status ?? "completed",
          items: turn.items ?? [],
          ...(turn.error !== undefined ? { error: turn.error } : {}),
        },
      },
    });
  }
}

function factory(client: ManualCodexClient): CodexAgentRuntimeFactory {
  return new CodexAgentRuntimeFactory({
    clientVersion: "0.0.1-test",
    createClient: () => client,
    probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "test" }),
  });
}

function exampleHostedTools() {
  return {
    definitions: [
      {
        name: "example_tool",
        description: "Example hosted tool",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    handler: vi.fn(async () => ({ success: true, content: [] })),
  };
}

function createRequest(eventSink: CreateAgentRuntimeRequest["eventSink"]): CreateAgentRuntimeRequest {
  return {
    eventSink,
    systemPrompt: "OpenTag managed system prompt",
    workspace: { cwd: "/workspace" },
    policy: {
      fileSystem: "workspace-write",
      network: "disabled",
      approvals: "on-request",
      tools: { mode: "provider-default" },
    },
  };
}

function input(text: string) {
  return { items: [{ type: "text" as const, text }] };
}

function activeTurn(id = "turn-1") {
  return { id, status: "inProgress", items: [] };
}

async function interact(
  runtime: AgentRuntime,
  client: ManualCodexClient,
  events: AgentRuntimeEvent[],
  id: number,
  method: string,
  response:
    | Omit<AgentApprovalResponse, "expectedRunId" | "requestId">
    | Omit<AgentQuestionResponse, "expectedRunId" | "requestId">,
  includeMessage = true,
): Promise<void> {
  const before = events.filter((event) => event.type === "interaction_requested").length;
  client.emitRequest({
    id,
    method,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      ...(includeMessage ? { reason: "reason", message: "message" } : {}),
    },
  });
  await vi.waitFor(() =>
    expect(events.filter((event) => event.type === "interaction_requested")).toHaveLength(before + 1),
  );
  await runtime.respond({
    ...response,
    expectedRunId: "interactions",
    requestId: `number:${id}`,
  } as AgentInteractionResponse);
}

async function temporaryDirectory(prefix: string): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  if (!resolveValue || !rejectValue) throw new Error("could not create deferred promise");
  return { promise, resolve: resolveValue, reject: rejectValue };
}
