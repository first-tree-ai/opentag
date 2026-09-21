import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeExecutionSource } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCredentialEnvironmentManager } from "../runtime/runtime-credential-environment-manager.js";
import {
  RUNTIME_CREDENTIAL_CAPABILITY,
  RUNTIME_MCP_GATEWAY_CAPABILITY,
  RUNTIME_PROVIDER_PROXY_CAPABILITY,
} from "../runtime/runtime-credential-frames.js";

const mocks = vi.hoisted(() => ({ relayOpen: vi.fn(), adapterStart: vi.fn() }));

vi.mock("../runtime/runtime-credential-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/runtime-credential-relay.js")>();
  return {
    ...actual,
    RuntimeCredentialRelay: { open: (...args: unknown[]) => mocks.relayOpen(...args) },
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
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  vi.clearAllMocks();
});

function fakeConnection(mcpNegotiated = true) {
  return {
    capabilityVersion: (capability: string): number | undefined => {
      if (capability === RUNTIME_CREDENTIAL_CAPABILITY || capability === RUNTIME_PROVIDER_PROXY_CAPABILITY) return 1;
      if (capability === RUNTIME_MCP_GATEWAY_CAPABILITY) return mcpNegotiated ? 1 : undefined;
      return undefined;
    },
    send: vi.fn(async () => undefined),
    subscribeBusinessFrames: vi.fn(() => () => undefined),
    subscribeState: vi.fn(() => () => undefined),
  };
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

async function manager(home: string, mcpNegotiated = true): Promise<RuntimeCredentialEnvironmentManager> {
  return new RuntimeCredentialEnvironmentManager({
    connection: fakeConnection(mcpNegotiated),
    home,
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
  it("composes the endpoint against the pinned Server origin, not anything the Server said", async () => {
    const relay = fakeRelay("exec-mcp", async () => ({ token: "otmg_abc", expiresAt: "2026-01-01T00:00:00.000Z" }));
    const prepared = await prepareWith(await home(), relay);
    expect(prepared.mcp).toEqual({ url: "https://server.example.test/api/v1/mcp", token: "otmg_abc" });
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
});
