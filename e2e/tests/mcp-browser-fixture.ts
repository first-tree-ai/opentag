import { randomUUID } from "node:crypto";
import type { MCPAgentServer, MCPAuthKind, MCPServer } from "@opentag/shared/browser";
import type { Page, Route } from "@playwright/test";
import { baseURL } from "../playwright.config.js";
import { expect } from "./fixtures.js";

const timestamp = "2026-10-10T00:00:00.000Z";
export function server(name: string, kind: MCPAuthKind = "none"): MCPServer {
  return {
    id: randomUUID(),
    name,
    url: `https://${name}.example.com/mcp`,
    description: null,
    defaultAuthKind: kind,
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    revision: 1,
    boundAgentCount: 0,
    authorizedAgentCount: 0,
    lastProbedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
export function binding(value: MCPServer): MCPAgentServer {
  return {
    mcpServerId: value.id,
    name: value.name,
    description: null,
    discoveredDescription: null,
    enabled: true,
    effective: { url: value.url, authHeader: value.authHeader, authScheme: value.authScheme, extraHeaders: {} },
    overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
    authorization: null,
    snapshot: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
export async function createAgent(page: Page, displayName: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("Missing authenticated CSRF cookie");
  const response = await page.request.post("/api/v1/agents", {
    data: { creationIntentId: randomUUID(), name: `mcp-${randomUUID()}`, displayName, runtimeProvider: "codex" },
    headers: { Origin: baseURL, "x-opentag-csrf": csrf },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

/** Sign-in, Agent creation, navigation, and the built app are real; MCP management responses are fixtures. */
export async function mcpFixture(page: Page, servers: MCPServer[] = []) {
  const mounts = new Map<string, MCPAgentServer[]>();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let failProbe = false;
  let failOAuth = false;
  let oauthSuccess = false;
  let releasePool: () => void = () => {};
  let poolGate: Promise<void> | undefined;
  let releaseProbe: () => void = () => {};
  let probeGate: Promise<void> | undefined;
  let oauthGate: Promise<void> | undefined;
  let releaseOAuth: () => void = () => {};
  await page.route(/\/api\/v1\/(?:agents\/[^/]+\/)?mcp-servers(?:\/.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    const method = route.request().method();
    if (method !== "GET") writes.push({ path, body: body ?? {} });
    if (path === "/api/v1/mcp-servers") {
      await respondPool(route, method, body);
      return;
    }
    if (await respondDefinition(route, path, method)) return;
    await respondAgentRequest(route, path, method, body);
  });
  async function respondAgentRequest(route: Route, path: string, method: string, body: Record<string, unknown> | null) {
    const match = /^\/api\/v1\/agents\/([^/]+)\/mcp-servers(?:\/([^/]+))?(.*)$/.exec(path);
    if (!match?.[1]) throw new Error(`Unexpected MCP fixture request: ${path}`);
    const agentId = match[1];
    const entries = mounts.get(agentId) ?? [];
    mounts.set(agentId, entries);
    if (!match[2]) {
      await respondAgentCollection(route, method, entries, body);
      return;
    }
    if (await respondRemoval(route, method, match[3], entries, match[2])) return;
    const entry = entries.find((value) => value.mcpServerId === match[2]);
    if (!entry) throw new Error("Missing binding fixture");
    await respond(route, agentId, entry, match[3] ?? "", body);
  }
  async function respondDefinition(route: Route, path: string, method: string) {
    const id = /^\/api\/v1\/mcp-servers\/([^/]+)$/.exec(path)?.[1];
    if (!id || method !== "GET") return false;
    const definition = servers.find((value) => value.id === id);
    if (!definition) throw new Error("Missing definition fixture");
    await route.fulfill({ json: { server: definition, agents: [] } });
    return true;
  }
  async function respondRemoval(
    route: Route,
    method: string,
    operation: string | undefined,
    entries: MCPAgentServer[],
    serverId: string | undefined,
  ) {
    if (method !== "DELETE" || operation !== "") return false;
    const index = entries.findIndex((value) => value.mcpServerId === serverId);
    if (index >= 0) entries.splice(index, 1);
    await route.fulfill({ status: 204 });
    return true;
  }
  async function respondAgentCollection(
    route: Route,
    method: string,
    entries: MCPAgentServer[],
    body: Record<string, unknown> | null,
  ) {
    if (method === "GET") await route.fulfill({ json: { servers: entries } });
    else {
      const value = servers.find((candidate) => candidate.id === body?.mcpServerId);
      if (!value) throw new Error("Missing server fixture");
      const entry = binding(value);
      entries.push(entry);
      await route.fulfill({ json: entry });
    }
  }
  async function respondPool(route: Route, method: string, body: Record<string, unknown> | null) {
    if (method === "GET") {
      await poolGate;
      await route.fulfill({ json: { servers } });
    } else {
      if (servers.some((value) => value.name.toLowerCase() === String(body?.name).toLowerCase())) {
        await route.fulfill({
          status: 409,
          json: { error: { message: "Name exists", code: "MCP_SERVER_NAME_CONFLICT", category: "deterministic" } },
        });
        return;
      }
      const value = { ...server(String(body?.name)), ...body } as MCPServer;
      servers.push(value);
      await route.fulfill({ json: value });
    }
  }
  async function respond(
    route: Route,
    agentId: string,
    entry: MCPAgentServer,
    operation: string,
    body: Record<string, unknown> | null,
  ) {
    if (operation === "/authorization/oauth") {
      await respondOAuth(route, agentId, entry);
      return;
    }
    if (operation === "/authorization") {
      await respondAuthorization(route, entry, body);
      return;
    }
    if (operation !== "/probe" || !entry.authorization) throw new Error(`Unexpected MCP operation: ${operation}`);
    await probeGate;
    entry.authorization.probeState = failProbe ? "failed" : "succeeded";
    entry.authorization.probeError = failProbe ? "Fixture unavailable" : null;
    entry.authorization.toolsCount = failProbe ? null : 1;
    entry.snapshot = {
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      serverInfo: null,
      capabilities: null,
      instructions: null,
      tools: failProbe ? null : [{ name: "read_document", description: null, inputSchema: { type: "object" } }],
    };
    await route.fulfill({
      json: {
        probeState: entry.authorization.probeState,
        probeError: entry.authorization.probeError,
        toolsCount: entry.authorization.toolsCount,
        toolsTruncated: false,
        protocolEra: "modern",
        protocolVersion: "2026-07-28",
      },
    });
  }
  async function respondAuthorization(route: Route, entry: MCPAgentServer, body: Record<string, unknown> | null) {
    entry.authorization = {
      kind: body?.kind as MCPAuthKind,
      status: "active",
      hasCredential: body?.kind !== "none",
      scopes: null,
      accessTokenExpiresAt: null,
      authorizationServer: null,
      probeState: "pending",
      probedAt: null,
      probeError: null,
      toolsCount: null,
      toolsTruncated: false,
      failureCode: null,
      revision: 1,
    };
    await route.fulfill({ json: entry });
  }
  async function respondOAuth(route: Route, agentId: string, entry: MCPAgentServer) {
    await oauthGate;
    if (failOAuth) {
      await route.fulfill({ status: 502, json: { message: "Private upstream detail", code: "MCP_OAUTH_FAILED" } });
    } else {
      const outcome = oauthSuccess ? "mcp_oauth=success" : "mcp_oauth=error&mcp_oauth_error=MCP_OAUTH_DENIED";
      const returnURL = `/agents/${agentId}/mcp?${outcome}&server=${entry.mcpServerId}`;
      await route.fulfill({
        json: {
          authorizationUrl: `${baseURL}/mcp-consent-fixture?return=${encodeURIComponent(returnURL)}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
    }
  }
  return {
    servers,
    mounts,
    writes,
    failProbe: (value: boolean) => {
      failProbe = value;
    },
    failOAuth: () => {
      failOAuth = true;
    },
    allowOAuth: () => {
      failOAuth = false;
      oauthSuccess = true;
    },
    completeOAuth: (agentId: string, serverId?: string) => {
      const entry = serverId
        ? mounts.get(agentId)?.find((item) => item.mcpServerId === serverId)
        : mounts.get(agentId)?.[0];
      if (!entry) throw new Error("Missing OAuth binding fixture");
      entry.authorization = {
        kind: "oauth",
        status: "active",
        hasCredential: true,
        scopes: null,
        accessTokenExpiresAt: null,
        authorizationServer: null,
        probeState: "pending",
        probedAt: null,
        probeError: null,
        toolsCount: null,
        toolsTruncated: false,
        failureCode: null,
        revision: 1,
      };
    },
    holdPool: () => {
      poolGate = new Promise((resolve) => {
        releasePool = resolve;
      });
    },
    releasePool: () => releasePool(),
    holdProbe: () => {
      probeGate = new Promise((resolve) => {
        releaseProbe = resolve;
      });
    },
    releaseProbe: () => releaseProbe(),
    holdOAuth: () => {
      oauthGate = new Promise((resolve) => {
        releaseOAuth = resolve;
      });
    },
    releaseOAuth: () => releaseOAuth(),
  };
}
