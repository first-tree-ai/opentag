import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { McpUpstreamCaller } from "../services/mcp/mcp-gateway-upstream.js";
import { McpProbe } from "../services/mcp/mcp-probe.js";
import { MCP_ACCEPT_HEADER, McpTransport, McpTransportError } from "../services/mcp/mcp-transport.js";
import type { McpFetchInit, McpFetchResponse, McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

/**
 * The legacy `notifications/initialized` request.
 *
 * It is the one legacy request that carries no `id`, so it never reaches the response interpreter:
 * a rejected notification used to be discarded, and the handshake was spoken without the version it
 * had just negotiated. Both halves are invisible in a happy-path probe, because a lenient Server
 * answers 202 and defaults a missing header to `2025-03-26` — which is exactly why a strict
 * `2025-06-18` or `2025-11-25` Server stayed unusable while every existing test passed.
 *
 * `2025-03-26` predates `MCP-Protocol-Version`, so it must keep receiving a notification with no
 * version header at all. These tests therefore assert the header both ways, and the exact request
 * ordering, because ordering is what proves nothing was dispatched after a refusal.
 */

const ACCOUNT = "account-1";
const ENDPOINT = "https://legacy.example.com/mcp";
const SESSION = "session-1";

interface Exchange {
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fetcher scripted per request, recording exactly what each hop sent. No network, no database. */
function recordingFetcher(respond: (exchange: Exchange, hop: number) => McpFetchResponse) {
  const sent: Exchange[] = [];
  let hop = 0;
  const fetcher = {
    fetchOutbound: async (_accountId: string, _url: string, init: McpFetchInit = {}): Promise<McpFetchResponse> => {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      const exchange: Exchange = {
        method: String(body.method ?? ""),
        body,
        headers: { ...((init.headers ?? {}) as Record<string, string>) },
      };
      sent.push(exchange);
      return respond(exchange, hop++);
    },
  } as unknown as McpOutboundFetcher;
  return { fetcher, sent };
}

/** Header lookup is case-insensitive, as HTTP requires; the assertion itself is exact. */
function header(exchange: Exchange, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(exchange.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function accepted(): McpFetchResponse {
  return { status: 202, headers: new Headers(), text: "" };
}

function json(status: number, body: unknown): McpFetchResponse {
  return { status, headers: new Headers({ "content-type": "application/json" }), text: JSON.stringify(body) };
}

function handshake(protocolVersion: string): McpFetchResponse {
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json", "mcp-session-id": SESSION }),
    text: JSON.stringify({
      jsonrpc: "2.0",
      id: "handshake",
      result: { protocolVersion, capabilities: {} },
    }),
  };
}

function notification(transport: McpTransport, negotiatedVersion?: string) {
  return transport.notifyLegacy(
    ACCOUNT,
    ENDPOINT,
    "notifications/initialized",
    { authorization: "Bearer upstream" },
    SESSION,
    negotiatedVersion === undefined ? {} : { negotiatedVersion },
  );
}

describe("the legacy notification revision", () => {
  it.each(["2025-06-18", "2025-11-25"])("sends the negotiated %s on notifications/initialized", async (version) => {
    const { fetcher, sent } = recordingFetcher(() => accepted());
    await notification(new McpTransport({ fetcher }), version);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("notifications/initialized");
    expect(header(sent[0] as Exchange, "MCP-Protocol-Version")).toBe(version);
    // The preserved headers: both content types, the JSON content type, the credential, the session.
    expect(header(sent[0] as Exchange, "accept")).toBe(MCP_ACCEPT_HEADER);
    expect(header(sent[0] as Exchange, "content-type")).toBe("application/json");
    expect(header(sent[0] as Exchange, "authorization")).toBe("Bearer upstream");
    expect(header(sent[0] as Exchange, "mcp-session-id")).toBe(SESSION);
    // A notification carries no id, so a Server can never mistake it for a request.
    expect(sent[0]?.body).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
  });

  /*
   * `2025-03-26` predates `MCP-Protocol-Version`. A Server of that revision may reject the header it
   * never defined, so omission is a protocol requirement, not an omission of convenience.
   */
  it("omits the header for 2025-03-26 while keeping the session header", async () => {
    const { fetcher, sent } = recordingFetcher(() => accepted());
    await notification(new McpTransport({ fetcher }), "2025-03-26");

    expect(header(sent[0] as Exchange, "MCP-Protocol-Version")).toBeUndefined();
    expect(header(sent[0] as Exchange, "mcp-session-id")).toBe(SESSION);
    expect(header(sent[0] as Exchange, "authorization")).toBe("Bearer upstream");
  });

  it("sends no version and no session header when neither is known", async () => {
    const { fetcher, sent } = recordingFetcher(() => accepted());
    await new McpTransport({ fetcher }).notifyLegacy(ACCOUNT, ENDPOINT, "notifications/initialized", {});

    expect(header(sent[0] as Exchange, "MCP-Protocol-Version")).toBeUndefined();
    expect(header(sent[0] as Exchange, "mcp-session-id")).toBeUndefined();
  });
});

describe("a rejected notification", () => {
  const MARKER = "upstream-body-marker-9f3c";

  it("is a bounded transport failure that carries no upstream body", async () => {
    const { fetcher } = recordingFetcher(() => json(400, { message: MARKER }));
    const failed = notification(new McpTransport({ fetcher }), "2025-06-18");

    await expect(failed).rejects.toBeInstanceOf(McpTransportError);
    const error = await failed.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpTransportError);
    expect((error as McpTransportError).code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect((error as McpTransportError).status).toBe(400);
    expect((error as McpTransportError).message).toContain("400");
    expect((error as McpTransportError).message).not.toContain(MARKER);
    // Bounded, so a summary can never become a raw upstream payload.
    expect((error as McpTransportError).message.length).toBeLessThanOrEqual(200);
  });

  it("reports a rejected credential as the credential-free summary, never as success", async () => {
    const { fetcher } = recordingFetcher(() => json(401, { message: "token abc123 expired" }));
    const error = await notification(new McpTransport({ fetcher }), "2025-06-18").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpTransportError);
    expect((error as McpTransportError).status).toBe(401);
    expect((error as McpTransportError).message).toBe(MCP_AUTH_REJECTION_SUMMARY);
  });

  it.each([200, 202, 204])("accepts HTTP %i as success", async (status) => {
    const { fetcher } = recordingFetcher(() => ({ status, headers: new Headers(), text: "" }));
    await expect(notification(new McpTransport({ fetcher }), "2025-06-18")).resolves.toBeUndefined();
  });
});

function toolCall(fetcher: McpOutboundFetcher, overrides: Record<string, unknown> = {}) {
  return new McpUpstreamCaller({ fetcher }).call({
    accountId: ACCOUNT,
    url: ENDPOINT,
    authHeaders: { authorization: "Bearer upstream" },
    method: "tools/call",
    params: { name: "create_issue", arguments: {} },
    name: "create_issue",
    cachedEra: "legacy",
    cachedVersion: "2025-06-18",
    ...overrides,
  });
}

describe("the gateway's legacy handshake", () => {
  it("notifies at the revision the handshake negotiated, before the call", async () => {
    const { fetcher, sent } = recordingFetcher((exchange) =>
      exchange.method === "initialize"
        ? handshake("2025-06-18")
        : exchange.method === "notifications/initialized"
          ? accepted()
          : json(200, { jsonrpc: "2.0", id: exchange.body.id, result: { content: [] } }),
    );
    await toolCall(fetcher);

    expect(sent.map((exchange) => exchange.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(header(sent[1] as Exchange, "MCP-Protocol-Version")).toBe("2025-06-18");
    expect(header(sent[1] as Exchange, "mcp-session-id")).toBe(SESSION);
    expect(header(sent[1] as Exchange, "authorization")).toBe("Bearer upstream");
    // The call after it speaks the same revision, so both requests agree.
    expect(header(sent[2] as Exchange, "MCP-Protocol-Version")).toBe("2025-06-18");
  });

  it("notifies without a version header when the handshake negotiated 2025-03-26", async () => {
    const { fetcher, sent } = recordingFetcher((exchange) =>
      exchange.method === "initialize"
        ? handshake("2025-03-26")
        : exchange.method === "notifications/initialized"
          ? accepted()
          : json(200, { jsonrpc: "2.0", id: exchange.body.id, result: { content: [] } }),
    );
    await toolCall(fetcher, { cachedVersion: "2025-03-26" });

    expect(sent.map((exchange) => exchange.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(header(sent[1] as Exchange, "MCP-Protocol-Version")).toBeUndefined();
    expect(header(sent[1] as Exchange, "mcp-session-id")).toBe(SESSION);
  });

  /*
   * A tool call must never be dispatched on a handshake the peer rejected half-way through: the
   * notification is part of the handshake, so a refused notification ends the attempt. The marker
   * proves the reason is bounded and redacted rather than the upstream text.
   */
  it("fails the call when the notification is refused, and dispatches no tool call", async () => {
    const MARKER = "notification-refused-4a71";
    const { fetcher, sent } = recordingFetcher((exchange) =>
      exchange.method === "initialize" ? handshake("2025-06-18") : json(500, { message: MARKER }),
    );
    const error = await toolCall(fetcher).catch((caught: unknown) => caught);

    expect(sent.map((exchange) => exchange.method)).toEqual(["initialize", "notifications/initialized"]);
    expect(error).toBeInstanceOf(McpTransportError);
    expect((error as McpTransportError).code).toBe(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect((error as McpTransportError).status).toBe(500);
    expect((error as McpTransportError).message).toContain("500");
    expect((error as McpTransportError).message).not.toContain(MARKER);
  });
});

function probe(fetcher: McpOutboundFetcher, overrides: Record<string, unknown> = {}) {
  return new McpProbe({ fetcher }).probe({
    accountId: ACCOUNT,
    url: ENDPOINT,
    authHeaders: { authorization: "Bearer upstream" },
    cachedEra: "legacy",
    cachedVersion: "2025-06-18",
    ...overrides,
  });
}

describe("the probe's legacy handshake", () => {
  it("notifies at the negotiated revision before listing tools", async () => {
    const { fetcher, sent } = recordingFetcher((exchange) => {
      if (exchange.method === "initialize") return handshake("2025-11-25");
      if (exchange.method === "notifications/initialized") return accepted();
      return json(200, { jsonrpc: "2.0", id: exchange.body.id, result: { tools: [{ name: "legacy-tool" }] } });
    });
    const result = await probe(fetcher);

    expect(sent.map((exchange) => exchange.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(header(sent[1] as Exchange, "MCP-Protocol-Version")).toBe("2025-11-25");
    expect(header(sent[1] as Exchange, "mcp-session-id")).toBe(SESSION);
    expect(result.probeState).toBe("succeeded");
    expect(result.protocolVersion).toBe("2025-11-25");
  });

  /*
   * The legacy path may not speak a modern revision: the modern version in the supported set is what
   * put `2026-07-28` on a handshake-based session in the first place. The notification follows the
   * same rule, so an unrecognized handshake reply notifies with no version header.
   */
  it("notifies without a version header when the handshake names no legacy revision", async () => {
    const { fetcher, sent } = recordingFetcher((exchange) => {
      if (exchange.method === "initialize") return handshake("2026-07-28");
      if (exchange.method === "notifications/initialized") return accepted();
      return json(200, { jsonrpc: "2.0", id: exchange.body.id, result: { tools: [{ name: "legacy-tool" }] } });
    });
    const result = await probe(fetcher);

    expect(header(sent[1] as Exchange, "MCP-Protocol-Version")).toBeUndefined();
    expect(result.probeState).toBe("succeeded");
  });

  it("reports a refused notification as a failed probe with no tool listing after it", async () => {
    const MARKER = "probe-notification-refused-8b02";
    const { fetcher, sent } = recordingFetcher((exchange) => {
      if (exchange.method === "initialize") return handshake("2025-06-18");
      return json(503, { message: MARKER });
    });
    const result = await probe(fetcher);

    expect(sent.map((exchange) => exchange.method)).toEqual(["initialize", "notifications/initialized"]);
    expect(result.probeState).toBe("failed");
    expect(result.probeError).toContain(MCP_ERROR_CODES.UPSTREAM_ERROR);
    expect(result.probeError).toContain("503");
    expect(result.probeError).not.toContain(MARKER);
    expect(result.eraInvalidated).toBe(false);
  });
});
