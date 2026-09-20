/*
 * The Account-facing MCP management HTTP surface.
 *
 * Every route runs through the real application: the real `createUserAuthPreHandler`, the parameter
 * schemas registered on the route, `parseRequest`'s `VALIDATION_ERROR` envelope, and the shared
 * `McpServiceError` mapping. The services behind the routes are fakes, because the domain rules have
 * their own suites — what is asserted here is the wire contract a client depends on: which status
 * each outcome carries, which body shape comes back, and that no credential material ever does.
 *
 * `app.inject` rather than calling the handler functions directly, because the schemas only run in a
 * real request pipeline.
 */

import {
  AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE,
  AGENT_MCP_AUTHORIZATION_TEMPLATE,
  AGENT_MCP_PROBE_TEMPLATE,
  AGENT_MCP_SERVER_TEMPLATE,
  AGENT_MCP_SERVERS_TEMPLATE,
  MCP_ERROR_CODES,
  MCP_OAUTH_CALLBACK_PATH,
  MCP_SERVERS_PATH as MCP_SERVERS_PATH_TEMPLATE,
} from "@opentag/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";
import { registerMcpServerRoutes } from "../api/mcp-servers.js";
import { createApp } from "../app.js";
import { BROWSER_COOKIE_NAMES } from "../services/auth/browser-cookies.js";
import type { UserAuthService } from "../services/auth/index.js";
import { McpServiceError } from "../services/mcp/errors.js";
import type { McpAuthorizationService, McpOAuthFlowService, McpServerService } from "../services/mcp/index.js";
import { signedInBrowser } from "./signed-in-browser.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";
const PUBLIC_ORIGIN = "https://opentag.example.com";
const ACCESS_HEADER = { authorization: "Bearer access-token" };
const SESSION_COOKIE = { cookie: `${BROWSER_COOKIE_NAMES.csrf}=csrf-token; opentag.session_token=session-token` };
const VALIDATION_ERROR = "VALIDATION_ERROR";

/**
 * The published path templates with this file's fixed ids substituted.
 *
 * Built from the constants rather than written out, so a route that moved would move here too and the
 * tests would still be addressed at the route the client uses.
 */
const MCP_SERVERS_PATH = MCP_SERVERS_PATH_TEMPLATE;
const AGENT_MCP_SERVERS_TEMPLATE_PATH = AGENT_MCP_SERVERS_TEMPLATE.replace(":agentId", AGENT);
const AGENT_MCP_SERVER_TEMPLATE_PATH = AGENT_MCP_SERVER_TEMPLATE.replace(":agentId", AGENT).replace(
  ":mcpServerId",
  SERVER,
);
const AGENT_MCP_AUTHORIZATION_TEMPLATE_PATH = AGENT_MCP_AUTHORIZATION_TEMPLATE.replace(":agentId", AGENT).replace(
  ":mcpServerId",
  SERVER,
);
const AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE_PATH = AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE.replace(
  ":agentId",
  AGENT,
).replace(":mcpServerId", SERVER);
const AGENT_MCP_PROBE_TEMPLATE_PATH = AGENT_MCP_PROBE_TEMPLATE.replace(":agentId", AGENT).replace(
  ":mcpServerId",
  SERVER,
);

/** A safe Server DTO: the exact shape `MCPServerSchema` admits, and nothing credential-shaped. */
const SERVER_DTO = {
  id: SERVER,
  name: "docs",
  description: null,
  url: "https://mcp.example.com/mcp",
  defaultAuthKind: "oauth" as const,
  authHeader: "authorization",
  authScheme: "Bearer",
  extraHeaders: {},
  revision: 1,
  boundAgentCount: 0,
  authorizedAgentCount: 0,
  lastProbedAt: null,
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const AGENT_SERVER_DTO = {
  mcpServerId: SERVER,
  name: "docs",
  description: null,
  discoveredDescription: null,
  enabled: true,
  effective: {
    url: "https://mcp.example.com/mcp",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
  },
  overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
  authorization: null,
  snapshot: null,
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const AVAILABLE_SERVER_DTO = {
  id: SERVER,
  name: "docs",
  description: null,
  boundAgentCount: 0,
};

const PROBE_OUTCOME = {
  probeState: "failed" as const,
  probeError: `${MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE}: the Server did not answer`,
  toolsCount: null,
  toolsTruncated: false,
  protocolEra: null,
  protocolVersion: null,
};

interface Harness {
  app: FastifyInstance;
  authorization: {
    probe: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    setBearerOrNone: ReturnType<typeof vi.fn>;
  };
  flows: { redirectFor: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
  servers: Record<
    | "attachServer"
    | "createServer"
    | "deleteServer"
    | "detachServer"
    | "getServerDetail"
    | "listAgentServers"
    | "listAvailableServers"
    | "listServers"
    | "readAgentServer"
    | "requireAgentBinding"
    | "updateBinding"
    | "updateServer",
    ReturnType<typeof vi.fn>
  >;
}

const apps: FastifyInstance[] = [];

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    updateSelfProfile: vi.fn(),
    getActiveUserById: vi.fn(async () => ({
      user: { id: ACCOUNT, email: "owner@example.com", displayName: "Owner" },
      setupCompletedAt: null,
    })),
    getAuthenticatedUser: vi.fn(async () => ({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: ACCOUNT, email: "owner@example.com", displayName: "Owner" },
        setupCompletedAt: null,
      },
    })),
  };
}

function build(options: { secureCookies?: boolean } = {}): Harness {
  const servers = {
    attachServer: vi.fn(async () => AGENT_SERVER_DTO),
    createServer: vi.fn(async () => SERVER_DTO),
    deleteServer: vi.fn(async () => undefined),
    detachServer: vi.fn(async () => undefined),
    getServerDetail: vi.fn(async () => ({ server: SERVER_DTO, agents: [] })),
    // Both list helpers return the array itself; the route wraps it in the response envelope.
    listAgentServers: vi.fn(async () => [AGENT_SERVER_DTO]),
    // The chooser DTO is narrower than the full Server DTO, and the response schema is strict.
    listAvailableServers: vi.fn(async () => [AVAILABLE_SERVER_DTO]),
    listServers: vi.fn(async () => [SERVER_DTO]),
    readAgentServer: vi.fn(async () => AGENT_SERVER_DTO),
    requireAgentBinding: vi.fn(async () => ({ agentId: AGENT, mcpServerId: SERVER })),
    updateBinding: vi.fn(async () => AGENT_SERVER_DTO),
    updateServer: vi.fn(async () => SERVER_DTO),
  };
  const authorization = {
    probe: vi.fn(async () => PROBE_OUTCOME),
    revoke: vi.fn(async () => undefined),
    setBearerOrNone: vi.fn(async () => undefined),
  };
  const flows = {
    redirectFor: vi.fn(() => `${PUBLIC_ORIGIN}/agents/${AGENT}/mcp?server=${SERVER}&mcp_oauth=success`),
    start: vi.fn(async () => ({
      authorizationUrl: "https://auth.example.com/authorize?state=s1",
      expiresAt: new Date("2026-09-16T00:10:00.000Z"),
    })),
  };
  const app = createApp({
    authService: authService(),
    loggerStream: { write: () => undefined },
    // A cookie request is a browser request, so the preHandler needs the origin to check its
    // double-submit fence; without it the browser path would never authenticate at all.
    browserAuth: {
      publicOrigin: PUBLIC_ORIGIN,
      secureCookies: false,
      sessionTtlSeconds: 600,
      providers: [],
      devLoginEnabled: false,
    } as never,
    mcp: {
      authorization: authorization as unknown as McpAuthorizationService,
      flows: flows as unknown as McpOAuthFlowService,
      servers: servers as unknown as McpServerService,
      publicOrigin: PUBLIC_ORIGIN,
      secureCookies: options.secureCookies ?? false,
    },
  });
  apps.push(app);
  return { app, authorization, flows, servers };
}

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function send(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  options: { payload?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await app.inject({
    method,
    url,
    headers: { ...ACCESS_HEADER, ...options.headers },
    ...(options.payload === undefined ? {} : { payload: options.payload as never }),
  });
  return {
    body: response.body ? (response.json() as Record<string, unknown>) : {},
    response,
    status: response.statusCode,
  };
}

describe("MCP Server definition pool", () => {
  it("lists the Account's definitions without caching them", async () => {
    const { app, servers } = build();
    const { body, response, status } = await send(app, "GET", MCP_SERVERS_PATH);
    expect(status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(body).toEqual({ servers: [SERVER_DTO] });
    expect(servers.listServers).toHaveBeenCalledWith(ACCOUNT);
  });

  it("creates a definition with 201 and the parsed safe DTO", async () => {
    const { app, servers } = build();
    const { body, status } = await send(app, "POST", MCP_SERVERS_PATH, {
      payload: { name: "docs", url: "https://mcp.example.com/mcp", defaultAuthKind: "oauth" },
    });
    expect(status).toBe(201);
    expect(body).toEqual(SERVER_DTO);
    expect(servers.createServer).toHaveBeenCalledWith(ACCOUNT, {
      name: "docs",
      url: "https://mcp.example.com/mcp",
      defaultAuthKind: "oauth",
    });
  });

  it("reads one definition's detail without caching it", async () => {
    const { app, servers } = build();
    const { body, response, status } = await send(app, "GET", `${MCP_SERVERS_PATH}/${SERVER}`);
    expect(status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(body).toEqual({ server: SERVER_DTO, agents: [] });
    expect(servers.getServerDetail).toHaveBeenCalledWith(ACCOUNT, SERVER);
  });

  it("edits a definition and passes the revision CAS through untouched", async () => {
    const { app, servers } = build();
    const { body, status } = await send(app, "PATCH", `${MCP_SERVERS_PATH}/${SERVER}`, {
      payload: { expectedRevision: 3, description: "Docs" },
    });
    expect(status).toBe(200);
    expect(body).toEqual(SERVER_DTO);
    expect(servers.updateServer).toHaveBeenCalledWith(ACCOUNT, SERVER, { expectedRevision: 3, description: "Docs" });
  });

  it("deletes a definition with 204 and no body", async () => {
    const { app, servers } = build();
    const { body, status } = await send(app, "DELETE", `${MCP_SERVERS_PATH}/${SERVER}`);
    expect(status).toBe(204);
    expect(body).toEqual({});
    expect(servers.deleteServer).toHaveBeenCalledWith(ACCOUNT, SERVER);
  });

  it("refuses a definition path whose id is not a uuid", async () => {
    const { app, servers } = build();
    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      const { body, status } = await send(app, method, `${MCP_SERVERS_PATH}/not-a-uuid`, {
        ...(method === "GET" ? {} : { payload: { expectedRevision: 1 } }),
      });
      expect(status, method).toBe(400);
      expect((body.error as { code: string }).code).toBe(VALIDATION_ERROR);
      // The service was never reached: the schema rejects before the handler runs.
      expect(servers.getServerDetail, method).not.toHaveBeenCalled();
      expect(servers.updateServer, method).not.toHaveBeenCalled();
      expect(servers.deleteServer, method).not.toHaveBeenCalled();
    }
  });

  it("carries a controlled service failure as its own status and code", async () => {
    const { app, servers } = build();
    servers.getServerDetail.mockRejectedValue(
      new McpServiceError(MCP_ERROR_CODES.SERVER_NOT_FOUND, "The requested MCP Server was not found"),
    );
    const { body, status } = await send(app, "GET", `${MCP_SERVERS_PATH}/${SERVER}`);
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: MCP_ERROR_CODES.SERVER_NOT_FOUND, category: "deterministic" });
  });
});

describe("MCP per-Agent mounts", () => {
  it("lists this Agent's mounts without caching them", async () => {
    const { app, servers } = build();
    const { body, response, status } = await send(app, "GET", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}`);
    expect(status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(body).toEqual({ servers: [AGENT_SERVER_DTO] });
    expect(servers.listAgentServers).toHaveBeenCalledWith(ACCOUNT, AGENT);
  });

  it("lists the definitions this Agent has not mounted", async () => {
    const { app, servers } = build();
    const { body, response, status } = await send(app, "GET", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}/available`);
    expect(status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(body).toEqual({ servers: [AVAILABLE_SERVER_DTO] });
    expect(servers.listAvailableServers).toHaveBeenCalledWith(ACCOUNT, AGENT);
  });

  it("mounts a definition with 201", async () => {
    const { app, servers } = build();
    const { body, status } = await send(app, "POST", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}`, {
      payload: { mcpServerId: SERVER, enabled: false },
    });
    expect(status).toBe(201);
    expect(body).toEqual(AGENT_SERVER_DTO);
    expect(servers.attachServer).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER, false);
  });

  it("defaults a mount to enabled when the body omits the flag", async () => {
    const { app, servers } = build();
    await send(app, "POST", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}`, { payload: { mcpServerId: SERVER } });
    expect(servers.attachServer).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER, true);
  });

  it("updates a mount's overrides and enable flag", async () => {
    const { app, servers } = build();
    const { body, status } = await send(app, "PATCH", `${AGENT_MCP_SERVER_TEMPLATE_PATH}`, {
      payload: { clearUrl: true, emptyExtraHeaders: true, enabled: false },
    });
    expect(status).toBe(200);
    expect(body).toEqual(AGENT_SERVER_DTO);
    expect(servers.updateBinding).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER, {
      clearUrl: true,
      emptyExtraHeaders: true,
      enabled: false,
    });
  });

  it("detaches a mount with 204 and no body", async () => {
    const { app, servers } = build();
    const { body, status } = await send(app, "DELETE", `${AGENT_MCP_SERVER_TEMPLATE_PATH}`);
    expect(status).toBe(204);
    expect(body).toEqual({});
    expect(servers.detachServer).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER);
  });

  it("refuses an Agent path whose id is not a uuid", async () => {
    const { app, servers } = build();
    const badAgent = AGENT_MCP_SERVERS_TEMPLATE_PATH.replace(AGENT, "not-a-uuid");
    for (const url of [badAgent, `${badAgent}/available`]) {
      const { body, status } = await send(app, "GET", url);
      expect(status, url).toBe(400);
      expect((body.error as { code: string }).code).toBe(VALIDATION_ERROR);
    }
    expect(servers.listAgentServers).not.toHaveBeenCalled();
    expect(servers.listAvailableServers).not.toHaveBeenCalled();
  });

  it("refuses a nested path whose Server id is not a uuid", async () => {
    const { app, servers } = build();
    const { body, status } = await send(app, "DELETE", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}/not-a-uuid`);
    expect(status).toBe(400);
    expect((body.error as { code: string }).code).toBe(VALIDATION_ERROR);
    expect(servers.detachServer).not.toHaveBeenCalled();
  });

  it("refuses an unknown field in a mount request", async () => {
    const { app, servers } = build();
    const { body, status } = await send(app, "POST", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}`, {
      payload: { mcpServerId: SERVER, surprise: true },
    });
    expect(status).toBe(400);
    expect(JSON.stringify(body.error)).toContain("surprise");
    expect(servers.attachServer).not.toHaveBeenCalled();
  });
});

describe("MCP per-Agent authorization", () => {
  it("writes a Bearer key, fires the probe without awaiting it, and returns the row", async () => {
    const { app, authorization } = build();
    const { body, status } = await send(app, "PUT", `${AGENT_MCP_AUTHORIZATION_TEMPLATE_PATH}`, {
      payload: { kind: "bearer", bearerKey: "sk-secret" },
    });
    expect(status).toBe(200);
    expect(body).toEqual(AGENT_SERVER_DTO);
    expect(authorization.setBearerOrNone).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER, {
      kind: "bearer",
      bearerKey: "sk-secret",
    });
    // The probe runs backstage: the response is not held for an upstream round trip.
    expect(authorization.probe).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER);
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });

  it("writes an anonymous authorization without a key field", async () => {
    const { app, authorization } = build();
    await send(app, "PUT", `${AGENT_MCP_AUTHORIZATION_TEMPLATE_PATH}`, {
      payload: { kind: "none" },
    });
    expect(authorization.setBearerOrNone).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER, { kind: "none" });
  });

  it("still answers 200 when the backstage probe fails", async () => {
    /*
     * The write is what the caller asked for, and it landed. A probe failure is reported through
     * `probeState`/`probeError` on the row the response carries, not as a failed request.
     */
    const { app, authorization } = build();
    authorization.probe.mockRejectedValue(new Error("probe exploded"));
    const { body, status } = await send(app, "PUT", `${AGENT_MCP_AUTHORIZATION_TEMPLATE_PATH}`, {
      payload: { kind: "none" },
    });
    expect(status).toBe(200);
    expect(body).toEqual(AGENT_SERVER_DTO);
    // The rejection is observed rather than escaping as an unhandled rejection.
    await vi.waitFor(() => expect(authorization.probe).toHaveBeenCalled());
  });

  it("revokes an authorization and returns the refreshed row", async () => {
    const { app, authorization } = build();
    const { body, status } = await send(app, "DELETE", `${AGENT_MCP_AUTHORIZATION_TEMPLATE_PATH}`);
    expect(status).toBe(200);
    expect(body).toEqual(AGENT_SERVER_DTO);
    expect(authorization.revoke).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER);
  });

  it("refuses an authorization request that pairs a kind with the wrong key field", async () => {
    const { app, authorization } = build();
    for (const payload of [
      { kind: "bearer" },
      { kind: "none", bearerKey: "sk-secret" },
      { kind: "oauth", bearerKey: "sk-secret" },
    ]) {
      const { body, status } = await send(app, "PUT", `${AGENT_MCP_AUTHORIZATION_TEMPLATE_PATH}`, {
        payload,
      });
      expect(status, JSON.stringify(payload)).toBe(400);
      expect((body.error as { code: string }).code).toBe(VALIDATION_ERROR);
    }
    expect(authorization.setBearerOrNone).not.toHaveBeenCalled();
  });

  it("starts an OAuth flow, sets the flow-binding cookie, and returns the authorization URL", async () => {
    const { app, flows } = build();
    const { body, response, status } = await send(app, "POST", `${AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE_PATH}`, {
      payload: { scopes: ["mcp.read"] },
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      authorizationUrl: "https://auth.example.com/authorize?state=s1",
      expiresAt: "2026-09-16T00:10:00.000Z",
    });
    // A fresh secret per flow, handed to the browser and never returned in the body.
    const secret = flows.start.mock.calls[0]?.[4] as string;
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(20);
    expect(JSON.stringify(body)).not.toContain(secret);
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain(`${BROWSER_COOKIE_NAMES.mcpOAuthContext}=${encodeURIComponent(secret)}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(`Path=${MCP_OAUTH_CALLBACK_PATH}`);
    // Not Secure on a deployment that did not ask for it.
    expect(cookie).not.toContain("Secure");
    expect(flows.start).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER, ["mcp.read"], secret);
  });

  it("marks the flow cookie Secure on a deployment that requires it", async () => {
    const { app } = build({ secureCookies: true });
    const { response } = await send(app, "POST", `${AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE_PATH}`);
    expect(String(response.headers["set-cookie"])).toContain("Secure");
  });

  it("accepts a start request with no body at all", async () => {
    const { app, flows } = build();
    const response = await app.inject({
      method: "POST",
      url: `${AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE_PATH}`,
      headers: ACCESS_HEADER,
    });
    expect(response.statusCode).toBe(200);
    expect(flows.start).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER, [], expect.any(String));
  });

  it("refuses a start request with an unknown field", async () => {
    const { app, flows } = build();
    const { body, status } = await send(app, "POST", `${AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE_PATH}`, {
      payload: { scope: "mcp.read" },
    });
    expect(status).toBe(400);
    expect(JSON.stringify(body.error)).toContain("scope");
    expect(flows.start).not.toHaveBeenCalled();
  });
});

describe("MCP probe route", () => {
  it("requires the mount first and reports the probe outcome", async () => {
    const { app, authorization, servers } = build();
    const { body, status } = await send(app, "POST", `${AGENT_MCP_PROBE_TEMPLATE_PATH}`);
    expect(status).toBe(200);
    expect(body).toEqual(PROBE_OUTCOME);
    // The mount is checked before the probe, so an unmounted Server is refused without an upstream call.
    expect(servers.requireAgentBinding).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER);
    expect(authorization.probe).toHaveBeenCalledWith(ACCOUNT, AGENT, SERVER);
  });

  it("refuses an unmounted probe with the binding error", async () => {
    const { app, authorization, servers } = build();
    servers.requireAgentBinding.mockRejectedValue(
      new McpServiceError(MCP_ERROR_CODES.BINDING_NOT_FOUND, "The Agent has not mounted this MCP Server"),
    );
    const { body, status } = await send(app, "POST", `${AGENT_MCP_PROBE_TEMPLATE_PATH}`);
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: MCP_ERROR_CODES.BINDING_NOT_FOUND });
    expect(authorization.probe).not.toHaveBeenCalled();
  });

  it("refuses a probe path whose Server id is not a uuid", async () => {
    const { app, servers } = build();
    const { body, status } = await send(app, "POST", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}/not-a-uuid/probe`);
    expect(status).toBe(400);
    expect((body.error as { code: string }).code).toBe(VALIDATION_ERROR);
    expect(servers.requireAgentBinding).not.toHaveBeenCalled();
  });
});

describe("MCP management authentication", () => {
  const routes = [
    ["GET", MCP_SERVERS_PATH],
    ["POST", MCP_SERVERS_PATH],
    ["GET", `${MCP_SERVERS_PATH}/${SERVER}`],
    ["PATCH", `${MCP_SERVERS_PATH}/${SERVER}`],
    ["DELETE", `${MCP_SERVERS_PATH}/${SERVER}`],
    ["GET", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}`],
    ["GET", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}/available`],
    ["POST", `${AGENT_MCP_SERVERS_TEMPLATE_PATH}`],
    ["PATCH", `${AGENT_MCP_SERVER_TEMPLATE_PATH}`],
    ["DELETE", `${AGENT_MCP_SERVER_TEMPLATE_PATH}`],
    ["PUT", `${AGENT_MCP_AUTHORIZATION_TEMPLATE_PATH}`],
    ["DELETE", `${AGENT_MCP_AUTHORIZATION_TEMPLATE_PATH}`],
    ["POST", `${AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE_PATH}`],
    ["POST", `${AGENT_MCP_PROBE_TEMPLATE_PATH}`],
  ] as const;

  it.each(routes)("refuses %s %s with no credential at all", async (method, url) => {
    const { app, servers } = build();
    const bodyless = method === "GET" || method === "DELETE";
    const response = await app.inject({
      method,
      url,
      headers: bodyless ? {} : { "content-type": "application/json" },
      ...(bodyless ? {} : { payload: {} as never }),
    });
    expect(response.statusCode).toBe(401);
    expect(servers.listServers).not.toHaveBeenCalled();
    expect(servers.createServer).not.toHaveBeenCalled();
  });

  it.each(routes)("resolves the Account from the bearer and never from the request", async (method, url) => {
    const { app, servers } = build();
    // A body claiming another Account must not affect whose data is read or written.
    const bodyless = method === "GET" || method === "DELETE";
    await app.inject({
      method,
      url,
      headers: bodyless ? ACCESS_HEADER : { ...ACCESS_HEADER, "content-type": "application/json" },
      ...(bodyless ? {} : { payload: { accountId: "somebody-else" } as never }),
    });
    const calls = Object.values(servers).flatMap((fn) => fn.mock.calls);
    const claimed = calls.filter((call) => JSON.stringify(call).includes("somebody-else"));
    // The only place an unknown field could surface is a schema rejection, which never reaches a service.
    expect(claimed).toEqual([]);
  });

  it("registers without auth options at all", async () => {
    /*
     * `registerMcpServerRoutes` takes an optional `authOptions`; a caller that omits it must still get
     * working routes, which is what the `?? {}` default is for.
     */
    const app = Fastify({ logger: false });
    registerMcpServerRoutes(app, authService(), {
      authorization: { probe: vi.fn() } as unknown as McpAuthorizationService,
      flows: { redirectFor: vi.fn(), start: vi.fn() } as unknown as McpOAuthFlowService,
      secureCookies: false,
      servers: { listServers: vi.fn(async () => [SERVER_DTO]) } as unknown as McpServerService,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: MCP_SERVERS_PATH, headers: ACCESS_HEADER });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ servers: [SERVER_DTO] });
  });

  it("fails the request rather than reading from an empty authenticated user id", async () => {
    /*
     * Every route reads the Account from `request.authContext`. An auth result that resolves no user
     * id is a programming error, and the honest answer is a failed request — silently proceeding
     * would scope the read to `""` and answer with whatever that matched.
     */
    const broken = {
      ...authService(),
      getAuthenticatedUser: vi.fn(async () => ({
        tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
        me: { user: { id: "", email: "nobody@example.com", displayName: "Nobody" }, setupCompletedAt: null },
      })),
    } as unknown as UserAuthService;
    const app = createApp({
      authService: broken,
      loggerStream: { write: () => undefined },
      mcp: {
        authorization: {
          probe: vi.fn(),
          revoke: vi.fn(),
          setBearerOrNone: vi.fn(),
        } as unknown as McpAuthorizationService,
        flows: { redirectFor: vi.fn(), start: vi.fn() } as unknown as McpOAuthFlowService,
        servers: {
          listServers: vi.fn(async () => {
            throw new Error("the service must not be reached without an Account");
          }),
        } as unknown as McpServerService,
        publicOrigin: PUBLIC_ORIGIN,
        secureCookies: false,
      },
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: MCP_SERVERS_PATH, headers: ACCESS_HEADER });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
  });

  it("accepts a browser session cookie with the double-submit token", async () => {
    const app = createApp({
      authService: authService(),
      loggerStream: { write: () => undefined },
      betterAuth: signedInBrowser(ACCOUNT, { publicUrl: PUBLIC_ORIGIN }),
      browserAuth: {
        publicOrigin: PUBLIC_ORIGIN,
        secureCookies: false,
        sessionTtlSeconds: 600,
        providers: [],
        devLoginEnabled: false,
      } as never,
      mcp: {
        authorization: {
          probe: vi.fn(),
          revoke: vi.fn(),
          setBearerOrNone: vi.fn(),
        } as unknown as McpAuthorizationService,
        flows: { redirectFor: vi.fn(), start: vi.fn() } as unknown as McpOAuthFlowService,
        servers: { listServers: vi.fn(async () => [SERVER_DTO]) } as unknown as McpServerService,
        publicOrigin: PUBLIC_ORIGIN,
        secureCookies: false,
      },
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: MCP_SERVERS_PATH, headers: SESSION_COOKIE });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ servers: [SERVER_DTO] });
  });
});
