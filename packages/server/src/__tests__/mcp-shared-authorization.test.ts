import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readMcpRolloutStatus } from "../admin/mcp-rollout-status.js";
import { agents, mcpServerAuthorizations } from "../db/schema/index.js";
import { MCP_ERROR_CODES } from "../services/mcp/errors.js";
import { McpServerService } from "../services/mcp/mcp-server-service.js";
import { SHARED_PROOF, sharedMcpFixture } from "./support/mcp-shared-authorization.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

describe("shared MCP authentication", () => {
  it("reuses the oldest compatible root without OAuth or a local credential", async () => {
    const f = await sharedMcpFixture(unit.database);
    const [, b, c, d] = f.ids as [string, string, string, string];
    await f.authorize(c);
    await expect(f.connect(b)).resolves.toBe(true);
    await expect(f.connect(d)).resolves.toBe(true);
    expect(await f.row(b)).toMatchObject({
      credentialSourceId: f.root.id,
      ciphertext: null,
      keyId: null,
      state: null,
      refreshClaimId: null,
      accessTokenExpiresAt: null,
    });
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer old-access");
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect((await f.servers.listServers(f.accountId))[0]?.authorizedAgentCount).toBe(4);
    expect((await f.row(d))?.credentialSourceId).toBe(f.root.id);
  });
  it("does not wait for a refresh claim and preserves each Agent's own tool probe", async () => {
    const f = await sharedMcpFixture(unit.database);
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ refreshClaimId: randomUUID(), refreshClaimedAt: new Date(), probeState: "failed", probeError: "401" })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    await f.connect(f.ids[1] as string);
    expect((await f.servers.readAgentServer(f.accountId, f.ids[1] as string, f.server.id)).authorization).toMatchObject(
      { status: "active", hasCredential: true },
    );
    expect(
      (await f.servers.readAgentServer(f.accountId, f.ids[1] as string, f.server.id)).authorization?.probeState,
    ).toBe("pending");
  });
  it("reauthorizes the same root from a referring Agent and restores all members", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    await f.connect(b);
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ status: "expired" })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    expect((await f.servers.readAgentServer(f.accountId, b, f.server.id)).authorization?.status).toBe("expired");
    const state = await f.start(b);
    expect((await f.row(f.ids[0] as string))?.state).toEqual(expect.any(String));
    expect(await f.flows.callback({ code: "code", state }, SHARED_PROOF)).toMatchObject({
      agentId: b,
      accountId: f.accountId,
    });
    expect((await f.row(b))?.credentialSourceId).toBe(f.root.id);
    expect((await f.auth.buildHeaders(f.accountId, b, f.server.id)).authorization).toBe("Bearer new-consent");
    expect((await f.servers.readAgentServer(f.accountId, b, f.server.id)).authorization?.status).toBe("active");
  });
  it("records an explicitly empty granted scope instead of the requested scope", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    await f.connect(b);
    f.exchange.mockResolvedValue({ accessToken: "empty-scope", expiresIn: 3600, scope: "" });
    const state = await f.start(b);
    await f.flows.callback({ code: "code", state }, SHARED_PROOF);
    expect((await f.row(f.ids[0] as string))?.scopes).toEqual([]);
  });
  it("does not switch an existing expired binding to a different valid root", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    await f.connect(b);
    await f.authorize(f.ids[2] as string);
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ status: "expired" })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    await expect(f.connect(b)).resolves.toBe(false);
    expect((await f.row(b))?.credentialSourceId).toBe(f.root.id);
  });
  it("rejects incompatible configuration, scopes, identity boundaries and disabled new reuse", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    await f.servers.updateBinding(f.accountId, b, f.server.id, { extraHeaders: { "x-account": "other" } });
    await expect(f.connect(b)).resolves.toBe(false);
    await expect(f.auth.connectOAuth(f.accountId, f.ids[2] as string, f.server.id, ["write"])).resolves.toBe(false);
    await unit.database
      .update(agents)
      .set({ status: "deleted" })
      .where(eq(agents.id, f.ids[0] as string));
    await expect(f.connect(f.ids[3] as string)).resolves.toBe(false);
  });
  it("keeps existing references readable after disabling new reuse", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    await f.connect(b);
    const disabled = new McpServerService({ database: unit.database, cipher: f.cipher });
    expect((await disabled.readAgentServer(f.accountId, b, f.server.id)).authorization).toMatchObject({
      status: "active",
      hasCredential: true,
    });
    await disabled.detachServer(f.accountId, f.ids[0] as string, f.server.id);
    expect((await f.row(b))?.id).toBe(f.root.id);
  });
  it("keeps sharing for unchanged connection settings and enable switches while guarding definition edits", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    await f.connect(b);
    const before = await f.row(b);
    await f.servers.updateBinding(f.accountId, b, f.server.id, { url: f.server.url });
    await expect(
      f.servers.updateServer(f.accountId, f.server.id, { expectedRevision: f.server.revision, authScheme: "Token" }),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.BINDING_CONFLICT });
    await f.servers.updateBinding(f.accountId, b, f.server.id, { enabled: false });
    expect(await f.row(b)).toEqual(before);
    expect((await f.servers.readAgentServer(f.accountId, b, f.server.id)).authorization?.status).toBe("active");
  });
  it.each([{ authHeader: "x-api-key" }, { authScheme: "Token" }, { extraHeaders: { "x-workspace": "other" } }])(
    "detaches only the edited Agent when headers change: %j",
    async (patch) => {
      const f = await sharedMcpFixture(unit.database);
      const [a, b] = f.ids as [string, string];
      await f.connect(b);
      await f.servers.updateBinding(f.accountId, b, f.server.id, patch);
      expect(await f.row(b)).toMatchObject({ credentialSourceId: null, status: "revoked", ciphertext: null });
      expect((await f.row(a))?.id).toBe(f.root.id);
      expect((await f.auth.buildHeaders(f.accountId, a, f.server.id)).authorization).toBe("Bearer old-access");
      await expect(f.connect(b)).resolves.toBe(false);
    },
  );
  it("does not publish OAuth onto a mount recreated during discovery", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    const metadata = {
      resource: f.server.url,
      authorizationServers: ["https://auth.example.test"],
      scopesSupported: ["read"],
    };
    f.oauth.protectedResourceMetadata = async () => {
      await f.servers.detachServer(f.accountId, b, f.server.id);
      await f.servers.attachServer(f.accountId, b, f.server.id, true);
      return { metadata };
    };
    await expect(f.start(b)).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID });
    expect(await f.row(b)).toBeUndefined();
    expect(f.exchange).not.toHaveBeenCalled();
  });
  it("keeps legacy revoke scoped to its Agent while the remaining Agents retain the root", async () => {
    const f = await sharedMcpFixture(unit.database);
    const [a, b, c] = f.ids as [string, string, string];
    await f.connect(b);
    await f.connect(c);
    await f.auth.revoke(f.accountId, a, f.server.id);
    expect(await f.row(a)).toMatchObject({ status: "revoked", credentialSourceId: null, ciphertext: null });
    expect((await f.row(b))?.id).toBe(f.root.id);
    expect((await f.auth.buildHeaders(f.accountId, c, f.server.id)).authorization).toBe("Bearer old-access");
  });
  it("cancels shared consent from its initiating Agent without clearing a working credential, refresh claim or tools", async () => {
    const f = await sharedMcpFixture(unit.database);
    const [a, b, c] = f.ids as [string, string, string];
    await f.connect(b);
    await f.connect(c);
    const claim = randomUUID();
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ probeState: "succeeded", tools: [{ name: "read" }], toolsCount: 1 })
      .where(eq(mcpServerAuthorizations.mcpServerId, f.server.id));
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ refreshClaimId: claim, refreshClaimedAt: new Date() })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    const state = await f.start(b);
    await f.auth.revoke(f.accountId, b, f.server.id, state);
    expect(await f.row(a)).toMatchObject({
      ciphertext: expect.any(String),
      status: "active",
      state: null,
      refreshClaimId: claim,
      toolsCount: 1,
      probeState: "succeeded",
    });
    expect(await f.row(b)).toMatchObject({ toolsCount: 1, probeState: "succeeded" });
    expect((await f.auth.buildHeaders(f.accountId, c, f.server.id)).authorization).toBe("Bearer old-access");
  });
  it("does not cancel a newer flow using an older browser state", async () => {
    const f = await sharedMcpFixture(unit.database);
    const [a, b] = f.ids as [string, string];
    await f.connect(b);
    const old = await f.start(a);
    const state = await f.start(b);
    await expect(f.auth.revoke(f.accountId, a, f.server.id, old)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
    });
    expect(await f.flows.callback({ code: "new-flow", state }, SHARED_PROOF)).toMatchObject({ agentId: b });
  });
  it("blocks legacy downgrade for references, versioned credentials and active versioned flows", async () => {
    const f = await sharedMcpFixture(unit.database);
    const a = f.ids[0] as string;
    const b = f.ids[1] as string;
    await f.connect(b);
    await f.start(b);
    expect(await readMcpRolloutStatus(unit.database, f.cipher)).toMatchObject({
      referenceCount: 1,
      versionedCredentialCount: 1,
      versionedFlowCount: 1,
      unreadableEnvelopeCount: 0,
      legacyDowngradeAllowed: false,
    });
    await f.servers.detachServer(f.accountId, a, f.server.id);
    await f.servers.detachServer(f.accountId, b, f.server.id);
    expect(await readMcpRolloutStatus(unit.database, f.cipher)).toMatchObject({ legacyDowngradeAllowed: true });
  });
});
