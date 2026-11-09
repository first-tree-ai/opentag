import { randomUUID } from "node:crypto";
import type { CreateMCPServerRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mcpServerAuthorizations, mcpServers } from "../db/schema/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { MCP_ERROR_CODES } from "../services/mcp/errors.js";
import { McpAuthorizationService } from "../services/mcp/mcp-authorization-service.js";
import { McpCredentialCipher } from "../services/mcp/mcp-credential-cipher.js";
import { McpServerService } from "../services/mcp/mcp-server-service.js";
import { SHARED_ISSUER, SHARED_URL, sharedMcpFixture } from "./support/mcp-shared-authorization.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());
const input: CreateMCPServerRequest = { name: "new-name", url: SHARED_URL, defaultAuthKind: "oauth" };

describe("ordinary MCP installation selection", () => {
  it("selects the existing definition, then mounts and connects without another OAuth", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    await f.servers.detachServer(f.accountId, b, f.server.id);
    const selected = await f.auth.findReusableInstallation(f.accountId, b, input, ["read"]);
    expect(selected?.id).toBe(f.server.id);
    await f.servers.attachServer(f.accountId, b, selected?.id as string, true);
    expect(await f.auth.connectOAuth(f.accountId, b, selected?.id as string, ["read"])).toBe(true);
    expect(await f.row(b)).toMatchObject({ credentialSourceId: f.root.id, ciphertext: null });
    expect(await unit.database.select().from(mcpServers)).toHaveLength(1);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it("selects the oldest compatible root across definitions without merging historical rows", async () => {
    const f = await sharedMcpFixture(unit.database);
    const older = await f.servers.createServer(f.accountId, { ...input, name: "historical" });
    const c = f.ids[2] as string;
    await f.servers.attachServer(f.accountId, c, older.id, true);
    const root = await f.authorize(c, new Date("2025-01-01T00:00:00Z"), older);
    expect((await f.auth.findReusableInstallation(f.accountId, f.ids[1] as string, input, ["read"]))?.id).toBe(
      older.id,
    );
    expect(await unit.database.select().from(mcpServers)).toHaveLength(2);
    expect((await f.row(f.ids[0] as string))?.id).toBe(f.root.id);
    expect(root.credentialSourceId).toBeNull();
  });
  it.each([
    { url: `${SHARED_URL}/other` },
    { authHeader: "x-api-key" },
    { authScheme: "Token" },
    { extraHeaders: { "x-team": "other" } },
    { defaultAuthKind: "bearer" as const },
    { defaultAuthKind: "none" as const },
  ])("keeps differing connection configuration independent: %j", async (patch) => {
    const f = await sharedMcpFixture(unit.database);
    expect(await f.auth.findReusableInstallation(f.accountId, f.ids[1] as string, { ...input, ...patch })).toBeNull();
  });
  it("does not select an effective override whose definition would mount a different endpoint", async () => {
    const f = await sharedMcpFixture(unit.database);
    await f.servers.updateServer(f.accountId, f.server.id, { expectedRevision: 1, url: `${SHARED_URL}/other` });
    await f.servers.updateBinding(f.accountId, f.ids[0] as string, f.server.id, { url: SHARED_URL });
    // Restore a valid root after the intentional endpoint edit revoked it.
    await unit.database
      .update(mcpServerAuthorizations)
      .set({
        status: "active",
        ...f.cipher.encryptAuthorizationCredential(
          { mcpServerId: f.server.id, agentId: f.ids[0] as string, authorizationServer: SHARED_ISSUER },
          { accessToken: "restored", clientId: f.oauth.clientMetadataUrl },
        ),
        authorizationServer: SHARED_ISSUER,
        oauthResource: SHARED_URL,
      })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    expect(await f.auth.findReusableInstallation(f.accountId, f.ids[1] as string, input)).toBeNull();
  });
  it("requires scopes, client proof, resource, a usable token and an owned target", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    expect(await f.auth.findReusableInstallation(f.accountId, b, input, ["write"])).toBeNull();
    const wrongClient = f.cipher.encryptAuthorizationCredential(
      { mcpServerId: f.server.id, agentId: f.ids[0] as string, authorizationServer: SHARED_ISSUER },
      { accessToken: "limited", clientId: "another-client" },
    );
    await unit.database
      .update(mcpServerAuthorizations)
      .set(wrongClient)
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    expect(await f.auth.findReusableInstallation(f.accountId, b, input)).toBeNull();
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ ...f.root, oauthResource: "https://other.example.test" })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    expect(await f.auth.findReusableInstallation(f.accountId, b, input)).toBeNull();
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ oauthResource: SHARED_URL, accessTokenExpiresAt: new Date(0) })
      .where(eq(mcpServerAuthorizations.id, f.root.id));
    expect(await f.auth.findReusableInstallation(f.accountId, b, input)).toBeNull();
    await expect(f.auth.findReusableInstallation(randomUUID(), b, input)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.SERVER_NOT_FOUND,
    });
    await expect(f.auth.findReusableInstallation(f.accountId, randomUUID(), input)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.SERVER_NOT_FOUND,
    });
  });
  it.each([true, false])(
    "skips an unreadable historical credential instead of blocking new connections (another source: %j)",
    async (anotherSource) => {
      const f = await sharedMcpFixture(unit.database);
      const b = f.ids[1] as string;
      const fallback = anotherSource ? await f.authorize(f.ids[2] as string) : undefined;
      const oldCipher = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(9)));
      const unreadable = oldCipher.encryptAuthorizationCredential(
        { mcpServerId: f.server.id, agentId: f.ids[0] as string, authorizationServer: SHARED_ISSUER },
        { accessToken: "unreadable", clientId: f.oauth.clientMetadataUrl },
      );
      await unit.database
        .update(mcpServerAuthorizations)
        .set(unreadable)
        .where(eq(mcpServerAuthorizations.id, f.root.id));
      const selected = await f.auth.findReusableInstallation(f.accountId, b, input);
      expect(selected?.id ?? null).toBe(anotherSource ? f.server.id : null);
      expect(await f.connect(b)).toBe(anotherSource);
      expect((await f.row(b))?.credentialSourceId).toBe(fallback?.id);
      expect(f.exchange).not.toHaveBeenCalled();
    },
  );
  it("keeps installation selection disabled with the new-reuse gate", async () => {
    const f = await sharedMcpFixture(unit.database);
    const servers = new McpServerService({ database: unit.database, cipher: f.cipher });
    const auth = new McpAuthorizationService({
      database: unit.database,
      cipher: f.cipher,
      servers,
      probe: {
        probe: async () => {
          throw new Error("unused");
        },
      } as never,
    });
    expect(await auth.findReusableInstallation(f.accountId, f.ids[1] as string, input)).toBeNull();
  });
  it("revalidates an advisory selection if its credential is revoked before Connect", async () => {
    const f = await sharedMcpFixture(unit.database);
    const b = f.ids[1] as string;
    expect((await f.auth.findReusableInstallation(f.accountId, b, input))?.id).toBe(f.server.id);
    await f.auth.revoke(f.accountId, f.ids[0] as string, f.server.id);
    expect(await f.connect(b)).toBe(false);
    expect(await f.row(b)).toBeUndefined();
    expect(f.exchange).not.toHaveBeenCalled();
  });
});
