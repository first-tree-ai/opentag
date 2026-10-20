import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchInboundRequest,
  type McpInboundHandlers,
  parseInboundRequest,
  toolErrorResult,
} from "../services/mcp/mcp-inbound-protocol.js";
import { MCP_META_SERVER_INFO } from "../services/mcp/mcp-transport.js";

const SERVER_INFO = { name: "opentag-mcp", title: "openTag MCP", version: "1" };

function handlers(overrides: Partial<McpInboundHandlers> = {}): McpInboundHandlers {
  return {
    serverInfo: SERVER_INFO,
    supportedVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    listTools: async () => ({ tools: [], notes: [] }),
    callTool: async () => ({ content: [] }),
    ...overrides,
  };
}

function resultOf(reply: Awaited<ReturnType<typeof dispatchInboundRequest>>): Record<string, unknown> {
  if (reply.kind !== "json") throw new Error("Expected a JSON reply");
  const body = reply.body as { result?: unknown };
  return (body.result ?? {}) as Record<string, unknown>;
}

function errorOf(reply: Awaited<ReturnType<typeof dispatchInboundRequest>>): { code: number; message: string } {
  if (reply.kind !== "json") throw new Error("Expected a JSON reply");
  return (reply.body as { error: { code: number; message: string } }).error;
}

describe("parseInboundRequest", () => {
  it("accepts a well-formed request and preserves the id", () => {
    expect(parseInboundRequest({ jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "ping",
    });
  });

  it("rejects a wrong version, a missing method, and a non-object body", () => {
    expect(parseInboundRequest({ jsonrpc: "1.0", method: "ping" })).toBeUndefined();
    expect(parseInboundRequest({ jsonrpc: "2.0" })).toBeUndefined();
    expect(parseInboundRequest("ping")).toBeUndefined();
    expect(parseInboundRequest(null)).toBeUndefined();
  });

  /*
   * A batch is refused rather than half-answered: neither provider CLI batches, and accepting an
   * array would mean inventing partial-failure semantics for a case that does not arise.
   */
  it("rejects a batch", () => {
    expect(parseInboundRequest([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toBeUndefined();
  });
});

describe("dispatch", () => {
  it("acknowledges a notification without a body", async () => {
    const reply = await dispatchInboundRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, handlers());
    expect(reply).toEqual({ kind: "accepted" });
  });

  it("answers ping", async () => {
    const reply = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, handlers());
    expect(resultOf(reply)).toEqual({});
  });

  it("answers an unknown method with method-not-found", async () => {
    const reply = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "resources/read" }, handlers());
    if (reply.kind !== "json") throw new Error("Expected a JSON reply");
    expect(reply.status).toBe(404);
    expect(errorOf(reply).code).toBe(-32601);
  });

  /*
   * An object-keyed method table would resolve `constructor`, `toString`, and the rest of
   * `Object.prototype` and dispatch them as methods. Every unknown name — inherited or invented —
   * must get the one method-not-found answer.
   */
  it("refuses an inherited name as an unknown method", async () => {
    for (const method of ["constructor", "toString", "__defineGetter__", "hasOwnProperty", "valueOf"]) {
      const reply = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method }, handlers());
      if (reply.kind !== "json") throw new Error("Expected a JSON reply");
      expect(reply.status, method).toBe(404);
      expect(errorOf(reply).code, method).toBe(-32601);
    }
  });

  /* An id that is neither a string nor a number is answered against null, per JSON-RPC. */
  it("normalizes a malformed id to null", async () => {
    const reply = await dispatchInboundRequest({ jsonrpc: "2.0", id: { bad: true }, method: "ping" }, handlers());
    if (reply.kind !== "json") throw new Error("Expected a JSON reply");
    expect((reply.body as { id: unknown }).id).toBeNull();
  });
});

describe("handshake and discovery", () => {
  /*
   * Claude Code's own bridge speaks 2025-03-26, so the legacy handshake is a first-class path here.
   * A gateway that only answered `server/discover` would be unusable by the client it exists for.
   */
  it("echoes a protocol version this deployment speaks", async () => {
    const reply = await dispatchInboundRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      handlers(),
    );
    expect(resultOf(reply).protocolVersion).toBe("2025-03-26");
  });

  /*
   * Echoing an unsupported version would strand the session: the client would then stamp a version
   * on every later request that the gateway never agreed to speak.
   */
  it("substitutes a supported version when the client asks for one it does not speak", async () => {
    const reply = await dispatchInboundRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      handlers(),
    );
    expect(resultOf(reply).protocolVersion).toBe(MCP_LEGACY_PROTOCOL_VERSIONS[0]);
  });

  it("declares the tools capability on both eras", async () => {
    const legacy = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, handlers());
    const modern = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "server/discover" }, handlers());
    expect(resultOf(legacy).capabilities).toEqual({ tools: {} });
    expect(resultOf(modern).capabilities).toEqual({ tools: {} });
  });

  it("reports the whole supported set on modern discovery", async () => {
    const reply = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "server/discover" }, handlers());
    const result = resultOf(reply);
    expect(result.supportedVersions).toContain(MCP_MODERN_PROTOCOL_VERSION);
    expect(result.protocolVersion).toBe(MCP_MODERN_PROTOCOL_VERSION);
  });

  /*
   * Identity comes from the handlers, not from this module: the runtime gateway and the catalog
   * endpoint present different servers and must be able to say so through the same protocol.
   */
  it("reports the identity the endpoint supplies on both eras", async () => {
    const legacy = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, handlers());
    const modern = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "server/discover" }, handlers());
    expect(resultOf(legacy).serverInfo).toEqual(SERVER_INFO);
    expect((resultOf(modern)._meta as Record<string, unknown>)[MCP_META_SERVER_INFO]).toEqual(SERVER_INFO);
  });

  /*
   * Notes are the only channel by which a model can learn that a Server it was told about is
   * missing. Without them a revoked credential looks exactly like a Server that never had tools.
   */
  it("surfaces catalogue notes as instructions", async () => {
    const reply = await dispatchInboundRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      handlers({ listTools: async () => ({ tools: [], notes: ["linear is not authorized"] }) }),
    );
    expect(resultOf(reply).instructions).toBe("linear is not authorized");
  });

  it("omits instructions when there is nothing to report", async () => {
    const reply = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, handlers());
    expect(resultOf(reply)).not.toHaveProperty("instructions");
  });
});

describe("tools/list", () => {
  it("publishes the catalogue verbatim", async () => {
    const reply = await dispatchInboundRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      handlers({
        listTools: async () => ({
          tools: [{ name: "linear__create_issue", description: "Create one", inputSchema: { type: "object" } }],
          notes: [],
        }),
      }),
    );
    expect(resultOf(reply).tools).toEqual([
      { name: "linear__create_issue", description: "Create one", inputSchema: { type: "object" } },
    ]);
  });

  /* Several clients reject a tool with no schema, so a snapshot without one gets a permissive one. */
  it("substitutes a permissive schema when the snapshot stored none", async () => {
    const reply = await dispatchInboundRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      handlers({
        listTools: async () => ({ tools: [{ name: "a__b", description: null, inputSchema: null }], notes: [] }),
      }),
    );
    expect(resultOf(reply).tools).toEqual([{ name: "a__b", inputSchema: { type: "object" } }]);
  });

  /*
   * An endpoint that does not implement the modern revision must not list it, or a negotiating client
   * picks a revision whose transport contract the endpoint does not honour.
   */
  it("advertises only the revisions the endpoint implements", async () => {
    const reply = await dispatchInboundRequest(
      { jsonrpc: "2.0", id: 1, method: "server/discover" },
      handlers({ supportedVersions: MCP_LEGACY_PROTOCOL_VERSIONS }),
    );
    const result = resultOf(reply);
    expect(result.supportedVersions).toEqual([...MCP_LEGACY_PROTOCOL_VERSIONS]);
    expect(result.protocolVersion).toBe(MCP_LEGACY_PROTOCOL_VERSIONS[0]);
  });

  it("never negotiates to the modern revision through the legacy handshake", async () => {
    const reply = await dispatchInboundRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_MODERN_PROTOCOL_VERSION } },
      handlers({ supportedVersions: MCP_LEGACY_PROTOCOL_VERSIONS }),
    );
    expect(resultOf(reply).protocolVersion).toBe(MCP_LEGACY_PROTOCOL_VERSIONS[0]);
  });

  /* The catalogue is bounded and served whole, so a cursor would describe state that is not kept. */
  it("never emits a pagination cursor", async () => {
    const reply = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, handlers());
    expect(resultOf(reply)).not.toHaveProperty("nextCursor");
  });
});

describe("tools/call", () => {
  it("forwards the name and arguments", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    await dispatchInboundRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "linear__x", arguments: { title: "t" } } },
      handlers({ callTool }),
    );
    expect(callTool).toHaveBeenCalledWith("linear__x", { title: "t" });
  });

  it("passes undefined arguments through rather than inventing an object", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    await dispatchInboundRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "linear__x" } },
      handlers({ callTool }),
    );
    expect(callTool).toHaveBeenCalledWith("linear__x", undefined);
  });

  it("rejects a call with no tool name", async () => {
    const reply = await dispatchInboundRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }, handlers());
    expect(errorOf(reply).code).toBe(-32602);
  });
});

describe("toolErrorResult", () => {
  /*
   * A failed tool call is a result, not a transport error. A transport error ends the model's turn;
   * an `isError` result is something it can read and recover from.
   */
  it("is an isError result rather than a JSON-RPC error", () => {
    expect(toolErrorResult("upstream refused")).toEqual({
      content: [{ type: "text", text: "upstream refused" }],
      isError: true,
    });
  });
});
