import { describe, expect, it } from "vitest";
import { selfMcpOAuthStatus } from "../agent-self.js";
import type { MCPAgentServer, MCPAuthorizationSummary, MCPProbeSnapshot } from "../mcp.js";

const now = "2026-09-22T00:00:00.000Z";

const baseServer: MCPAgentServer = {
  mcpServerId: "0f4c8f7e-4a4d-4b7b-9a51-7c8f1d2e3a4b",
  name: "hubspot",
  description: null,
  discoveredDescription: null,
  enabled: true,
  effective: {
    url: "https://mcp.example.com",
    authHeader: "Authorization",
    authScheme: "Bearer",
    extraHeaders: {},
  },
  overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
  authorization: null,
  snapshot: null,
  createdAt: now,
  updatedAt: now,
};

const baseAuth: MCPAuthorizationSummary = {
  kind: "oauth",
  status: "pending",
  hasCredential: false,
  scopes: null,
  accessTokenExpiresAt: null,
  authorizationServer: null,
  probedAt: null,
  probeState: "pending",
  probeError: null,
  failureCode: null,
  toolsCount: null,
  toolsTruncated: false,
  revision: 1,
};

const baseSnapshot: MCPProbeSnapshot = {
  protocolEra: "modern",
  protocolVersion: null,
  serverInfo: null,
  capabilities: null,
  instructions: null,
  tools: null,
};

describe("agent-self shared helpers", () => {
  it("projects MCPAgentServer to SelfMCPOAuthStatus when tools are null", () => {
    const server: MCPAgentServer = {
      ...baseServer,
      authorization: baseAuth,
    };

    const status = selfMcpOAuthStatus(server);
    expect(status).toEqual({
      mcpServerId: "0f4c8f7e-4a4d-4b7b-9a51-7c8f1d2e3a4b",
      name: "hubspot",
      enabled: true,
      authKind: "oauth",
      authStatus: "pending",
      probeState: "pending",
      probeError: null,
      failureCode: null,
      toolsCount: null,
      toolsTruncated: false,
      tools: null,
    });
  });

  it("projects MCPAgentServer to SelfMCPOAuthStatus with tools list", () => {
    const server: MCPAgentServer = {
      ...baseServer,
      authorization: {
        ...baseAuth,
        kind: "bearer",
        status: "active",
        probeState: "succeeded",
        toolsCount: 2,
      },
      snapshot: {
        ...baseSnapshot,
        tools: [
          { name: "create_issue", description: "Create an issue", inputSchema: null },
          { name: "list_issues", description: null, inputSchema: null },
        ],
      },
    };

    const status = selfMcpOAuthStatus(server);
    expect(status).toEqual({
      mcpServerId: "0f4c8f7e-4a4d-4b7b-9a51-7c8f1d2e3a4b",
      name: "hubspot",
      enabled: true,
      authKind: "bearer",
      authStatus: "active",
      probeState: "succeeded",
      probeError: null,
      failureCode: null,
      toolsCount: 2,
      toolsTruncated: false,
      tools: [
        { name: "create_issue", description: "Create an issue" },
        { name: "list_issues", description: null },
      ],
    });
  });

  it("handles missing authorization cleanly", () => {
    const server: MCPAgentServer = {
      ...baseServer,
      authorization: null,
      snapshot: null,
    };

    const status = selfMcpOAuthStatus(server);
    expect(status.authKind).toBeNull();
    expect(status.authStatus).toBeNull();
    expect(status.tools).toBeNull();
  });
});
