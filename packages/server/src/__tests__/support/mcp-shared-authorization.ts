import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import type { DatabaseClient } from "../../db/client.js";
import { agentRuntimeConfigs, agents, mcpServerAuthorizations, users } from "../../db/schema/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { McpAuthorizationService } from "../../services/mcp/mcp-authorization-service.js";
import { McpCredentialCipher } from "../../services/mcp/mcp-credential-cipher.js";
import { McpOAuthClient } from "../../services/mcp/mcp-oauth.js";
import { McpOAuthFlowService } from "../../services/mcp/mcp-oauth-flow-service.js";
import type { McpProbe } from "../../services/mcp/mcp-probe.js";
import { McpServerService } from "../../services/mcp/mcp-server-service.js";
import { McpOutboundFetcher } from "../../services/mcp/mcp-url-policy.js";

export const SHARED_ISSUER = "https://auth.example.test";
export const SHARED_URL = "https://mcp.example.test/mcp";
export const SHARED_PROOF = "test-browser-proof";

export async function sharedMcpFixture(database: DatabaseClient) {
  const accountId = randomUUID();
  await database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "Owner" });
  const ids = Array.from({ length: 4 }, () => randomUUID());
  await database.insert(agents).values(
    ids.map((id, index) => ({
      id,
      createdByUserId: accountId,
      name: `agent-${index}`,
      displayName: `Agent ${index}`,
      runtimeProvider: "codex" as const,
      status: "suspended" as const,
    })),
  );
  await database.insert(agentRuntimeConfigs).values(ids.map((agentId) => ({ agentId, instructions: "" })));
  const cipher = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(7)));
  const servers = new McpServerService({ database, cipher, reuseOAuth: true });
  const server = await servers.createServer(accountId, { name: "shared", url: SHARED_URL, defaultAuthKind: "oauth" });
  for (const id of ids) await servers.attachServer(accountId, id, server.id, true);
  const oauth = new McpOAuthClient({
    publicUrl: "https://opentag.example.test",
    fetcher: new McpOutboundFetcher({
      allowLoopback: false,
      fetch: vi.fn(() => {
        throw new Error("Unexpected network request");
      }),
    }),
  });
  vi.spyOn(oauth, "protectedResourceMetadata").mockResolvedValue({
    metadata: { resource: SHARED_URL, authorizationServers: [SHARED_ISSUER], scopesSupported: ["read"] },
  });
  vi.spyOn(oauth, "authorizationServerMetadata").mockResolvedValue({
    issuer: SHARED_ISSUER,
    authorizationEndpoint: `${SHARED_ISSUER}/authorize`,
    tokenEndpoint: `${SHARED_ISSUER}/token`,
    scopesSupported: ["read"],
    clientIdMetadataDocumentSupported: true,
    authorizationResponseIssParameterSupported: false,
    tokenEndpointAuthMethodsSupported: ["none"],
  });
  const refresh = vi
    .spyOn(oauth, "refreshAccessToken")
    .mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });
  const exchange = vi.spyOn(oauth, "exchangeAuthorizationCode").mockResolvedValue({
    accessToken: "new-consent",
    refreshToken: "new-consent-refresh",
    expiresIn: 3600,
    scope: "read",
  });
  const flows = new McpOAuthFlowService({ database, cipher, servers, oauth });
  const auth = new McpAuthorizationService({
    database,
    cipher,
    servers,
    probe: { probe: vi.fn() } as unknown as McpProbe,
    reusableClient: (...args) => flows.reusableClient(...args),
  });
  async function authorize(agentId: string, createdAt = new Date(), definition = server) {
    const sealed = cipher.encryptAuthorizationCredential(
      { mcpServerId: definition.id, agentId, authorizationServer: SHARED_ISSUER },
      { accessToken: "old-access", refreshToken: "old-refresh", clientId: oauth.clientMetadataUrl },
    );
    const [row] = await database
      .insert(mcpServerAuthorizations)
      .values({
        agentId,
        mcpServerId: definition.id,
        kind: "oauth",
        status: "active",
        authorizationServer: SHARED_ISSUER,
        oauthResource: definition.url,
        scopes: ["read"],
        accessTokenExpiresAt: new Date(Date.now() + 3600000),
        ...sealed,
        createdAt,
      })
      .returning();
    if (!row) throw new Error("Missing authorization");
    return row;
  }
  async function row(agentId: string) {
    const [value] = await database
      .select()
      .from(mcpServerAuthorizations)
      .where(eq(mcpServerAuthorizations.agentId, agentId));
    return value;
  }
  const root = await authorize(ids[0] as string, new Date("2026-01-01T00:00:00Z"));
  async function connect(agentId: string) {
    return auth.connectOAuth(accountId, agentId, server.id, ["read", "offline_access"]);
  }
  async function start(agentId: string) {
    const result = await flows.start(accountId, agentId, server.id, ["read"], SHARED_PROOF);
    const state = new URL(result.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("No state");
    return state;
  }
  return {
    database,
    accountId,
    ids,
    cipher,
    servers,
    server,
    oauth,
    refresh,
    exchange,
    flows,
    auth,
    authorize,
    row,
    root,
    connect,
    start,
  };
}
