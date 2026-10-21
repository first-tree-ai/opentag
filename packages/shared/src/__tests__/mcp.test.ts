import { describe, expect, it } from "vitest";
import {
  CANVA_DEVELOPER_PORTAL_MCP_URL,
  GOOGLE_WORKSPACE_MCP_ORIGINS,
  isCanvaDeveloperPortalMcpEndpoint,
  isGoogleWorkspaceMcpEndpoint,
  isMcpStaticOAuthEndpoint,
  MCP_CATALOG_DEPLOYMENT_ENDPOINTS,
  MCP_STATIC_OAUTH_PROVIDERS,
  MCP_TOOL_DESCRIPTION_MAX_BYTES,
  MCP_TOOL_INPUT_SCHEMA_MAX_BYTES,
  MCP_TOOL_NAME_MAX_BYTES,
  MCP_TOOL_SNAPSHOT_DESCRIPTION_MAX_BYTES,
  MCPCatalogEndpointsResponseSchema,
  MCPToolSnapshotSchema,
  mcpStaticOAuthEnvNames,
  probedServerDescription,
} from "../mcp.js";

/**
 * The Server's own description, read out of the `serverInfo` a probe recorded.
 *
 * This is derived on read rather than stored, so the only thing that can be wrong here is the
 * extraction: `server_info` is jsonb written from a peer's response and read back by a later build,
 * which means every input below is untrusted and most of them are not the specification's
 * `Implementation` shape at all.
 */
describe("probedServerDescription", () => {
  it("reads the description out of a specification-shaped serverInfo", () => {
    expect(probedServerDescription({ name: "linear", version: "1.2.0", description: "Issue tracking" })).toBe(
      "Issue tracking",
    );
  });

  it("returns null when the Server omitted the field, since it is optional in the specification", () => {
    expect(probedServerDescription({ name: "linear", version: "1.2.0" })).toBeNull();
    expect(probedServerDescription({ name: "linear", description: "" })).toBeNull();
    expect(probedServerDescription({ name: "linear", description: "   " })).toBeNull();
  });

  it("returns null for every value that is not an object with a string description", () => {
    for (const value of [null, undefined, "Issue tracking", 42, true, [], [1, 2], { description: 42 }]) {
      expect(probedServerDescription(value)).toBeNull();
    }
  });

  it("trims the value and bounds it to the column's 1024 characters", () => {
    expect(probedServerDescription({ description: "  Issue tracking  " })).toBe("Issue tracking");
    expect(probedServerDescription({ description: "x".repeat(5000) })).toHaveLength(1024);
  });

  it("ignores a nested description, which belongs to some other object", () => {
    expect(probedServerDescription({ name: "linear", nested: { description: "Issue tracking" } })).toBeNull();
  });
});

/**
 * The stored tool snapshot is parsed back with this schema before it reaches a live catalogue, so
 * it must accept at least what any release's probe may store — bounded in UTF-8 bytes, not in code
 * units — and the description's reader bound may never be narrower than the writer's, so a rollback
 * stays readable.
 */
describe("MCPToolSnapshotSchema", () => {
  const tool = (overrides: Record<string, unknown>) => ({
    name: "create_issue",
    description: null,
    inputSchema: null,
    ...overrides,
  });

  it("accepts a description at the reader bound and refuses one byte over it", () => {
    expect(
      MCPToolSnapshotSchema.safeParse(tool({ description: "d".repeat(MCP_TOOL_SNAPSHOT_DESCRIPTION_MAX_BYTES) }))
        .success,
    ).toBe(true);
    expect(
      MCPToolSnapshotSchema.safeParse(tool({ description: "d".repeat(MCP_TOOL_SNAPSHOT_DESCRIPTION_MAX_BYTES + 1) }))
        .success,
    ).toBe(false);
  });

  it("accepts Google's update_doc description under both the writer and reader bounds", () => {
    // The reader shipped first and the writer followed; both now store the ~35 KiB description that
    // motivated the raise, and the reader must never be the narrower of the two.
    const googleUpdateDocBytes = 35_410;
    expect(MCP_TOOL_SNAPSHOT_DESCRIPTION_MAX_BYTES).toBeGreaterThanOrEqual(MCP_TOOL_DESCRIPTION_MAX_BYTES);
    expect(googleUpdateDocBytes).toBeLessThanOrEqual(MCP_TOOL_DESCRIPTION_MAX_BYTES);
    expect(googleUpdateDocBytes).toBeLessThanOrEqual(MCP_TOOL_SNAPSHOT_DESCRIPTION_MAX_BYTES);
    expect(MCPToolSnapshotSchema.safeParse(tool({ description: "d".repeat(googleUpdateDocBytes) })).success).toBe(true);
  });

  it("counts multi-byte text in bytes, so a short string of wide characters can still be over", () => {
    // Half the bound in code units, but two bytes each: 65538 bytes, over by two.
    const wide = "é".repeat(MCP_TOOL_SNAPSHOT_DESCRIPTION_MAX_BYTES / 2 + 1);
    expect(wide.length).toBeLessThan(MCP_TOOL_SNAPSHOT_DESCRIPTION_MAX_BYTES);
    expect(MCPToolSnapshotSchema.safeParse(tool({ description: wide })).success).toBe(false);
    expect(
      MCPToolSnapshotSchema.safeParse(tool({ description: "é".repeat(MCP_TOOL_SNAPSHOT_DESCRIPTION_MAX_BYTES / 2) }))
        .success,
    ).toBe(true);
  });

  it("bounds the name in bytes as well and refuses an empty one", () => {
    expect(MCPToolSnapshotSchema.safeParse(tool({ name: "n".repeat(MCP_TOOL_NAME_MAX_BYTES) })).success).toBe(true);
    expect(MCPToolSnapshotSchema.safeParse(tool({ name: "n".repeat(MCP_TOOL_NAME_MAX_BYTES + 1) })).success).toBe(
      false,
    );
    expect(MCPToolSnapshotSchema.safeParse(tool({ name: "é".repeat(MCP_TOOL_NAME_MAX_BYTES / 2 + 1) })).success).toBe(
      false,
    );
    expect(MCPToolSnapshotSchema.safeParse(tool({ name: "" })).success).toBe(false);
  });

  it("bounds the input schema by its serialized bytes: at the bound passes, one byte over fails", () => {
    // `{"text":"<padding>"}` serializes to the padding plus 11 bytes of punctuation and key.
    const framing = JSON.stringify({ text: "" }).length;
    const atBound = { text: "x".repeat(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES - framing) };
    expect(JSON.stringify(atBound).length).toBe(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES);
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: atBound })).success).toBe(true);
    const oneOver = { text: "x".repeat(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES - framing + 1) };
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: oneOver })).success).toBe(false);
    // In bytes of the serialization, not code units: wide characters count double.
    const wide = { text: "é".repeat(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES / 2) };
    expect(JSON.stringify(wide).length).toBeLessThan(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES);
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: wide })).success).toBe(false);
  });

  it("refuses an input schema that cannot be serialized instead of throwing out of the parse", () => {
    const circular: Record<string, unknown> = { type: "object" };
    circular.self = circular;
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: circular })).success).toBe(false);
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: { max: 1n } })).success).toBe(false);
    // Null stays a valid "takes no arguments" schema.
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: null })).success).toBe(true);
  });
});

/**
 * The deployment's Google client is offered only to these origins. The predicate is an allowlist
 * against a hostile Server that advertises Google as its authorization server to harvest a Google
 * token, so every near-miss host must be refused.
 */
describe("isGoogleWorkspaceMcpEndpoint", () => {
  it("accepts every Google Workspace MCP endpoint at its documented URL", () => {
    expect(GOOGLE_WORKSPACE_MCP_ORIGINS).toHaveLength(8);
    expect(isGoogleWorkspaceMcpEndpoint("https://gmailmcp.googleapis.com/mcp/v1")).toBe(true);
    expect(isGoogleWorkspaceMcpEndpoint("https://drivemcp.googleapis.com/mcp/v1")).toBe(true);
    expect(isGoogleWorkspaceMcpEndpoint("https://docsmcp.googleapis.com/mcp/v1")).toBe(true);
    expect(isGoogleWorkspaceMcpEndpoint("https://sheetsmcp.googleapis.com/mcp/v1")).toBe(true);
    expect(isGoogleWorkspaceMcpEndpoint("https://slidesmcp.googleapis.com/mcp/v1")).toBe(true);
    expect(isGoogleWorkspaceMcpEndpoint("https://calendarmcp.googleapis.com/mcp/v1")).toBe(true);
    expect(isGoogleWorkspaceMcpEndpoint("https://chatmcp.googleapis.com/mcp/v1")).toBe(true);
    expect(isGoogleWorkspaceMcpEndpoint("https://people.googleapis.com/mcp/v1")).toBe(true);
  });

  it("is origin-based: any path on an allowed origin qualifies", () => {
    expect(isGoogleWorkspaceMcpEndpoint("https://gmailmcp.googleapis.com/")).toBe(true);
    expect(isGoogleWorkspaceMcpEndpoint("https://gmailmcp.googleapis.com:443/mcp/v1")).toBe(true);
    expect(isGoogleWorkspaceMcpEndpoint("https://GMAILMCP.GOOGLEAPIS.COM/mcp/v1")).toBe(true);
  });

  it("refuses a lookalike or suffixed host that is not one of the eight origins", () => {
    for (const url of [
      "https://gmailmcp.googleapis.com.evil.example/mcp/v1",
      "https://evilgmailmcp.googleapis.com/mcp/v1",
      "https://googleapis.com/mcp/v1",
      "https://accounts.google.com/mcp/v1",
      "https://mcp.example.com/mcp/v1",
    ]) {
      expect(isGoogleWorkspaceMcpEndpoint(url)).toBe(false);
    }
  });

  it("refuses a non-HTTPS scheme, a non-default port, and any userinfo", () => {
    expect(isGoogleWorkspaceMcpEndpoint("http://gmailmcp.googleapis.com/mcp/v1")).toBe(false);
    expect(isGoogleWorkspaceMcpEndpoint("https://gmailmcp.googleapis.com:8443/mcp/v1")).toBe(false);
    expect(isGoogleWorkspaceMcpEndpoint("https://user:secret@gmailmcp.googleapis.com/mcp/v1")).toBe(false);
    expect(isGoogleWorkspaceMcpEndpoint("https://user@gmailmcp.googleapis.com/mcp/v1")).toBe(false);
  });

  it("refuses a value that is not an absolute URL", () => {
    expect(isGoogleWorkspaceMcpEndpoint("")).toBe(false);
    expect(isGoogleWorkspaceMcpEndpoint("/mcp/v1")).toBe(false);
    expect(isGoogleWorkspaceMcpEndpoint("not a url")).toBe(false);
  });
});

/**
 * The deployment's Canva client is a Developer Portal client, so it is offered only to Canva's
 * Developer Portal MCP origin, by the same exact-origin rule as the Google allowlist. The waitlist
 * endpoint at `mcp.canva.com` belongs to a different authorization server and is refused.
 */
describe("isCanvaDeveloperPortalMcpEndpoint", () => {
  it("accepts the Developer Portal endpoint at its documented URL and any path on that origin", () => {
    expect(isCanvaDeveloperPortalMcpEndpoint(CANVA_DEVELOPER_PORTAL_MCP_URL)).toBe(true);
    expect(isCanvaDeveloperPortalMcpEndpoint("https://api.canva.com/")).toBe(true);
    expect(isCanvaDeveloperPortalMcpEndpoint("https://api.canva.com:443/connect/v1/mcp")).toBe(true);
    expect(isCanvaDeveloperPortalMcpEndpoint("https://API.CANVA.COM/connect/v1/mcp")).toBe(true);
  });

  it("refuses the waitlist endpoint and every lookalike, suffixed, or sibling host", () => {
    for (const url of [
      "https://mcp.canva.com/mcp",
      "https://www.canva.com/connect/v1/mcp",
      "https://api.canva.com.evil.example/connect/v1/mcp",
      "https://evilapi.canva.com/connect/v1/mcp",
      "https://canva.com/connect/v1/mcp",
      "https://mcp.example.com/mcp",
    ]) {
      expect(isCanvaDeveloperPortalMcpEndpoint(url)).toBe(false);
    }
  });

  it("refuses a non-HTTPS scheme, a non-default port, any userinfo, and a non-URL", () => {
    expect(isCanvaDeveloperPortalMcpEndpoint("http://api.canva.com/connect/v1/mcp")).toBe(false);
    expect(isCanvaDeveloperPortalMcpEndpoint("https://api.canva.com:8443/connect/v1/mcp")).toBe(false);
    expect(isCanvaDeveloperPortalMcpEndpoint("https://user:secret@api.canva.com/connect/v1/mcp")).toBe(false);
    expect(isCanvaDeveloperPortalMcpEndpoint("")).toBe(false);
    expect(isCanvaDeveloperPortalMcpEndpoint("not a url")).toBe(false);
  });
});

describe("MCP catalog deployment endpoints", () => {
  it("replaces only the Canva entry, with the Developer Portal endpoint", () => {
    expect(MCP_CATALOG_DEPLOYMENT_ENDPOINTS).toEqual({ canva: CANVA_DEVELOPER_PORTAL_MCP_URL });
  });

  it("accepts an empty list and refuses unknown keys or a malformed URL", () => {
    expect(MCPCatalogEndpointsResponseSchema.parse({ endpoints: [] })).toEqual({ endpoints: [] });
    expect(
      MCPCatalogEndpointsResponseSchema.safeParse({ endpoints: [{ catalogId: "canva", url: "not a url" }] }).success,
    ).toBe(false);
    expect(
      MCPCatalogEndpointsResponseSchema.safeParse({
        endpoints: [{ catalogId: "canva", url: CANVA_DEVELOPER_PORTAL_MCP_URL, secret: "x" }],
      }).success,
    ).toBe(false);
  });
});

describe("MCP static OAuth providers", () => {
  const provider = (brand: string) => {
    const found = MCP_STATIC_OAUTH_PROVIDERS.find((candidate) => candidate.brand === brand);
    if (!found) throw new Error(`missing provider ${brand}`);
    return found;
  };

  it("derives the OPENTAG_MCP_<BRAND>_CLIENT_* names", () => {
    expect(mcpStaticOAuthEnvNames("hubspot")).toEqual({
      clientId: "OPENTAG_MCP_HUBSPOT_CLIENT_ID",
      clientSecret: "OPENTAG_MCP_HUBSPOT_CLIENT_SECRET",
    });
  });

  it("matches only each provider's own origins", () => {
    expect(isMcpStaticOAuthEndpoint(provider("zoom"), "https://mcp.zoom.us/mcp/zoom/streamable")).toBe(true);
    expect(isMcpStaticOAuthEndpoint(provider("hubspot"), "https://mcp.hubspot.com")).toBe(true);
    expect(isMcpStaticOAuthEndpoint(provider("asana"), "https://mcp.asana.com/v2/mcp")).toBe(true);
    for (const url of [
      "https://mcp.zoom.us.evil.example/mcp",
      "https://evil.example/mcp.zoom.us",
      "http://mcp.zoom.us/mcp",
      "https://mcp.zoom.us:8443/mcp",
      "https://user:secret@mcp.zoom.us/mcp",
      "not a url",
    ]) {
      expect(isMcpStaticOAuthEndpoint(provider("zoom"), url)).toBe(false);
    }
    expect(isMcpStaticOAuthEndpoint(provider("asana"), "https://mcp.zoom.us/mcp")).toBe(false);
  });
});
