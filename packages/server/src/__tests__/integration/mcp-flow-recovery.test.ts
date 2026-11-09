import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { mcpServerAuthorizations } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { MCP_ERROR_CODES, McpServiceError } from "../../services/mcp/errors.js";
import { McpAuthorizationService } from "../../services/mcp/mcp-authorization-service.js";
import { McpCredentialCipher } from "../../services/mcp/mcp-credential-cipher.js";
import { McpOAuthClient } from "../../services/mcp/mcp-oauth.js";
import { McpOAuthFlowService } from "../../services/mcp/mcp-oauth-flow-service.js";
import { McpProbe } from "../../services/mcp/mcp-probe.js";
import { McpRefreshWorker } from "../../services/mcp/mcp-refresh-worker.js";
import { McpServerService } from "../../services/mcp/mcp-server-service.js";
import { McpOutboundFetcher } from "../../services/mcp/mcp-url-policy.js";
import { McpFixtureServer } from "../fixtures/mcp-fixture-server.js";
import { deferred } from "../support/deferred.js";
import { createSkillHarness } from "../support/skill-service-harness.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const SECRET = "fixture-browser-secret";
let pg: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let observer: ReturnType<typeof createDatabaseClient>;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
  client = createDatabaseClient(pg.databaseUrl, { max: 1, statementTimeoutMs: 500, queryTimeoutMs: 2000 });
  observer = createDatabaseClient(pg.databaseUrl, { max: 2 });
}, 120000);
beforeEach(async () => pg.reset());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
afterAll(async () => {
  await Promise.all([client?.sql.end(), observer?.sql.end()]);
  await pg?.stop();
});

async function fixture() {
  const endpoint = await McpFixtureServer.start();
  cleanups.push(() => endpoint.stop());
  const accountId = await createSkillHarness(client).createUser();
  const agent = await new AgentService(client.database).createForAccount(accountId, {
    name: "mcp-flow",
    displayName: "Flow",
    runtimeProvider: "pi",
  });
  const cipher = new McpCredentialCipher(new ApplicationCipher(randomBytes(32)));
  const servers = new McpServerService({ database: client.database, cipher });
  const server = await servers.createServer(accountId, {
    name: "fixture",
    url: endpoint.endpoint,
    defaultAuthKind: "oauth",
  });
  await servers.attachServer(accountId, agent.id, server.id, true);
  const fault = { dropRefreshResponse: false };
  const fetcher = new McpOutboundFetcher({
    allowLoopback: true,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (fault.dropRefreshResponse && String(init?.body).includes("grant_type=refresh_token")) {
        await response.arrayBuffer();
        throw new TypeError("controlled lost token acknowledgement");
      }
      return response;
    },
  });
  const oauth = new McpOAuthClient({ fetcher, publicUrl: "https://example.test" });
  const flows = new McpOAuthFlowService({ database: client.database, cipher, oauth, servers });
  const authorization = new McpAuthorizationService({
    database: client.database,
    cipher,
    servers,
    probe: new McpProbe({ fetcher }),
  });
  const worker = new McpRefreshWorker({ database: client.database, authorization, flows, servers });
  cleanups.push(() => worker.stop());
  return {
    accountId,
    agentId: agent.id,
    server,
    servers,
    endpoint,
    cipher,
    oauth,
    flows,
    authorization,
    worker,
    fault,
  };
}
type Harness = Awaited<ReturnType<typeof fixture>>;
async function begin(h: Harness) {
  const started = await h.flows.start(h.accountId, h.agentId, h.server.id, [], SECRET);
  const response = await fetch(started.authorizationUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  assert(location);
  const url = new URL(location);
  return {
    started,
    query: {
      state: url.searchParams.get("state") ?? "",
      code: url.searchParams.get("code") ?? "",
      iss: url.searchParams.get("iss") ?? undefined,
    },
  };
}
async function authorize(h: Harness) {
  const flow = await begin(h);
  await h.flows.callback(flow.query, SECRET);
  return flow;
}
async function root(h: Harness) {
  const [row] = await client.database
    .select()
    .from(mcpServerAuthorizations)
    .where(eq(mcpServerAuthorizations.agentId, h.agentId));
  assert(row);
  return row;
}
function credential(row: Awaited<ReturnType<typeof root>>) {
  return {
    status: row.status,
    ciphertext: row.ciphertext,
    keyId: row.keyId,
    generation: row.refreshGeneration,
    expiresAt: row.accessTokenExpiresAt,
    resource: row.oauthResource,
  };
}
async function holdClientRows() {
  const entered = deferred(),
    release = deferred();
  const task = observer.sql.begin(async (tx) => {
    await tx`lock table mcp_client_registrations in access exclusive mode`;
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return async () => {
    release.resolve();
    await task;
  };
}

it.each(["recover", "revoke", "configuration"] as const)(
  "preserves unspent refresh state across real preparation SQL timeout and %s",
  async (outcome) => {
    const h = await fixture();
    await authorize(h);
    await client.database
      .update(mcpServerAuthorizations)
      .set({ accessTokenExpiresAt: new Date(Date.now() + 120000) })
      .where(eq(mcpServerAuthorizations.agentId, h.agentId));
    const before = await root(h),
      beforeCredential = credential(before),
      refresh = vi.spyOn(h.oauth, "refreshAccessToken");
    const unlock = await holdClientRows();
    const running = h.flows.refreshAuthorization(before.id);
    const writer = createDatabaseClient(pg.databaseUrl, { max: 1 });
    try {
      await expect
        .poll(
          async () =>
            (
              await observer.sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`
            )[0]?.n,
        )
        .toBeGreaterThan(0);
      if (outcome === "revoke")
        await new McpAuthorizationService({
          database: writer.database,
          cipher: h.cipher,
          servers: new McpServerService({ database: writer.database }),
          probe: new McpProbe({ fetcher: new McpOutboundFetcher({ allowLoopback: true }) }),
        }).revoke(h.accountId, h.agentId, h.server.id);
      if (outcome === "configuration")
        await new McpServerService({ database: writer.database }).updateServer(h.accountId, h.server.id, {
          expectedRevision: h.server.revision,
          url: h.endpoint.endpoint.replace("/mcp", "/changed"),
        });
      const changed =
        outcome === "recover"
          ? beforeCredential
          : credential(
              await (async () => {
                const [row] = await writer.database
                  .select()
                  .from(mcpServerAuthorizations)
                  .where(eq(mcpServerAuthorizations.id, before.id));
                assert(row);
                return row;
              })(),
            );
      await running;
      expect(refresh).not.toHaveBeenCalled();
      expect(h.endpoint.tokensIssued).toBe(2);
      expect(credential(await root(h))).toEqual(changed);
      expect((await root(h)).refreshClaimId).toBeNull();
    } finally {
      await unlock();
      await running;
      await writer.sql.end();
    }
    if (outcome === "recover") {
      expect(await h.authorization.buildHeaders(h.accountId, h.agentId, h.server.id)).toMatchObject({
        authorization: "Bearer at_2",
      });
      expect(await h.worker.runOnce()).toBe(1);
      expect((await root(h)).refreshGeneration).toBe(before.refreshGeneration + 1);
      expect(h.endpoint.tokensIssued).toBe(3);
    }
  },
);

it("retains the uncertain-exchange policy after a real refresh consumed the token", async () => {
  const h = await fixture();
  await authorize(h);
  const before = await root(h);
  h.fault.dropRefreshResponse = true;
  await h.flows.refreshAuthorization(before.id);
  expect(h.endpoint.tokensIssued).toBe(3);
  expect(await root(h)).toMatchObject({
    status: "error",
    failureCode: MCP_ERROR_CODES.REFRESH_OUTCOME_UNKNOWN,
    ciphertext: null,
    keyId: null,
    refreshClaimId: null,
  });
  h.fault.dropRefreshResponse = false;
  expect(await h.worker.runOnce()).toBe(0);
  expect(h.endpoint.tokensIssued).toBe(3);
});

it("ends a first failed discovery and permits a fresh user authorization", async () => {
  const h = await fixture();
  vi.spyOn(h.oauth, "authorizationServerMetadata").mockRejectedValueOnce(
    new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "controlled metadata failure"),
  );
  await expect(h.flows.start(h.accountId, h.agentId, h.server.id, [], SECRET)).rejects.toMatchObject({
    code: MCP_ERROR_CODES.OAUTH_FAILED,
  });
  expect(await root(h)).toMatchObject({
    status: "error",
    failureCode: MCP_ERROR_CODES.OAUTH_FAILED,
    state: null,
    ciphertext: null,
  });
  expect((await h.servers.readAgentServer(h.accountId, h.agentId, h.server.id)).authorization?.status).toBe("error");
  await authorize(h);
  expect((await root(h)).status).toBe("active");
  expect(h.endpoint.tokensIssued).toBe(2);
});

it("does not fail a newer flow when an older discovery completes late", async () => {
  const h = await fixture(),
    entered = deferred(),
    release = deferred();
  vi.spyOn(h.oauth, "authorizationServerMetadata").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    throw new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "controlled late metadata failure");
  });
  const old = h.flows.start(h.accountId, h.agentId, h.server.id, [], SECRET).then(
    () => undefined,
    (error) => error,
  );
  try {
    await entered.promise;
    const current = await begin(h),
      before = await root(h);
    release.resolve();
    expect(await old).toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FAILED });
    expect(await root(h)).toEqual(before);
    await h.flows.callback(current.query, SECRET);
    expect((await root(h)).status).toBe("active");
  } finally {
    release.resolve();
    await old;
  }
});

it("keeps an already-published flow when another discovery fails", async () => {
  const h = await fixture(),
    current = await begin(h),
    before = await root(h);
  vi.spyOn(h.oauth, "authorizationServerMetadata").mockRejectedValueOnce(
    new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "controlled metadata failure"),
  );
  await expect(h.flows.start(h.accountId, h.agentId, h.server.id, [], SECRET)).rejects.toBeDefined();
  expect(await root(h)).toEqual(before);
  await h.flows.callback(current.query, SECRET);
  expect((await root(h)).status).toBe("active");
});

it.each([false, true])("ends a failed one-time exchange and preserves prior usable credential=%s", async (prior) => {
  const h = await fixture();
  if (prior) await authorize(h);
  const flow = await begin(h),
    before = await root(h);
  vi.spyOn(h.oauth, "exchangeAuthorizationCode").mockRejectedValueOnce(
    new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "controlled uncertain exchange"),
  );
  await expect(h.flows.callback(flow.query, SECRET)).rejects.toMatchObject({
    code: MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE,
  });
  const after = await root(h);
  expect(after.state).toBeNull();
  expect(after.failureCode).toBe(MCP_ERROR_CODES.OAUTH_FAILED);
  expect(after.status).toBe(prior ? "active" : "error");
  if (prior) {
    expect(credential(after)).toEqual(credential(before));
    expect(await h.authorization.buildHeaders(h.accountId, h.agentId, h.server.id)).toMatchObject({
      authorization: "Bearer at_2",
    });
  }
  await expect(h.flows.callback(flow.query, SECRET)).rejects.toMatchObject({
    code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
  });
});

it("cannot clear a newer flow after an older code exchange fails", async () => {
  const h = await fixture(),
    flow = await begin(h),
    entered = deferred(),
    release = deferred();
  vi.spyOn(h.oauth, "exchangeAuthorizationCode").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    throw new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "controlled late exchange");
  });
  const old = h.flows.callback(flow.query, SECRET).then(
    () => undefined,
    (error) => error,
  );
  try {
    await entered.promise;
    const current = await begin(h),
      before = await root(h);
    release.resolve();
    expect(await old).toMatchObject({ code: MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE });
    expect(await root(h)).toEqual(before);
    await h.flows.callback(current.query, SECRET);
    expect((await root(h)).status).toBe("active");
  } finally {
    release.resolve();
    await old;
  }
});
