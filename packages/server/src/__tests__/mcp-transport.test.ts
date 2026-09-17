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
  const fetcher = new McpOutboundFetcher({ allowLoopback: true, fetch: fetchImpl });
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
