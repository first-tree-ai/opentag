import { describe, expect, it } from "vitest";
import {
  formatMcpCatalogKey,
  MCP_CATALOG_ENTRIES,
  matchesMcpCatalogEndpoint,
  resolveMcpCatalogSetup,
} from "../index.js";

function entry(id: string) {
  const result = MCP_CATALOG_ENTRIES.find((value) => value.id === id);
  if (!result) throw new Error(`Missing preset ${id}`);
  return result;
}

describe("customer endpoint setup", () => {
  it("keeps all seven unresolved endpoints out of ready-to-run connection fields", () => {
    const configured = MCP_CATALOG_ENTRIES.filter((value) => value.setup?.endpoint);
    expect(configured.map((value) => value.id).sort()).toEqual([
      "databricks",
      "dbt",
      "dynatrace",
      "elastic",
      "make",
      "n8n",
      "snowflake",
    ]);
    for (const value of configured) {
      expect(value.installable).toBe(false);
      expect(value.url).toBeUndefined();
    }
  });

  it("resolves real endpoints with the existing Server request shape and exact key scheme", () => {
    const resolved = resolveMcpCatalogSetup(
      entry("elastic"),
      "https://kibana.example.com/s/research/api/agent_builder/mcp",
    );
    expect(resolved).toMatchObject({
      installable: true,
      defaultAuthKind: "bearer",
      authScheme: "ApiKey",
      extraHeaders: {},
    });
    expect(resolveMcpCatalogSetup(entry("n8n"), "https://automation.example.com/mcp-server/http")).toMatchObject({
      installable: true,
      authScheme: "Bearer",
    });
  });

  it.each([
    "http://automation.example.com/mcp-server/http",
    "https://user:secret@automation.example.com/mcp-server/http",
    "https://automation.example.com/mcp-server/http#token",
    "https://automation.example.com/mcp-server/http?token=secret",
    "https://automation.example.com/other",
  ])("refuses an invalid or credential-bearing endpoint: %s", (url) => {
    expect(resolveMcpCatalogSetup(entry("n8n"), url)).toBeUndefined();
  });

  it("checks provider host boundaries and preserves permitted workspace query parameters", () => {
    expect(matchesMcpCatalogEndpoint(entry("make"), "https://eu2.make.com/mcp/v2")).toBe(true);
    expect(matchesMcpCatalogEndpoint(entry("make"), "https://evilmake.com/mcp/v2")).toBe(false);
    const url = "https://work.cloud.databricks.com/ai-gateway/mcp-services/system.ai.dbsql?o=123";
    expect(resolveMcpCatalogSetup(entry("databricks"), url)?.url).toBe(url);
    expect(resolveMcpCatalogSetup(entry("databricks"), `${url}&token=secret`)).toBeUndefined();
    expect(resolveMcpCatalogSetup(entry("databricks"), `${url}&o=456`)).toBeUndefined();
  });

  it.each([
    ["dynatrace", "https://tenant.apps.dynatrace.com/platform-reserved/mcp-gateway/v0.1/servers/dynatrace-mcp/mcp"],
    ["snowflake", "https://account.snowflakecomputing.com/api/v2/databases/DB/schemas/PUBLIC/mcp-servers/TOOLS"],
  ])("accepts the documented customer endpoint for %s", (id, url) => {
    expect(resolveMcpCatalogSetup(entry(id), url)).toMatchObject({ url, defaultAuthKind: "bearer" });
  });

  it("requires dbt environment settings and keeps optional headers out until supplied", () => {
    const value = entry("dbt"),
      url = "https://account.us1.dbt.com/api/ai/v1/mcp/";
    expect(resolveMcpCatalogSetup(value, url)).toBeUndefined();
    expect(resolveMcpCatalogSetup(value, url, { "x-dbt-prod-environment-id": "invalid" })).toBeUndefined();
    expect(resolveMcpCatalogSetup(value, url, { "x-dbt-prod-environment-id": "42" })).toMatchObject({
      authScheme: "Token",
      extraHeaders: { "x-dbt-prod-environment-id": "42" },
    });
    expect(
      resolveMcpCatalogSetup(value, url, { "x-dbt-prod-environment-id": "42", "x-dbt-user-id": "12\r\nsecret" }),
    ).toBeUndefined();
  });
});

describe("documented key placement", () => {
  it.each([
    ["similarweb", "api-key"],
    ["se-ranking", "x-api-key"],
    ["langsmith", "x-api-key"],
    ["lemlist", "x-api-key"],
    ["close", "close-api-key"],
  ])("preserves the raw-key first-install defaults for %s", (id, header) => {
    expect(entry(id)).toMatchObject({ defaultAuthKind: "bearer", authHeader: header, authScheme: "" });
  });

  it("retains Close's non-secret tool-scope header", () => {
    expect(entry("close").extraHeaders).toEqual({ "close-scope": "mcp.read" });
  });

  it("formats PagerDuty exactly once, and respects advanced header overrides", () => {
    const value = entry("pagerduty"),
      config = { authHeader: "authorization", authScheme: "Token" };
    expect(formatMcpCatalogKey(value, " example-key ", config)).toBe("token=example-key");
    expect(formatMcpCatalogKey(value, "token=example-key", config)).toBe("token=example-key");
    expect(formatMcpCatalogKey(value, "example-key", { ...config, authScheme: "Bearer" })).toBe("example-key");
    expect(formatMcpCatalogKey(value, "example-key", { ...config, authHeader: "x-api-key" })).toBe("example-key");
    expect(formatMcpCatalogKey(undefined, "example-key", config)).toBe("example-key");
  });
});
