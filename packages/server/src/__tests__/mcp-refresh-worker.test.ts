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
import { McpProbe as RealMcpProbe } from "../services/mcp/mcp-probe.js";
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

  async function seedOAuthBindings(options: {
    accountId: string;
    cipher: McpCredentialCipher;
    count: number;
    issuer: string;
    now: Date;
    prefix: string;
  }) {
    const { accountId, cipher, count, issuer, now, prefix } = options;
    for (let index = 0; index < count; index += 1) {
      const agentId = randomUUID();
      await unit.database.insert(agents).values({
        id: agentId,
        createdByUserId: accountId,
        name: `agent-${prefix}-${index}-${agentId.slice(0, 6)}`,
        displayName: `${prefix} Agent ${index}`,
        runtimeProvider: "codex",
      });
      const [server] = await unit.database
        .insert(mcpServers)
        .values({
          accountId,
          name: `mcp-${prefix}-${index}`,
          url: `https://mcp-${prefix}-${index}.example.com/mcp`,
          defaultAuthKind: "oauth",
        })
        .returning();
      const serverId = server?.id as string;
      await unit.database.insert(agentMcpServers).values({ agentId, mcpServerId: serverId });
      const sealed = cipher.encryptAuthorizationCredential(
        { mcpServerId: serverId, agentId, authorizationServer: issuer },
        { accessToken: `at-old-${index}`, refreshToken: `rt-old-${index}` },
      );
      await unit.database.insert(mcpServerAuthorizations).values({
        agentId,
        mcpServerId: serverId,
        kind: "oauth",
        status: "active",
        authorizationServer: issuer,
        oauthResource: `https://mcp-${prefix}-${index}.example.com/mcp`,
        ciphertext: sealed.ciphertext,
        keyId: sealed.keyId,
        accessTokenExpiresAt: new Date(now.getTime() + 60_000),
        probeState: "pending",
      });
    }
  }

  function isToolsListRequest(init?: RequestInit): boolean {
    if (typeof init?.body !== "string") return false;
    return (JSON.parse(init.body) as { method?: string }).method === "tools/list";
  }

  function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("runs >= 5 pending probes and due OAuth refreshes in the same Account at default concurrency and reuses OAuth metadata across a pass", async () => {
    expect(MCP_REFRESH_CONCURRENCY).toBe(3);
    const now = new Date();
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
    const totalBindings = 6;
    await seedOAuthBindings({ accountId, cipher, count: totalBindings, issuer, now, prefix: "conc" });

    let metadataCalls = 0;
    let tokenCalls = 0;
    let activeTokenCalls = 0;
    let maxConcurrentTokenCalls = 0;
    let activeProbes = 0;
    let maxConcurrentProbes = 0;
    let totalProbes = 0;
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr === asMetadataUrl) {
        metadataCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return jsonResponse({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: tokenEndpoint,
        });
      }
      if (urlStr === tokenEndpoint) {
        tokenCalls += 1;
        activeTokenCalls += 1;
        maxConcurrentTokenCalls = Math.max(maxConcurrentTokenCalls, activeTokenCalls);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeTokenCalls -= 1;
        return jsonResponse({
          access_token: `at-new-${tokenCalls}`,
          refresh_token: `rt-new-${tokenCalls}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (isToolsListRequest(init)) {
        return jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
      }
      totalProbes += 1;
      activeProbes += 1;
      maxConcurrentProbes = Math.max(maxConcurrentProbes, activeProbes);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeProbes -= 1;
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities: {},
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "mock-mcp", version: "1.0.0" } },
        },
      });
    }) as unknown as typeof globalThis.fetch;

    const fetcher = new McpOutboundFetcher({
      allowLoopback: false,
      fetch: fetchImpl,
      resolveAddresses: async () => ["93.184.216.34"],
    });
    const oauth = new McpOAuthClient({ fetcher, publicUrl: "https://opentag.test", now: () => now });
    const servers = new McpServerService({ database: unit.database, now: () => now });
    const probe = new RealMcpProbe({ fetcher, now: () => now });
    const authorization = new McpAuthorizationService({
      database: unit.database,
      cipher,
      servers,
      probe,
      now: () => now,
    });
    const flows = new McpOAuthFlowService({
      database: unit.database,
      cipher,
      oauth,
      servers,
      now: () => now,
    });
    const worker = new McpRefreshWorker({
      authorization,
      database: unit.database,
      flows,
      servers,
      now: () => now,
    });

    expect(await worker.runOnce()).toBe(totalBindings);
    expect(totalProbes).toBe(totalBindings);
    expect(maxConcurrentProbes).toBe(MCP_REFRESH_CONCURRENCY);
    expect(tokenCalls).toBe(totalBindings);
    expect(maxConcurrentTokenCalls).toBe(MCP_REFRESH_CONCURRENCY);
    // All six refreshes for the same issuer share a single well-known fetch.
    expect(metadataCalls).toBe(1);

    const rows = await unit.database.select().from(mcpServerAuthorizations);
    expect(rows).toHaveLength(totalBindings);
    for (const row of rows) {
      expect(row.status).toBe("active");
      expect(row.probeState).toBe("succeeded");
      expect(row.refreshGeneration).toBe(1);
      expect(row.ciphertext).toBeTruthy();
    }
  });

  it("preserves credentials and pending probe state when an Account's outbound concurrency cap is reached", async () => {
    const now = new Date();
    const accountId = randomUUID();
    await unit.database
      .insert(users)
      .values({ id: accountId, email: `${accountId}@example.test`, displayName: "Cap Owner" });

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
    const totalBindings = 5;
    await seedOAuthBindings({ accountId, cipher, count: totalBindings, issuer, now, prefix: "cap" });

    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const urlStr = String(url);
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (urlStr === asMetadataUrl) {
        return jsonResponse({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: tokenEndpoint,
        });
      }
      if (urlStr === tokenEndpoint) {
        return jsonResponse({
          access_token: "at-new",
          refresh_token: "rt-new",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (isToolsListRequest(init)) {
        return jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities: {},
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "mock-mcp", version: "1.0.0" } },
        },
      });
    }) as unknown as typeof globalThis.fetch;

    // Force per-Account concurrency rejections by capping the Account at 2 while worker concurrency is 5.
    const fetcher = new McpOutboundFetcher({
      allowLoopback: false,
      fetch: fetchImpl,
      maxConcurrentPerAccount: 2,
      resolveAddresses: async () => ["93.184.216.34"],
    });
    const oauth = new McpOAuthClient({ fetcher, publicUrl: "https://opentag.test", now: () => now });
    const servers = new McpServerService({ database: unit.database, now: () => now });
    const probe = new RealMcpProbe({ fetcher, now: () => now });
    const authorization = new McpAuthorizationService({
      database: unit.database,
      cipher,
      servers,
      probe,
      now: () => now,
    });
    const flows = new McpOAuthFlowService({
      database: unit.database,
      cipher,
      oauth,
      servers,
      now: () => now,
    });
    const worker = new McpRefreshWorker({
      authorization,
      concurrency: 5,
      database: unit.database,
      flows,
      servers,
      now: () => now,
    });

    await worker.runOnce();
    const rows = await unit.database.select().from(mcpServerAuthorizations);
    expect(rows).toHaveLength(totalBindings);
    // Every row that was refused a local concurrency slot must remain active with its credential
    // intact (never wiped as MCP_REFRESH_OUTCOME_UNKNOWN) and must not be marked probeState = "failed".
    for (const row of rows) {
      expect(row.status).toBe("active");
      expect(row.failureCode).toBeNull();
      expect(row.ciphertext).toBeTruthy();
      expect(row.keyId).toBe("default");
      expect(row.refreshClaimId).toBeNull();
      expect(["pending", "succeeded"]).toContain(row.probeState);
    }
    expect(rows.some((row) => row.refreshGeneration === 0)).toBe(true);
    expect(rows.some((row) => row.probeState === "pending")).toBe(true);

    // Direct callers (`POST .../probe`, `setMcpBearerKey`, `createMcpServer`) do not pass
    // `rethrowConcurrencyLimit` and receive the current probe snapshot instead of a 503 error.
    const cappedFetcher = new McpOutboundFetcher({
      allowLoopback: false,
      fetch: fetchImpl,
      maxConcurrentPerAccount: 0,
      resolveAddresses: async () => ["93.184.216.34"],
    });
    const cappedAuth = new McpAuthorizationService({
      database: unit.database,
      cipher,
      servers,
      probe: new RealMcpProbe({ fetcher: cappedFetcher, now: () => now }),
      now: () => now,
    });
    const targetRow = rows[0];
    if (!targetRow) throw new Error("Expected at least one authorization row");
    const directOutcome = await cappedAuth.probe(accountId, targetRow.agentId, targetRow.mcpServerId);
    expect(directOutcome.probeState).toBe(targetRow.probeState);
    expect(directOutcome.probeError).toBeNull();
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

  it("drains sibling in-flight workers before settling runOnce() and stop() when one worker rejects", async () => {
    const now = new Date("2026-04-20T12:00:00.000Z");
    const accountId = randomUUID();
    await unit.database
      .insert(users)
      .values({ id: accountId, email: `${accountId}@example.test`, displayName: "Drain Owner" });

    for (let index = 0; index < 2; index += 1) {
      const agentId = randomUUID();
      await unit.database.insert(agents).values({
        id: agentId,
        createdByUserId: accountId,
        name: `agent-drain-${index}-${agentId.slice(0, 6)}`,
        displayName: `Drain Agent ${index}`,
        runtimeProvider: "codex",
      });
      const [server] = await unit.database
        .insert(mcpServers)
        .values({
          accountId,
          name: `mcp-drain-${index}`,
          url: `https://mcp-drain-${index}.example.com/mcp`,
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

    let siblingSettled = false;
    let siblingSettledWhenStopResolved = false;
    let stopPromise: Promise<void> | undefined;
    let callIndex = 0;
    let worker!: McpRefreshWorker;
    const authorization = {
      probe: vi.fn(async () => {
        callIndex += 1;
        if (callIndex === 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("probe failed");
        }
        stopPromise = worker
          .stop()
          .catch(() => undefined)
          .then(() => {
            siblingSettledWhenStopResolved = siblingSettled;
          });
        await new Promise((resolve) => setTimeout(resolve, 40));
        siblingSettled = true;
      }),
    } as unknown as McpAuthorizationService;

    worker = new McpRefreshWorker({
      authorization,
      concurrency: 2,
      database: unit.database,
      flows: { refreshAuthorization: vi.fn() } as unknown as McpOAuthFlowService,
      onError: () => {
        throw new Error("onError callback threw");
      },
      servers: new McpServerService({ database: unit.database, now: () => now }),
      now: () => now,
    });

    await expect(worker.runOnce()).rejects.toThrow("onError callback threw");
    expect(siblingSettled).toBe(true);
    await expect(stopPromise).resolves.toBeUndefined();
    expect(siblingSettledWhenStopResolved).toBe(true);
  });
});
