import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { mcpServerAuthorizations, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { MCP_ERROR_CODES } from "../../services/mcp/errors.js";
import { McpAuthorizationService } from "../../services/mcp/mcp-authorization-service.js";
import { lockMcpAccounts } from "../../services/mcp/mcp-binding-locks.js";
import type { McpProbeResult } from "../../services/mcp/mcp-probe.js";
import { OnboardingResetService } from "../../services/onboarding-reset/index.js";
import { deferred } from "../support/deferred.js";
import { SHARED_ISSUER, SHARED_PROOF, SHARED_URL, sharedMcpFixture } from "../support/mcp-shared-authorization.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let fixture: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  fixture = await startMigratedTestDatabase();
  client = createDatabaseClient(fixture.databaseUrl);
}, 120000);
afterAll(async () => {
  await client?.sql.end();
  await fixture?.stop();
});
beforeEach(async () => fixture.reset());

describe("shared MCP authentication on PostgreSQL", () => {
  it("admits a new Agent and hands off the holder while one refresh is on the network", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b, c] = f.ids as [string, string, string];
    await f.connect(b);
    await f.servers.detachServer(f.accountId, c, f.server.id);
    await client.database
      .update(mcpServerAuthorizations)
      .set({
        tools: [{ name: "b-only", description: null, inputSchema: null }],
        toolsCount: 1,
        probeState: "succeeded",
      })
      .where(eq(mcpServerAuthorizations.agentId, b));
    const sent = deferred();
    const reply = deferred<{ accessToken: string; refreshToken: string; expiresIn: number }>();
    f.refresh.mockImplementation(async () => {
      sent.resolve();
      return reply.promise;
    });
    const refreshing = f.flows.refreshAuthorization(f.root.id);
    try {
      await sent.promise;
      const before = await f.row(a);
      const installation = await f.auth.findReusableInstallation(
        f.accountId,
        c,
        { name: "new-agent", url: SHARED_URL, defaultAuthKind: "oauth" },
        ["read"],
      );
      expect(installation?.id).toBe(f.server.id);
      await f.servers.attachServer(f.accountId, c, installation?.id as string, true);
      await expect(f.connect(c)).resolves.toBe(true);
      await f.servers.detachServer(f.accountId, a, f.server.id);
      const holder = await f.row(b);
      expect(holder).toMatchObject({
        id: f.root.id,
        refreshClaimId: before?.refreshClaimId,
        refreshGeneration: before?.refreshGeneration,
        toolsCount: 1,
        tools: [{ name: "b-only" }],
      });
      expect((await f.servers.readAgentServer(f.accountId, c, f.server.id)).authorization?.status).toBe("active");
    } finally {
      reply.resolve({ accessToken: "rotated", refreshToken: "rotated-refresh", expiresIn: 3600 });
      await refreshing;
    }
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer rotated");
    expect((await f.auth.buildHeaders(f.accountId, c, f.server.id)).authorization).toBe("Bearer rotated");
    const holder = await f.row(b);
    expect(holder?.refreshGeneration).toBe(f.root.refreshGeneration + 1);
    expect(holder?.refreshClaimId).toBeNull();
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1])("keeps other Agents authorized when member %i edits its URL", async (index) => {
    const f = await sharedMcpFixture(client.database);
    const [a, b, c] = f.ids as [string, string, string];
    await f.connect(b);
    await f.connect(c);
    const edited = f.ids[index] as string;
    const survivor = index === 0 ? b : a;
    const before = await f.row(edited);
    const changed = await f.servers.updateBinding(f.accountId, edited, f.server.id, {
      url: "https://other.example.test/mcp",
    });
    expect(changed.effective.url).toBe("https://other.example.test/mcp");
    expect(changed.authorization).toMatchObject({ status: "revoked", hasCredential: false });
    expect(await f.row(edited)).toMatchObject({ credentialSourceId: null, ciphertext: null, keyId: null, state: null });
    expect((await f.row(edited))?.id).not.toBe(before?.id);
    expect((await f.row(survivor))?.id).toBe(f.root.id);
    expect((await f.auth.buildHeaders(f.accountId, survivor, f.server.id)).authorization).toBe("Bearer old-access");
    expect((await f.auth.buildHeaders(f.accountId, c, f.server.id)).authorization).toBe("Bearer old-access");
    await expect(f.connect(edited)).resolves.toBe(false);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it("hands off an in-flight refresh before changing the holder configuration", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const sent = deferred();
    const reply = deferred<{ accessToken: string; expiresIn: number }>();
    f.refresh.mockImplementation(async () => {
      sent.resolve();
      return reply.promise;
    });
    const refreshing = f.flows.refreshAuthorization(f.root.id);
    try {
      await sent.promise;
      const claim = (await f.row(a))?.refreshClaimId;
      await f.servers.updateBinding(f.accountId, a, f.server.id, { authScheme: "Token" });
      expect(await f.row(b)).toMatchObject({ id: f.root.id, refreshClaimId: claim });
      expect(await f.row(a)).toMatchObject({ status: "revoked", ciphertext: null, refreshClaimId: null });
    } finally {
      reply.resolve({ accessToken: "after-edit", expiresIn: 3600 });
      await refreshing;
    }
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer after-edit");
    expect(await f.row(a)).toMatchObject({ status: "revoked", ciphertext: null });
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it("preserves another Agent's pending consent across holder configuration changes", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const state = await f.start(b);
    await f.servers.updateBinding(f.accountId, a, f.server.id, { extraHeaders: { "x-workspace": "new" } });
    expect((await f.row(b))?.id).toBe(f.root.id);
    await f.flows.callback({ code: "after-edit", state }, SHARED_PROOF);
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer new-consent");
    expect(await f.row(a)).toMatchObject({ status: "revoked", ciphertext: null });
  });
  it("rolls back handoff and unlink if saving the configuration fails", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const beforeA = await f.row(a);
    const beforeB = await f.row(b);
    const beforeMount = await f.servers.readAgentServer(f.accountId, a, f.server.id);
    await client.sql.unsafe(
      `create function mcp_test_reject_binding_update() returns trigger language plpgsql as $$ begin raise exception 'injected binding save failure'; end $$`,
    );
    await client.sql.unsafe(
      `create trigger mcp_test_binding_failure before update on agent_mcp_servers for each row execute function mcp_test_reject_binding_update()`,
    );
    try {
      await expect(
        f.servers.updateBinding(f.accountId, a, f.server.id, { url: "https://other.example.test/mcp" }),
      ).rejects.toMatchObject({ cause: { message: "injected binding save failure" } });
    } finally {
      await client.sql.unsafe(`drop trigger mcp_test_binding_failure on agent_mcp_servers`);
      await client.sql.unsafe(`drop function mcp_test_reject_binding_update()`);
    }
    expect(await f.row(a)).toEqual(beforeA);
    expect(await f.row(b)).toEqual(beforeB);
    expect(await f.servers.readAgentServer(f.accountId, a, f.server.id)).toEqual(beforeMount);
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer old-access");
  });
  it.each(["read", ""])(
    "invalidates every member's tools and fences an old probe when refresh scopes become %j",
    async (scope) => {
      const f = await sharedMcpFixture(client.database);
      const [a, b] = f.ids as [string, string];
      await f.connect(b);
      const tools = [{ name: "write", description: null, inputSchema: null }];
      await client.database
        .update(mcpServerAuthorizations)
        .set({ tools, toolsCount: 1, probeState: "succeeded" })
        .where(eq(mcpServerAuthorizations.mcpServerId, f.server.id));
      await client.database
        .update(mcpServerAuthorizations)
        .set({ scopes: ["read", "write"] })
        .where(eq(mcpServerAuthorizations.id, f.root.id));
      const sent = deferred();
      const reply = deferred<McpProbeResult>();
      const auth = new McpAuthorizationService({
        database: client.database,
        cipher: f.cipher,
        servers: f.servers,
        probe: {
          probe: vi.fn(async () => {
            sent.resolve();
            return reply.promise;
          }),
        } as never,
      });
      const probing = auth.probe(f.accountId, b, f.server.id);
      try {
        await sent.promise;
        f.refresh.mockResolvedValue({ accessToken: "narrower", refreshToken: "rotated", expiresIn: 3600, scope });
        await f.flows.refreshAuthorization(f.root.id);
      } finally {
        reply.resolve({
          probeState: "succeeded",
          protocolEra: "modern",
          protocolVersion: "2026-07-28",
          serverInfo: null,
          capabilities: null,
          instructions: null,
          tools,
          toolsCount: 1,
          toolsTruncated: false,
          toolsSkipped: 0,
          probeError: null,
          eraInvalidated: false,
        });
        await probing;
      }
      expect(await f.row(a)).toMatchObject({
        scopes: scope ? [scope] : [],
        tools: null,
        toolsCount: null,
        probeState: "pending",
      });
      expect(await f.row(b)).toMatchObject({ tools: null, toolsCount: null, probeState: "pending" });
    },
  );
  it("retains tool snapshots when only scope order, duplicates or offline_access changes", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    await client.database
      .update(mcpServerAuthorizations)
      .set({ tools: [{ name: "read" }], toolsCount: 1, probeState: "succeeded" })
      .where(eq(mcpServerAuthorizations.mcpServerId, f.server.id));
    await client.database
      .update(mcpServerAuthorizations)
      .set({ scopes: ["read", "write", "offline_access"] })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    const before = await f.row(b);
    f.refresh.mockResolvedValue({ accessToken: "rotated", expiresIn: 3600, scope: "write read read" });
    await f.flows.refreshAuthorization(f.root.id);
    expect(await f.row(a)).toMatchObject({ toolsCount: 1, probeState: "succeeded" });
    expect(await f.row(b)).toMatchObject({ toolsCount: 1, probeState: "succeeded", revision: before?.revision });
  });
  it("preserves a refresh committed before holder handoff", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    await f.flows.refreshAuthorization(f.root.id);
    await f.servers.detachServer(f.accountId, a, f.server.id);
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer new-access");
    expect((await f.row(b))?.id).toBe(f.root.id);
  });
  it("settles a callback on the current holder after the original holder was removed", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const state = await f.start(b);
    const sent = deferred();
    const reply = deferred<{ accessToken: string; expiresIn: number }>();
    f.exchange.mockImplementation(async () => {
      sent.resolve();
      return reply.promise;
    });
    const callback = f.flows.callback({ code: "code", state }, SHARED_PROOF);
    try {
      await sent.promise;
      await f.servers.detachServer(f.accountId, a, f.server.id);
    } finally {
      reply.resolve({ accessToken: "consent-after-handoff", expiresIn: 3600 });
    }
    expect(await callback).toMatchObject({ accountId: f.accountId, agentId: b });
    expect((await f.row(b))?.id).toBe(f.root.id);
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer consent-after-handoff");
  });
  it("redeems an Agent handoff once after the authentication holder has moved", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const started = await f.flows.startWithHandoff(
      f.accountId,
      b,
      f.server.id,
      ["read"],
      "https://opentag.example.test",
      "account",
    );
    const token = new URL(started.authorizationUrl).searchParams.get("token") as string;
    await f.servers.detachServer(f.accountId, a, f.server.id);
    const redeemed = await f.flows.redeemHandoffToken(token, f.accountId);
    await expect(f.flows.redeemHandoffToken(token, f.accountId)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
    });
    expect(await f.flows.callback({ code: "handoff", state: started.state }, redeemed.flowSecret)).toMatchObject({
      accountId: f.accountId,
      agentId: b,
    });
    expect((await f.row(b))?.id).toBe(f.root.id);
  });
  it("makes a one-use callback single flight", async () => {
    const f = await sharedMcpFixture(client.database);
    const a = f.ids[0] as string;
    const state = await f.start(a);
    const sent = deferred();
    const reply = deferred<{ accessToken: string; expiresIn: number }>();
    f.exchange.mockImplementation(async () => {
      sent.resolve();
      return reply.promise;
    });
    const first = f.flows.callback({ code: "code", state }, SHARED_PROOF);
    try {
      await sent.promise;
      await expect(f.flows.callback({ code: "code", state }, SHARED_PROOF)).rejects.toMatchObject({
        code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
      });
    } finally {
      reply.resolve({ accessToken: "once", expiresIn: 3600 });
      await first;
    }
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it("fences a late refresh after a shared reauthorization", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const sent = deferred();
    const reply = deferred<{ accessToken: string; refreshToken: string; expiresIn: number }>();
    f.refresh.mockImplementation(async () => {
      sent.resolve();
      return reply.promise;
    });
    const refreshing = f.flows.refreshAuthorization(f.root.id);
    try {
      await sent.promise;
      const claim = (await f.row(a))?.refreshClaimId;
      const state = await f.start(b);
      expect((await f.row(a))?.refreshClaimId).toBe(claim);
      await f.flows.callback({ code: "consent", state }, SHARED_PROOF);
    } finally {
      reply.resolve({ accessToken: "obsolete", refreshToken: "obsolete-refresh", expiresIn: 3600 });
      await refreshing;
    }
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer new-consent");
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it("never resurrects removed connections from an in-flight refresh", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const sent = deferred();
    const reply = deferred<{ accessToken: string; expiresIn: number }>();
    f.refresh.mockImplementation(async () => {
      sent.resolve();
      return reply.promise;
    });
    const refreshing = f.flows.refreshAuthorization(f.root.id);
    try {
      await sent.promise;
      await f.servers.detachServer(f.accountId, b, f.server.id);
      await f.servers.detachServer(f.accountId, a, f.server.id);
    } finally {
      reply.resolve({ accessToken: "discarded", expiresIn: 3600 });
      await refreshing;
    }
    expect(await f.row(a)).toBeUndefined();
    expect(await f.row(b)).toBeUndefined();
  });
  it("does not replay a stale refresh claim or expose a refresh token", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    await client.database
      .update(mcpServerAuthorizations)
      .set({ refreshClaimId: randomUUID(), refreshClaimedAt: new Date(Date.now() - 180000) })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    await f.flows.refreshAuthorization(f.root.id);
    await f.flows.refreshAuthorization(f.root.id);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(await f.row(a)).toMatchObject({
      ciphertext: null,
      keyId: null,
      status: "error",
      failureCode: MCP_ERROR_CODES.REFRESH_OUTCOME_UNKNOWN,
    });
    expect((await f.servers.readAgentServer(f.accountId, b, f.server.id)).authorization).toMatchObject({
      status: "error",
      hasCredential: false,
    });
  });
  it("transfers only the departing Agent and retains the root for its original Account", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const target = randomUUID();
    await client.database.insert(users).values({ id: target, email: `${target}@example.test`, displayName: "Target" });
    await new AgentService(client.database, { mcpCredentialCipher: f.cipher }).transferToAccount({
      agentId: a,
      targetAccountId: target,
      slack: "disable",
    });
    expect((await f.row(b))?.id).toBe(f.root.id);
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer old-access");
    await expect(f.auth.buildHeaders(target, a, f.server.id)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.BINDING_NOT_FOUND,
    });
  });
  it("takes Account admission before locking a deleted Agent and handing off its root", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const blocker = createDatabaseClient(fixture.databaseUrl, { max: 1 });
    const remover = createDatabaseClient(fixture.databaseUrl, { max: 1 });
    const locked = deferred();
    const release = deferred();
    const afterAgentLocked = vi.fn(async () => {});
    const holding = blocker.database.transaction(async (transaction) => {
      await lockMcpAccounts(transaction, [f.accountId]);
      locked.resolve();
      await release.promise;
    });
    const pending: Promise<unknown>[] = [holding];
    try {
      await locked.promise;
      const [backend] = await remover.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("Missing deletion backend");
      const deleting = Promise.allSettled([
        new AgentService(remover.database, { mcpCredentialCipher: f.cipher, afterAgentLocked }).deleteById(
          f.accountId,
          a,
        ),
      ]);
      pending.push(deleting);
      await vi.waitFor(
        async () => {
          const [activity] = await client.sql<{ blocked: boolean; query: string }[]>`
          select wait_event_type = 'Lock' as blocked, query from pg_stat_activity where pid = ${backend.pid}
        `;
          expect(activity?.blocked).toBe(true);
          expect(activity?.query).toContain('"users"');
        },
        { timeout: 5_000 },
      );
      expect(afterAgentLocked).not.toHaveBeenCalled();
      release.resolve();
      expect(await deleting).toMatchObject([{ status: "fulfilled" }]);
      expect(afterAgentLocked).toHaveBeenCalledOnce();
      expect((await f.row(b))?.id).toBe(f.root.id);
      expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer old-access");
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await Promise.all([blocker.sql.end(), remover.sql.end()]);
    }
  }, 20_000);
  it("clears a complete shared family through onboarding reset", async () => {
    const f = await sharedMcpFixture(client.database);
    await f.connect(f.ids[1] as string);
    const agents = new AgentService(client.database, { mcpCredentialCipher: f.cipher });
    await new OnboardingResetService({ database: client.database, agents, environment: "staging" }).resetOnboarding(
      f.accountId,
    );
    expect(await f.row(f.ids[0] as string)).toBeUndefined();
    expect(await f.row(f.ids[1] as string)).toBeUndefined();
  });
  it("moves a still-pending PKCE flow before its callback begins", async () => {
    const f = await sharedMcpFixture(client.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const state = await f.start(a);
    await f.servers.detachServer(f.accountId, a, f.server.id);
    await f.flows.callback({ code: "code", state }, SHARED_PROOF);
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer new-consent");
    const row = await f.row(b);
    expect(row?.authorizationServer).toBe(SHARED_ISSUER);
    expect(row?.state).toBeNull();
  });
});
