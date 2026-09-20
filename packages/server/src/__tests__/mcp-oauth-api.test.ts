/*
 * The two unauthenticated MCP paths: the OAuth callback and the client metadata document.
 *
 * Both are reachable without a session, so what is asserted here is the boundary: only a bounded
 * public code ever reaches the browser, the flow cookie is read once and cleared on every path, the
 * CIMD document derives `client_id` from the configured origin rather than from the request, and an
 * upstream's own words never echo back.
 */

import { MCP_CLIENT_METADATA_PATH, MCP_ERROR_CODES, MCP_OAUTH_CALLBACK_PATH } from "@opentag/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";
import { registerMcpOAuthRoutes } from "../api/mcp-oauth.js";
import { BROWSER_COOKIE_NAMES } from "../services/auth/browser-cookies.js";
import { McpServiceError } from "../services/mcp/errors.js";
import type { McpOAuthFlowService } from "../services/mcp/index.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";
const PUBLIC_ORIGIN = "https://opentag.example.com";
const FLOW_SECRET = "flow-secret-value";

const apps: FastifyInstance[] = [];

interface Harness {
  app: FastifyInstance;
  flows: {
    callback: ReturnType<typeof vi.fn>;
    redirectFor: ReturnType<typeof vi.fn>;
  };
  onCredentialStored: ReturnType<typeof vi.fn>;
}

function build(options: { secureCookies?: boolean; withProbeHook?: boolean } = {}): Harness {
  const flows = {
    callback: vi.fn(async () => ({ accountId: ACCOUNT, agentId: AGENT, mcpServerId: SERVER })),
    redirectFor: vi.fn(
      (agentId: string, mcpServerId: string, errorCode?: string) =>
        `${PUBLIC_ORIGIN}/agents/${agentId}/mcp?server=${mcpServerId}&mcp_oauth=${errorCode ? "error" : "success"}`,
    ),
  };
  const onCredentialStored = vi.fn();
  const app = Fastify({ logger: false });
  registerMcpOAuthRoutes(app, {
    flows: flows as unknown as McpOAuthFlowService,
    publicOrigin: PUBLIC_ORIGIN,
    secureCookies: options.secureCookies ?? false,
    ...(options.withProbeHook === false ? {} : { onCredentialStored }),
  });
  apps.push(app);
  return { app, flows, onCredentialStored };
}

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function locationOf(response: { headers: Record<string, unknown> }): URL {
  return new URL(String(response.headers.location));
}

async function callback(
  app: FastifyInstance,
  query: Record<string, string>,
  cookie?: string,
): Promise<{ location: URL; response: Awaited<ReturnType<FastifyInstance["inject"]>>; setCookie: string[] }> {
  const response = await app.inject({
    method: "GET",
    url: `${MCP_OAUTH_CALLBACK_PATH}?${new URLSearchParams(query)}`,
    ...(cookie ? { headers: { cookie } } : {}),
  });
  const raw = response.headers["set-cookie"];
  return {
    location: locationOf(response as never),
    response,
    setCookie: raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)],
  };
}

describe("MCP OAuth callback", () => {
  it("hands the state and the browser binding to the flow and redirects to the Agent's page", async () => {
    const { app, flows, onCredentialStored } = build();
    const { location, response } = await callback(
      app,
      { code: "code-1", state: "state-1", iss: "https://auth.example.com" },
      `${BROWSER_COOKIE_NAMES.mcpOAuthContext}=${FLOW_SECRET}`,
    );
    expect(response.statusCode).toBe(302);
    expect(location.pathname).toBe(`/agents/${AGENT}/mcp`);
    expect(location.searchParams.get("mcp_oauth")).toBe("success");
    expect(location.searchParams.get("server")).toBe(SERVER);
    // The callback has no session: the flow proved which pair and which Account it belongs to.
    expect(flows.callback).toHaveBeenCalledWith(
      { code: "code-1", state: "state-1", iss: "https://auth.example.com" },
      FLOW_SECRET,
    );
    // The probe is fired backstage, not awaited into the browser's redirect.
    expect(onCredentialStored).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER);
  });

  it("omits the optional query fields it was not given", async () => {
    const { app, flows } = build();
    await callback(app, { state: "state-1" }, `${BROWSER_COOKIE_NAMES.mcpOAuthContext}=${FLOW_SECRET}`);
    expect(flows.callback).toHaveBeenCalledWith({ state: "state-1" }, FLOW_SECRET);
  });

  it("clears the flow cookie on every path, including a success", async () => {
    const { app } = build();
    const { setCookie } = await callback(
      app,
      { code: "code-1", state: "state-1" },
      `${BROWSER_COOKIE_NAMES.mcpOAuthContext}=${FLOW_SECRET}`,
    );
    const cleared = setCookie.find((entry) => entry.startsWith(BROWSER_COOKIE_NAMES.mcpOAuthContext));
    // Single use by construction: a reload of the callback URL must not try again with the binding.
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain(`Path=${MCP_OAUTH_CALLBACK_PATH}`);
    expect(cleared).toContain("HttpOnly");
  });

  it("marks the cleared cookie Secure on a deployment that requires it", async () => {
    const { app } = build({ secureCookies: true });
    const { setCookie } = await callback(app, { state: "state-1" });
    expect(setCookie.join(";")).toContain("Secure");
  });

  it("accepts a callback with no cookie at all and lets the flow refuse it", async () => {
    const { app, flows } = build();
    flows.callback.mockRejectedValue(new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "not this browser"));
    const { location, response } = await callback(app, { state: "state-1" });
    expect(response.statusCode).toBe(302);
    expect(location.searchParams.get("mcp_oauth")).toBe("error");
    // Nothing was identified, so the outcome lands on the Agent list with the bounded code.
    expect(location.pathname).toBe("/agents");
    expect(location.searchParams.get("mcp_oauth_error")).toBe(MCP_ERROR_CODES.OAUTH_FLOW_INVALID);
    expect(flows.redirectFor).not.toHaveBeenCalled();
  });

  it("falls back to the Agent list when the failure happened before a flow was identified", async () => {
    /*
     * With no Agent and no Server there is no page to land on, and an unauthenticated callback must
     * still end somewhere bounded on this origin.
     */
    const { app, flows } = build();
    flows.callback.mockRejectedValue(new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED, "expired"));
    const { location, response } = await callback(app, { state: "state-1" });
    expect(response.statusCode).toBe(302);
    expect(location.pathname).toBe("/agents");
    expect(location.searchParams.get("mcp_oauth")).toBe("error");
    expect(location.searchParams.get("mcp_oauth_error")).toBe(MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED);
  });

  it("lands a failure that happened after the pair was known on that Agent's page", async () => {
    /*
     * A failure after the flow resolved — here the backstage probe hook throwing — still knows which
     * Agent and Server the user was working on, so the outcome lands on that page with the bounded
     * code rather than on the Agent list.
     */
    const { app, onCredentialStored } = build();
    onCredentialStored.mockImplementation(() => {
      throw new McpServiceError(MCP_ERROR_CODES.PROBE_FAILED, "the probe hook is misbehaving");
    });
    const { location } = await callback(app, { code: "c", state: "s" }, `${BROWSER_COOKIE_NAMES.mcpOAuthContext}=x`);
    expect(location.pathname).toBe(`/agents/${AGENT}/mcp`);
    expect(location.searchParams.get("server")).toBe(SERVER);
    expect(location.searchParams.get("mcp_oauth")).toBe("error");
    expect(location.searchParams.get("mcp_oauth_error")).toBe(MCP_ERROR_CODES.PROBE_FAILED);
  });

  it("leaves the Server parameter off that page when the flow reported none", async () => {
    const { app, flows, onCredentialStored } = build();
    flows.callback.mockResolvedValue({ accountId: ACCOUNT, agentId: AGENT, mcpServerId: undefined });
    onCredentialStored.mockImplementation(() => {
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FAILED, "no Server on the row");
    });
    const { location } = await callback(app, { code: "c", state: "s" });
    expect(location.pathname).toBe(`/agents/${AGENT}/mcp`);
    expect(location.searchParams.get("server")).toBeNull();
    expect(location.searchParams.get("mcp_oauth_error")).toBe(MCP_ERROR_CODES.OAUTH_FAILED);
  });

  it.each([
    ["access_denied", MCP_ERROR_CODES.OAUTH_DENIED],
    ["access_denied2", MCP_ERROR_CODES.OAUTH_FAILED],
  ])("maps the %s denial to the bounded code %s", async (error, expected) => {
    const { app, flows } = build();
    flows.callback.mockRejectedValue(new McpServiceError(expected, "the authorization was not granted"));
    const { location } = await callback(app, { state: "state-1", error }, `${BROWSER_COOKIE_NAMES.mcpOAuthContext}=x`);
    expect(location.searchParams.get("mcp_oauth_error")).toBe(expected);
  });

  it("reports an unexpected failure as a bounded OAuth failure, never with the thrown message", async () => {
    const { app, flows } = build();
    flows.callback.mockRejectedValue(new Error("postgres://user:secret@host/db exploded"));
    const { location } = await callback(app, { state: "state-1" }, `${BROWSER_COOKIE_NAMES.mcpOAuthContext}=x`);
    expect(location.searchParams.get("mcp_oauth_error")).toBe(MCP_ERROR_CODES.OAUTH_FAILED);
    expect(location.toString()).not.toContain("secret");
  });

  it("refuses a callback whose query fails its schema and never calls the flow", async () => {
    const { app, flows } = build();
    for (const query of [
      {},
      { state: "" },
      { state: "state-1", error_description: "d".repeat(2049) },
      { state: "state-1", code: "c".repeat(8193) },
      { state: "state-1", surprise: "1" },
    ]) {
      const { location, response } = await callback(app, query);
      expect(response.statusCode, JSON.stringify(query)).toBe(302);
      expect(location.searchParams.get("mcp_oauth_error")).toBe(MCP_ERROR_CODES.OAUTH_FAILED);
    }
    expect(flows.callback).not.toHaveBeenCalled();
  });

  it("discards the authorization server's own error description", async () => {
    const { app, flows } = build();
    flows.callback.mockRejectedValue(new McpServiceError(MCP_ERROR_CODES.OAUTH_DENIED, "denied"));
    // Accepted and bounded, then dropped: a peer's prose must never reach the browser.
    const { location } = await callback(
      app,
      { state: "state-1", error: "access_denied", error_description: "<script>alert(1)</script>" },
      `${BROWSER_COOKIE_NAMES.mcpOAuthContext}=x`,
    );
    expect(location.searchParams.get("mcp_oauth_error")).toBe(MCP_ERROR_CODES.OAUTH_DENIED);
    expect(location.toString()).not.toContain("script");
    expect(flows.callback).toHaveBeenCalledWith({ state: "state-1", error: "access_denied" }, expect.any(String));
  });

  it("still completes when no probe hook is wired", async () => {
    const { app } = build({ withProbeHook: false });
    const { response } = await callback(app, { code: "c", state: "s" });
    expect(response.statusCode).toBe(302);
  });
});

describe("MCP client metadata document", () => {
  it("publishes this deployment's own client id and callback, cacheable for an hour", async () => {
    const { app } = build();
    const response = await app.inject({ method: "GET", url: MCP_CLIENT_METADATA_PATH });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.json()).toEqual({
      client_id: `${PUBLIC_ORIGIN}${MCP_CLIENT_METADATA_PATH}`,
      client_name: "OpenTag",
      redirect_uris: [`${PUBLIC_ORIGIN}${MCP_OAUTH_CALLBACK_PATH}`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
    // The document is public by specification: nothing in it is a secret or names an Account.
    expect(JSON.stringify(response.json())).not.toContain(ACCOUNT);
  });

  it("derives the client id from the configured origin, not from a spoofed Host header", async () => {
    /*
     * `client_id` must be this exact URL. Reading it off the request would let a forged Host change
     * what the document claims to be — and the document is what an authorization server trusts.
     */
    const { app } = build();
    const response = await app.inject({
      method: "GET",
      url: MCP_CLIENT_METADATA_PATH,
      headers: { host: "attacker.example.com", "x-forwarded-host": "attacker.example.com" },
    });
    expect(response.json().client_id).toBe(`${PUBLIC_ORIGIN}${MCP_CLIENT_METADATA_PATH}`);
    expect(response.json().redirect_uris).toEqual([`${PUBLIC_ORIGIN}${MCP_OAUTH_CALLBACK_PATH}`]);
  });
});
