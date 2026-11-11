import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import {
  CodexAgentRuntime,
  CodexAgentRuntimeFactory,
  codexAgentRuntimeEnvironment,
} from "../providers/codex/agent-runtime.js";
import type {
  CodexAppServerMessage,
  CodexAppServerRequest,
  InteractiveCodexAppServerClient,
} from "../providers/codex/app-server-wire.js";

describe("CodexAgentRuntime", () => {
  it("creates a persistent thread and maps one Codex turn to one Agent run", async () => {
    const client = new ScriptedCodexClient("complete");
    const events: AgentRuntimeEvent[] = [];
    const factory = codexFactory(client);
    const runtime = await factory.create(
      createRequest((event) => {
        events.push(event);
      }),
    );

    const result = await runtime.prompt({ runId: "run-1", input: input("hello") });

    expect(runtime).toBeInstanceOf(CodexAgentRuntime);
    expect(runtime.binding).toEqual({ providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-1" } });
    expect(result).toMatchObject({
      runId: "run-1",
      status: "completed",
      output: [{ type: "text", text: "final answer" }],
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
      providerDiagnostics: { providerThreadId: "thread-1", providerTurnId: "turn-1" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "binding_changed",
      "run_started",
      "message_started",
      "message_delta",
      "message_completed",
      "usage_updated",
      "run_completed",
    ]);
    expect(client.call("thread/start")?.params).toMatchObject({
      cwd: "/workspace",
      developerInstructions: "OpenTag managed system prompt",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-test",
    });
    expect(client.call("turn/start")?.params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace"],
        networkAccess: false,
      },
      model: "gpt-test",
      effort: "high",
    });
    await runtime.close();
  });

  it("injects a superseding developer message on resume when systemPromptUpdated is true", async () => {
    const unchangedClient = new ScriptedCodexClient("complete");
    const unchangedRuntime = await codexFactory(unchangedClient).resume({
      ...createRequest(() => undefined),
      binding: { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-1" } },
    });
    expect(unchangedClient.call("thread/inject_items")).toBeUndefined();
    await unchangedRuntime.close();

    const updatedClient = new ScriptedCodexClient("complete");
    const updatedRuntime = await codexFactory(updatedClient).resume({
      ...createRequest(() => undefined),
      systemPrompt: "Updated OpenTag managed system prompt",
      systemPromptUpdated: true,
      binding: { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-1" } },
    });
    expect(updatedClient.call("thread/inject_items")?.params).toEqual({
      threadId: "thread-1",
      items: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "Updated instructions (supersede all earlier developer instructions):\n\nUpdated OpenTag managed system prompt",
            },
          ],
        },
      ],
    });
    await updatedRuntime.close();
  });

  it("writes the exact managed CLI prefix even without user command allowances", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-codex-managed-cli-"));
    const invocation = ["/opt/current node/bin/node", "/opt/owner's app/cli/index.mjs"];
    const request = createRequest(() => undefined);
    const runtime = await codexFactory(new ScriptedCodexClient("complete")).create({
      ...request,
      workspace: { cwd: root },
      policy: { ...request.policy, managedCli: invocation },
    });
    try {
      const rules = await readFile(join(root, ".codex/rules/opentag.rules"), "utf8");
      expect(rules).toContain(`prefix_rule(pattern=${JSON.stringify(invocation)}, decision="allow")`);
      expect(rules).not.toContain(`pattern=${JSON.stringify([invocation[0]])}`);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes only the exact thread encoded by the binding", async () => {
    const client = new ScriptedCodexClient("complete");
    const factory = codexFactory(client);
    const runtime = await factory.resume({
      ...createRequest(() => undefined),
      binding: { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-exact" } },
    });

    expect(client.call("thread/resume")?.params).toMatchObject({
      threadId: "thread-exact",
      developerInstructions: "OpenTag managed system prompt",
      approvalPolicy: "on-request",
    });
    expect(client.call("thread/start")).toBeUndefined();
    expect(runtime.binding?.payload).toEqual({ threadId: "thread-exact" });
    await runtime.close();

    const wrongClient = new ScriptedCodexClient("complete", { resumeThreadId: "another-thread" });
    await expect(
      codexFactory(wrongClient).resume({
        ...createRequest(() => undefined),
        binding: { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-exact" } },
      }),
    ).rejects.toMatchObject({ code: "resume_failed" });
    expect(wrongClient.closed).toBe(true);
    expect(wrongClient.call("thread/start")).toBeUndefined();
  });

  describe("compactContext", () => {
    const BINDING = { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-1" } };

    function compactedThread(client: ScriptedCodexClient) {
      const events: AgentRuntimeEvent[] = [];
      const open = codexFactory(client).resume({
        ...createRequest((event) => {
          events.push(event);
        }),
        binding: BINDING,
      });
      return { events, open };
    }

    it("waits for the compaction Turn on the same thread before starting the Turn", async () => {
      const client = new ScriptedCodexClient("complete");
      client.compaction = "complete";
      const { events, open } = compactedThread(client);
      const runtime = await open;
      await expect(runtime.prompt({ runId: "run", input: input("work"), compactContext: true })).resolves.toMatchObject(
        { status: "completed", output: [{ type: "text", text: "final answer" }] },
      );
      const methods = client.calls.map((call) => call.method);
      expect(methods.indexOf("thread/compact/start")).toBeLessThan(methods.indexOf("turn/start"));
      expect(client.call("thread/compact/start")?.params).toEqual({ threadId: "thread-1" });
      expect(client.call("turn/start")?.params).toMatchObject({ threadId: "thread-1" });
      expect(client.call("thread/start")).toBeUndefined();
      expect(events.some((event) => event.type === "provider_warning")).toBe(false);
      await runtime.close();
    });

    it("does not compact without the request", async () => {
      const client = new ScriptedCodexClient("complete");
      const runtime = await compactedThread(client).open;
      await runtime.prompt({ runId: "run", input: input("work") });
      expect(client.call("thread/compact/start")).toBeUndefined();
      await runtime.close();
    });

    it("has nothing to compact on a thread with no Turn yet", async () => {
      const client = new ScriptedCodexClient("complete");
      const runtime = await codexFactory(client).create(createRequest(() => undefined));
      await runtime.prompt({ runId: "run", input: input("work"), compactContext: true });
      expect(client.call("thread/compact/start")).toBeUndefined();
      await runtime.close();
    });

    it.each([
      ["a failed compaction Turn", "failed" as const, "compaction broke"],
      ["a refused request", "refused" as const, "compaction refused"],
      ["a request that rejects with a non-Error", "refused-raw" as const, "Codex compaction failed"],
      ["an interrupted compaction Turn", "interrupted" as const, "Codex compaction ended as interrupted"],
    ])("warns and still runs after %s", async (_name, compaction, message) => {
      const client = new ScriptedCodexClient("complete");
      client.compaction = compaction;
      const { events, open } = compactedThread(client);
      const runtime = await open;
      await expect(runtime.prompt({ runId: "run", input: input("work"), compactContext: true })).resolves.toMatchObject(
        { status: "completed" },
      );
      expect(events).toContainEqual(expect.objectContaining({ code: "codex_compaction_failed", message }));
      await runtime.close();
    });

    it("interrupts the compaction Turn and never starts the Turn when aborted", async () => {
      const client = new ScriptedCodexClient("complete");
      client.compaction = "hold";
      const runtime = await compactedThread(client).open;
      const run = runtime.prompt({ runId: "run", input: input("work"), compactContext: true });
      await vi.waitFor(() => expect(client.call("thread/compact/start")).toBeDefined());
      await runtime.abort({ expectedRunId: "run" });
      await expect(run).resolves.toMatchObject({ status: "aborted" });
      expect(client.interrupts).toEqual([{ threadId: "thread-1", turnId: "compact-turn" }]);
      expect(client.call("turn/start")).toBeUndefined();
      await runtime.close();
    });

    it("warns and fails the Run when the App Server stops during compaction", async () => {
      const client = new ScriptedCodexClient("complete");
      client.compaction = "process-error";
      const { events, open } = compactedThread(client);
      const runtime = await open;
      await expect(runtime.prompt({ runId: "run", input: input("work"), compactContext: true })).resolves.toMatchObject(
        { status: "failed" },
      );
      expect(events).toContainEqual(
        expect.objectContaining({ code: "codex_compaction_failed", message: "Codex stopped during compaction" }),
      );
      await runtime.close();
    });

    it("aborts while the compaction request is unanswered, with no Turn to interrupt", async () => {
      const client = new ScriptedCodexClient("complete");
      client.compaction = "hold";
      client.compactAck = new Promise<void>(() => undefined);
      const runtime = await compactedThread(client).open;
      const run = runtime.prompt({ runId: "run", input: input("work"), compactContext: true });
      await vi.waitFor(() => expect(client.call("thread/compact/start")).toBeDefined());
      await runtime.abort({ expectedRunId: "run" });
      client.finishCompaction();
      await expect(run).resolves.toMatchObject({ status: "aborted" });
      expect(client.interrupts).toEqual([]);
      expect(client.call("turn/start")).toBeUndefined();
      await runtime.close();
    });

    it("interrupts a compaction Turn that starts after the abort, before the Run settles", async () => {
      const client = new ScriptedCodexClient("complete");
      client.compaction = "hold";
      client.compactAck = new Promise<void>(() => undefined);
      const runtime = await compactedThread(client).open;
      let settled = false;
      const run = runtime.prompt({ runId: "run", input: input("work"), compactContext: true }).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(client.call("thread/compact/start")).toBeDefined());
      await runtime.abort({ expectedRunId: "run" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      client.startCompaction();
      await expect(run).resolves.toMatchObject({ status: "aborted" });
      expect(client.interrupts).toEqual([{ threadId: "thread-1", turnId: "compact-turn" }]);
      expect(runtime.state.phase).toBe("idle");
      expect(client.closed).toBe(false);
      await runtime.close();
    });

    it("closes the runtime when the compaction Turn cannot be interrupted", async () => {
      const client = new ScriptedCodexClient("complete");
      client.compaction = "hold";
      client.interruptError = new Error("interrupt failed");
      const runtime = await compactedThread(client).open;
      const run = runtime.prompt({ runId: "run", input: input("work"), compactContext: true });
      await vi.waitFor(() => expect(client.call("thread/compact/start")).toBeDefined());
      await runtime.abort({ expectedRunId: "run" }).catch(() => undefined);
      await expect(run).resolves.toMatchObject({ output: [] });
      expect(client.call("turn/start")).toBeUndefined();
      await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
      expect(client.closed).toBe(true);
    });

    it("fails the Run when the Run deadline ends during compaction", async () => {
      const client = new ScriptedCodexClient("complete");
      client.compaction = "hold";
      const runtime = await compactedThread(client).open;
      const deadline = new AbortController();
      const run = runtime.prompt({ runId: "run", input: input("work"), compactContext: true, signal: deadline.signal });
      await vi.waitFor(() => expect(client.call("thread/compact/start")).toBeDefined());
      deadline.abort("turn_timeout");
      await expect(run).resolves.toMatchObject({ status: "aborted" });
      expect(client.call("turn/start")).toBeUndefined();
      await runtime.close();
    });
  });

  it("uses Codex expectedTurnId for same-run steer", async () => {
    const client = new ScriptedCodexClient("hold");
    const events: AgentRuntimeEvent[] = [];
    const runtime = await codexFactory(client).create(
      createRequest((event) => {
        events.push(event);
      }),
    );
    const run = runtime.prompt({ runId: "run-1", input: input("start") });
    await vi.waitFor(() => expect(client.call("turn/start")).toBeDefined());

    const receipt = await runtime.steer({ expectedRunId: "run-1", input: input("focus tests") });
    // The rollout holds the input once the App Server answers.
    await expect(receipt.inConversation).resolves.toBeUndefined();
    expect(client.call("turn/steer")?.params).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "focus tests" }],
    });
    expect(events.some((event) => event.type === "input_accepted")).toBe(true);

    client.complete();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    await runtime.close();
  });

  it("bridges a Codex approval through a reentrant interaction response", async () => {
    const client = new ScriptedCodexClient("interaction");
    const events: AgentRuntimeEvent[] = [];
    let runtime: CodexAgentRuntime;
    runtime = await codexFactory(client).create(
      createRequest(async (event) => {
        events.push(event);
        if (event.type === "interaction_requested") {
          await runtime.respond({
            kind: "approval",
            expectedRunId: event.runId,
            requestId: event.request.requestId,
            decision: "accept",
            scope: "runtime",
          });
        }
      }),
    );

    await expect(runtime.prompt({ runId: "run-1", input: input("run command") })).resolves.toMatchObject({
      status: "completed",
    });
    expect(client.serverResponses).toEqual([{ id: "approval-1", result: { decision: "acceptForSession" } }]);
    expect(events.map((event) => event.type)).toContain("interaction_requested");
    expect(events.map((event) => event.type)).toContain("interaction_resolved");
    await runtime.close();
  });

  it("settles aborted only when Codex completes the turn as interrupted", async () => {
    const client = new ScriptedCodexClient("hold");
    const runtime = await codexFactory(client).create(createRequest(() => undefined));
    const run = runtime.prompt({ runId: "run-1", input: input("long task") });
    await vi.waitFor(() => expect(client.call("turn/start")).toBeDefined());

    await runtime.abort({ expectedRunId: "run-1", reason: "stop" });

    await expect(run).resolves.toMatchObject({ status: "aborted", error: { code: "run_aborted" } });
    expect(client.interrupts).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
    await runtime.close();
  });

  it("reports a fatal provider failure as failed while closing the damaged runtime", async () => {
    const client = new ScriptedCodexClient("failure");
    const runtime = await codexFactory(client).create(createRequest(() => undefined));

    await expect(runtime.prompt({ runId: "run-1", input: input("fail") })).resolves.toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "process exited" },
    });
    await vi.waitFor(() => expect(runtime.state.phase).toBe("closed"));
    expect(client.closed).toBe(true);
  });

  it("cleans up and rejects when the initial binding event cannot be delivered", async () => {
    const client = new ScriptedCodexClient("complete");
    await expect(
      codexFactory(client).create(
        createRequest(() => {
          throw new Error("sink failed");
        }),
      ),
    ).rejects.toMatchObject({ code: "create_failed" });
    expect(client.closed).toBe(true);
  });

  it("probes local readiness without making a provider network request", async () => {
    const ready = new CodexAgentRuntimeFactory({
      clientVersion: "0.0.1",
      probeRunner: async () => ({
        appServer: true,
        credential: true,
        experimentalTools: true,
        version: "codex-cli 1.2.3",
      }),
    });
    await expect(ready.probe({})).resolves.toEqual({ ready: true, version: "codex-cli 1.2.3", issues: [] });

    const missingCredential = new CodexAgentRuntimeFactory({
      clientVersion: "0.0.1",
      probeRunner: async () => ({
        appServer: true,
        credential: false,
        experimentalTools: false,
        version: "codex-cli 1.2.3",
      }),
    });
    await expect(missingCredential.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "credential_missing" }],
    });
  });

  it("preserves native plugin variables and does not mutate the source environment", () => {
    const source = {
      HOME: "/home/provider",
      PATH: "/bin",
      CODEX_HOME: "/home/provider/.codex",
      PLUGIN_API_KEY: "fixture-plugin-key",
      CUSTOM_PLUGIN_OPTION: "fixture-option",
    };
    const environment = codexAgentRuntimeEnvironment(source);
    expect(environment).toEqual(source);
    expect(environment).not.toBe(source);
    environment.PLUGIN_API_KEY = "replacement";
    expect(source.PLUGIN_API_KEY).toBe("fixture-plugin-key");
  });
});

type Scenario = "complete" | "failure" | "hold" | "interaction";

class ScriptedCodexClient implements InteractiveCodexAppServerClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly serverResponses: Array<{ id: number | string; result: unknown }> = [];
  readonly #notifications = new Set<(message: CodexAppServerMessage) => void>();
  readonly #requests = new Set<(request: CodexAppServerRequest) => void>();
  readonly #scenario: Scenario;
  readonly #resumeThreadId?: string;
  closed = false;
  compaction?: "complete" | "failed" | "hold" | "interrupted" | "process-error" | "refused" | "refused-raw";
  interruptError?: Error;
  compactAck?: Promise<void>;

  constructor(scenario: Scenario, options: { resumeThreadId?: string } = {}) {
    this.#scenario = scenario;
    this.#resumeThreadId = options.resumeThreadId;
  }

  async initialize(clientVersion: string): Promise<void> {
    this.calls.push({ method: "initialize", params: { clientVersion } });
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "thread/resume") {
      const requested = (params as { threadId?: string }).threadId;
      return { thread: { id: this.#resumeThreadId ?? requested } };
    }
    if (method === "thread/inject_items") return {};
    if (method === "turn/steer") return { turnId: "turn-1" };
    if (method === "thread/compact/start") {
      if (this.compaction === "refused") throw new Error("compaction refused");
      if (this.compaction === "refused-raw") throw "refused";
      if (this.compactAck) {
        // Like the real App Server client, an abort cancels only this local waiter.
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
          void this.compactAck?.then(resolve);
        });
        return {};
      }
      this.#emitCompaction();
      return {};
    }
    if (method !== "turn/start") throw new Error(`unexpected Codex request: ${method}`);
    return this.#startTurn();
  }

  #startTurn(): { turn: ReturnType<typeof activeTurn> } {
    this.#emit({ method: "turn/started", params: { turn: activeTurn() } });
    if (this.#scenario === "complete") this.#emitCompleteMessages();
    if (this.#scenario === "failure") {
      this.#emit({ method: "opentag/processError", params: { error: new Error("process exited") } });
    }
    if (this.#scenario === "interaction") {
      this.#emit({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "command-1", type: "commandExecution", command: ["pnpm", "test"], status: "inProgress" },
        },
      });
      this.#emitRequest({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", reason: "Run tests" },
      });
    }
    return { turn: activeTurn() };
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

  async respondServerRequest(id: number | string, result: unknown): Promise<void> {
    this.serverResponses.push({ id, result });
    this.#emit({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: id } });
    this.#emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "command-1", type: "commandExecution", command: ["pnpm", "test"], status: "completed" },
      },
    });
    this.complete();
  }

  async rejectServerRequest(id: number | string, code: number, message: string): Promise<void> {
    this.serverResponses.push({ id, result: { error: { code, message } } });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
    if (this.interruptError) throw this.interruptError;
    if (turnId === "compact-turn") {
      this.#emit({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, items: [], status: "interrupted" } },
      });
      return;
    }
    this.#emit({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } },
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  call(method: string): { method: string; params: unknown } | undefined {
    return this.calls.find((call) => call.method === method);
  }

  complete(): void {
    this.#emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ id: "message-1", type: "agentMessage", phase: "final_answer", text: "final answer" }],
        },
      },
    });
  }

  #emitCompleteMessages(): void {
    this.#emit({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "message-1", type: "agentMessage", text: "" } },
    });
    this.#emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "final answer" },
    });
    this.#emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "message-1", type: "agentMessage", phase: "final_answer", text: "final answer" },
      },
    });
    this.#emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 } },
      },
    });
    this.complete();
  }

  startCompaction(): void {
    this.#emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "compact-turn", items: [], status: "inProgress" } },
    });
  }

  finishCompaction(): void {
    this.#emit({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "compact-turn", items: [], status: "interrupted" } },
    });
  }

  #emitCompaction(): void {
    const scope = { threadId: "thread-1", turnId: "compact-turn" };
    const turn = { id: "compact-turn", items: [] };
    this.#emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { ...turn, status: "inProgress" } },
    });
    this.#emit({ method: "item/started", params: { ...scope, item: { id: "c1", type: "contextCompaction" } } });
    if (this.compaction === "hold") return;
    if (this.compaction === "process-error") {
      this.#emit({ method: "opentag/processError", params: { error: new Error("process exited") } });
      return;
    }
    this.#emit({ method: "thread/tokenUsage/updated", params: { ...scope, tokenUsage: { last: { inputTokens: 9 } } } });
    this.#emit({ method: "item/completed", params: { ...scope, item: { id: "c1", type: "contextCompaction" } } });
    this.#emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn:
          this.compaction === "failed"
            ? { ...turn, status: "failed", error: { message: "compaction broke" } }
            : { ...turn, status: this.compaction === "interrupted" ? "interrupted" : "completed" },
      },
    });
  }

  #emit(message: CodexAppServerMessage): void {
    for (const listener of this.#notifications) listener(message);
  }

  #emitRequest(request: CodexAppServerRequest): void {
    for (const listener of this.#requests) listener(request);
  }
}

function codexFactory(client: ScriptedCodexClient): CodexAgentRuntimeFactory {
  return new CodexAgentRuntimeFactory({
    clientVersion: "0.0.1",
    createClient: () => client,
    probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "test" }),
  });
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
    configuration: { model: "gpt-test", reasoningEffort: "high" },
  };
}

function input(text: string) {
  return { items: [{ type: "text" as const, text }] };
}

function activeTurn() {
  return { id: "turn-1", status: "inProgress", items: [] };
}
