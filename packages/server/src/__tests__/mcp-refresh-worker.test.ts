import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentMcpServers,
  agents,
  mcpClientRegistrations,
  mcpServerAuthorizations,
  mcpServers,
  users,
} from "../db/schema/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { McpAuthorizationService } from "../services/mcp/mcp-authorization-service.js";
import { McpCredentialCipher } from "../services/mcp/mcp-credential-cipher.js";
import { FEISHU_MCP_ISSUER, FEISHU_TOKEN_ENDPOINT, McpOAuthClient } from "../services/mcp/mcp-oauth.js";
import { McpOAuthFlowService } from "../services/mcp/mcp-oauth-flow-service.js";
import type { McpProbe } from "../services/mcp/mcp-probe.js";
import {
  MCP_REFRESH_CONCURRENCY,
  McpRefreshWorker,
  refreshAtFrom,
  refreshLeadMs,
} from "../services/mcp/mcp-refresh-worker.js";
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

  it("runs pending probes and due OAuth refreshes with bounded concurrency and reuses OAuth metadata across a pass", async () => {
    expect(MCP_REFRESH_CONCURRENCY).toBe(5);
    const now = new Date("2026-04-20T12:00:00.000Z");
    const accountId = randomUUID();
    await unit.database
      .insert(users)
      .values({ id: accountId, email: `${accountId}@example.test`, displayName: "Concurrency Owner" });

    const issuer = "https://auth.example.com";
    const asMetadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
    const tokenEndpoint = `${issuer}/token`;
    await unit.database.insert(mcpClientRegistrations).values({
      accountId,
      authorizationServer: issuer,
      source: "preregistered",
      clientId: "shared-client",
    });

    const cipher = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(7)));
    const totalBindings = 4;
    for (let index = 0; index < totalBindings; index += 1) {
      const agentId = randomUUID();
      await unit.database.insert(agents).values({
        id: agentId,
        createdByUserId: accountId,
        name: `agent-conc-${index}-${agentId.slice(0, 6)}`,
        displayName: `Concurrency Agent ${index}`,
        runtimeProvider: "codex",
      });
      const [server] = await unit.database
        .insert(mcpServers)
        .values({
          accountId,
          name: `mcp-${index}`,
          url: `https://mcp-${index}.example.com/mcp`,
          defaultAuthKind: "oauth",
        })
        .returning();
      await unit.database.insert(agentMcpServers).values({ agentId, mcpServerId: server?.id as string });
      const sealed = cipher.encryptAuthorizationCredential(
        { mcpServerId: server?.id as string, agentId, authorizationServer: issuer },
        { accessToken: `at-old-${index}`, refreshToken: `rt-old-${index}` },
      );
      await unit.database.insert(mcpServerAuthorizations).values({
        agentId,
        mcpServerId: server?.id as string,
        kind: "oauth",
        status: "active",
        authorizationServer: issuer,
        oauthResource: `https://mcp-${index}.example.com/mcp`,
        ciphertext: sealed.ciphertext,
        keyId: sealed.keyId,
        accessTokenExpiresAt: new Date(now.getTime() + 60_000),
        probeState: "pending",
      });
    }

    let metadataCalls = 0;
    let tokenCalls = 0;
    let activeTokenCalls = 0;
    let maxConcurrentTokenCalls = 0;
    const fetchImpl = vi.fn(async (url: URL | string) => {
      const urlStr = String(url);
      if (urlStr === asMetadataUrl) {
        metadataCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return new Response(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: tokenEndpoint,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr === tokenEndpoint) {
        tokenCalls += 1;
        activeTokenCalls += 1;
        maxConcurrentTokenCalls = Math.max(maxConcurrentTokenCalls, activeTokenCalls);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeTokenCalls -= 1;
        return new Response(
          JSON.stringify({
            access_token: `at-new-${tokenCalls}`,
            refresh_token: `rt-new-${tokenCalls}`,
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const fetcher = new McpOutboundFetcher({
      allowLoopback: false,
      fetch: fetchImpl,
      resolveAddresses: async () => ["93.184.216.34"],
    });
    const oauth = new McpOAuthClient({ fetcher, publicUrl: "https://opentag.test", now: () => now });
    const servers = new McpServerService({ database: unit.database, now: () => now });

    let activeProbes = 0;
    let maxConcurrentProbes = 0;
    let totalProbes = 0;
    const authorization = {
      probe: vi.fn(async (_accountId: string, agentId: string, mcpServerId: string) => {
        totalProbes += 1;
        activeProbes += 1;
        maxConcurrentProbes = Math.max(maxConcurrentProbes, activeProbes);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeProbes -= 1;
        await unit.database
          .update(mcpServerAuthorizations)
          .set({ probeState: "succeeded", updatedAt: now })
          .where(eq(mcpServerAuthorizations.agentId, agentId));
        return { probeState: "succeeded" as const, toolsCount: 0, mcpServerId };
      }),
    } as unknown as McpAuthorizationService;

    const flows = new McpOAuthFlowService({
      database: unit.database,
      cipher,
      oauth,
      servers,
      now: () => now,
    });
    const worker = new McpRefreshWorker({
      authorization,
      concurrency: 2,
      database: unit.database,
      flows,
      servers,
      now: () => now,
    });

    expect(await worker.runOnce()).toBe(totalBindings);
    expect(totalProbes).toBe(totalBindings);
    expect(maxConcurrentProbes).toBe(2);
    expect(tokenCalls).toBe(totalBindings);
    expect(maxConcurrentTokenCalls).toBe(2);
    // All four concurrent/subsequent refreshes for the same issuer share a single well-known fetch.
    expect(metadataCalls).toBe(1);
  });

  it("stops scheduling remaining items once stop() is called while awaiting in-flight work", async () => {
    const now = new Date("2026-04-20T12:00:00.000Z");
    const accountId = randomUUID();
    await unit.database
      .insert(users)
      .values({ id: accountId, email: `${accountId}@example.test`, displayName: "Stop Owner" });

    for (let index = 0; index < 3; index += 1) {
      const agentId = randomUUID();
      await unit.database.insert(agents).values({
        id: agentId,
        createdByUserId: accountId,
        name: `agent-stop-${index}-${agentId.slice(0, 6)}`,
        displayName: `Stop Agent ${index}`,
        runtimeProvider: "codex",
      });
      const [server] = await unit.database
        .insert(mcpServers)
        .values({
          accountId,
          name: `mcp-stop-${index}`,
          url: `https://mcp-stop-${index}.example.com/mcp`,
          defaultAuthKind: "bearer",
        })
        .returning();
      await unit.database.insert(agentMcpServers).values({ agentId, mcpServerId: server?.id as string });
      await unit.database.insert(mcpServerAuthorizations).values({
        agentId,
        mcpServerId: server?.id as string,
        kind: "bearer",
        status: "active",
        ciphertext: "v2.default.x.y.z",
        keyId: "default",
        probeState: "pending",
      });
    }

    let worker!: McpRefreshWorker;
    let probeCalls = 0;
    const authorization = {
      probe: vi.fn(async () => {
        probeCalls += 1;
        void worker.stop();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
    } as unknown as McpAuthorizationService;

    worker = new McpRefreshWorker({
      authorization,
      concurrency: 1,
      database: unit.database,
      flows: { refreshAuthorization: vi.fn() } as unknown as McpOAuthFlowService,
      servers: new McpServerService({ database: unit.database, now: () => now }),
      now: () => now,
    });

    expect(await worker.runOnce()).toBe(0);
    expect(probeCalls).toBe(1);
  });
});
