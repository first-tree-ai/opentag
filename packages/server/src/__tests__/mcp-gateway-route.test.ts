import { MCP_GATEWAY_PATH } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { registerMcpGatewayRoutes } from "../api/mcp-gateway.js";
import { createApp } from "../app.js";
import { McpGatewayError, type McpGatewayExecutionAuthorizer } from "../runtime-credentials/mcp-gateway-execution.js";
import { RuntimeMcpGatewayTokenStore } from "../runtime-credentials/mcp-gateway-token-store.js";
import { LiveMcpServicePolicy } from "../runtime-credentials/mcp-policy.js";
import type { RuntimeExecutionRecord } from "../runtime-credentials/types.js";
import { MCP_ERROR_CODES, McpServiceError } from "../services/mcp/errors.js";
import type { McpGatewayService } from "../services/mcp/mcp-gateway-service.js";

/**
 * The route's own contract: which status each refusal carries, and that every body stays JSON-RPC.
 *
 * An MCP client cannot read OpenTag's `{ error: { code, category } }` envelope, so a refusal that
 * escaped into the app's error handler would be unreadable to the only caller this route has.
 */

const ACCOUNT = "account-1";
const AGENT = "agent-1";

function harness(
  options: {
    authorize?: McpGatewayExecutionAuthorizer["authorize"];
    catalog?: McpGatewayService["catalog"];
    callTool?: McpGatewayService["callTool"];
  } = {},
) {
  const tokens = new RuntimeMcpGatewayTokenStore();
  const app = createApp({});
  const authorizer = {
    authorize:
      options.authorize ??
      (async () => ({ accountId: ACCOUNT, agentId: AGENT, purpose: "execution" }) as RuntimeExecutionRecord),
  } as McpGatewayExecutionAuthorizer;
  const service = {
    catalog: options.catalog ?? vi.fn(async () => ({ tools: [], notes: [] })),
    callTool: options.callTool ?? vi.fn(async () => ({ result: { content: [] } })),
  } as unknown as McpGatewayService;
  registerMcpGatewayRoutes(app, { tokens, authorizer, service });
  const { token } = tokens.issue({ executionId: "exec-1", expiresAt: Date.now() + 600_000 });
  return { app, tokens, token };
}

async function post(
  app: ReturnType<typeof createApp>,
  token: string | undefined,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: "POST",
    url: MCP_GATEWAY_PATH,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    payload: payload as never,
  });
  return { status: response.statusCode, body: (response.body ? response.json() : {}) as Record<string, unknown> };
}

describe("authentication", () => {
  it("refuses a missing, malformed, empty, and unknown bearer alike", async () => {
    const { app, token } = harness();
    for (const bearer of [undefined, "", "not-a-token"]) {
      const response = await post(app, bearer, { jsonrpc: "2.0", id: 1, method: "ping" });
      expect(response.status).toBe(401);
      // JSON-RPC shaped, not OpenTag's error envelope: the caller is an MCP client.
      expect(response.body.jsonrpc).toBe("2.0");
      expect(response.body.error).toBeDefined();
    }
    expect((await post(app, token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
    await app.close();
  });

  it("refuses a Basic authorization header", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "POST",
      url: MCP_GATEWAY_PATH,
      headers: { authorization: "Basic abc", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "ping" } as never,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("request shape", () => {
  /* Valid JSON that is not a JSON-RPC request: the structure is wrong, so `-32600`. */
  it("rejects a body that is not a JSON-RPC request", async () => {
    const { app, token } = harness();
    for (const payload of [{ jsonrpc: "1.0", method: "ping" }, { jsonrpc: "2.0" }, [], 5]) {
      const response = await post(app, token, payload);
      expect(response.status).toBe(400);
      expect((response.body.error as { code: number }).code).toBe(-32600);
    }
    await app.close();
  });

  /*
   * Bytes Fastify's parser rejects never reach the handler, so without the route's own error handler
   * they would escape as OpenTag's `{ error: { code, category } }` envelope — which the only caller
   * this route has cannot read. `-32700` is the parse error, distinct from the structural `-32600`.
   */
  it("answers an unparseable body in JSON-RPC rather than OpenTag's envelope", async () => {
    const { app, token } = harness();
    const response = await app.inject({
      method: "POST",
      url: MCP_GATEWAY_PATH,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: "not json at all",
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    expect((body.error as { code: number }).code).toBe(-32700);
    await app.close();
  });

  it("answers a body past the size bound in JSON-RPC too", async () => {
    const { app, token } = harness();
    const response = await app.inject({
      method: "POST",
      url: MCP_GATEWAY_PATH,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect((response.json() as Record<string, unknown>).jsonrpc).toBe("2.0");
    await app.close();
  });

  it("acknowledges a notification with 202 and no body", async () => {
    const { app, token } = harness();
    const response = await post(app, token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    await app.close();
  });

  it("marks every response uncacheable", async () => {
    const { app, token } = harness();
    const response = await app.inject({
      method: "POST",
      url: MCP_GATEWAY_PATH,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "ping" } as never,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });
});

describe("fence refusals map to a deterministic status", () => {
  it.each([
    ["execution_unknown", 404],
    ["execution_closed", 409],
    ["scope_denied", 403],
    ["unauthenticated", 401],
    ["timeout", 504],
  ] as const)("answers %s with %i", async (code, status) => {
    const { app, token } = harness({
      authorize: async () => {
        throw new McpGatewayError(code, "refused");
      },
    });
    const response = await post(app, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(status);
    expect(response.body.jsonrpc).toBe("2.0");
    await app.close();
  });
});

describe("service failures", () => {
  /* A catalogue failure propagates: a client that cannot list tools has nothing to act on. */
  it("answers a catalogue failure with a transport error", async () => {
    const { app, token } = harness({
      catalog: (async () => {
        throw new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "upstream down");
      }) as unknown as McpGatewayService["catalog"],
    });
    const response = await post(app, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(502);
    expect(response.body.error).toBeDefined();
    await app.close();
  });

  /*
   * A tool-call failure does not: by then the model is mid-turn, and an `isError` result is
   * something it can read and recover from where a transport error would end the turn.
   */
  it("answers a tool-call failure with an isError result", async () => {
    const { app, token } = harness({
      callTool: (async () => {
        throw new McpServiceError(MCP_ERROR_CODES.AUTHORIZATION_REQUIRED, "not authorized");
      }) as unknown as McpGatewayService["callTool"],
    });
    const response = await post(app, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "linear__x", arguments: {} },
    });
    expect(response.status).toBe(200);
    expect(response.body.error).toBeUndefined();
    expect((response.body.result as { isError: boolean }).isError).toBe(true);
    await app.close();
  });

  it("redacts an unexpected tool-call failure rather than echoing it", async () => {
    const { app, token } = harness({
      callTool: (async () => {
        throw new Error("postgres://user:secret@host/db exploded");
      }) as unknown as McpGatewayService["callTool"],
    });
    const response = await post(app, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "linear__x" },
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
    await app.close();
  });

  it("answers an unexpected catalogue failure with a bounded internal error", async () => {
    const { app, token } = harness({
      catalog: (async () => {
        throw new Error("boom");
      }) as unknown as McpGatewayService["catalog"],
    });
    const response = await post(app, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(500);
    expect((response.body.error as { message: string }).message).toBe("Internal error");
    await app.close();
  });
});

describe("the service policy", () => {
  it("grants the service only when the Agent has a usable mount", async () => {
    const granted = new LiveMcpServicePolicy({ hasUsableMount: async () => true });
    const denied = new LiveMcpServicePolicy({ hasUsableMount: async () => false });
    expect(await granted.authorizeMcp({ accountId: ACCOUNT, agentId: AGENT })).toEqual(["mcp:tools"]);
    expect(await denied.authorizeMcp({ accountId: ACCOUNT, agentId: AGENT })).toBeUndefined();
  });

  /* Per Agent, never per Account: an Account-level answer would lend one Agent another's credential. */
  it("asks about the exact Agent", async () => {
    const hasUsableMount = vi.fn(async () => true);
    await new LiveMcpServicePolicy({ hasUsableMount }).authorizeMcp({ accountId: ACCOUNT, agentId: AGENT });
    expect(hasUsableMount).toHaveBeenCalledWith(ACCOUNT, AGENT);
  });
});
