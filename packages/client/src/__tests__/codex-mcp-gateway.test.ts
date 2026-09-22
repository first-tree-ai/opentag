import { describe, expect, it, vi } from "vitest";
import type { CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";
import type {
  CodexAppServerMessage,
  CodexAppServerRequest,
  InteractiveCodexAppServerClient,
} from "../providers/codex/app-server-wire.js";
import type { CodexMcpGatewayEndpoint, CodexMcpGatewayRelay } from "../providers/codex/mcp-gateway-relay.js";

const GATEWAY: CodexMcpGatewayEndpoint = { url: "https://server.example.test/api/v1/mcp", token: "otmg_secret" };
const THREAD_ID = "thread-1";

type ReloadBehavior = (client: ScriptedCodexClient) => Promise<unknown>;

/** Answers the App Server requests a Codex runtime makes, completing every turn immediately. */
class ScriptedCodexClient implements InteractiveCodexAppServerClient {
  readonly methods: string[] = [];
  readonly #notifications = new Set<(message: CodexAppServerMessage) => void>();
  #turn = 0;
  reload: ReloadBehavior = async (client) => {
    client.status("ready");
    return {};
  };
  closeError?: Error;

  constructor(private readonly relay: RecordingRelay) {}

  async initialize(): Promise<void> {}

  async request(method: string): Promise<unknown> {
    this.methods.push(method);
    if (method === "thread/start") return { thread: { id: THREAD_ID } };
    if (method === "config/mcpServer/reload") {
      this.relay.events.push(`reload:${this.relay.upstream ? "attached" : "detached"}`);
      return this.reload(this);
    }
    if (method !== "turn/start") throw new Error(`unexpected request: ${method}`);
    this.#turn += 1;
    const id = `turn-${this.#turn}`;
    this.relay.events.push(`turn:${this.relay.upstream ? "attached" : "detached"}`);
    setImmediate(() =>
      this.emit({
        method: "turn/completed",
        params: { threadId: THREAD_ID, turn: { id, status: "completed", items: [] } },
      }),
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

  async close(): Promise<void> {
    if (this.closeError) throw this.closeError;
  }

  emit(message: CodexAppServerMessage): void {
    for (const listener of this.#notifications) listener(message);
  }

  status(status: unknown, overrides: Record<string, unknown> = {}): void {
    this.emit({
      method: "mcpServer/startupStatus/updated",
      params: { threadId: THREAD_ID, name: "opentag-mcp", status, ...overrides },
    });
  }
}

class RecordingRelay implements CodexMcpGatewayRelay {
  readonly url = "http://127.0.0.1:4100/mcp";
  readonly token = "relay-token";
  readonly events: string[] = [];
  upstream: CodexMcpGatewayEndpoint | undefined;
  closed = 0;

  setUpstream(endpoint: CodexMcpGatewayEndpoint | undefined): void {
    this.upstream = endpoint;
    this.events.push(endpoint ? `attach:${endpoint.token}` : "detach");
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

function setup(options: { mcpReloadTimeoutMs?: number; createClientError?: Error } = {}) {
  const relay = new RecordingRelay();
  const client = new ScriptedCodexClient(relay);
  const factory = new CodexAgentRuntimeFactory({
    clientVersion: "0.0.1-test",
    createClient: () => {
      if (options.createClientError) throw options.createClientError;
      return client;
    },
    startMcpRelay: async () => relay,
    ...(options.mcpReloadTimeoutMs ? { mcpReloadTimeoutMs: options.mcpReloadTimeoutMs } : {}),
    probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "test" }),
  });
  return { relay, client, factory };
}

function createRequest(configuration?: CreateAgentRuntimeRequest["configuration"]): CreateAgentRuntimeRequest {
  return {
    eventSink: () => undefined,
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

function prompt(runId: string, mcpGateway?: CodexMcpGatewayEndpoint) {
  return {
    runId,
    input: { items: [{ type: "text" as const, text: "hello" }] },
    ...(mcpGateway ? { configuration: { provider: { mcpGateway: { ...mcpGateway } } } } : {}),
  };
}

describe("Codex MCP gateway delivery", () => {
  it("attaches the run's gateway, reloads Codex before the turn, and detaches it afterwards", async () => {
    const { relay, client, factory } = setup();
    client.reload = async (scripted) => {
      // Only the gateway server's settled status for this thread may end the wait.
      scripted.emit({ method: "turn/plan/updated", params: {} });
      scripted.status("ready", { name: "other-server" });
      scripted.status("ready", { threadId: "thread-other" });
      scripted.status("starting");
      scripted.status(7);
      scripted.emit({ method: "mcpServer/startupStatus/updated" });
      setImmediate(() => scripted.status("ready"));
      return {};
    };
    const runtime = await factory.create(createRequest());

    await expect(runtime.prompt(prompt("first", GATEWAY))).resolves.toMatchObject({ status: "completed" });
    expect(relay.events).toEqual(["attach:otmg_secret", "reload:attached", "turn:attached", "detach"]);

    // Codex still holds the gateway catalogue, so a run without a gateway reloads to drop it.
    relay.events.length = 0;
    await expect(runtime.prompt(prompt("second"))).resolves.toMatchObject({ status: "completed" });
    expect(relay.events).toEqual(["detach", "reload:detached", "turn:detached", "detach"]);

    // Nothing to refresh once Codex already holds the detached, empty catalogue.
    relay.events.length = 0;
    await expect(runtime.prompt(prompt("third"))).resolves.toMatchObject({ status: "completed" });
    expect(relay.events).toEqual(["detach", "turn:detached", "detach"]);

    await runtime.close();
    expect(relay.closed).toBe(1);
  });

  it("never reloads a Session that has not seen a gateway", async () => {
    const { relay, client, factory } = setup();
    const runtime = await factory.create(createRequest());
    await runtime.prompt(prompt("plain"));
    expect(client.methods).not.toContain("config/mcpServer/reload");
    expect(relay.events).toEqual(["detach", "turn:detached", "detach"]);
    await runtime.close();
  });

  it.each([
    ["a failed reconnect", (client: ScriptedCodexClient) => client.status("failed", { error: "handshake failed" })],
    ["a failed reconnect without detail", (client: ScriptedCodexClient) => client.status("failed")],
  ])("keeps the turn alive through %s and reloads again on the next run", async (_label, report) => {
    const { relay, client, factory } = setup();
    client.reload = async (scripted) => {
      setImmediate(() => report(scripted));
      return {};
    };
    const runtime = await factory.create(createRequest());
    await expect(runtime.prompt(prompt("failed", GATEWAY))).resolves.toMatchObject({ status: "completed" });

    client.reload = async (scripted) => {
      setImmediate(() => scripted.status("failed"));
      return {};
    };
    relay.events.length = 0;
    await runtime.prompt(prompt("after-failure"));
    expect(relay.events).toEqual(["detach", "reload:detached", "turn:detached", "detach"]);

    // An unconfirmed detach may still have left the gateway catalogue behind.
    relay.events.length = 0;
    await runtime.prompt(prompt("after-unconfirmed-detach"));
    expect(relay.events).toContain("reload:detached");
    await runtime.close();
  });

  it("stops waiting for a reconnect that never settles", async () => {
    const { relay, client, factory } = setup({ mcpReloadTimeoutMs: 5 });
    client.reload = async () => ({});
    const runtime = await factory.create(createRequest());
    await expect(runtime.prompt(prompt("timeout", GATEWAY))).resolves.toMatchObject({ status: "completed" });
    expect(relay.events).toEqual(["attach:otmg_secret", "reload:attached", "turn:attached", "detach"]);
    await runtime.close();
  });

  it("keeps the turn alive when Codex rejects the reload request", async () => {
    const { client, factory } = setup();
    client.reload = async () => {
      throw new Error("method not found");
    };
    const runtime = await factory.create(createRequest());
    await expect(runtime.prompt(prompt("rejected", GATEWAY))).resolves.toMatchObject({ status: "completed" });
    expect(client.methods).toContain("turn/start");
    await runtime.close();
  });

  it("does not start the turn when the runtime closes during the reload", async () => {
    const { relay, client, factory } = setup();
    const runtime = await factory.create(createRequest());
    let closing: Promise<void> | undefined;
    client.reload = async () => {
      closing = runtime.close();
      throw new Error("Codex request was aborted");
    };
    const result = await runtime.prompt(prompt("closed", GATEWAY)).catch((error: unknown) => error);
    await closing;
    expect(result).not.toMatchObject({ status: "completed" });
    expect(client.methods).not.toContain("turn/start");
    expect(relay.upstream).toBeUndefined();
    expect(relay.closed).toBe(1);
  });

  it("accepts a gateway carried by the Session configuration", async () => {
    const { relay, factory } = setup();
    const runtime = await factory.create(createRequest({ provider: { mcpGateway: { ...GATEWAY } } }));
    await runtime.prompt(prompt("session-config"));
    expect(relay.events[0]).toBe("attach:otmg_secret");
    await runtime.close();
  });

  it.each([
    ["a non-object", "not-an-object"],
    ["a missing token", { url: GATEWAY.url }],
    ["an empty token", { url: GATEWAY.url, token: "" }],
    ["a relative url", { url: "/api/v1/mcp", token: "t" }],
    ["a non-http url", { url: "file:///etc/passwd", token: "t" }],
  ])("rejects a gateway descriptor with %s", async (_label, mcpGateway) => {
    const { relay, factory } = setup();
    await expect(factory.create(createRequest({ provider: { mcpGateway } }))).rejects.toMatchObject({
      code: "configuration_invalid",
    });
    expect(relay.closed).toBe(0);
  });

  it("closes the relay when the App Server cannot be created or started", async () => {
    const failing = setup({ createClientError: new Error("spawn failed") });
    await expect(failing.factory.create(createRequest())).rejects.toThrow("spawn failed");
    expect(failing.relay.closed).toBe(1);

    const { relay, client, factory } = setup();
    client.initialize = async () => {
      throw new Error("initialize failed");
    };
    await expect(factory.create(createRequest())).rejects.toMatchObject({ code: "create_failed" });
    expect(relay.closed).toBe(1);
  });

  it("closes the relay even when the App Server fails to close", async () => {
    const { relay, client, factory } = setup();
    const runtime = await factory.create(createRequest());
    client.closeError = new Error("close failed");
    await runtime.close().catch(() => undefined);
    expect(relay.closed).toBe(1);
  });

  it("reports only the gateway's own reconnect as settled", async () => {
    const { client, factory } = setup({ mcpReloadTimeoutMs: 50 });
    const settledAt: number[] = [];
    client.reload = async (scripted) => {
      scripted.status("ready", { name: "opentag" });
      setTimeout(() => {
        settledAt.push(Date.now());
        scripted.status("ready");
      }, 10);
      return {};
    };
    const runtime = await factory.create(createRequest());
    const startedAt = Date.now();
    await runtime.prompt(prompt("settle", GATEWAY));
    expect(settledAt).toHaveLength(1);
    expect(settledAt[0]).toBeGreaterThanOrEqual(startedAt);
    await runtime.close();
  });
});

vi.setConfig({ testTimeout: 10_000 });
