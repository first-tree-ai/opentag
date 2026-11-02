import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentMcpServers, agents, mcpServerAuthorizations, mcpServers, users } from "../db/schema/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { McpAuthorizationService } from "../services/mcp/mcp-authorization-service.js";
import { McpCredentialCipher } from "../services/mcp/mcp-credential-cipher.js";
import { FEISHU_MCP_ISSUER, FEISHU_TOKEN_ENDPOINT, McpOAuthClient } from "../services/mcp/mcp-oauth.js";
import { McpOAuthFlowService } from "../services/mcp/mcp-oauth-flow-service.js";
import type { McpProbe } from "../services/mcp/mcp-probe.js";
import { McpRefreshWorker, refreshAtFrom, refreshLeadMs } from "../services/mcp/mcp-refresh-worker.js";
import { McpServerService } from "../services/mcp/mcp-server-service.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => {
  await unit.reset();
});

const FEISHU_MCP_URL = "https://mcp.feishu.cn/mcp";
const FEISHU_CLIENT = { clientId: "feishu-app-id", clientSecret: "feishu-app-secret" };

describe("McpRefreshWorker", () => {
  it("computes the renewal lead window before token expiry", () => {
    expect(refreshLeadMs(7200)).toBe(5 * 60 * 1000);
    expect(refreshLeadMs(120)).toBe(60 * 1000);
    const expiresAt = new Date("2026-04-20T12:00:00.000Z");
    expect(refreshAtFrom(expiresAt, 7200).toISOString()).toBe("2026-04-20T11:55:00.000Z");
  });

  it("refreshes due Feishu OAuth credentials and rotates both access and refresh tokens before expiry", async () => {
    const now = new Date();
    const accountId = randomUUID();
    await unit.database
      .insert(users)
      .values({ id: accountId, email: `${accountId}@example.test`, displayName: "Feishu Owner" });
    const agentId = randomUUID();
    await unit.database.insert(agents).values({
      id: agentId,
      createdByUserId: accountId,
      name: `agent-${agentId.slice(0, 8)}`,
      displayName: "Feishu Agent",
      runtimeProvider: "codex",
    });
    const [server] = await unit.database
      .insert(mcpServers)
      .values({
        accountId,
        name: "feishu",
        url: FEISHU_MCP_URL,
        defaultAuthKind: "oauth",
        authHeader: "x-lark-mcp-uat",
        authScheme: "",
        extraHeaders: {
          "x-lark-mcp-allowed-tools": "search-user,fetch-file,search-doc,create-doc,fetch-doc,update-doc",
        },
      })
      .returning();
    await unit.database.insert(agentMcpServers).values({ agentId, mcpServerId: server?.id as string });

    const cipher = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(7)));
    const sealed = cipher.encryptAuthorizationCredential(
      { mcpServerId: server?.id as string, agentId, authorizationServer: FEISHU_MCP_ISSUER },
      { accessToken: "u-feishu-old", refreshToken: "ur-feishu-old" },
    );
    await unit.database.insert(mcpServerAuthorizations).values({
      agentId,
      mcpServerId: server?.id as string,
      kind: "oauth",
      status: "active",
      authorizationServer: FEISHU_MCP_ISSUER,
      oauthResource: FEISHU_MCP_URL,
      ciphertext: sealed.ciphertext,
      keyId: sealed.keyId,
      accessTokenExpiresAt: new Date(now.getTime() + 2 * 60 * 1000),
      probeState: "succeeded",
      tools: [{ name: "fetch-doc", description: "Fetch doc", inputSchema: { type: "object" } }],
      toolsCount: 1,
    });

    const fetchImpl = vi.fn(async (url: URL | string) => {
      expect(String(url)).toBe(FEISHU_TOKEN_ENDPOINT);
      return new Response(
        JSON.stringify({
          code: 0,
          access_token: "u-feishu-new",
          refresh_token: "ur-feishu-new",
          token_type: "Bearer",
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const fetcher = new McpOutboundFetcher({
      allowLoopback: false,
      fetch: fetchImpl,
      resolveAddresses: async () => ["93.184.216.34"],
    });
    const oauth = new McpOAuthClient({ fetcher, publicUrl: "https://opentag.test" });
    const servers = new McpServerService({ database: unit.database, now: () => now });
    const authorization = new McpAuthorizationService({
      database: unit.database,
      cipher,
      servers,
      probe: { probe: vi.fn() } as unknown as McpProbe,
      now: () => now,
    });
    const flows = new McpOAuthFlowService({
      database: unit.database,
      cipher,
      oauth,
      servers,
      staticMcpClients: { feishu: FEISHU_CLIENT },
      now: () => now,
    });
    const worker = new McpRefreshWorker({
      authorization,
      database: unit.database,
      flows,
      servers,
      now: () => now,
    });

    expect(await worker.runOnce()).toBe(1);
    const [row] = await unit.database
      .select()
      .from(mcpServerAuthorizations)
      .where(eq(mcpServerAuthorizations.agentId, agentId));
    expect(row?.status).toBe("active");
    expect(row?.refreshGeneration).toBe(1);
    expect(await authorization.buildHeaders(accountId, agentId, server?.id as string)).toEqual({
      "x-lark-mcp-uat": "u-feishu-new",
      "x-lark-mcp-allowed-tools": "search-user,fetch-file,search-doc,create-doc,fetch-doc,update-doc",
    });
  });
});
