import type { MCPAgentServer, MCPServer } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  promptForBearerKey,
  readBearerKeyFromStdin,
  runAgentMcpAvailable,
  runAgentMcpDetach,
  runAgentMcpEnable,
  runAgentMcpList,
  runMcpAuthorize,
  runMcpList,
  runMcpProbe,
  runMcpRemove,
  runMcpRevoke,
} from "../core/mcp/operations.js";
import type { McpApiClient } from "../core/mcp/shared.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

const server: MCPServer = {
  id: "d91ba522-498b-4d5e-845b-06f8dc9d562c",
  name: "tools",
  description: null,
  url: "https://tools.example.test/mcp",
  defaultAuthKind: "oauth",
  authHeader: "authorization",
  authScheme: "",
  extraHeaders: {},
  revision: 4,
  boundAgentCount: 1,
  authorizedAgentCount: 1,
  lastProbedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

function mount(overrides: Partial<MCPAgentServer> = {}): MCPAgentServer {
  return {
    mcpServerId: server.id,
    name: server.name,
    description: null,
    discoveredDescription: null,
    enabled: true,
    effective: { url: server.url, authHeader: "authorization", authScheme: "", extraHeaders: {} },
    overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
    authorization: null,
    snapshot: null,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function authorization(overrides: Partial<NonNullable<MCPAgentServer["authorization"]>> = {}) {
  return {
    kind: "oauth" as const,
    status: "pending" as const,
    hasCredential: false,
    scopes: null,
    accessTokenExpiresAt: null,
    authorizationServer: null,
    probeState: "pending" as const,
    probedAt: null,
    probeError: null,
    toolsCount: null,
    toolsTruncated: false,
    failureCode: null,
    revision: 1,
    ...overrides,
  };
}

function fixture(overrides: Partial<McpApiClient> = {}) {
  const api = {
    listMcpServers: vi.fn(async () => ({ servers: [server] })),
    createMcpServer: vi.fn(async () => server),
    getMcpServer: vi.fn(async () => ({ server, agents: [] })),
    updateMcpServer: vi.fn(async () => server),
    removeMcpServer: vi.fn(async () => undefined),
    listAgentMcpServers: vi.fn(async () => ({ servers: [] as MCPAgentServer[] })),
    listAvailableMcpServers: vi.fn(async () => ({ servers: [server] })),
    attachMcpServer: vi.fn(async () => mount()),
    updateAgentMcpServer: vi.fn(async () => mount()),
    detachMcpServer: vi.fn(async () => undefined),
    setMcpAuthorization: vi.fn(async () => mount()),
    revokeMcpAuthorization: vi.fn(async () => mount()),
    startMcpOAuth: vi.fn(async () => ({
      authorizationUrl: "https://auth.example.test/authorize",
      expiresAt: "2030-01-01T00:10:00.000Z",
    })),
    probeMcpServer: vi.fn(async () => ({
      probeState: "succeeded" as const,
      probeError: null,
      toolsCount: 3,
      toolsTruncated: false,
      protocolEra: "modern" as const,
      protocolVersion: "2030-01-01",
    })),
    ...overrides,
  };
  return {
    api,
    dependencies: { api: api as unknown as McpApiClient, accessToken: "fixture-account-access" },
  };
}

describe("mcp server definition operations", () => {
  it("lists the Account's definitions", async () => {
    const f = fixture();
    await expect(runMcpList(f.dependencies)).resolves.toEqual([server]);
    expect(f.api.listMcpServers).toHaveBeenCalledWith("fixture-account-access");
  });

  it("removes a definition after resolving it by name and by id", async () => {
    const f = fixture();
    await expect(runMcpRemove("tools", f.dependencies)).resolves.toEqual(server);
    expect(f.api.removeMcpServer).toHaveBeenCalledWith("fixture-account-access", server.id);
    await expect(runMcpRemove(server.id, f.dependencies)).resolves.toEqual(server);
    expect(f.api.removeMcpServer).toHaveBeenCalledTimes(2);
    await expect(runMcpRemove("missing", f.dependencies)).rejects.toThrow(
      'No MCP Server named or identified by "missing"',
    );
    expect(f.api.removeMcpServer).toHaveBeenCalledTimes(2);
  });

  it("surfaces a definition-level removal failure from the API", async () => {
    const f = fixture({
      removeMcpServer: vi.fn(async () => {
        throw new Error("still mounted by 2 Agents");
      }),
    });
    await expect(runMcpRemove("tools", f.dependencies)).rejects.toThrow("still mounted by 2 Agents");
  });
});

describe("agent mcp mount operations", () => {
  it("lists the Servers one Agent mounts", async () => {
    const f = fixture({ listAgentMcpServers: vi.fn(async () => ({ servers: [mount()] })) });
    await expect(runAgentMcpList(agentId, f.dependencies)).resolves.toEqual([mount()]);
    expect(f.api.listAgentMcpServers).toHaveBeenCalledWith("fixture-account-access", agentId);
  });

  it("lists the Account Servers one Agent has not mounted", async () => {
    const f = fixture();
    await expect(runAgentMcpAvailable(agentId, f.dependencies)).resolves.toEqual([server]);
    expect(f.api.listAvailableMcpServers).toHaveBeenCalledWith("fixture-account-access", agentId);
  });

  it("detaches a mount by the Server's id", async () => {
    const f = fixture();
    await expect(runAgentMcpDetach(agentId, "tools", f.dependencies)).resolves.toBeUndefined();
    expect(f.api.detachMcpServer).toHaveBeenCalledWith("fixture-account-access", agentId, server.id);
    const failure = fixture({
      detachMcpServer: vi.fn(async () => {
        throw new Error("this Agent does not mount the Server");
      }),
    });
    await expect(runAgentMcpDetach(agentId, "tools", failure.dependencies)).rejects.toThrow(
      "this Agent does not mount the Server",
    );
  });

  it("enables and disables a mount without touching its credential", async () => {
    const f = fixture();
    await runAgentMcpEnable(agentId, "tools", true, f.dependencies);
    expect(f.api.updateAgentMcpServer).toHaveBeenLastCalledWith("fixture-account-access", agentId, server.id, {
      enabled: true,
    });
    await runAgentMcpEnable(agentId, server.id, false, f.dependencies);
    expect(f.api.updateAgentMcpServer).toHaveBeenLastCalledWith("fixture-account-access", agentId, server.id, {
      enabled: false,
    });
    expect(f.api.setMcpAuthorization).not.toHaveBeenCalled();
  });
});

describe("mcp revoke and probe", () => {
  it("drops one Agent's credential and keeps the mount", async () => {
    const f = fixture();
    await runMcpRevoke(agentId, "tools", f.dependencies);
    expect(f.api.revokeMcpAuthorization).toHaveBeenCalledWith("fixture-account-access", agentId, server.id);
  });

  it("re-probes one Agent's credential", async () => {
    const f = fixture();
    await expect(runMcpProbe(agentId, "tools", f.dependencies)).resolves.toMatchObject({ toolsCount: 3 });
    expect(f.api.probeMcpServer).toHaveBeenCalledWith("fixture-account-access", agentId, server.id);
    const failure = fixture({
      probeMcpServer: vi.fn(async () => {
        throw new Error("the credential was rejected");
      }),
    });
    await expect(runMcpProbe(agentId, "tools", failure.dependencies)).rejects.toThrow("the credential was rejected");
  });
});

describe("mcp authorize waiting", () => {
  it("returns immediately with --no-wait and never polls the Agent's mounts", async () => {
    const f = fixture();
    const onStarted = vi.fn();
    const result = await runMcpAuthorize(
      agentId,
      "tools",
      { noWait: true, scopes: ["read", "write"] },
      { ...f.dependencies, onStarted },
    );
    expect(result.probe).toBeUndefined();
    expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationUrl: "https://auth.example.test/authorize" }),
    );
    expect(f.api.startMcpOAuth).toHaveBeenCalledWith("fixture-account-access", agentId, server.id, {
      scopes: ["read", "write"],
    });
    expect(f.api.listAgentMcpServers).not.toHaveBeenCalled();
  });

  it("omits the scope list entirely when none was asked for", async () => {
    const f = fixture();
    await runMcpAuthorize(agentId, "tools", { noWait: true }, f.dependencies);
    expect(f.api.startMcpOAuth).toHaveBeenCalledWith("fixture-account-access", agentId, server.id, {});
  });

  it("returns the probe once the row is active and probed, including its protocol era", async () => {
    const f = fixture({
      listAgentMcpServers: vi.fn(async () => ({
        servers: [
          mount({
            authorization: authorization({
              status: "active",
              probeState: "succeeded",
              toolsCount: 4,
              toolsTruncated: true,
            }),
            snapshot: {
              protocolEra: "modern",
              protocolVersion: "2030-01-01",
              serverInfo: null,
              capabilities: null,
              instructions: null,
              tools: null,
            },
          }),
        ],
      })),
    });
    const result = await runMcpAuthorize(agentId, "tools", {}, f.dependencies);
    expect(result.probe).toEqual({
      probeState: "succeeded",
      probeError: null,
      toolsCount: 4,
      toolsTruncated: true,
      protocolEra: "modern",
      protocolVersion: "2030-01-01",
    });
  });

  it("reports a null protocol era when the row carries no snapshot", async () => {
    const f = fixture({
      listAgentMcpServers: vi.fn(async () => ({
        servers: [
          mount({ authorization: authorization({ status: "active", probeState: "failed", probeError: "boom" }) }),
        ],
      })),
    });
    const result = await runMcpAuthorize(agentId, "tools", {}, f.dependencies);
    expect(result.probe).toMatchObject({ protocolEra: null, protocolVersion: null, probeState: "failed" });
  });

  it("keeps polling while the row is still pending", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const f = fixture({
        listAgentMcpServers: vi.fn(async () => {
          calls += 1;
          return {
            servers: [
              mount({
                authorization:
                  calls < 3
                    ? authorization({ status: "pending" })
                    : authorization({ status: "active", probeState: "succeeded", toolsCount: 1 }),
              }),
            ],
          };
        }),
      });
      const pending = runMcpAuthorize(agentId, "tools", {}, f.dependencies);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ probe: { toolsCount: 1 } });
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the wait on a terminal status that is neither pending nor active", async () => {
    const f = fixture({
      listAgentMcpServers: vi.fn(async () => ({
        servers: [mount({ authorization: authorization({ status: "revoked" }) })],
      })),
    });
    await expect(runMcpAuthorize(agentId, "tools", {}, f.dependencies)).rejects.toThrow(
      'The authorization ended in state "revoked"',
    );
  });

  it("times out rather than waiting on a state the server has already discarded", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({
        listAgentMcpServers: vi.fn(async () => ({
          servers: [mount({ authorization: authorization({ status: "pending" }) })],
        })),
      });
      const pending = runMcpAuthorize(agentId, "tools", {}, f.dependencies);
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      await expect(settled).resolves.toMatchObject({
        message: "Timed out waiting for the authorization to finish",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bearer key readers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a trimmed key from standard input", async () => {
    const original = process.stdin[Symbol.asyncIterator];
    Object.defineProperty(process.stdin, Symbol.asyncIterator, {
      configurable: true,
      value: async function* () {
        yield "  piped-key\n";
      },
    });
    try {
      await expect(readBearerKeyFromStdin()).resolves.toBe("piped-key");
    } finally {
      Object.defineProperty(process.stdin, Symbol.asyncIterator, { configurable: true, value: original });
    }
  });

  it("refuses an empty standard input", async () => {
    const original = process.stdin[Symbol.asyncIterator];
    Object.defineProperty(process.stdin, Symbol.asyncIterator, {
      configurable: true,
      value: async function* () {
        yield "   \n";
      },
    });
    try {
      await expect(readBearerKeyFromStdin()).rejects.toThrow("No bearer key was read from standard input");
    } finally {
      Object.defineProperty(process.stdin, Symbol.asyncIterator, { configurable: true, value: original });
    }
  });
});

describe("interactive bearer key prompt", () => {
  /** A raw-mode stream the test can drive by emitting the escape sequences a terminal would send. */
  function fakeTty() {
    const listeners = new Set<(chunk: Buffer) => void>();
    const output: string[] = [];
    const stream = {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      on: vi.fn((event: string, listener: (chunk: Buffer) => void) => {
        if (event === "data") listeners.add(listener);
      }),
      off: vi.fn((event: string, listener: (chunk: Buffer) => void) => {
        if (event === "data") listeners.delete(listener);
      }),
      emit: (text: string) => {
        for (const listener of [...listeners]) listener(Buffer.from(text, "utf8"));
      },
    };
    const out = {
      isTTY: true,
      write: vi.fn((chunk: string) => {
        output.push(chunk);
        return true;
      }),
    };
    vi.spyOn(process, "stdin", "get").mockReturnValue(stream as unknown as typeof process.stdin);
    vi.spyOn(process, "stdout", "get").mockReturnValue(out as unknown as typeof process.stdout);
    return { stream, out, output };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a non-interactive stdin instead of hanging", async () => {
    vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: false } as unknown as typeof process.stdin);
    vi.spyOn(process, "stdout", "get").mockReturnValue({ isTTY: true } as unknown as typeof process.stdout);
    await expect(promptForBearerKey()).rejects.toThrow(
      "A bearer key is required; pipe it with --bearer-key-stdin when not interactive",
    );
  });

  it("refuses a non-interactive stdout as well", async () => {
    vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: true } as unknown as typeof process.stdin);
    vi.spyOn(process, "stdout", "get").mockReturnValue({ isTTY: false } as unknown as typeof process.stdout);
    await expect(promptForBearerKey()).rejects.toThrow("pipe it with --bearer-key-stdin");
  });

  it("accumulates keystrokes, honours backspace, and restores the previous raw mode", async () => {
    const { stream, output } = fakeTty();
    const pending = promptForBearerKey();
    stream.emit("sec");
    stream.emit("ret");
    stream.emit("\u007f");
    stream.emit("X\r");
    await expect(pending).resolves.toBe("secreX");
    expect(output.join("")).toContain("Bearer key: ");
    expect(stream.setRawMode).toHaveBeenCalledWith(true);
    expect(stream.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stream.pause).toHaveBeenCalled();
    expect(stream.off).toHaveBeenCalled();
  });

  it("reports a Cancel keystroke rather than storing the escape", async () => {
    const { stream } = fakeTty();
    const pending = promptForBearerKey();
    stream.emit("ab\u0003");
    await expect(pending).rejects.toThrow("Cancelled");
    expect(stream.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("refuses an empty entry", async () => {
    const { stream } = fakeTty();
    const pending = promptForBearerKey();
    stream.emit("\n");
    await expect(pending).rejects.toThrow("No bearer key was entered");
    expect(stream.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("accepts a carriage return as the terminator", async () => {
    const { stream } = fakeTty();
    const pending = promptForBearerKey();
    stream.emit("k");
    stream.emit("\r");
    await expect(pending).resolves.toBe("k");
  });
});
