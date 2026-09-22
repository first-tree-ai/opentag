import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";
import type {
  CodexAppServerMessage,
  CodexAppServerRequest,
  InteractiveCodexAppServerClient,
} from "../providers/codex/app-server-wire.js";

vi.setConfig({ testTimeout: 10_000 });

const GATEWAY = { url: "https://server.example.test/api/v1/mcp", token: "otmg_secret" };
const ATTACHED_CONFIG = {
  mcp_servers: {
    "opentag-mcp": {
      url: GATEWAY.url,
      http_headers: { Authorization: "Bearer otmg_secret" },
      default_tools_approval_mode: "approve",
      startup_timeout_sec: 10,
    },
  },
};
const DETACHED_CONFIG = { mcp_servers: {} };
const THREAD_PARAMS = {
  cwd: "/workspace",
  developerInstructions: "OpenTag managed system prompt",
  approvalPolicy: "never",
  sandbox: "workspace-write",
  serviceName: "OpenTag",
};

type Handler = (params: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<unknown>;

/**
 * Answers the App Server requests a Codex runtime makes, completing every turn immediately.
 *
 * `events` records `start`, `start:attached`, `start:detached`, `unsubscribe:<thread>`,
 * `resume:attached`, `resume:detached`, and `turn:<thread>` in request order.
 */
class ScriptedCodexClient implements InteractiveCodexAppServerClient {
  readonly events: string[] = [];
  readonly params: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly #notifications = new Set<(message: CodexAppServerMessage) => void>();
  #threads = 0;
  #turn = 0;
  start: Handler = async () => {
    this.#threads += 1;
    return { thread: { id: `thread-${this.#threads}` } };
  };
  resume: Handler = async (params) => ({ thread: { id: params.threadId } });
  unsubscribe: Handler = async () => ({ status: "unsubscribed" });

  async initialize(): Promise<void> {}

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = params as Record<string, unknown>;
    this.params.push({ method, params: record });
    if (method === "thread/start") {
      this.events.push(record.config ? `start:${mcpState(record)}` : "start");
      return this.start(record, signal);
    }
    if (method === "thread/unsubscribe") {
      this.events.push(`unsubscribe:${record.threadId}`);
      return this.unsubscribe(record, signal);
    }
    if (method === "thread/resume") {
      this.events.push(record.config ? `resume:${mcpState(record)}` : "resume");
      return this.resume(record, signal);
    }
    if (method !== "turn/start") throw new Error(`unexpected request: ${method}`);
    this.#turn += 1;
    const id = `turn-${this.#turn}`;
    const threadId = record.threadId;
    this.events.push(`turn:${threadId}`);
    setImmediate(() =>
      this.emit({ method: "turn/completed", params: { threadId, turn: { id, status: "completed", items: [] } } }),
    );
    return { turn: { id, status: "inProgress", items: [] } };
  }

  async notify(): Promise<void> {}

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  subscribeServerRequests(_listener: (request: CodexAppServerRequest) => void): () => void {
    return () => undefined;
  }

  async respondServerRequest(): Promise<void> {}

  async rejectServerRequest(): Promise<void> {}

  async interrupt(): Promise<void> {}

  setDynamicToolHandler(): void {}

  async close(): Promise<void> {}

  emit(message: CodexAppServerMessage): void {
    for (const listener of this.#notifications) listener(message);
  }

  last(method: string): Record<string, unknown> | undefined {
    return this.params.filter((entry) => entry.method === method).at(-1)?.params;
  }
}

function mcpState(params: Record<string, unknown>): "attached" | "detached" {
  return Object.keys((params.config as { mcp_servers: object }).mcp_servers).length > 0 ? "attached" : "detached";
}

/** A request that settles only when its signal aborts, like the App Server wire does. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("Codex request was aborted")), { once: true });
  });
}

function setup(options: { mcpAttachTimeoutMs?: number } = {}) {
  const client = new ScriptedCodexClient();
  const factory = new CodexAgentRuntimeFactory({
    clientVersion: "0.0.1-test",
    createClient: () => client,
    ...(options.mcpAttachTimeoutMs ? { mcpAttachTimeoutMs: options.mcpAttachTimeoutMs } : {}),
    probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "test" }),
  });
  return { client, factory };
}

function createRequest(
  events: AgentRuntimeEvent[] = [],
  configuration?: CreateAgentRuntimeRequest["configuration"],
): CreateAgentRuntimeRequest {
  return {
    eventSink: (event) => {
      events.push(event);
    },
    systemPrompt: "OpenTag managed system prompt",
    workspace: { cwd: "/workspace" },
    policy: {
      fileSystem: "workspace-write",
      network: "disabled",
      approvals: "never",
      tools: { mode: "provider-default" },
    },
    ...(configuration ? { configuration } : {}),
  };
}

function prompt(runId: string, withGateway = false) {
  return {
    runId,
    input: { items: [{ type: "text" as const, text: "hello" }] },
    ...(withGateway ? { configuration: { provider: { mcpGateway: { ...GATEWAY } } } } : {}),
  };
}

/** A runtime whose thread has already started a turn, so Codex has persisted it. */
async function persistedRuntime(options: { mcpAttachTimeoutMs?: number } = {}) {
  const { client, factory } = setup(options);
  const runtime = await factory.create(createRequest());
  await runtime.prompt(prompt("warmup"));
  client.events.length = 0;
  return { client, runtime };
}

describe("Codex MCP gateway delivery", () => {
  it("replaces a thread that has no rollout yet, moving the binding to the new thread", async () => {
    const { client, factory } = setup();
    const events: AgentRuntimeEvent[] = [];
    const runtime = await factory.create({
      ...createRequest(events),
      hostedTools: {
        definitions: [{ name: "example_tool", inputSchema: { type: "object", properties: {} } }],
        handler: async () => ({ success: true, content: [] }),
      },
    });
    expect(runtime.binding?.payload).toMatchObject({ threadId: "thread-1" });

    await expect(runtime.prompt(prompt("first", true))).resolves.toMatchObject({ status: "completed" });
    expect(client.events).toEqual(["start", "start:attached", "unsubscribe:thread-1", "turn:thread-2"]);
    // The replacement keeps the thread's launch parameters and hosted tools; only MCP changes.
    expect(client.last("thread/start")).toMatchObject({
      ...THREAD_PARAMS,
      ephemeral: false,
      dynamicTools: [expect.objectContaining({ name: "example_tool" })],
      config: ATTACHED_CONFIG,
    });
    expect(runtime.binding?.payload).toMatchObject({ threadId: "thread-2", hostedToolsHash: expect.any(String) });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "binding_changed", runId: "first", binding: runtime.binding }),
    );
    await runtime.close();
  });

  it("reloads a persisted thread with each run's gateway, and with none once a run has no gateway", async () => {
    const { client, runtime } = await persistedRuntime();

    await expect(runtime.prompt(prompt("first", true))).resolves.toMatchObject({ status: "completed" });
    expect(client.events).toEqual(["unsubscribe:thread-1", "resume:attached", "turn:thread-1"]);
    expect(client.last("thread/resume")).toEqual({
      ...THREAD_PARAMS,
      threadId: "thread-1",
      excludeTurns: true,
      config: ATTACHED_CONFIG,
    });

    // The next execution brings its own bearer.
    client.events.length = 0;
    await runtime.prompt(prompt("second", true));
    expect(client.events).toEqual(["unsubscribe:thread-1", "resume:attached", "turn:thread-1"]);

    // A run without a gateway drops the previous catalogue once.
    client.events.length = 0;
    await runtime.prompt(prompt("third"));
    expect(client.events).toEqual(["unsubscribe:thread-1", "resume:detached", "turn:thread-1"]);
    expect(client.last("thread/resume")?.config).toEqual(DETACHED_CONFIG);

    client.events.length = 0;
    await runtime.prompt(prompt("fourth"));
    expect(client.events).toEqual(["turn:thread-1"]);
    await runtime.close();
  });

  it("treats a resumed binding as persisted", async () => {
    const { client, factory } = setup();
    const created = await factory.create(createRequest());
    const binding = created.binding;
    await created.close();
    if (!binding) throw new Error("no binding");
    const runtime = await factory.resume({ ...createRequest(), binding });
    client.events.length = 0;
    await runtime.prompt(prompt("resumed", true));
    expect(client.events).toEqual(["unsubscribe:thread-1", "resume:attached", "turn:thread-1"]);
    await runtime.close();
  });

  it("never rebinds a Session that has not seen a gateway", async () => {
    const { client, factory } = setup();
    const runtime = await factory.create(createRequest());
    await runtime.prompt(prompt("plain"));
    await runtime.prompt(prompt("plain-again"));
    expect(client.events).toEqual(["start", "turn:thread-1", "turn:thread-1"]);
    await runtime.close();
  });

  it.each([
    ["Codex rejects the resume", async () => Promise.reject(new Error("resume failed"))],
    ["Codex resumes another thread", async () => ({ thread: { id: "thread-other" } })],
    ["Codex returns no thread", async () => ({})],
  ])("restores a persisted thread without MCP when %s, and still runs the turn", async (_label, failure) => {
    const { client, runtime } = await persistedRuntime();
    client.resume = async (params) =>
      mcpState(params) === "attached" ? failure() : { thread: { id: params.threadId } };

    await expect(runtime.prompt(prompt("failed-attach", true))).resolves.toMatchObject({ status: "completed" });
    expect(client.events).toEqual([
      "unsubscribe:thread-1",
      "resume:attached",
      "unsubscribe:thread-1",
      "resume:detached",
      "turn:thread-1",
    ]);

    // The restore left no gateway behind, so a run without one has nothing to drop.
    client.events.length = 0;
    await runtime.prompt(prompt("after"));
    expect(client.events).toEqual(["turn:thread-1"]);
    await runtime.close();
  });

  it.each([
    ["Codex rejects the start", async () => Promise.reject(new Error("start failed"))],
    ["Codex returns no thread", async () => ({})],
    ["Codex returns no thread id", async () => ({ thread: {} })],
    ["Codex returns an invalid response", async () => null],
  ])("keeps an unpersisted thread untouched when %s", async (_label, failure) => {
    const { client, factory } = setup();
    const runtime = await factory.create(createRequest());
    client.start = failure;
    client.events.length = 0;
    await expect(runtime.prompt(prompt("fresh-failure", true))).resolves.toMatchObject({ status: "completed" });
    expect(client.events).toEqual(["start:attached", "turn:thread-1"]);
    expect(runtime.binding?.payload).toMatchObject({ threadId: "thread-1" });

    // The thread never held a gateway, so the next run has nothing to drop.
    client.events.length = 0;
    await runtime.prompt(prompt("after"));
    expect(client.events).toEqual(["turn:thread-1"]);
    await runtime.close();
  });

  it("keeps the replacement when the replaced thread cannot be unloaded", async () => {
    const { client, factory } = setup();
    const runtime = await factory.create(createRequest());
    client.unsubscribe = async () => {
      throw new Error("unsubscribe failed");
    };
    await expect(runtime.prompt(prompt("fresh", true))).resolves.toMatchObject({ status: "completed" });
    expect(client.events.at(-1)).toBe("turn:thread-2");
    await runtime.close();
  });

  it("bounds the whole rebind, including a resume request that never settles", async () => {
    const { client, runtime } = await persistedRuntime({ mcpAttachTimeoutMs: 20 });
    client.resume = async (params, signal) =>
      mcpState(params) === "attached" ? hangUntilAborted(signal) : { thread: { id: params.threadId } };

    const startedAt = Date.now();
    await expect(runtime.prompt(prompt("slow", true))).resolves.toMatchObject({ status: "completed" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(client.events).toEqual([
      "unsubscribe:thread-1",
      "resume:attached",
      "unsubscribe:thread-1",
      "resume:detached",
      "turn:thread-1",
    ]);
    await runtime.close();
  });

  it("fails the run when a persisted thread cannot be restored at all, and rebinds on the next run", async () => {
    const { client, runtime } = await persistedRuntime();
    client.resume = async () => {
      throw new Error("resume failed");
    };
    await expect(runtime.prompt(prompt("broken", true))).resolves.toMatchObject({
      status: "failed",
      error: { message: "resume failed" },
    });
    expect(client.events.some((event) => event.startsWith("turn:"))).toBe(false);

    // The thread may still be unloaded, so the next run rebinds before starting its turn.
    client.resume = async (params) => ({ thread: { id: params.threadId } });
    client.events.length = 0;
    await runtime.prompt(prompt("recovered"));
    expect(client.events).toEqual(["unsubscribe:thread-1", "resume:detached", "turn:thread-1"]);
    await runtime.close();
  });

  it("aborts a run during its MCP attach without waiting for a turn that never started", async () => {
    const { client, runtime } = await persistedRuntime();
    client.resume = async (_params, signal) => hangUntilAborted(signal);

    const run = runtime.prompt(prompt("aborted", true));
    await vi.waitFor(() => expect(client.events).toContain("resume:attached"));
    await runtime.abort({ expectedRunId: "aborted", reason: "user" });
    await expect(run).resolves.toMatchObject({ status: "aborted" });
    expect(client.events.some((event) => event.startsWith("turn:"))).toBe(false);

    // The interrupted rebind may have left the thread unloaded.
    client.resume = async (params) => ({ thread: { id: params.threadId } });
    client.events.length = 0;
    await runtime.prompt(prompt("after-abort"));
    expect(client.events).toEqual(["unsubscribe:thread-1", "resume:detached", "turn:thread-1"]);
    await runtime.close();
  });

  it("aborts a run whose attach completes just as it is cancelled", async () => {
    const { client, runtime } = await persistedRuntime();
    const holder: { runtime?: AgentRuntime } = { runtime };
    client.resume = async (params) => {
      await holder.runtime?.abort({ expectedRunId: "raced", reason: "user" });
      return { thread: { id: params.threadId } };
    };
    await expect(runtime.prompt(prompt("raced", true))).resolves.toMatchObject({ status: "aborted" });
    expect(client.events.some((event) => event.startsWith("turn:"))).toBe(false);
    await runtime.close();
  });

  it("aborts a run whose restore is cancelled", async () => {
    const { client, runtime } = await persistedRuntime();
    client.resume = async (params, signal) =>
      mcpState(params) === "attached" ? Promise.reject(new Error("resume failed")) : hangUntilAborted(signal);
    const run = runtime.prompt(prompt("restore-aborted", true));
    await vi.waitFor(() => expect(client.events).toContain("resume:detached"));
    await runtime.abort({ expectedRunId: "restore-aborted", reason: "user" });
    await expect(run).resolves.toMatchObject({ status: "aborted" });
    await runtime.close();
  });

  it("stops the attach when the runtime closes", async () => {
    const { client, runtime } = await persistedRuntime();
    client.unsubscribe = async (_params, signal) => hangUntilAborted(signal);
    const run = runtime.prompt(prompt("closing", true));
    await vi.waitFor(() => expect(client.events).toContain("unsubscribe:thread-1"));
    await runtime.close();
    await expect(run).resolves.toMatchObject({ status: "aborted" });
    expect(client.events.some((event) => event.startsWith("turn:"))).toBe(false);
  });

  it("accepts a gateway carried by the Session configuration", async () => {
    const { client, factory } = setup();
    const runtime = await factory.create(createRequest([], { provider: { mcpGateway: { ...GATEWAY } } }));
    await runtime.prompt(prompt("session-config"));
    expect(client.last("thread/start")?.config).toEqual(ATTACHED_CONFIG);
    await runtime.close();
  });

  it.each([
    ["a non-object", "not-an-object"],
    ["a missing token", { url: GATEWAY.url }],
    ["an empty token", { url: GATEWAY.url, token: "" }],
    ["a relative url", { url: "/api/v1/mcp", token: "t" }],
    ["a non-http url", { url: "file:///etc/passwd", token: "t" }],
  ])("rejects a gateway descriptor with %s", async (_label, mcpGateway) => {
    const { factory } = setup();
    await expect(factory.create(createRequest([], { provider: { mcpGateway } }))).rejects.toMatchObject({
      code: "configuration_invalid",
    });
  });
});
