import { MCP_ERROR_CODES } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServiceError } from "../services/mcp/errors.js";
import {
  decodeHeaderValue,
  detectEraFromFailure,
  encodeHeaderValue,
  invalidatesProtocolEra,
  MCP_ACCEPT_HEADER,
  McpTransport,
  McpTransportError,
  negotiateProtocolVersion,
  parseSseResponse,
} from "../services/mcp/mcp-transport.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

/**
 * The modern protocol is stateless and per-request: every request carries its version twice, the
 * method as a header, and the name when there is one. These assertions cover the parts a reader
 * cannot verify by reading the specification once — the Base64 sentinel boundary and the two
 * response shapes — and the downgrade rule that decides whether a failure means "retry" or "this
 * Server is older".
 */

const ACCOUNT = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";

/** A fetcher whose response is scripted, so no test reaches the network. */
function stubFetch(
  responses: { status: number; body?: string; contentType?: string; headers?: Record<string, string> }[],
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 200, body: "{}" };
    return new Response(next.body ?? "", {
      status: next.status,
      headers: {
        "content-type": next.contentType ?? "application/json",
        "x-request-id": "test",
        ...next.headers,
      },
    });
  }) as unknown as typeof globalThis.fetch;
  const fetcher = new McpOutboundFetcher({
    allowLoopback: true,
    fetch: fetchImpl,
    /*
     * The gate resolves hostnames, and these tests dial `mcp.example.com`. A stub resolver keeps them
     * about the transport rather than about DNS, and keeps them offline.
     */
    resolveAddresses: async (): Promise<string[]> => ["93.184.216.34"],
  });
  return { calls, fetcher };
}

function headersOf(call: { init: RequestInit }): Record<string, string> {
  const headers = new Headers(call.init.headers);
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe("MCP transport headers", () => {
  it("sends every required header with both content types accepted", async () => {
    const { calls, fetcher } = stubFetch([{ status: 200, body: JSON.stringify({ result: {} }) }]);
    const transport = new McpTransport({ fetcher });
    await transport.call(ACCOUNT, "https://mcp.example.com/mcp", "server/discover", {}, { authorization: "Bearer t" });

    const headers = headersOf(calls[0] as { init: RequestInit });
    expect(headers.accept).toBe(MCP_ACCEPT_HEADER);
    expect(headers.accept).toContain("application/json");
    expect(headers.accept).toContain("text/event-stream");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(headers["mcp-method"]).toBe("server/discover");
    // `server/discover` has no `params.name`, so the name header must be absent, not empty.
    expect(headers["mcp-name"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer t");
  });

  it("sends the name header for a named call", async () => {
    const { calls, fetcher } = stubFetch([{ status: 200, body: JSON.stringify({ result: {} }) }]);
    const transport = new McpTransport({ fetcher });
    await transport.call(ACCOUNT, "https://mcp.example.com/mcp", "tools/call", { name: "create_issue" }, {});
    expect(headersOf(calls[0] as { init: RequestInit })["mcp-name"]).toBe("create_issue");
  });

  it("carries the protocol version and capabilities in every request body", async () => {
    const { calls, fetcher } = stubFetch([{ status: 200, body: JSON.stringify({ result: {} }) }]);
    const transport = new McpTransport({ fetcher });
    await transport.call(ACCOUNT, "https://mcp.example.com/mcp", "tools/list", {}, {});

    const params = bodyOf(calls[0] as { init: RequestInit }).params as { _meta: Record<string, unknown> };
    expect(params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(params._meta).toHaveProperty("io.modelcontextprotocol/clientCapabilities");
    expect(params._meta).toHaveProperty("io.modelcontextprotocol/clientInfo");
  });

  it("encodes a non-ASCII header value and an ASCII value that only looks like the sentinel", () => {
    expect(encodeHeaderValue("plain")).toBe("plain");
    // Non-ASCII has no representation in a header, so the sentinel carries the bytes.
    expect(encodeHeaderValue("工具箱")).toBe(`=?base64?${Buffer.from("工具箱", "utf8").toString("base64")}?=`);
    // An ASCII value that begins like the sentinel must be encoded too, or a reader could not tell
    // the two apart and would decode a literal as if it were an encoding.
    expect(encodeHeaderValue("=?base64?literal?=")).toBe(
      `=?base64?${Buffer.from("=?base64?literal?=", "utf8").toString("base64")}?=`,
    );
    expect(decodeHeaderValue(encodeHeaderValue("工具箱"))).toBe("工具箱");
    expect(decodeHeaderValue("plain")).toBe("plain");
  });

  it("encodes the method header when it would otherwise be ambiguous", async () => {
    const { calls, fetcher } = stubFetch([{ status: 200, body: JSON.stringify({ result: {} }) }]);
    const transport = new McpTransport({ fetcher });
    await transport.call(ACCOUNT, "https://mcp.example.com/mcp", "=?base64?odd?=", {}, {});
    const encoded = headersOf(calls[0] as { init: RequestInit })["mcp-method"];
    expect(encoded).toBe(`=?base64?${Buffer.from("=?base64?odd?=", "utf8").toString("base64")}?=`);
    expect(decodeHeaderValue(encoded as string)).toBe("=?base64?odd?=");
  });
});

describe("MCP response parsing", () => {
  it("reads a single JSON object", async () => {
    const { fetcher } = stubFetch([
      { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { tools: [] } }) },
    ]);
    const transport = new McpTransport({ fetcher });
    await expect(transport.call(ACCOUNT, "https://mcp.example.com/mcp", "tools/list", {}, {})).resolves.toEqual({
      tools: [],
    });
  });

  it("reads a request-scoped SSE stream, ignoring notifications and other ids", async () => {
    const id = "REQUEST_ID";
    const stream = [
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
      'event: message\ndata: {"jsonrpc":"2.0","id":"other","result":{"ignored":true}}\n\n',
      `event: message\ndata: {"jsonrpc":"2.0","id":"${id}","result":{"tools":[{"name":"a"}]}}\n\n`,
    ].join("");
    const parsed = parseSseResponse(stream, id);
    expect(parsed?.result).toEqual({ tools: [{ name: "a" }] });
  });

  it("returns nothing when the stream ends without our response", () => {
    expect(parseSseResponse('data: {"jsonrpc":"2.0","method":"notifications/x"}\n\n', "mine")).toBeUndefined();
  });

  it("accepts a notification accepted with no body", async () => {
    const { fetcher } = stubFetch([{ status: 202, body: "" }]);
    const transport = new McpTransport({ fetcher });
    await expect(
      transport.call(ACCOUNT, "https://mcp.example.com/mcp", "notifications/x", {}, {}),
    ).resolves.toBeUndefined();
  });

  it("reports a JSON-RPC error with its code so a caller can branch on it", async () => {
    const { fetcher } = stubFetch([
      {
        status: 400,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          error: { code: -32022, message: "unsupported", data: { supported: ["2026-07-28", "2025-11-25"] } },
        }),
      },
    ]);
    const transport = new McpTransport({ fetcher });
    const error = await transport
      .call(ACCOUNT, "https://mcp.example.com/mcp", "server/discover", {}, {})
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpTransportError);
    expect((error as McpTransportError).rpcError?.code).toBe(-32022);
    expect((error as McpTransportError).supportedVersions).toEqual(["2026-07-28", "2025-11-25"]);
  });

  /*
   * A gateway's error body is JSON, just not JSON-RPC. Returning it as the result made the probe
   * report `probeState: "succeeded"` with zero tools and no error — the one answer the probe must
   * never give, since its whole purpose is to be evidence that the credential and the Server agree.
   */
  it("refuses a non-2xx status even when the body is a JSON object", async () => {
    for (const [status, body] of [
      [401, JSON.stringify({ message: "Unauthorized" })],
      [403, JSON.stringify({ detail: "Forbidden" })],
      [500, JSON.stringify({ error: "boom" })],
      [502, JSON.stringify({ gateway: "upstream failed" })],
    ] as const) {
      const { fetcher } = stubFetch([{ status, body }]);
      const transport = new McpTransport({ fetcher });
      const error = await transport
        .call(ACCOUNT, "https://mcp.example.com/mcp", "tools/list", {}, {})
        .catch((caught: unknown) => caught);
      expect(error, `status ${status}`).toBeInstanceOf(McpTransportError);
      expect((error as McpTransportError).code, `status ${status}`).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
      // The status travels with the error so the caller can tell a refused credential from an outage.
      expect((error as McpTransportError & { status?: number }).status, `status ${status}`).toBe(status);
    }
  });

  it("names a refused credential as such rather than reporting a bare status", async () => {
    for (const status of [401, 403]) {
      const { fetcher } = stubFetch([{ status, body: JSON.stringify({ message: "Unauthorized" }) }]);
      const transport = new McpTransport({ fetcher });
      await expect(transport.call(ACCOUNT, "https://mcp.example.com/mcp", "tools/list", {}, {})).rejects.toThrow(
        /refused this credential/u,
      );
    }
  });

  it("still accepts a 2xx JSON body with no JSON-RPC envelope as a result", async () => {
    /*
     * The status rule must not turn a legitimate empty 200 into a failure. A body with no JSON-RPC
     * keys is treated as a bare result (`splitEnvelope`), so `{}` unwraps to `{}`.
     */
    const { fetcher } = stubFetch([{ status: 200, body: "{}" }]);
    const transport = new McpTransport({ fetcher });
    await expect(transport.call(ACCOUNT, "https://mcp.example.com/mcp", "tools/list", {}, {})).resolves.toEqual({});
    // And a 200 that carries a result still yields it.
    const withResult = stubFetch([{ status: 200, body: JSON.stringify({ result: { tools: [] } }) }]);
    await expect(
      new McpTransport({ fetcher: withResult.fetcher }).call(
        ACCOUNT,
        "https://mcp.example.com/mcp",
        "tools/list",
        {},
        {},
      ),
    ).resolves.toEqual({ tools: [] });
  });
});

/*
 * The legacy era is not one protocol. `2025-03-26` carries the version in the session alone, while
 * `2025-06-18` and `2025-11-25` want `MCP-Protocol-Version` on every request after the handshake.
 * `call` always stamps the modern version plus `Mcp-Method` and `_meta`, and the SDK answers
 * `400 Unsupported protocol version` for any value it does not know — which is what broke the legacy
 * path immediately after a successful `initialize`.
 */
describe("MCP transport legacy calls", () => {
  it("sends none of the modern envelope on a legacy call", async () => {
    const { calls, fetcher } = stubFetch([{ status: 200, body: JSON.stringify({ result: { tools: [] } }) }]);
    const transport = new McpTransport({ fetcher });
    await transport.callLegacy(
      ACCOUNT,
      "https://mcp.example.com/mcp",
      "tools/list",
      {},
      { authorization: "Bearer t" },
      { headers: { "mcp-session-id": "session-1" } },
    );

    const headers = headersOf(calls[0] as { init: RequestInit });
    expect(headers["mcp-protocol-version"]).toBeUndefined();
    expect(headers["mcp-method"]).toBeUndefined();
    expect(headers["mcp-name"]).toBeUndefined();
    // The session header the legacy protocol requires does travel.
    expect(headers["mcp-session-id"]).toBe("session-1");
    // And the body carries no `_meta`, which only the modern shape defines.
    const body = bodyOf(calls[0] as { init: RequestInit });
    expect(body).not.toHaveProperty("params._meta");
    expect(body.method).toBe("tools/list");
  });

  it("carries the negotiated version when the peer's era wants one", async () => {
    const { calls, fetcher } = stubFetch([{ status: 200, body: JSON.stringify({ result: { tools: [] } }) }]);
    const transport = new McpTransport({ fetcher });
    await transport.callLegacy(
      ACCOUNT,
      "https://mcp.example.com/mcp",
      "tools/list",
      {},
      {},
      { negotiatedVersion: "2025-06-18" },
    );

    const headers = headersOf(calls[0] as { init: RequestInit });
    expect(headers["mcp-protocol-version"]).toBe("2025-06-18");
    // Still none of the modern per-request envelope.
    expect(headers["mcp-method"]).toBeUndefined();
  });

  it("omits the version header for the legacy version that predates it", async () => {
    const { calls, fetcher } = stubFetch([{ status: 200, body: JSON.stringify({ result: { tools: [] } }) }]);
    const transport = new McpTransport({ fetcher });
    await transport.callLegacy(
      ACCOUNT,
      "https://mcp.example.com/mcp",
      "tools/list",
      {},
      {},
      { negotiatedVersion: "2025-03-26" },
    );

    expect(headersOf(calls[0] as { init: RequestInit })["mcp-protocol-version"]).toBeUndefined();
  });
});

/*
 * The SSE branch got the same B6 status rule as the JSON branch, and the review noted it landed
 * code-only. A stream is a body shape, not a licence to ignore the status.
 *
 * A stream answer must carry the request's own id (a frame without one is a notification), and the
 * id is a fresh UUID per call, so these fixtures build the frame from the body they receive.
 */
describe("MCP transport SSE responses", () => {
  /** A fetcher that answers with an SSE frame echoing the request id. */
  function sseFetcher(frame: (id: string) => unknown, status: number) {
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const id = String((JSON.parse(String(init?.body)) as { id?: unknown }).id ?? "");
      return new Response(`data: ${JSON.stringify(frame(id))}\n\n`, {
        status,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;
    return new McpTransport({
      fetcher: new McpOutboundFetcher({
        allowLoopback: true,
        fetch: fetchImpl,
        resolveAddresses: async () => ["93.184.216.34"],
      }),
    });
  }

  it("refuses a non-2xx status whose stream carries no JSON-RPC error", async () => {
    for (const status of [401, 500]) {
      const transport = sseFetcher((id) => ({ jsonrpc: "2.0", id, result: { tools: [] } }), status);
      await expect(
        transport.call(ACCOUNT, "https://mcp.example.com/mcp", "tools/list", {}, {}),
        `status ${status}`,
      ).rejects.toMatchObject({ code: MCP_ERROR_CODES.UPSTREAM_ERROR });
    }
  });

  it("preserves a JSON-RPC error delivered inside the stream", async () => {
    const transport = sseFetcher(
      (id) => ({ jsonrpc: "2.0", id, error: { code: -32022, message: "unsupported" } }),
      400,
    );
    const error = await transport
      .call(ACCOUNT, "https://mcp.example.com/mcp", "server/discover", {}, {})
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpTransportError);
    expect((error as McpTransportError).rpcError?.code).toBe(-32022);
  });

  it("accepts a 2xx stream with a result", async () => {
    const transport = sseFetcher((id) => ({ jsonrpc: "2.0", id, result: { tools: [{ name: "a" }] } }), 200);
    await expect(transport.call(ACCOUNT, "https://mcp.example.com/mcp", "tools/list", {}, {})).resolves.toEqual({
      tools: [{ name: "a" }],
    });
  });
});

describe("MCP era detection and downgrade", () => {
  it("treats a modern JSON-RPC error body as a modern peer and takes its advertised versions", () => {
    const detection = detectEraFromFailure(
      400,
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32022, message: "no", data: { supported: ["2025-11-25"] } } }),
    );
    expect(detection).toEqual({ era: "modern", retryWithVersions: ["2025-11-25"] });
  });

  it("treats a non-modern 404 body as a legacy peer", () => {
    expect(detectEraFromFailure(404, "<html>Not Found</html>")).toEqual({ era: "legacy" });
    // A method-not-found from an old Server must not be read as a modern signal: only the
    // MCP-registered error codes are modern era evidence.
    expect(
      detectEraFromFailure(400, JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "no method" } })),
    ).toEqual({ era: "legacy" });
  });

  it("refuses to negotiate a version this client does not speak", () => {
    expect(negotiateProtocolVersion(["2025-11-25", "2026-07-28"])).toBe("2026-07-28");
    expect(negotiateProtocolVersion(["2025-06-18"])).toBe("2025-06-18");
    const error = (() => {
      try {
        negotiateProtocolVersion(["2019-01-01"]);
        return undefined;
      } catch (caught) {
        return caught as McpServiceError;
      }
    })();
    expect(error?.code).toBe(MCP_ERROR_CODES.PROTOCOL_UNSUPPORTED);
  });

  it("invalidates a cached era only on a protocol-class failure", () => {
    const protocol = new McpTransportError(MCP_ERROR_CODES.TRANSPORT_UNSUPPORTED, "no method");
    const rpc = new McpTransportError(MCP_ERROR_CODES.UPSTREAM_ERROR, "no", 400, {
      code: -32022,
      message: "unsupported",
    });
    expect(invalidatesProtocolEra(protocol)).toBe(true);
    expect(invalidatesProtocolEra(rpc)).toBe(true);
    // A timeout or a 5xx says nothing about the origin's protocol, so a correct cache survives it.
    const timeout = new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "unreachable");
    expect(invalidatesProtocolEra(timeout)).toBe(false);
    const upstream = new McpTransportError(MCP_ERROR_CODES.UPSTREAM_ERROR, "boom", 500);
    expect(invalidatesProtocolEra(upstream)).toBe(false);
  });
});
