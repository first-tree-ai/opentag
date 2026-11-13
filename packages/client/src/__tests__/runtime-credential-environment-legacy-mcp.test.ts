import type { RuntimeExecutionSource } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImCredentialEnvironmentManager } from "../runtime/im-credential-environment-manager.js";
import { RuntimeCredentialEnvironmentManager } from "../runtime/runtime-credential-environment-manager.js";
import { RUNTIME_CREDENTIAL_CAPABILITY, RUNTIME_MCP_GATEWAY_CAPABILITY } from "../runtime/runtime-credential-frames.js";

const mocks = vi.hoisted(() => ({ openServices: vi.fn() }));

vi.mock("../runtime/runtime-credential-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/runtime-credential-relay.js")>();
  return {
    ...actual,
    RuntimeCredentialRelay: { openServices: (...args: unknown[]) => mocks.openServices(...args) },
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function fakeConnection(negotiated: { credential?: boolean; mcp?: boolean } = {}) {
  return {
    capabilityVersion: (capability: string): number | undefined => {
      if (capability === RUNTIME_CREDENTIAL_CAPABILITY) return negotiated.credential === false ? undefined : 1;
      if (capability === RUNTIME_MCP_GATEWAY_CAPABILITY) return negotiated.mcp === false ? undefined : 1;
      return undefined;
    },
    send: vi.fn(async () => undefined),
    subscribeBusinessFrames: vi.fn(() => () => undefined),
    subscribeState: vi.fn(() => () => undefined),
  };
}

function fakeLegacy() {
  let next = 0;
  return {
    prepare: vi.fn(async () => ({
      executionId: `legacy-${++next}`,
      environmentManifest: "/tmp/manifest",
      path: "/tmp/env",
      provider: "feishu" as const,
    })),
    cleanup: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function fakeRelay(token: string | undefined) {
  return {
    executionId: "exec-mcp",
    acquireMcpGatewayToken: vi.fn(async () => (token ? { token, expiresAt: "2026-01-01T00:00:00.000Z" } : undefined)),
    close: vi.fn(async () => undefined),
  };
}

function request(sessionId = "session-1") {
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

function manager(options: { negotiated?: { credential?: boolean; mcp?: boolean }; legacyMcpGateway?: boolean } = {}) {
  const legacy = fakeLegacy();
  const credentials = new RuntimeCredentialEnvironmentManager({
    connection: fakeConnection(options.negotiated),
    home: "/tmp/opentag-legacy-mcp-unused",
    legacy: () => legacy as unknown as ImCredentialEnvironmentManager,
    mode: "legacy",
    serverUrl: "https://server.example.test",
    ...(options.legacyMcpGateway !== undefined ? { legacyMcpGateway: options.legacyMcpGateway } : {}),
  });
  return { credentials, legacy };
}

describe("legacy-mode MCP gateway", () => {
  it("opens an MCP-only execution next to the legacy IM grant", async () => {
    const relay = fakeRelay("otmg_legacy");
    mocks.openServices.mockResolvedValueOnce(relay);
    const { credentials } = manager();
    const prepared = await credentials.prepare(request());
    expect(prepared.executionId).toBe("legacy-1");
    expect(prepared.provider).toBe("feishu");
    expect(prepared.mcp).toEqual({ url: "https://server.example.test/api/v1/mcp", token: "otmg_legacy" });
    const subject = mocks.openServices.mock.calls[0]?.[1] as { services?: readonly string[]; runId: string };
    expect(subject.services).toEqual(["mcp"]);
    expect(subject.runId).toBe("run-session-1");
  });

  it("closes the MCP execution with the matching legacy cleanup only", async () => {
    const relay = fakeRelay("otmg_legacy");
    mocks.openServices.mockResolvedValueOnce(relay);
    const { credentials, legacy } = manager();
    await credentials.prepare(request());
    await credentials.cleanup("session-1", "stale-execution");
    expect(relay.close).not.toHaveBeenCalled();
    await credentials.cleanup("session-1", "legacy-1");
    expect(relay.close).toHaveBeenCalledTimes(1);
    expect(legacy.cleanup).toHaveBeenCalledWith("session-1", "legacy-1");
  });

  it("replaces the previous MCP execution of the same Session", async () => {
    const first = fakeRelay("otmg_1");
    const second = fakeRelay("otmg_2");
    mocks.openServices.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { credentials } = manager();
    await credentials.prepare(request());
    const prepared = await credentials.prepare(request());
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(prepared.mcp?.token).toBe("otmg_2");
    await credentials.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("closes the execution at once when the Server grants no MCP service", async () => {
    const relay = fakeRelay(undefined);
    mocks.openServices.mockResolvedValueOnce(relay);
    const { credentials } = manager();
    const prepared = await credentials.prepare(request());
    expect(prepared.mcp).toBeUndefined();
    expect(relay.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy grant when the MCP execution cannot be opened", async () => {
    mocks.openServices.mockRejectedValueOnce(new Error("execution rejected"));
    const { credentials } = manager();
    const prepared = await credentials.prepare(request());
    expect(prepared.mcp).toBeUndefined();
    expect(prepared.executionId).toBe("legacy-1");
  });

  it.each([
    ["the switch is off", { legacyMcpGateway: false }],
    ["runtimeCredential was not negotiated", { negotiated: { credential: false } }],
    ["mcpGateway was not negotiated", { negotiated: { mcp: false } }],
  ])("opens no execution when %s", async (_label, options) => {
    const { credentials } = manager(options);
    const prepared = await credentials.prepare(request());
    expect(prepared.mcp).toBeUndefined();
    expect(mocks.openServices).not.toHaveBeenCalled();
  });

  it("gives an internal Session only the MCP service", async () => {
    const relay = fakeRelay("otmg_internal");
    mocks.openServices.mockResolvedValueOnce(relay);
    const { credentials, legacy } = manager();
    const prepared = await credentials.prepareLegacyServices(request("internal-1"));
    expect(legacy.prepare).not.toHaveBeenCalled();
    expect(prepared?.mcp?.token).toBe("otmg_internal");
    expect(prepared?.provider).toBeUndefined();
    await credentials.cleanup("internal-1", prepared?.executionId);
    expect(relay.close).toHaveBeenCalledTimes(1);
  });

  it("resolves no environment for an internal Session without an MCP grant", async () => {
    mocks.openServices.mockResolvedValueOnce(fakeRelay(undefined));
    const { credentials } = manager();
    await expect(credentials.prepareLegacyServices(request("internal-1"))).resolves.toBeUndefined();
  });
});
