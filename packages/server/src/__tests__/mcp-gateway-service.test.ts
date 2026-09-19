import { composeGatewayToolName } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { McpAuthorizationService } from "../services/mcp/mcp-authorization-service.js";
import { McpGatewayService } from "../services/mcp/mcp-gateway-service.js";
import type { McpUpstreamCaller } from "../services/mcp/mcp-gateway-upstream.js";
import type { McpJoinedBinding, McpServerService } from "../services/mcp/mcp-server-service.js";

const ACCOUNT = "account-1";
const AGENT = "agent-1";

interface MountSpec {
  name: string;
  enabled?: boolean;
  status?: "active" | "revoked" | "expired" | "pending" | "error";
  probeState?: "succeeded" | "failed" | "pending";
  tools?: { name: string; description?: string | null; inputSchema?: unknown }[];
  url?: string;
}

/**
 * A joined row shaped like the one the database returns. Only the columns the gateway reads are
 * populated; the rest are irrelevant to aggregation and would be noise in every assertion.
 */
function mount(spec: MountSpec): McpJoinedBinding {
  const id = `server-${spec.name}`;
  return {
    binding: { agentId: AGENT, mcpServerId: id, enabled: spec.enabled ?? true } as McpJoinedBinding["binding"],
    server: {
      id,
      name: spec.name,
      accountId: ACCOUNT,
      url: spec.url ?? `https://${spec.name}.example.com/mcp`,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
    } as McpJoinedBinding["server"],
    authorization: {
      mcpServerId: id,
      agentId: AGENT,
      kind: "bearer",
      status: spec.status ?? "active",
      probeState: spec.probeState ?? "succeeded",
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      tools: (spec.tools ?? [{ name: "list" }]).map((tool) => ({
        name: tool.name,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema ?? null,
      })),
    } as McpJoinedBinding["authorization"],
  };
}

function build(
  mounts: McpJoinedBinding[],
  overrides: {
    upstreamCall?: McpUpstreamCaller["call"];
    resolveActiveCredential?: McpAuthorizationService["resolveActiveCredential"];
    maxTools?: number;
  } = {},
) {
  const servers = { listAgentBindings: vi.fn(async () => mounts) } as unknown as McpServerService;
  const upstreamCall =
    overrides.upstreamCall ??
    (vi.fn(async () => ({
      result: { content: [{ type: "text", text: "ok" }] },
      era: "modern" as const,
      protocolVersion: "2026-07-28",
      eraInvalidated: false,
    })) as unknown as McpUpstreamCaller["call"]);
  const resolveActiveCredential =
    overrides.resolveActiveCredential ??
    (vi.fn(async (_a: string, _g: string, mcpServerId: string) => {
      const found = mounts.find((row) => row.server.id === mcpServerId);
      return found ? { binding: found.binding, server: found.server, authorization: found.authorization } : undefined;
    }) as unknown as McpAuthorizationService["resolveActiveCredential"]);
  const authorizations = {
    resolveActiveCredential,
    buildHeadersFor: vi.fn(() => ({ authorization: "Bearer upstream-key" })),
  } as unknown as McpAuthorizationService;
  const upstream = { call: upstreamCall } as unknown as McpUpstreamCaller;
  const service = new McpGatewayService({
    servers,
    authorizations,
    upstream,
    ...(overrides.maxTools === undefined ? {} : { maxTools: overrides.maxTools }),
  });
  return { service, upstreamCall, authorizations };
}

describe("catalog", () => {
  it("namespaces every upstream tool with its Server name", async () => {
    const { service } = build([
      mount({ name: "linear", tools: [{ name: "create_issue" }] }),
      mount({ name: "notion", tools: [{ name: "search" }] }),
    ]);
    const catalog = await service.catalog(ACCOUNT, AGENT);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["linear__create_issue", "notion__search"]);
  });

  /*
   * Two Servers may legitimately expose a tool of the same name; the namespace is what keeps both
   * reachable. Without it one would silently shadow the other.
   */
  it("keeps same-named tools from different Servers distinct", async () => {
    const { service } = build([
      mount({ name: "linear", tools: [{ name: "search" }] }),
      mount({ name: "notion", tools: [{ name: "search" }] }),
    ]);
    const catalog = await service.catalog(ACCOUNT, AGENT);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["linear__search", "notion__search"]);
  });

  it("omits a disabled mount silently, because disabling is a deliberate act", async () => {
    const { service } = build([mount({ name: "linear", enabled: false })]);
    const catalog = await service.catalog(ACCOUNT, AGENT);
    expect(catalog.tools).toEqual([]);
    expect(catalog.notes).toEqual([]);
  });

  /*
   * These two are reported rather than dropped silently. "My tool vanished" is otherwise
   * indistinguishable between a revoked credential and a Server that stopped answering.
   */
  it("reports a mount whose authorization is not active", async () => {
    const { service } = build([mount({ name: "linear", status: "revoked" })]);
    const catalog = await service.catalog(ACCOUNT, AGENT);
    expect(catalog.tools).toEqual([]);
    expect(catalog.notes.join(" ")).toContain("linear");
    expect(catalog.notes.join(" ")).toContain("not authorized");
  });

  it("reports a mount whose probe has not succeeded", async () => {
    const { service } = build([mount({ name: "linear", probeState: "failed" })]);
    const catalog = await service.catalog(ACCOUNT, AGENT);
    expect(catalog.tools).toEqual([]);
    expect(catalog.notes.join(" ")).toContain("no usable tool snapshot");
  });

  it("carries the description and schema through", async () => {
    const { service } = build([
      mount({ name: "linear", tools: [{ name: "x", description: "does x", inputSchema: { type: "object" } }] }),
    ]);
    const [tool] = (await service.catalog(ACCOUNT, AGENT)).tools;
    expect(tool).toEqual({ name: "linear__x", description: "does x", inputSchema: { type: "object" } });
  });

  it("bounds the catalogue and says so", async () => {
    const { service } = build([mount({ name: "linear", tools: [{ name: "a" }, { name: "b" }, { name: "c" }] })], {
      maxTools: 2,
    });
    const catalog = await service.catalog(ACCOUNT, AGENT);
    expect(catalog.tools).toHaveLength(2);
    expect(catalog.notes.join(" ")).toContain("Only the first 2 tools");
  });

  /*
   * A tool whose snapshot row is malformed contributes nothing rather than reaching a model with a
   * name or schema the gateway could not validate.
   */
  it("ignores a snapshot that does not parse", async () => {
    const row = mount({ name: "linear" });
    (row.authorization as unknown as { tools: unknown }).tools = [{ nope: true }];
    const { service } = build([row]);
    expect((await service.catalog(ACCOUNT, AGENT)).tools).toEqual([]);
  });
});

describe("callTool", () => {
  it("routes to the Server that owns the name and strips the namespace", async () => {
    const { service, upstreamCall } = build([
      mount({ name: "linear", tools: [{ name: "create_issue" }] }),
      mount({ name: "notion", tools: [{ name: "search" }] }),
    ]);
    await service.callTool({ accountId: ACCOUNT, agentId: AGENT, name: "notion__search", arguments: { q: "x" } });
    expect(upstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://notion.example.com/mcp",
        method: "tools/call",
        name: "search",
        params: { name: "search", arguments: { q: "x" } },
      }),
    );
  });

  it("sends the Agent's own upstream headers", async () => {
    const { service, upstreamCall } = build([mount({ name: "linear", tools: [{ name: "x" }] })]);
    await service.callTool({ accountId: ACCOUNT, agentId: AGENT, name: "linear__x" });
    expect(upstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({ authHeaders: { authorization: "Bearer upstream-key" } }),
    );
  });

  it("refuses a name no mount produces", async () => {
    const { service } = build([mount({ name: "linear", tools: [{ name: "x" }] })]);
    await expect(service.callTool({ accountId: ACCOUNT, agentId: AGENT, name: "notion__search" })).rejects.toThrow(
      /No MCP tool named/,
    );
  });

  /*
   * The resolution set is exactly what this Agent may call, so a name lifted from a disabled mount
   * resolves to nothing rather than reaching a Server the catalogue declined to publish.
   */
  it("refuses a tool belonging to a disabled mount", async () => {
    const { service } = build([mount({ name: "linear", enabled: false, tools: [{ name: "x" }] })]);
    await expect(service.callTool({ accountId: ACCOUNT, agentId: AGENT, name: "linear__x" })).rejects.toThrow(
      /No MCP tool named/,
    );
  });

  it("refuses a tool whose authorization was revoked", async () => {
    const { service } = build([mount({ name: "linear", status: "revoked", tools: [{ name: "x" }] })]);
    await expect(service.callTool({ accountId: ACCOUNT, agentId: AGENT, name: "linear__x" })).rejects.toThrow(
      /No MCP tool named/,
    );
  });

  it("reports an Agent that lost its credential between listing and calling", async () => {
    const { service } = build([mount({ name: "linear", tools: [{ name: "x" }] })], {
      resolveActiveCredential: (async () => undefined) as unknown as McpAuthorizationService["resolveActiveCredential"],
    });
    await expect(service.callTool({ accountId: ACCOUNT, agentId: AGENT, name: "linear__x" })).rejects.toThrow(
      /not authorized/,
    );
  });

  it("defaults absent arguments to an empty object", async () => {
    const { service, upstreamCall } = build([mount({ name: "linear", tools: [{ name: "x" }] })]);
    await service.callTool({ accountId: ACCOUNT, agentId: AGENT, name: "linear__x" });
    expect(upstreamCall).toHaveBeenCalledWith(expect.objectContaining({ params: { name: "x", arguments: {} } }));
  });

  it("passes the row's cached protocol era and version", async () => {
    const { service, upstreamCall } = build([mount({ name: "linear", tools: [{ name: "x" }] })]);
    await service.callTool({ accountId: ACCOUNT, agentId: AGENT, name: "linear__x" });
    expect(upstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({ cachedEra: "modern", cachedVersion: "2026-07-28" }),
    );
  });
});

describe("long tool names", () => {
  /*
   * The longest name a snapshot can hold: `MCPToolSnapshotSchema` bounds a tool name at 128 bytes,
   * so with any Server name the composed form exceeds the 128-byte composed bound and is shortened.
   * The shortened form must still round-trip, because the model can only call back with the name it
   * was given.
   */
  it("publishes and resolves a shortened name", async () => {
    const long = "z".repeat(128);
    const { service, upstreamCall } = build([mount({ name: "linear", tools: [{ name: long }] })]);
    const [tool] = (await service.catalog(ACCOUNT, AGENT)).tools;
    expect(tool?.name).toBe(composeGatewayToolName("linear", long));
    expect(tool?.name).not.toBe(`linear__${long}`);
    await service.callTool({ accountId: ACCOUNT, agentId: AGENT, name: tool?.name as string });
    expect(upstreamCall).toHaveBeenCalledWith(expect.objectContaining({ name: long }));
  });

  /*
   * One out-of-bound entry invalidates that Server's whole snapshot, matching the probe's own rule:
   * it fails a page that violates a per-tool bound rather than truncating it. Publishing the rest
   * would present a partial list as complete, which is the failure the probe already refuses.
   */
  it("drops the whole snapshot when one entry exceeds the stored bound", async () => {
    const { service } = build([mount({ name: "linear", tools: [{ name: "fine" }, { name: "z".repeat(129) }] })]);
    expect((await service.catalog(ACCOUNT, AGENT)).tools).toEqual([]);
  });
});
