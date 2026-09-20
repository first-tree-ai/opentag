import type {
  MCPAgentServer,
  MCPAuthorizationSummary,
  MCPProbeResponse,
  MCPServer,
  MCPServerDetail,
} from "@opentag/shared";
import { describe, expect, it } from "vitest";
import {
  describeProbe,
  extraHeadersFrom,
  formatAgentMcpServers,
  formatAgentServerRow,
  formatAuthorization,
  formatHeaders,
  formatMcpServer,
  formatMcpServerList,
  formatMcpShow,
  formatProbe,
} from "../core/mcp/shared.js";

const server: MCPServer = {
  id: "d91ba522-498b-4d5e-845b-06f8dc9d562c",
  name: "tools",
  description: null,
  url: "https://tools.example.test/mcp",
  defaultAuthKind: "oauth",
  authHeader: "authorization",
  authScheme: "",
  extraHeaders: {},
  revision: 4,
  boundAgentCount: 2,
  authorizedAgentCount: 1,
  lastProbedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

function authorization(overrides: Partial<MCPAuthorizationSummary> = {}): MCPAuthorizationSummary {
  return {
    kind: "bearer",
    status: "active",
    hasCredential: true,
    scopes: null,
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
    authorizationServer: null,
    probeState: "pending",
    probedAt: null,
    probeError: null,
    toolsCount: null,
    toolsTruncated: false,
    failureCode: null,
    revision: 1,
    ...overrides,
  };
}

function agentServer(overrides: Partial<MCPAgentServer> = {}): MCPAgentServer {
  return {
    mcpServerId: server.id,
    name: server.name,
    description: null,
    discoveredDescription: null,
    enabled: true,
    effective: { url: server.url, authHeader: "authorization", authScheme: "", extraHeaders: {} },
    overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
    authorization: null,
    snapshot: null,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("extraHeadersFrom", () => {
  it("lowercases and trims the name while keeping the value verbatim", () => {
    // Only the name is trimmed; the value is passed through exactly as typed.
    expect(extraHeadersFrom(["  X-Tenant =a=b  "])).toEqual({ "x-tenant": "a=b  " });
    expect(extraHeadersFrom(["X-A=1", "x-b=2"])).toEqual({ "x-a": "1", "x-b": "2" });
    // An empty value is a real value: the header is sent with nothing after the name.
    expect(extraHeadersFrom(["X-Empty="])).toEqual({ "x-empty": "" });
  });

  it("rejects an entry with no separator, an empty name, and a duplicate name", () => {
    expect(() => extraHeadersFrom(["nope"])).toThrow('--extra-header expects name=value, received "nope"');
    expect(() => extraHeadersFrom(["=only-value"])).toThrow("--extra-header expects name=value");
    expect(() => extraHeadersFrom(["   =only-value"])).toThrow("--extra-header requires a header name");
    expect(() => extraHeadersFrom(["X-A=1", "X-A=2"])).toThrow('--extra-header repeats "x-a"');
  });
});

describe("formatMcpServer", () => {
  it("marks a null description, an empty scheme, and a missing probe timestamp", () => {
    expect(formatMcpServer(server)).toBe(
      [
        `id\t${server.id}`,
        "name\ttools",
        "description\t-",
        "url\thttps://tools.example.test/mcp",
        "defaultAuthKind\toauth (prefill for a new authorization only)",
        "authHeader\tauthorization",
        "authScheme\t(sent verbatim)",
        "extraHeaders\t-",
        "revision\t4",
        "boundAgentCount\t2",
        "authorizedAgentCount\t1",
        "lastProbedAt\t-",
      ].join("\n"),
    );
  });

  it("prints a description, a non-empty scheme, extra headers, and a probe timestamp", () => {
    const output = formatMcpServer({
      ...server,
      description: "Probed description",
      authScheme: "Bearer",
      extraHeaders: { "x-tenant": "team", "x-trace": "on" },
      lastProbedAt: "2030-01-02T00:00:00.000Z",
    });
    expect(output).toContain("description\tProbed description");
    expect(output).toContain("authScheme\tBearer");
    expect(output).toContain("extraHeaders\tx-tenant=team, x-trace=on");
    expect(output).toContain("lastProbedAt\t2030-01-02T00:00:00.000Z");
  });
});

describe("formatMcpServerList", () => {
  it("says so when the Account has no definitions", () => {
    expect(formatMcpServerList([])).toBe("No MCP Servers configured");
  });

  it("prints a header row and one row per definition", () => {
    const rows = formatMcpServerList([
      server,
      { ...server, name: "other", boundAgentCount: 0, lastProbedAt: "2030-01-02T00:00:00.000Z" },
    ]).split("\n");
    expect(rows[0]).toBe(["NAME", "URL", "AGENTS", "AUTHORIZED", "LAST PROBED"].join("\t"));
    expect(rows[1]).toBe(["tools", server.url, "2", "1", "-"].join("\t"));
    expect(rows[2]).toBe(["other", server.url, "0", "1", "2030-01-02T00:00:00.000Z"].join("\t"));
    expect(rows).toHaveLength(3);
  });
});

describe("describeProbe", () => {
  it("distinguishes an absent authorization, a success, a failure, and a pending probe", () => {
    expect(describeProbe(null)).toBe("not authorized");
    expect(describeProbe(authorization({ probeState: "succeeded", probedAt: "2030-01-02T00:00:00.000Z" }))).toBe(
      "probed 2030-01-02T00:00:00.000Z",
    );
    expect(describeProbe(authorization({ probeState: "succeeded" }))).toBe("probed -");
    expect(describeProbe(authorization({ probeState: "failed", probeError: "connection refused" }))).toBe(
      "failed: connection refused",
    );
    expect(describeProbe(authorization({ probeState: "failed" }))).toBe("failed: -");
    expect(describeProbe(authorization({ probeState: "pending" }))).toBe("pending");
  });
});

describe("formatHeaders", () => {
  it("prints a dash for an empty set and name=value pairs otherwise", () => {
    expect(formatHeaders({})).toBe("-");
    expect(formatHeaders({ "x-a": "1" })).toBe("x-a=1");
    expect(formatHeaders({ "x-a": "1", "x-b": "2" })).toBe("x-a=1, x-b=2");
  });
});

describe("formatAgentMcpServers", () => {
  it("says so when the Agent mounts nothing", () => {
    expect(formatAgentMcpServers([])).toBe("No MCP Servers mounted");
  });

  it("prints each mount's four independent states and the truncation marker", () => {
    const rows = formatAgentMcpServers([
      agentServer(),
      agentServer({
        name: "disabled-server",
        enabled: false,
        authorization: authorization({ toolsCount: 3, toolsTruncated: true }),
      }),
      agentServer({ name: "no-tools", authorization: authorization({ toolsCount: 0 }) }),
      agentServer({ name: "null-tools", authorization: authorization({ toolsCount: null }) }),
    ]).split("\n");
    expect(rows[0]).toBe(["NAME", "MOUNT", "AUTH KIND", "AUTH STATUS", "PROBE", "TOOLS", "EXPIRES"].join("\t"));
    expect(rows[1]).toBe(["tools", "enabled", "none", "none", "not authorized", "-", "-"].join("\t"));
    expect(rows[2]).toBe(
      ["disabled-server", "disabled", "bearer", "active", "pending", "3 (truncated)", "2030-01-01T01:00:00.000Z"].join(
        "\t",
      ),
    );
    expect(rows[3]).toBe(
      ["no-tools", "enabled", "bearer", "active", "pending", "0", "2030-01-01T01:00:00.000Z"].join("\t"),
    );
    expect(rows[4]).toBe(
      ["null-tools", "enabled", "bearer", "active", "pending", "-", "2030-01-01T01:00:00.000Z"].join("\t"),
    );
  });

  it("prints a dash for an authorization without an access-token expiry", () => {
    const [, row] = formatAgentMcpServers([
      agentServer({ authorization: authorization({ accessTokenExpiresAt: null }) }),
    ]).split("\n");
    expect(row?.endsWith("\t-")).toBe(true);
  });
});

describe("formatAgentServerRow", () => {
  it("labels every inherited field as inherited", () => {
    expect(formatAgentServerRow(agentServer())).toBe(
      [
        "name\ttools",
        "mount\tenabled",
        "authKind\tnone",
        "authStatus\tnone",
        "probeState\tnot authorized",
        "probeError\t-",
        "toolsCount\t-",
        `effectiveUrl\t${server.url}\tinherited`,
        "effectiveAuthHeader\tauthorization\tinherited",
        "effectiveAuthScheme\t(verbatim)\tinherited",
        "effectiveExtraHeaders\t-\tinherited",
      ].join("\n"),
    );
  });

  it("marks overridden fields and an explicit empty extra-header set", () => {
    const output = formatAgentServerRow(
      agentServer({
        enabled: false,
        effective: {
          url: "https://agent.example.test/mcp",
          authHeader: "x-key",
          authScheme: "Token",
          extraHeaders: { "x-tenant": "private" },
        },
        overridden: { url: true, authHeader: true, authScheme: true, extraHeaders: true },
        authorization: authorization({ kind: "none", status: "revoked", probeState: "failed", probeError: "denied" }),
      }),
    );
    expect(output).toContain("mount\tdisabled");
    expect(output).toContain("authKind\tnone");
    expect(output).toContain("authStatus\trevoked");
    expect(output).toContain("probeState\tfailed");
    expect(output).toContain("probeError\tdenied");
    expect(output).toContain("effectiveUrl\thttps://agent.example.test/mcp\toverridden");
    expect(output).toContain("effectiveAuthHeader\tx-key\toverridden");
    expect(output).toContain("effectiveAuthScheme\tToken\toverridden");
    expect(output).toContain("effectiveExtraHeaders\tx-tenant=private\toverridden");
  });

  it("reports the tool count with its truncation marker", () => {
    const output = formatAgentServerRow(
      agentServer({
        authorization: authorization({ toolsCount: 5, toolsTruncated: true, probeState: "succeeded" }),
      }),
    );
    expect(output).toContain("toolsCount\t5 (truncated)");
    expect(formatAgentServerRow(agentServer({ authorization: authorization({ toolsCount: 5 }) }))).toContain(
      "toolsCount\t5",
    );
  });
});

describe("formatAuthorization", () => {
  it("reports a pending probe when the caller did not wait", () => {
    const output = formatAuthorization({
      server,
      started: { authorizationUrl: "https://auth.example.test/authorize", expiresAt: "2030-01-01T00:10:00.000Z" },
    });
    expect(output).toBe(
      [
        "server\ttools",
        "authorizationUrl\thttps://auth.example.test/authorize",
        "expiresAt\t2030-01-01T00:10:00.000Z",
        "probeState\tpending",
        "toolsCount\t-",
        "protocolEra\t-",
      ].join("\n"),
    );
  });

  it("reports the probe the authorization produced, including truncation", () => {
    const probe: MCPProbeResponse = {
      probeState: "succeeded",
      probeError: null,
      toolsCount: 7,
      toolsTruncated: true,
      protocolEra: "modern",
      protocolVersion: "2030-01-01",
    };
    const output = formatAuthorization({
      server,
      started: { authorizationUrl: "https://auth.example.test/authorize", expiresAt: "2030-01-01T00:10:00.000Z" },
      probe,
    });
    expect(output).toContain("probeState\tsucceeded");
    expect(output).toContain("toolsCount\t7 (truncated)");
    expect(output).toContain("protocolEra\tmodern");
    expect(
      formatAuthorization({
        server,
        started: { authorizationUrl: "https://auth.example.test/authorize", expiresAt: "2030-01-01T00:10:00.000Z" },
        probe: { ...probe, toolsCount: null, toolsTruncated: false, protocolEra: null },
      }),
    ).toContain("protocolEra\t-");
  });
});

describe("formatProbe", () => {
  it("prints every field, falling back to a dash for the null ones", () => {
    expect(
      formatProbe({
        probeState: "failed",
        probeError: null,
        toolsCount: null,
        toolsTruncated: false,
        protocolEra: null,
        protocolVersion: null,
      }),
    ).toBe(
      [
        "probeState\tfailed",
        "probeError\t-",
        "toolsCount\t-",
        "toolsTruncated\tfalse",
        "protocolEra\t-",
        "protocolVersion\t-",
      ].join("\n"),
    );
  });

  it("prints the error, the count, and the protocol when the probe produced them", () => {
    const output = formatProbe({
      probeState: "succeeded",
      probeError: "ignored",
      toolsCount: 12,
      toolsTruncated: true,
      protocolEra: "legacy",
      protocolVersion: "2024-11-05",
    });
    expect(output).toContain("probeError\tignored");
    expect(output).toContain("toolsCount\t12");
    expect(output).toContain("toolsTruncated\ttrue");
    expect(output).toContain("protocolEra\tlegacy");
    expect(output).toContain("protocolVersion\t2024-11-05");
  });
});

describe("formatMcpShow", () => {
  const detail = (agents: MCPServerDetail["agents"]): MCPServerDetail => ({ server, agents });

  it("answers for the definition when no Agent view was asked for", () => {
    const output = formatMcpShow({ server: detail([]) });
    expect(output.startsWith(formatMcpServer(server))).toBe(true);
    expect(output).toContain("agentCount\t0");
    expect(output).not.toContain("\nagent\t");
  });

  it("prints one row per mounting Agent with its authorization state", () => {
    const output = formatMcpShow({
      server: detail([
        {
          agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
          agentName: "reviewer",
          agentDisplayName: "Reviewer",
          enabled: true,
          effective: { url: server.url, authHeader: "authorization", authScheme: "", extraHeaders: {} },
          overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
          protocolEra: "modern",
          protocolVersion: "2030-01-01",
          authorization: authorization({ kind: "oauth", status: "active" }),
        },
        {
          agentId: "2b74b32f-a7d8-4585-a2fb-5ebcf1677b35",
          agentName: "disabled-agent",
          agentDisplayName: "Disabled",
          enabled: false,
          effective: { url: server.url, authHeader: "authorization", authScheme: "", extraHeaders: {} },
          overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
          protocolEra: null,
          protocolVersion: null,
          authorization: null,
        },
      ]),
    });
    expect(output).toContain("agentCount\t2");
    expect(output).toContain(["agent", "reviewer", "enabled", "oauth", "active", "modern"].join("\t"));
    expect(output).toContain(["agent", "disabled-agent", "disabled", "none", "unauthorized", "-"].join("\t"));
  });

  it("appends one Agent's effective view when the caller asked for it", () => {
    const output = formatMcpShow({
      server: detail([]),
      agentView: agentServer({ authorization: authorization({ toolsCount: 2 }) }),
    });
    expect(
      output.endsWith(formatAgentServerRow(agentServer({ authorization: authorization({ toolsCount: 2 }) }))),
    ).toBe(true);
  });
});
