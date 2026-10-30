import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, mcpServerAuthorizations } from "../db/schema/index.js";
import { AgentService } from "../services/agents/agent-service.js";
import { GitHubProviderAdapter } from "../services/github-proxy/github-provider-adapter.js";
import { githubMcpFixture } from "./support/github-mcp.js";
import { body, proxyAuthorization, proxyRequest } from "./support/github-proxy-fixture.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

describe("Context Tree consumes Agent GitHub MCP OAuth", () => {
  it("uses the exact shared credential without minting, copying or refreshing a token", async () => {
    const f = await githubMcpFixture(unit.database);
    const b = f.ids[1] as string;
    await f.connect(b);
    const { connection } = await f.github.getOverview(f.accountId, b);
    expect(connection?.fence?.rootAuthorizationId).toBe(f.root.id);
    const credential = await f.github.getExecutionUserCredential({
      accountId: f.accountId,
      agentId: b,
      connectionId: f.server.id,
      authorizationRevision: `github:${connection?.authorizationVersion}`,
    });
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe(
      `Bearer ${credential?.accessToken}`,
    );
    expect(credential?.accessToken).toBe("old-access");
    expect((await f.row(b))?.ciphertext).toBeNull();
    expect((await f.row(f.ids[0] as string))?.ciphertext).toBe(f.root.ciphertext);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("accepts a rotated access token under the same authority and never waits on a refresh claim", async () => {
    const f = await githubMcpFixture(unit.database);
    const agentId = f.ids[0] as string;
    const { connection } = await f.github.getOverview(f.accountId, agentId);
    await f.flows.refreshAuthorization(f.root.id);
    const next = await f.github.getExecutionUserCredential({
      accountId: f.accountId,
      agentId,
      connectionId: f.server.id,
      authorizationRevision: `github:${connection?.authorizationVersion}`,
    });
    expect(next?.accessToken).toBe("new-access");
    expect((await f.github.getOverview(f.accountId, agentId)).connection?.authorizationVersion).toBe(
      connection?.authorizationVersion,
    );
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ refreshClaimId: randomUUID(), refreshClaimedAt: new Date() })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    expect((await f.github.getOverview(f.accountId, agentId)).connection).not.toBeNull();
  });

  it("never borrows an unshared token from another Agent or Account", async () => {
    const f = await githubMcpFixture(unit.database);
    expect((await f.github.getOverview(f.accountId, f.ids[1] as string)).connection).toBeNull();
    expect((await f.github.getOverview(randomUUID(), f.ids[0] as string)).connection).toBeNull();
  });

  it("routes Context requests with the current MCP token and enforces the selected repository", async () => {
    const f = await githubMcpFixture(unit.database);
    const agentId = f.ids[1] as string;
    await f.connect(agentId);
    const connection = (await f.github.getOverview(f.accountId, agentId)).connection;
    if (!connection) throw new Error("Missing GitHub MCP connection");
    const auth = {
      ...proxyAuthorization(),
      purpose: "context-tree" as const,
      accountId: f.accountId,
      agentId,
      bindingId: f.server.id,
      authorizationRevision: `github:${connection.authorizationVersion}`,
      contextTree: {
        kind: "git" as const,
        parentExecutionId: randomUUID(),
        repository: "acme/memory",
        path: ".",
        ref: "main",
      },
    };
    const request = () =>
      proxyRequest(auth, {
        headers: { "x-opentag-provider-origin": "github.com" },
        path: "/acme/memory.git/info/refs?service=git-upload-pack",
      });
    const transport = { request: vi.fn(async () => ({ status: 200, headers: {}, body: body() })) };
    const adapter = new GitHubProviderAdapter({ management: f.github, transport });
    await adapter.handle(request(), auth);
    expect(transport.request).toHaveBeenLastCalledWith(expect.objectContaining({ token: "old-access" }));
    await f.flows.refreshAuthorization(f.root.id);
    await adapter.handle(request(), auth);
    expect(transport.request).toHaveBeenLastCalledWith(expect.objectContaining({ token: "new-access" }));
    await expect(
      adapter.handle({ ...request(), path: "/acme/other.git/info/refs?service=git-upload-pack" }, auth),
    ).rejects.toMatchObject({ code: "scope_denied" });
    await f.servers.updateBinding(f.accountId, agentId, f.server.id, { enabled: false });
    await expect(adapter.handle(request(), auth)).rejects.toMatchObject({ code: "github_credential_failed" });
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it("blocks receive-pack discovery for a read-only connector before any Git request", async () => {
    const f = await githubMcpFixture(unit.database);
    const agentId = f.ids[0] as string;
    await f.servers.updateBinding(f.accountId, agentId, f.server.id, { extraHeaders: { "x-mcp-readonly": "true" } });
    const connection = (await f.github.getOverview(f.accountId, agentId)).connection;
    if (!connection) throw new Error("Missing GitHub MCP connection");
    const auth = {
      ...proxyAuthorization(),
      purpose: "context-tree" as const,
      accountId: f.accountId,
      agentId,
      bindingId: f.server.id,
      authorizationRevision: `github:${connection.authorizationVersion}`,
      contextTree: {
        kind: "git" as const,
        parentExecutionId: randomUUID(),
        repository: "acme/memory",
        path: ".",
        ref: "main",
      },
    };
    const transport = { request: vi.fn() };
    const adapter = new GitHubProviderAdapter({ management: f.github, transport });
    await expect(
      adapter.handle(
        proxyRequest(auth, {
          headers: { "x-opentag-provider-origin": "github.com" },
          path: "/acme/memory.git/info/refs?service=git-receive-pack",
        }),
        auth,
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it.each([
    { status: "expired" as const },
    { status: "revoked" as const },
    { authorizationServer: "https://other.example.test" },
    { oauthResource: "https://other.example.test/mcp" },
    { accessTokenExpiresAt: new Date(0) },
  ])("rejects an unusable authentication: %j", async (patch) => {
    const f = await githubMcpFixture(unit.database);
    await unit.database.update(mcpServerAuthorizations).set(patch).where(eq(mcpServerAuthorizations.id, f.root.id));
    expect((await f.github.getOverview(f.accountId, f.ids[0] as string)).connection).toBeNull();
  });

  it("does not equate a missing repo scope with a missing OAuth authentication", async () => {
    const f = await githubMcpFixture(unit.database);
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ scopes: ["public_repo"] })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    expect((await f.github.getOverview(f.accountId, f.ids[0] as string)).connection).not.toBeNull();
  });

  it("rejects a token whose OAuth client cannot be proven", async () => {
    const f = await githubMcpFixture(unit.database);
    const sealed = f.cipher.encryptAuthorizationCredential(
      { mcpServerId: f.server.id, agentId: f.ids[0] as string, authorizationServer: f.root.authorizationServer },
      { accessToken: "wrong-client", clientId: "another-app" },
    );
    await unit.database.update(mcpServerAuthorizations).set(sealed).where(eq(mcpServerAuthorizations.id, f.root.id));
    expect((await f.github.getOverview(f.accountId, f.ids[0] as string)).connection).toBeNull();
  });

  it("selects the oldest mount before status checks and never falls back after disabling it", async () => {
    const f = await githubMcpFixture(unit.database);
    const agentId = f.ids[0] as string;
    const second = await f.servers.createServer(f.accountId, {
      name: "later",
      url: f.server.url,
      defaultAuthKind: "oauth",
    });
    await f.servers.attachServer(f.accountId, agentId, second.id, true);
    await f.authorize(agentId, new Date(), second);
    const old = (await f.github.getOverview(f.accountId, agentId)).connection;
    if (!old) throw new Error("Missing GitHub MCP connection");
    await f.servers.updateBinding(f.accountId, agentId, f.server.id, { enabled: false });
    await expect(f.github.getOverview(f.accountId, agentId)).rejects.toMatchObject({
      code: "github_connector_disabled",
    });
    await f.servers.updateBinding(f.accountId, agentId, f.server.id, { enabled: true });
    expect((await f.github.getOverview(f.accountId, agentId)).connection?.authorizationVersion).not.toBe(
      old.authorizationVersion,
    );
    expect(
      await f.github.getExecutionUserCredential({
        accountId: f.accountId,
        agentId,
        connectionId: f.server.id,
        authorizationRevision: `github:${old.authorizationVersion}`,
      }),
    ).toBeNull();
  });

  it("preserves shared root handoff without authorizing the removed mount", async () => {
    const f = await githubMcpFixture(unit.database);
    const a = f.ids[0] as string,
      b = f.ids[1] as string;
    await f.connect(b);
    await f.servers.detachServer(f.accountId, a, f.server.id);
    expect((await f.github.getOverview(f.accountId, a)).connection).toBeNull();
    expect((await f.github.getOverview(f.accountId, b)).connection?.fence?.rootAuthorizationId).toBe(f.root.id);
  });

  it("enforces current owner and root-holder lifecycle", async () => {
    const f = await githubMcpFixture(unit.database);
    const a = f.ids[0] as string,
      b = f.ids[1] as string;
    await f.connect(b);
    await unit.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, a));
    expect((await f.github.getOverview(f.accountId, b)).connection).toBeNull();
  });

  it.each(["true", "1", "yes", "false", "off", ""])("inherits official readonly semantics: %s", async (value) => {
    const f = await githubMcpFixture(unit.database);
    const agentId = f.ids[0] as string;
    await f.servers.updateBinding(f.accountId, agentId, f.server.id, { extraHeaders: { "x-mcp-readonly": value } });
    expect((await f.github.getOverview(f.accountId, agentId)).connection?.readOnly).toBe(
      !["false", "off", ""].includes(value),
    );
  });

  it("checks authentication again in the final selection transaction and rolls back on mismatch", async () => {
    const f = await githubMcpFixture(unit.database);
    const agentId = f.ids[0] as string;
    const service = new AgentService(unit.database, { mcpCredentialCipher: f.cipher });
    const config = await service.getConfigById(f.accountId, agentId);
    const authority = (await f.github.getOverview(f.accountId, agentId)).connection?.fence;
    if (!authority) throw new Error("Missing authority fence");
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ status: "expired" })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    await expect(
      service.updateContextTreeSelection(
        f.accountId,
        agentId,
        { ...config, runtimeConfigRevision: config.runtimeConfig.revision },
        [{ kind: "git", repository: "acme/memory", path: ".", ref: "main" }],
        authority,
      ),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect((await service.getConfigById(f.accountId, agentId)).runtimeConfig.contextTrees).toEqual([]);
  });
});
