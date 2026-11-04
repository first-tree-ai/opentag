import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  agentMcpServers,
  agentSkills,
  agents,
  mcpServerAuthorizations,
  mcpServers,
  users,
} from "../../db/schema/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { McpAuthorizationService } from "../../services/mcp/mcp-authorization-service.js";
import { McpCredentialCipher } from "../../services/mcp/mcp-credential-cipher.js";
import { FEISHU_MCP_ISSUER, FEISHU_TOKEN_ENDPOINT, McpOAuthClient } from "../../services/mcp/mcp-oauth.js";
import { McpOAuthFlowService } from "../../services/mcp/mcp-oauth-flow-service.js";
import type { McpProbe } from "../../services/mcp/mcp-probe.js";
import { McpRefreshWorker } from "../../services/mcp/mcp-refresh-worker.js";
import { McpServerService } from "../../services/mcp/mcp-server-service.js";
import { McpOutboundFetcher } from "../../services/mcp/mcp-url-policy.js";
import { SkillObjectGc } from "../../services/skills/skill-object-gc.js";
import { SkillObjectStoreError, skillObjectKey } from "../../services/skills/skill-object-store.js";
import { closeServerResources } from "../../shutdown.js";
import { deferred } from "../support/deferred.js";
import { FakeSkillObjectStore } from "../support/fake-skill-object-store.js";
import { pausedTableRead } from "../support/paused-binding-read.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
let unit: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
beforeEach(async () => {
  await pg.reset();
  unit = createDatabaseClient(pg.databaseUrl, { max: 1 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await unit?.sql.end();
});
afterAll(async () => pg?.stop());
const FEISHU_MCP_URL = "https://mcp.feishu.cn/mcp";
const FEISHU_CLIENT = { clientId: "feishu-app-id", clientSecret: "feishu-app-secret" };

describe("background worker drain", () => {
  it("joins an issued refresh through credential persistence before stopping", async () => {
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

    const entered = deferred(),
      release = deferred();
    const fetchImpl = vi.fn(async (url: URL | string) => {
      expect(String(url)).toBe(FEISHU_TOKEN_ENDPOINT);
      entered.resolve();
      await release.promise;
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

    const running = worker.runOnce();
    await entered.promise;
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      const [claimed] = await unit.database
        .select()
        .from(mcpServerAuthorizations)
        .where(eq(mcpServerAuthorizations.agentId, agentId));
      expect(claimed?.refreshClaimId).not.toBeNull();
      release.resolve();
      expect(await running).toBe(1);
      await stopping;
    } finally {
      release.resolve();
      await Promise.allSettled([running, stopping]);
    }
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
  it("joins a paused real MCP scan before pool disposal and skips subsequent SQL", async () => {
    const paused = pausedTableRead(unit.database, mcpServerAuthorizations);
    paused.arm();
    const worker = emptyWorker(paused.database);
    const running = worker.runOnce();
    await paused.captured;
    let disposed = false;
    const closing = closeServerResources([
      ["MCP worker", () => worker.stop()],
      [
        "SQL",
        async () => {
          disposed = true;
          await unit.sql.end();
        },
      ],
    ]);
    try {
      await Promise.resolve();
      expect(disposed).toBe(false);
      paused.release();
      await closing;
      expect(await running).toBe(0);
      expect(disposed).toBe(true);
      expect(await worker.runOnce()).toBe(0);
    } finally {
      paused.release();
      await Promise.allSettled([running, closing]);
    }
  });

  it("observes a failed admitted SQL pass while continuing pool cleanup", async () => {
    const observer = createDatabaseClient(pg.databaseUrl, { max: 2 }),
      locked = deferred(),
      unlock = deferred();
    const holding = observer.sql.begin(async (tx) => {
      await tx`lock table mcp_server_authorizations in access exclusive mode`;
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
    await unit.sql`set statement_timeout = '150ms'`;
    const worker = emptyWorker(unit.database),
      running = worker.runOnce();
    const outcome = running.then(
      () => undefined,
      (error) => error,
    );
    let disposed = false;
    const closing = closeServerResources([
      ["MCP worker", () => worker.stop()],
      [
        "SQL",
        async () => {
          disposed = true;
          await unit.sql.end();
        },
      ],
    ]);
    try {
      await expect(closing).rejects.toBeInstanceOf(AggregateError);
      expect(await outcome).toMatchObject({ cause: { code: "57014" } });
      expect(disposed).toBe(true);
      expect(await worker.runOnce()).toBe(0);
    } finally {
      unlock.resolve();
      await holding;
      await Promise.allSettled([outcome, closing]);
      await observer.sql.end();
    }
  });

  it("joins GC reference SQL before pool disposal without starting a delete", async () => {
    const paused = pausedTableRead(unit.database, agentSkills);
    paused.arm();
    const store = orphanStore(2),
      gc = new SkillObjectGc({ database: paused.database, store, prefix: "skills" });
    const running = gc.runOnce();
    await paused.captured;
    let disposed = false;
    const closing = closeServerResources([
      ["Skill GC", () => gc.stop()],
      [
        "SQL",
        async () => {
          disposed = true;
          await unit.sql.end();
        },
      ],
    ]);
    try {
      await Promise.resolve();
      expect(disposed).toBe(false);
      paused.release();
      await closing;
      expect((await running).deleted).toBe(0);
      expect(store.deletes).toBe(0);
      expect(disposed).toBe(true);
      expect((await gc.runOnce()).scanned).toBe(0);
    } finally {
      paused.release();
      await Promise.allSettled([running, closing]);
    }
  });

  it("bounds real reference checks for failed deletions and progresses over later pages", async () => {
    const store = orphanStore(6),
      deletion = vi.spyOn(store, "delete").mockRejectedValue(new SkillObjectStoreError("unavailable", "controlled"));
    const gc = new SkillObjectGc({
      database: unit.database,
      store,
      prefix: "skills",
      pageSize: 2,
      maxPagesPerRun: 1,
      maxDeletesPerRun: 2,
    });
    for (let page = 0; page < 3; page += 1) expect(await gc.runOnce()).toMatchObject({ scanned: 2, deleted: 0 });
    expect(store.lists).toBe(3);
    expect(new Set(deletion.mock.calls.map(([key]) => key)).size).toBe(6);
    await gc.stop();
  });
});

function orphanStore(count: number) {
  const store = new FakeSkillObjectStore();
  store.defaultLastModified = new Date(0);
  for (let n = 0; n < count; n += 1)
    store.plant(
      skillObjectKey({
        prefix: "skills",
        accountId: randomUUID(),
        agentId: randomUUID(),
        skillId: randomUUID(),
        objectId: "a".repeat(64),
      }),
      new Uint8Array([1]),
    );
  return store;
}

function emptyWorker(database: DatabaseClient) {
  const cipher = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(7)));
  const servers = new McpServerService({ database: database });
  const authorization = new McpAuthorizationService({
    database: database,
    cipher,
    servers,
    probe: { probe: vi.fn() } as unknown as McpProbe,
  });
  const oauth = new McpOAuthClient({ fetcher: new McpOutboundFetcher(), publicUrl: "https://opentag.test" });
  const flows = new McpOAuthFlowService({ database: database, cipher, oauth, servers });
  return new McpRefreshWorker({ database: database, authorization, flows, servers });
}
