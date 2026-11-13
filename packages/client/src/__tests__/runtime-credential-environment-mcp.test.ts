import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  RuntimeExecutionCloseRequestSchema,
  RuntimeExecutionOpenRequestSchema,
  type RuntimeExecutionSource,
  RuntimeMcpGatewayRequestSchema,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import { RuntimeCredentialEnvironmentManager } from "../runtime/runtime-credential-environment-manager.js";
import {
  RUNTIME_CREDENTIAL_CAPABILITY,
  RUNTIME_MCP_GATEWAY_CAPABILITY,
  RUNTIME_PROVIDER_PROXY_CAPABILITY,
} from "../runtime/runtime-credential-frames.js";

const mocks = vi.hoisted(() => ({
  relayOpen: vi.fn(),
  openServices: vi.fn(),
  adapterStart: vi.fn(),
  realOpenServices: undefined as
    | typeof import("../runtime/runtime-credential-relay.js").RuntimeCredentialRelay.openServices
    | undefined,
}));

vi.mock("../runtime/runtime-credential-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/runtime-credential-relay.js")>();
  mocks.realOpenServices = actual.RuntimeCredentialRelay.openServices;
  return {
    ...actual,
    RuntimeCredentialRelay: {
      open: (...args: unknown[]) => mocks.relayOpen(...args),
      openServices: (...args: Parameters<typeof actual.RuntimeCredentialRelay.openServices>) =>
        mocks.openServices(...args),
    },
  };
});

vi.mock("../runtime/runtime-proxy-loopback-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/runtime-proxy-loopback-adapter.js")>();
  return {
    ...actual,
    RuntimeProxyLoopbackAdapter: { start: (...args: unknown[]) => mocks.adapterStart(...args) },
  };
});

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  vi.clearAllMocks();
});

function fakeConnection(mcpNegotiated = true) {
  const businessListeners = new Set<(frame: Record<string, unknown>) => void>();
  const connection = {
    capabilityVersion: (capability: string): number | undefined => {
      if (capability === RUNTIME_CREDENTIAL_CAPABILITY || capability === RUNTIME_PROVIDER_PROXY_CAPABILITY) return 1;
      if (capability === RUNTIME_MCP_GATEWAY_CAPABILITY) return mcpNegotiated ? 1 : undefined;
      return undefined;
    },
    send: vi.fn(async (frame: Record<string, unknown>) => {
      if (frame.type === "runtime:execution:open") {
        const parsed = RuntimeExecutionOpenRequestSchema.parse(frame);
        queueMicrotask(() => {
          for (const listener of businessListeners) {
            listener({
              type: "runtime:execution:result",
              requestId: parsed.requestId,
              status: "succeeded",
              executionId: "11111111-1111-4111-8111-111111111111",
              expiresAt: "2026-01-01T00:00:00.000Z",
              providers: [],
              services: [{ service: "mcp", scopes: ["mcp:tools"] }],
            });
          }
        });
      } else if (frame.type === "runtime:mcp:gateway") {
        const parsed = RuntimeMcpGatewayRequestSchema.parse(frame);
        queueMicrotask(() => {
          for (const listener of businessListeners) {
            listener({
              type: "runtime:mcp:gateway:result",
              requestId: parsed.requestId,
              status: "succeeded",
              executionId: parsed.executionId,
              token: `{{SECRET_bdtyfqlv}}after_restart_${"a".repeat(32)}`,
              expiresAt: "2026-01-01T00:00:00.000Z",
              path: "/api/v1/mcp",
            });
          }
        });
      } else if (frame.type === "runtime:execution:close") {
        const parsed = RuntimeExecutionCloseRequestSchema.parse(frame);
        queueMicrotask(() => {
          for (const listener of businessListeners) {
            listener({
              type: "runtime:execution:closed",
              requestId: parsed.requestId,
              executionId: parsed.executionId,
              status: "succeeded",
            });
          }
        });
      }
    }),
    subscribeBusinessFrames: vi.fn((listener: (frame: Record<string, unknown>) => void) => {
      businessListeners.add(listener);
      return () => {
        businessListeners.delete(listener);
      };
    }),
    subscribeState: vi.fn(() => () => undefined),
  };
  return connection;
}

function fakeRelay(executionId: string, acquire: () => Promise<{ token: string; expiresAt: string } | undefined>) {
  const abort = new AbortController();
  return {
    executionId,
    providers: [{ provider: "slack" }],
    services: [{ service: "mcp" as const, scopes: ["mcp:tools" as const] }],
    signal: abort.signal,
    localHandleFor: () => "local-handle",
    cliMetadataFor: () => ({}),
    openProviderStream: async () => ({}) as never,
    verifyLocalHandle: () => true,
    acquireMcpGatewayToken: vi.fn(acquire),
    close: vi.fn(async () => undefined),
    abort,
  };
}

function request(sessionId: string) {
  return {
    agentId: "agent-1",
    placementGeneration: 1,
    sessionId,
    run: {
      runId: `run-${sessionId}`,
      source: { kind: "delivery", deliveryId: "delivery-1", turnId: "turn-1" } as RuntimeExecutionSource,
    },
  };
}

async function manager(
  home: string,
  mcpNegotiated = true,
  mcpGatewayFetch?: typeof fetch,
): Promise<RuntimeCredentialEnvironmentManager> {
  return new RuntimeCredentialEnvironmentManager({
    connection: fakeConnection(mcpNegotiated),
    home,
    ...(mcpGatewayFetch ? { mcpGatewayFetch } : {}),
    mode: "proxy",
    platform: "darwin",
    serverUrl: "https://server.example.test",
  });
}

async function prepareWith(
  home: string,
  relay: ReturnType<typeof fakeRelay>,
  mcpNegotiated = true,
): Promise<Awaited<ReturnType<RuntimeCredentialEnvironmentManager["prepare"]>>> {
  const credentials = await manager(home, mcpNegotiated);
  try {
    mocks.relayOpen.mockResolvedValueOnce(relay);
    mocks.adapterStart.mockImplementationOnce(async () => ({
      caCertPath: join(home, "fake-ca.pem"),
      connectProxyUrl: "http://127.0.0.1:0",
      slackApiHost: undefined,
      close: vi.fn(async () => undefined),
    }));
    return await credentials.prepare(request("session-1"));
  } finally {
    await credentials.close();
  }
}

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opentag-mcp-manager-"));
  homes.push(directory);
  return directory;
}

describe("MCP gateway preparation", () => {
  it("prepares a service-only internal execution without an IM provider or outbox", async () => {
    const relay = fakeRelay("exec-internal", async () => ({
      token: "otmg_internal_fixture",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }));
    relay.providers = [];
    const prepared = await prepareWith(await home(), relay);
    expect(prepared.providers).toEqual([]);
    expect(prepared.provider).toBeUndefined();
    expect(prepared.outboxContext).toBeUndefined();
    expect(prepared.mcp?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/mcp$/);
    expect(prepared.mcp?.token).toMatch(/^otmg_local_[A-Za-z0-9_-]+$/);
  });

  it("produces an MCP gateway descriptor accepted by both PiAgentRuntimeFactory and the Pi MCP extension", async () => {
    const relay = fakeRelay("exec-pi-compat", async () => ({
      token: "otmg_upstream_pi_compat",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }));
    const workspace = await home();
    const credentials = await manager(workspace, true);
    try {
      mocks.relayOpen.mockResolvedValueOnce(relay);
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: join(workspace, "fake-ca.pem"),
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const prepared = await credentials.prepare(request("session-pi"));
      expect(prepared.mcp).toBeDefined();

      const adapterEntry = join(workspace, "adapter.mjs");
      await writeFile(
        adapterEntry,
        `
        export function registerMcpServer({ pi, name, definition }) {
          pi.events.emit("registered", { name, definition });
          return { dispose: async () => undefined };
        }
        export function createMcpAdapter({ config }) {
          return (pi) => pi.events.emit("installed", config);
        }
      `,
      );
      const factory = new PiAgentRuntimeFactory({
        mcpAdapterEntry: adapterEntry,
        createSessionId: () => "11111111-1111-4111-8111-111111111111",
        createClient: () => ({
          request: async () => ({}),
          subscribe: () => () => undefined,
          close: async () => undefined,
        }),
        probeRunner: async () => ({ credential: true, rpc: true, version: "fixture" }),
      });
      const probeResult = await factory.probe({
        configuration: { provider: { mcpGateway: prepared.mcp } },
      });
      expect(probeResult).toEqual({ ready: true, version: "fixture", issues: [] });
      const runtime = await factory.create({
        eventSink: () => undefined,
        systemPrompt: "OpenTag managed system prompt",
        workspace: { cwd: workspace },
        policy: {
          fileSystem: "read-only",
          network: "disabled",
          approvals: "never",
          tools: { mode: "provider-default" },
        },
        configuration: { provider: { mcpGateway: prepared.mcp } },
      });
      await runtime.close();

      vi.stubEnv("OPENTAG_PI_NATIVE_RESOURCES", "0");
      vi.stubEnv("OPENTAG_MCP_GATEWAY_URL", prepared.mcp?.url ?? "");
      vi.stubEnv("OPENTAG_MCP_GATEWAY_TOKEN", prepared.mcp?.token ?? "");
      vi.stubEnv("OPENTAG_PI_MCP_ADAPTER_ENTRY", adapterEntry);
      const emit = vi.fn();
      const { default: mcpGatewayExtension } = await import("../pi-extensions/mcp-gateway.js");
      mcpGatewayExtension({
        on: () => undefined,
        registerTool: () => undefined,
        getAllTools: () => [],
        getCommands: () => [],
        events: { emit },
      } as unknown as ExtensionAPI);
      expect(emit).toHaveBeenCalledWith(
        "installed",
        expect.objectContaining({
          mcpServers: {
            "opentag-mcp": expect.objectContaining({
              url: prepared.mcp?.url,
              bearerToken: prepared.mcp?.token,
            }),
          },
        }),
      );
    } finally {
      await credentials.close();
    }
  });

  it("composes the endpoint against the pinned Server origin, not anything the Server said", async () => {
    const relay = fakeRelay("exec-mcp", async () => ({ token: "otmg_abc", expiresAt: "2026-01-01T00:00:00.000Z" }));
    const upstreamFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    const credentials = await manager(await home(), true, upstreamFetch);
    try {
      mocks.relayOpen.mockResolvedValueOnce(relay);
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: "/tmp/fake-ca.pem",
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const prepared = await credentials.prepare(request("session-1"));
      expect(prepared.mcp?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/mcp$/);
      expect(prepared.mcp?.token).not.toBe("otmg_abc");
      const response = await fetch(prepared.mcp?.url ?? "", {
        method: "POST",
        headers: {
          authorization: `Bearer ${prepared.mcp?.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
      expect(upstreamFetch.mock.calls[0]?.[0]).toBe("https://server.example.test/api/v1/mcp");
      expect(upstreamFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
        authorization: "Bearer otmg_abc",
      });
    } finally {
      await credentials.close();
    }
  });

  it("requests the mcp service when its capability is negotiated", async () => {
    const relay = fakeRelay("exec-mcp", async () => ({ token: "otmg_abc", expiresAt: "2026-01-01T00:00:00.000Z" }));
    await prepareWith(await home(), relay);
    const subject = mocks.relayOpen.mock.calls[0]?.[1] as { services?: readonly string[] };
    expect(subject.services).toEqual(["mcp"]);
  });

  /* An older Server never negotiated the capability, so it must never see a field it would reject. */
  it("omits the service request when the capability was not negotiated", async () => {
    const relay = fakeRelay("exec-mcp", async () => ({ token: "otmg_abc", expiresAt: "2026-01-01T00:00:00.000Z" }));
    await prepareWith(await home(), relay, false);
    const subject = mocks.relayOpen.mock.calls[0]?.[1] as { services?: unknown };
    expect(subject.services).toBeUndefined();
  });

  it("prepares no gateway when the Server grants no token", async () => {
    const relay = fakeRelay("exec-mcp", async () => undefined);
    const prepared = await prepareWith(await home(), relay);
    expect(prepared.mcp).toBeUndefined();
  });

  /*
   * The execution is already prepared by the time the gateway is fetched, so a failure here must
   * cost the Agent its MCP tools and nothing else. Throwing would discard working IM credentials
   * over an optional service.
   */
  it("keeps the execution usable when the gateway request fails", async () => {
    const relay = fakeRelay("exec-mcp", async () => {
      throw new Error("control channel closed");
    });
    const prepared = await prepareWith(await home(), relay);
    expect(prepared.mcp).toBeUndefined();
    expect(prepared.executionId).toBe("exec-mcp");
  });

  it("keeps the execution usable against a peer that does not implement the request", async () => {
    const relay = fakeRelay("exec-mcp", async () => undefined);
    (relay as { acquireMcpGatewayToken?: unknown }).acquireMcpGatewayToken = undefined;
    const prepared = await prepareWith(await home(), relay);
    expect(prepared.mcp).toBeUndefined();
    expect(prepared.executionId).toBe("exec-mcp");
  });

  it("refreshes the upstream bearer on the active relay and replays once when the Server token store returns 401", async () => {
    const tokens = ["otmg_initial", "otmg_refreshed"];
    const relay = fakeRelay("exec-mcp", async () => {
      const next = tokens.shift();
      return next ? { token: next, expiresAt: "2026-01-01T00:00:00.000Z" } : undefined;
    });
    const upstreamFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (auth === "Bearer otmg_initial") {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: ["search"] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const credentials = await manager(await home(), true, upstreamFetch);
    try {
      mocks.relayOpen.mockResolvedValueOnce(relay);
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: "/tmp/fake-ca.pem",
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const prepared = await credentials.prepare(request("session-1"));
      const response = await fetch(prepared.mcp?.url ?? "", {
        method: "POST",
        headers: {
          authorization: `Bearer ${prepared.mcp?.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: ["search"] } });
      expect(relay.acquireMcpGatewayToken).toHaveBeenCalledTimes(2);
      expect(mocks.openServices).not.toHaveBeenCalled();
      expect(upstreamFetch).toHaveBeenCalledTimes(2);
    } finally {
      await credentials.close();
    }
  });

  it("opens a replacement MCP execution and replays once when the Server restarts mid-turn and loses both token and execution state", async () => {
    let initialAcquired = false;
    const relay = fakeRelay("exec-before-restart", async () => {
      if (!initialAcquired) {
        initialAcquired = true;
        return { token: "otmg_before_restart", expiresAt: "2026-01-01T00:00:00.000Z" };
      }
      throw new Error("execution_unknown");
    });
    const upstreamFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (auth === "Bearer otmg_before_restart") {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "ok" }] } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const connection = fakeConnection(true);
    const credentials = new RuntimeCredentialEnvironmentManager({
      connection,
      home: await home(),
      mcpGatewayFetch: upstreamFetch,
      mode: "proxy",
      platform: "darwin",
      serverUrl: "https://server.example.test",
    });
    try {
      mocks.relayOpen.mockResolvedValueOnce(relay);
      mocks.openServices.mockImplementationOnce(
        (...args: Parameters<NonNullable<typeof mocks.realOpenServices>>) =>
          mocks.realOpenServices?.(...args) ?? Promise.reject(new Error("realOpenServices missing")),
      );
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: "/tmp/fake-ca.pem",
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const prepared = await credentials.prepare(request("session-1"));
      // Simulate control connection loss during Server rolling restart:
      relay.abort.abort();

      const [first, second] = await Promise.all([
        fetch(prepared.mcp?.url ?? "", {
          method: "POST",
          headers: {
            authorization: `Bearer ${prepared.mcp?.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call" }),
        }),
        fetch(prepared.mcp?.url ?? "", {
          method: "POST",
          headers: {
            authorization: `Bearer ${prepared.mcp?.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call" }),
        }),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      // Single-flight refresh opens only one replacement MCP execution across concurrent 401s:
      expect(mocks.openServices).toHaveBeenCalledTimes(1);
      const replacementSubject = mocks.openServices.mock.calls[0]?.[1] as {
        agentId: string;
        placementGeneration: number;
        sessionId: string;
        runId: string;
        source: RuntimeExecutionSource;
        services: readonly string[];
      };
      expect(replacementSubject).toMatchObject({
        agentId: "agent-1",
        placementGeneration: 1,
        sessionId: "session-1",
        source: { kind: "delivery", deliveryId: "delivery-1", turnId: "turn-1" },
        services: ["mcp"],
      });
      expect(replacementSubject.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      await credentials.cleanup("session-1", prepared.executionId);
      expect(
        connection.send.mock.calls.some(
          ([frame]) =>
            frame.type === "runtime:execution:close" && frame.executionId === "11111111-1111-4111-8111-111111111111",
        ),
      ).toBe(true);
    } finally {
      await credentials.close();
    }
  });

  it("enforces local loopback path, method, bearer, and payload limits and surfaces unrecoverable upstream errors", async () => {
    const relay = fakeRelay("exec-mcp", async () => ({
      token: "otmg_initial",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }));
    relay.acquireMcpGatewayToken
      .mockResolvedValueOnce({ token: "otmg_initial", expiresAt: "2026-01-01T00:00:00.000Z" })
      .mockResolvedValue(undefined);
    let failNetwork = false;
    const upstreamFetch = vi.fn<typeof fetch>(async () => {
      if (failNetwork) throw new Error("socket hang up");
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const credentials = await manager(await home(), true, upstreamFetch);
    try {
      mocks.relayOpen.mockResolvedValueOnce(relay);
      mocks.openServices.mockRejectedValue(new Error("execution_source_invalid"));
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: "/tmp/fake-ca.pem",
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const prepared = await credentials.prepare(request("session-1"));
      const baseUrl = new URL(prepared.mcp?.url ?? "");

      const notFound = await fetch(new URL("/wrong-path", baseUrl), { method: "POST" });
      expect(notFound.status).toBe(404);

      const badMethod = await fetch(baseUrl, { method: "GET" });
      expect(badMethod.status).toBe(405);

      const unauthorized = await fetch(baseUrl, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      const tooLarge = await fetch(baseUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${prepared.mcp?.token}` },
        body: "x".repeat(1024 * 1024 + 16),
      });
      expect(tooLarge.status).toBe(413);

      const unrecoverable401 = await fetch(baseUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${prepared.mcp?.token}` },
        body: "{}",
      });
      expect(unrecoverable401.status).toBe(401);

      failNetwork = true;
      const upstreamDown = await fetch(baseUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${prepared.mcp?.token}` },
        body: "{}",
      });
      expect(upstreamDown.status).toBe(502);
    } finally {
      await credentials.close();
    }
  });

  it("propagates downstream client cancellation and gateway shutdown to in-flight upstream fetches", async () => {
    const relay = fakeRelay("exec-mcp", async () => ({
      token: "otmg_initial",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }));
    const upstreamSignals: AbortSignal[] = [];
    const notifyUpstreamStarted: Array<() => void> = [];
    const upstreamFetch = vi.fn<typeof fetch>((_url, init) => {
      const signal = init?.signal;
      if (signal) {
        upstreamSignals.push(signal);
      }
      notifyUpstreamStarted.shift()?.();
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            reject(signal.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
    });

    const credentials = await manager(await home(), true, upstreamFetch);
    try {
      mocks.relayOpen.mockResolvedValueOnce(relay);
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: "/tmp/fake-ca.pem",
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const prepared = await credentials.prepare(request("session-1"));
      const gatewayUrl = prepared.mcp?.url ?? "";
      const gatewayToken = prepared.mcp?.token ?? "";

      // 1. Downstream client cancellation aborts the upstream fetch signal:
      const firstStarted = new Promise<void>((resolve) => {
        notifyUpstreamStarted.push(resolve);
      });
      const downstreamAbort = new AbortController();
      const firstRequest = fetch(gatewayUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
        signal: downstreamAbort.signal,
      }).catch((error: unknown) => error);

      await firstStarted;
      expect(upstreamSignals).toHaveLength(1);
      expect(upstreamSignals[0]?.aborted).toBe(false);

      const firstAborted = new Promise<void>((resolve) => {
        upstreamSignals[0]?.addEventListener("abort", () => resolve(), { once: true });
      });
      downstreamAbort.abort();
      await firstRequest;
      await firstAborted;
      expect(upstreamSignals[0]?.aborted).toBe(true);

      // 2. Gateway shutdown (cleanup) aborts in-flight upstream requests:
      const secondStarted = new Promise<void>((resolve) => {
        notifyUpstreamStarted.push(resolve);
      });
      const secondRequest = fetch(gatewayUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call" }),
      }).catch((error: unknown) => error);

      await secondStarted;
      expect(upstreamSignals).toHaveLength(2);
      expect(upstreamSignals[1]?.aborted).toBe(false);

      await credentials.cleanup("session-1", prepared.executionId);
      expect(upstreamSignals[1]?.aborted).toBe(true);
      await secondRequest;
    } finally {
      await credentials.close();
    }
  });

  it("rejects malformed or non-origin request targets with 400 without unhandled rejections", async () => {
    const relay = fakeRelay("exec-mcp", async () => ({
      token: "otmg_initial",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }));
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const credentials = await manager(await home(), true);
    try {
      mocks.relayOpen.mockResolvedValueOnce(relay);
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: "/tmp/fake-ca.pem",
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const prepared = await credentials.prepare(request("session-1"));
      const parsedUrl = new URL(prepared.mcp?.url ?? "");
      const port = Number(parsedUrl.port);

      const sendRawRequest = (requestLine: string): Promise<string> =>
        new Promise((resolve, reject) => {
          const socket = connectSocket({ host: "127.0.0.1", port });
          const chunks: Buffer[] = [];
          socket.on("error", reject);
          socket.on("data", (chunk: Buffer) => chunks.push(chunk));
          socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          socket.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        });

      const malformedAbsolute = await sendRawRequest("POST http://[ HTTP/1.1");
      expect(malformedAbsolute).toContain("HTTP/1.1 400 Bad Request");
      expect(malformedAbsolute).toContain('{"error":"bad_request"}');

      const authorityRelative = await sendRawRequest("POST //evil.example/api/v1/mcp HTTP/1.1");
      expect(authorityRelative).toContain("HTTP/1.1 400 Bad Request");
      expect(authorityRelative).toContain('{"error":"bad_request"}');

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await credentials.close();
    }
  });
});
