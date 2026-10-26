import { MCP_ERROR_CODES, MCP_MODERN_PROTOCOL_VERSION } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { McpUpstreamCaller } from "../services/mcp/mcp-gateway-upstream.js";
import { McpProbe } from "../services/mcp/mcp-probe.js";
import { MCP_ACCEPT_HEADER, McpTransport, McpTransportError } from "../services/mcp/mcp-transport.js";
import type { McpFetchInit, McpFetchResponse, McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

/**
 * A 2xx status is not an answer.
 *
 * The transport used to read any 2xx whose body was not a JSON-RPC envelope — an HTML error page
 * from a CDN, an empty body, a truncated object — as a successful `undefined` result. Downstream
 * that turned a Server which answered nothing into a *healthy* empty one: the probe stored
 * `probeState: "succeeded"` with zero tools, and a gateway `tools/call` replied with a JSON-RPC
 * envelope that had no `result` at all, which a client waits on forever.
 *
 * These cases pin the whole boundary rather than the one reported shape: every body a reader cannot
 * take as an answer fails, at both response shapes; a legitimate notification acknowledgement, a
 * bare result object, an explicit `null` result, and a JSON-RPC error body all still pass; and a
 * failure is dispatched exactly once, because a `tools/call` is not idempotent.
 */

const ACCOUNT = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const ENDPOINT = "https://mcp.example.com/mcp";

interface ScriptedAnswer {
  status: number;
  /** A raw body, or a function of the request id so an SSE fixture can answer the real request. */
  body?: string | ((id: string) => string);
  contentType?: string;
  /** Extra response headers, such as the legacy `mcp-session-id` a handshake opens a session with. */
  headers?: Record<string, string>;
}

interface Exchange {
  method: string;
  id: string;
  headers: Record<string, string>;
}

/** The header map as the real fetcher would see it: `Headers` lowercases every name. */
function lowercased(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

/** A fetcher answering from a script and recording every request, so no test reaches the network. */
function scripted(answers: ScriptedAnswer[]) {
  const sent: Exchange[] = [];
  const fetcher = {
    fetchOutbound: async (_accountId: string, _url: string, init: McpFetchInit = {}): Promise<McpFetchResponse> => {
      const request = JSON.parse(String(init.body ?? "{}")) as { method?: unknown; id?: unknown };
      const id = String(request.id ?? "");
      sent.push({ method: String(request.method ?? ""), id, headers: lowercased(init.headers) });
      const next = answers.shift();
      if (!next) throw new Error(`unscripted request: ${String(request.method)}`);
      const text = typeof next.body === "function" ? next.body(id) : (next.body ?? "");
      return {
        status: next.status,
        headers: new Headers({ "content-type": next.contentType ?? "application/json", ...next.headers }),
        text,
      };
    },
  } as unknown as McpOutboundFetcher;
  return { fetcher, sent };
}

function transportFor(answers: ScriptedAnswer[]): { transport: McpTransport; sent: Exchange[] } {
  const { fetcher, sent } = scripted(answers);
  return { transport: new McpTransport({ fetcher }), sent };
}

/** The rejection from one modern call, so a test can assert on its shape. */
async function rejectionOf(promise: Promise<unknown>): Promise<McpTransportError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(McpTransportError);
  return caught as McpTransportError;
}

/** A body that is HTML, not JSON: what a proxy answers when the upstream never replied. */
const HTML_PAGE = "<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>";

describe("a 2xx response that is not an answer", () => {
  /*
   * The JSON branch: every body that cannot be read as a JSON-RPC response *or* as a bare result
   * object. The message must describe the shape and never echo the body, which may carry an
   * upstream stack trace or a credential in an error string.
   */
  const UNREADABLE: { label: string; answer: ScriptedAnswer; message: RegExp }[] = [
    {
      label: "an HTML error page",
      answer: { status: 200, body: HTML_PAGE, contentType: "text/html" },
      message: /not valid JSON/,
    },
    { label: "an empty body", answer: { status: 200, body: "" }, message: /empty response/ },
    { label: "a whitespace-only body", answer: { status: 200, body: " \n\t" }, message: /empty response/ },
    {
      label: "a truncated object",
      answer: { status: 200, body: '{"jsonrpc":"2.0","id":"1","result":{' },
      message: /not valid JSON/,
    },
    {
      label: "a JSON array",
      answer: { status: 200, body: "[]" },
      message: /not a JSON-RPC response/,
    },
    { label: "a JSON string", answer: { status: 200, body: '"ok"' }, message: /not a JSON-RPC response/ },
    { label: "JSON null", answer: { status: 200, body: "null" }, message: /not a JSON-RPC response/ },
    {
      label: "an envelope with neither result nor error",
      answer: { status: 200, body: '{"jsonrpc":"2.0","id":"1"}' },
      message: /not a JSON-RPC response/,
    },
  ];

  for (const { label, answer, message } of UNREADABLE) {
    it(`refuses ${label} as a protocol failure, not an empty result`, async () => {
      const { transport, sent } = transportFor([answer]);
      const error = await rejectionOf(transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {}));

      expect(error.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
      // The status the peer really sent travels with the error; nothing is invented.
      expect(error.status).toBe(200);
      expect(error.message).toMatch(message);
      // The upstream body never becomes part of the message.
      expect(error.message).not.toContain("Bad Gateway");
      expect(error.message).not.toContain("jsonrpc");
      // One dispatch: an unreadable answer is reported, never re-requested.
      expect(sent).toHaveLength(1);
      expect(sent[0]?.method).toBe("tools/list");
    });
  }

  it("refuses the same bodies on the legacy call and on the initialize handshake", async () => {
    // Both legacy shapes share `#interpret`, so a fix in one place has to hold in all three.
    const legacy = transportFor([{ status: 200, body: HTML_PAGE, contentType: "text/html" }]);
    const legacyError = await rejectionOf(legacy.transport.callLegacy(ACCOUNT, ENDPOINT, "tools/list", {}, {}));
    expect(legacyError.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(legacyError.status).toBe(200);

    const handshake = transportFor([{ status: 200, body: "" }]);
    const handshakeError = await rejectionOf(handshake.transport.initialize(ACCOUNT, ENDPOINT, {}));
    expect(handshakeError.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(handshakeError.message).toMatch(/empty response/);
    // No session is invented for a handshake that never answered.
    expect(handshake.sent).toHaveLength(1);
  });
});

describe("a 2xx response stream that never answers the request", () => {
  const SSE = "text/event-stream";

  /*
   * A request-scoped stream exists to carry the response for the request that opened it. A stream
   * that ends without one — no frames, only notifications, only other ids, or a frame that is not
   * JSON — answered nothing, which is the same failure as an empty body.
   */
  const EMPTY_STREAMS: { label: string; answer: ScriptedAnswer }[] = [
    { label: "an empty stream", answer: { status: 200, body: "", contentType: SSE } },
    {
      label: "a stream carrying only notifications",
      answer: {
        status: 200,
        body: 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
        contentType: SSE,
      },
    },
    {
      label: "a stream carrying only another request's answer",
      answer: {
        status: 200,
        body: 'event: message\ndata: {"jsonrpc":"2.0","id":"other","result":{"tools":[]}}\n\n',
        contentType: SSE,
      },
    },
    {
      label: "a stream whose data is not JSON",
      answer: { status: 200, body: "data: <html>oops</html>\n\n", contentType: SSE },
    },
  ];

  for (const { label, answer } of EMPTY_STREAMS) {
    it(`refuses ${label} instead of reporting an empty result`, async () => {
      const { transport, sent } = transportFor([answer]);
      const error = await rejectionOf(transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {}));

      expect(error.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
      expect(error.status).toBe(200);
      expect(error.message).toBe("The MCP Server returned a response stream with no answer to this request");
      expect(sent).toHaveLength(1);
    });
  }

  it("still reads a stream that answers the request, and still refuses a non-2xx one", async () => {
    const { transport, sent } = transportFor([
      {
        status: 200,
        contentType: SSE,
        body: (id) => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } })}\n\n`,
      },
    ]);
    await expect(transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {})).resolves.toEqual({ tools: [] });
    expect(sent[0]?.headers.accept).toBe(MCP_ACCEPT_HEADER);

    // The status rule the stream branch already had must survive this change.
    const refused = transportFor([{ status: 401, body: "", contentType: SSE }]);
    const error = await rejectionOf(refused.transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {}));
    expect(error.status).toBe(401);
  });
});

describe("answers the protocol does allow", () => {
  it("accepts a notification acknowledged with 202 and with 204, sending the required headers", async () => {
    for (const status of [202, 204]) {
      const { transport, sent } = transportFor([{ status, body: "" }]);
      await expect(
        transport.call(ACCOUNT, ENDPOINT, "notifications/cancelled", { requestId: "x" }, {}),
      ).resolves.toBeUndefined();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.headers.accept).toBe(MCP_ACCEPT_HEADER);
      expect(sent[0]?.headers["content-type"]).toBe("application/json");
      expect(sent[0]?.headers["mcp-method"]).toBe("notifications/cancelled");
    }
  });

  it("keeps a bare result object, and an explicit null result, as results", async () => {
    const bare = transportFor([{ status: 200, body: '{"tools":[]}' }]);
    await expect(bare.transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {})).resolves.toEqual({ tools: [] });

    const emptyObject = transportFor([{ status: 200, body: "{}" }]);
    await expect(emptyObject.transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {})).resolves.toEqual({});

    /*
     * `"result": null` is a present key with a null value, which the protocol allows; only an
     * *absent* `result` is the shape this change refuses.
     */
    const nullResult = transportFor([
      { status: 200, body: (id) => JSON.stringify({ jsonrpc: "2.0", id, result: null }) },
    ]);
    await expect(nullResult.transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {})).resolves.toBeNull();

    const withId = transportFor([{ status: 200, body: '{"jsonrpc":"2.0","id":"1","result":{"tools":[]}}' }]);
    await expect(withId.transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {})).resolves.toEqual({ tools: [] });
  });

  it("still preserves a JSON-RPC error body so a caller can branch on its code", async () => {
    const { transport } = transportFor([
      {
        status: 200,
        body: (id) =>
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32022, message: "unsupported", data: { supported: ["2025-11-25"] } },
          }),
      },
    ]);
    const error = await rejectionOf(transport.call(ACCOUNT, ENDPOINT, "server/discover", {}, {}));
    expect(error.rpcError?.code).toBe(-32022);
    expect(error.isModernJsonRpcError).toBe(true);
    expect(error.supportedVersions).toEqual(["2025-11-25"]);
  });

  it("keeps a valid JSON-RPC error and the real status when the failure is not a 2xx", async () => {
    const { transport } = transportFor([
      { status: 500, body: (id) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "boom" } }) },
    ]);
    const error = await rejectionOf(transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {}));
    // The code still reaches the caller, which is what the downgrade rules branch on.
    expect(error.rpcError?.code).toBe(-32603);
    expect(error.status).toBe(500);
  });
});

/**
 * A request method needs a result. `202` and `204` say "acknowledged, nothing to answer", which the
 * protocol defines for a notification and for nothing else, so an acknowledgement of `tools/call`,
 * `tools/list`, or `initialize` is an answer that never arrived — the shape that let a probe record
 * a Server which did nothing as a healthy empty one.
 */
describe("an acknowledgement is not an answer to a request", () => {
  it.each([202, 204])("refuses a %i answer to tools/call, with the headers it sent", async (status) => {
    const { transport, sent } = transportFor([{ status, body: "" }]);
    const error = await rejectionOf(transport.call(ACCOUNT, ENDPOINT, "tools/call", { name: "create_issue" }, {}));

    expect(error.name).toBe("McpTransportError");
    expect(error.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(error.status).toBe(status);
    expect(error.message).toBe("The MCP Server returned an acknowledgement instead of a response");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["mcp-method"]).toBe("tools/call");
    expect(sent[0]?.headers["mcp-name"]).toBe("create_issue");
    expect(sent[0]?.headers.accept).toBe(MCP_ACCEPT_HEADER);
  });

  it.each([202, 204])("refuses a %i answer to tools/list and to initialize", async (status) => {
    const list = transportFor([{ status, body: "" }]);
    const listError = await rejectionOf(list.transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {}));
    expect(listError.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(listError.status).toBe(status);
    expect(listError.message).toMatch(/acknowledgement instead of a response/);

    // The handshake is a request too: an acknowledged one opened no session and negotiated nothing.
    const handshake = transportFor([{ status, body: "" }]);
    const handshakeError = await rejectionOf(handshake.transport.initialize(ACCOUNT, ENDPOINT, {}));
    expect(handshakeError.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(handshakeError.status).toBe(status);
  });

  it("still accepts an acknowledgement of a notification on the modern and legacy paths", async () => {
    for (const status of [202, 204]) {
      const modern = transportFor([{ status, body: "" }]);
      await expect(
        modern.transport.call(ACCOUNT, ENDPOINT, "notifications/progress", { progressToken: "t" }, {}),
      ).resolves.toBeUndefined();

      const legacy = transportFor([{ status, body: "" }]);
      await expect(
        legacy.transport.callLegacy(ACCOUNT, ENDPOINT, "notifications/cancelled", { requestId: "r" }, {}),
      ).resolves.toBeUndefined();
    }
  });
});

/**
 * The `error` member has to be read, not trusted.
 *
 * Reading `payload.error.message` off whatever the Server sent threw a raw `TypeError` for
 * `"error": null`, and a `code` of the wrong type was silently rewritten to `-32602` — a verdict
 * the downgrade rules then treat as the Server's own. A present but unreadable member is a protocol
 * failure with a fixed message and the real HTTP status; a readable one is still preserved.
 */
describe("a malformed JSON-RPC error member", () => {
  const MALFORMED = [
    { label: "null", member: null },
    { label: "a string", member: "boom" },
    { label: "a number", member: 42 },
    { label: "a boolean", member: false },
    { label: "an array", member: [{ code: -32603, message: "boom" }] },
    { label: "an object with no code", member: { message: "boom" } },
    { label: "a code that is not a number", member: { code: "-32603", message: "boom" } },
    { label: "a message that is not a string", member: { code: -32603, message: 42 } },
    { label: "a code that is an object", member: { code: { value: -32603 }, message: "boom" } },
  ];

  for (const { label, member } of MALFORMED) {
    it(`reports ${label} as a protocol failure instead of a TypeError`, async () => {
      const { transport, sent } = transportFor([
        { status: 200, body: (id) => JSON.stringify({ jsonrpc: "2.0", id, error: member }) },
      ]);
      const error = await rejectionOf(transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {}));

      expect(error.name).toBe("McpTransportError");
      expect(error).not.toBeInstanceOf(TypeError);
      expect(error.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
      expect(error.status).toBe(200);
      expect(error.message).toBe("The MCP Server returned a malformed JSON-RPC error");
      // The member's own text never becomes part of the message, and no code is invented for it.
      expect(error.message).not.toContain("boom");
      expect(error.rpcError).toBeUndefined();
      expect(sent).toHaveLength(1);
    });
  }

  it("keeps the real status when a malformed member arrives with a failure status", async () => {
    const { transport } = transportFor([
      { status: 400, body: (id) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: "-32022" } }) },
    ]);
    const error = await rejectionOf(transport.call(ACCOUNT, ENDPOINT, "server/discover", {}, {}));
    expect(error.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(error.status).toBe(400);
    // No invented `-32602` for the downgrade rules to read as a Server verdict.
    expect(error.rpcError).toBeUndefined();
  });

  it("reads a malformed member inside a stream the same way", async () => {
    const SSE = "text/event-stream";
    for (const member of [null, "boom", { code: [] }, { code: -32603, message: 7 }]) {
      const { transport } = transportFor([
        {
          status: 200,
          contentType: SSE,
          body: (id) => `data: ${JSON.stringify({ jsonrpc: "2.0", id, error: member })}\n\n`,
        },
      ]);
      const error = await rejectionOf(transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {}));
      expect(error.name).toBe("McpTransportError");
      expect(error.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
      expect(error.message).toBe("The MCP Server returned a malformed JSON-RPC error");
    }
  });

  it("still preserves a readable error delivered inside a stream", async () => {
    const { transport } = transportFor([
      {
        status: 200,
        contentType: "text/event-stream",
        body: (id) => `data: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "bad" } })}\n\n`,
      },
    ]);
    const error = await rejectionOf(transport.call(ACCOUNT, ENDPOINT, "tools/list", {}, {}));
    expect(error.rpcError?.code).toBe(-32602);
    expect(error.message).toContain("bad");
  });
});

/** A runtime tool call, which is the one path where a second dispatch would run a tool twice. */
describe("the gateway never replays a side-effecting tool call after an unreadable answer", () => {
  function callerFor(answers: (request: { method: string; id: string }) => ScriptedAnswer) {
    const sent: Exchange[] = [];
    const fetcher = {
      fetchOutbound: async (_accountId: string, _url: string, init: McpFetchInit = {}): Promise<McpFetchResponse> => {
        const request = JSON.parse(String(init.body ?? "{}")) as { method?: unknown; id?: unknown };
        const hop = { method: String(request.method ?? ""), id: String(request.id ?? "") };
        sent.push({ ...hop, headers: lowercased(init.headers) });
        const next = answers(hop);
        return {
          status: next.status,
          headers: new Headers({ "content-type": next.contentType ?? "application/json", ...next.headers }),
          text: typeof next.body === "function" ? next.body(hop.id) : (next.body ?? ""),
        };
      },
    } as unknown as McpOutboundFetcher;
    const caller = new McpUpstreamCaller({ fetcher });
    return {
      sent,
      call: (overrides: Record<string, unknown> = {}) =>
        caller.call({
          accountId: ACCOUNT,
          url: ENDPOINT,
          authHeaders: { authorization: "Bearer upstream" },
          method: "tools/call",
          params: { name: "create_issue", arguments: { title: "once" } },
          name: "create_issue",
          cachedEra: "modern",
          cachedVersion: MCP_MODERN_PROTOCOL_VERSION,
          ...overrides,
        }),
    };
  }

  it.each([
    { label: "an HTML page at 200", answer: { status: 200, body: HTML_PAGE, contentType: "text/html" } },
    { label: "an empty body at 200", answer: { status: 200, body: "" } },
    { label: "an empty stream at 200", answer: { status: 200, body: "", contentType: "text/event-stream" } },
  ])("dispatches exactly once for $label and propagates the failure", async ({ answer }) => {
    const { sent, call } = callerFor(() => answer as ScriptedAnswer);
    const error = await rejectionOf(call());

    expect(error.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    // One dispatch, and no handshake fallback that would run the call a second time.
    expect(sent.map((exchange) => exchange.method)).toEqual(["tools/call"]);
    // The single request is exactly the one the transport promises for a modern call.
    expect(sent[0]?.headers["mcp-protocol-version"]).toBe(MCP_MODERN_PROTOCOL_VERSION);
    expect(sent[0]?.headers["mcp-method"]).toBe("tools/call");
    expect(sent[0]?.headers["mcp-name"]).toBe("create_issue");
    expect(sent[0]?.headers.accept).toBe(MCP_ACCEPT_HEADER);
  });

  it.each([202, 204])("dispatches once when tools/call is only acknowledged with %i", async (status) => {
    const { sent, call } = callerFor(() => ({ status, body: "" }));
    const error = await rejectionOf(call());

    expect(error.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(error.status).toBe(status);
    expect(sent.map((exchange) => exchange.method)).toEqual(["tools/call"]);
  });

  it("dispatches once on the legacy path too, through a real session", async () => {
    /*
     * The handshake opens a session, so the acknowledgement is dispatched under it and only then is
     * the call made. The whole legacy sequence is asserted, because a failure after the call must
     * not be answered by running the sequence — and therefore the tool — a second time.
     */
    const { sent, call } = callerFor((request) => {
      if (request.method === "initialize") {
        return {
          status: 200,
          headers: { "mcp-session-id": "session-1" },
          body: (id) =>
            JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {} } }),
        };
      }
      if (request.method === "notifications/initialized") return { status: 202, body: "" };
      return { status: 200, body: HTML_PAGE, contentType: "text/html" };
    });
    const error = await rejectionOf(call({ cachedEra: "legacy", cachedVersion: "2025-06-18" }));

    expect(error.code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(sent.map((exchange) => exchange.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    // The session the handshake opened rides the acknowledgement and the call, and the call is the
    // legacy shape (no `Mcp-Method`) at the negotiated version.
    expect(sent[1]?.headers["mcp-session-id"]).toBe("session-1");
    expect(sent[2]?.headers["mcp-session-id"]).toBe("session-1");
    expect(sent[2]?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(sent[2]?.headers["mcp-method"]).toBeUndefined();
  });
});

/**
 * A probe is the evidence that a credential and a Server agree, so a Server that answered nothing
 * must fail the probe rather than be recorded as a healthy empty one — and nothing may be dispatched
 * after the failure.
 */
describe("the probe fails instead of storing an empty healthy snapshot", () => {
  function probeFor(answers: (method: string) => ScriptedAnswer) {
    const sent: string[] = [];
    const fetcher = {
      fetchOutbound: async (_accountId: string, _url: string, init: McpFetchInit = {}): Promise<McpFetchResponse> => {
        const request = JSON.parse(String(init.body ?? "{}")) as { method?: unknown; id?: unknown };
        const method = String(request.method ?? "");
        sent.push(method);
        const next = answers(method);
        return {
          status: next.status,
          headers: new Headers({ "content-type": next.contentType ?? "application/json", ...next.headers }),
          text: typeof next.body === "function" ? next.body(String(request.id ?? "")) : (next.body ?? ""),
        };
      },
    } as unknown as McpOutboundFetcher;
    return { sent, probe: new McpProbe({ fetcher }) };
  }

  const request = { accountId: ACCOUNT, url: ENDPOINT, authHeaders: {}, cachedEra: null, cachedVersion: null };

  it("fails the modern probe on a discovery answer that is HTML, and never lists tools", async () => {
    const { sent, probe } = probeFor(() => ({ status: 200, body: HTML_PAGE, contentType: "text/html" }));
    const result = await probe.probe(request);

    expect(result.probeState).toBe("failed");
    expect(result.tools).toEqual([]);
    expect(result.probeError).toContain(MCP_ERROR_CODES.UPSTREAM_ERROR);
    // The HTML never reaches the stored error string, which the UI renders.
    expect(result.probeError).not.toContain("Bad Gateway");
    // The era rule retries a modern read once; what must never follow is a `tools/list` on a probe
    // that already failed, which would have published an empty snapshot as a healthy one.
    expect(sent.every((method) => method === "server/discover")).toBe(true);
    expect(sent).not.toContain("tools/list");
    expect(sent).not.toContain("initialize");
  });

  it("fails the modern probe on an empty discovery stream", async () => {
    const { sent, probe } = probeFor(() => ({ status: 200, body: "", contentType: "text/event-stream" }));
    const result = await probe.probe(request);

    expect(result.probeState).toBe("failed");
    expect(result.probeError).toContain(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(sent).not.toContain("tools/list");
  });

  it("stops a legacy probe whose handshake answered nothing", async () => {
    const { sent, probe } = probeFor(() => ({ status: 200, body: "", contentType: "application/json" }));
    const result = await probe.probe({ ...request, cachedEra: "legacy", cachedVersion: "2025-06-18" });

    expect(result.probeState).toBe("failed");
    expect(result.probeError).toContain(MCP_ERROR_CODES.UPSTREAM_ERROR);
    // No `notifications/initialized` and no `tools/list` ride a session that was never opened.
    expect(sent).toEqual(["initialize"]);
  });

  it.each([202, 204])("fails the modern probe when discovery is only acknowledged with %i", async (status) => {
    const { sent, probe } = probeFor(() => ({ status, body: "" }));
    const result = await probe.probe(request);

    expect(result.probeState).toBe("failed");
    expect(result.probeError).toContain(MCP_ERROR_CODES.UPSTREAM_ERROR);
    // An acknowledged discovery is not a discovery: nothing may be listed from it.
    expect(sent).not.toContain("tools/list");
    expect(sent).not.toContain("initialize");
  });

  it.each([202, 204])("fails a legacy probe whose initialize is only acknowledged with %i", async (status) => {
    const { sent, probe } = probeFor(() => ({ status, body: "" }));
    const result = await probe.probe({ ...request, cachedEra: "legacy", cachedVersion: "2025-06-18" });

    expect(result.probeState).toBe("failed");
    expect(result.probeError).toContain(MCP_ERROR_CODES.UPSTREAM_ERROR);
    // No handshake completed, so no notification and no tool listing may follow it.
    expect(sent).toEqual(["initialize"]);
  });

  it("fails the modern probe on a malformed discovery error member", async () => {
    const { sent, probe } = probeFor(() => ({
      status: 200,
      body: (id) => JSON.stringify({ jsonrpc: "2.0", id, error: null }),
    }));
    const result = await probe.probe(request);

    // A raw TypeError here used to escape every probe error contract and reach the caller.
    expect(result.probeState).toBe("failed");
    expect(result.probeError).toContain(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(result.probeError).not.toContain("TypeError");
    expect(sent).not.toContain("tools/list");
  });
});
