import { GitHubConnectionStatusSchema, type GitHubRepositoryBinding } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { agents, githubConnections, users } from "../../db/schema/index.js";
import {
  createGitHubRepositoryAdmissionProof,
  type GitHubAuthorizationFlowHandle,
  GitHubBindingsService,
  GitHubConnectionService,
  type GitHubOAuthCompletionProof,
  sha256Hex,
} from "../../services/github/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let clock: Date;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);

afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});

beforeEach(async () => {
  await testDatabase.reset();
  clock = new Date("2026-09-16T00:00:00.000Z");
});

const sessionHash = "a".repeat(64);

function service() {
  return new GitHubConnectionService(client.database, { now: () => clock });
}

function bindingsService() {
  return new GitHubBindingsService(client.database, { now: () => clock });
}

async function createAccount(email: string) {
  const [account] = await client.database.insert(users).values({ displayName: "Owner", email }).returning();
  if (!account) throw new Error("Missing test Account");
  return account.id;
}

async function createAgent(accountId: string, name: string) {
  const [agent] = await client.database
    .insert(agents)
    .values({ createdByUserId: accountId, name, displayName: name, runtimeProvider: "codex" })
    .returning();
  if (!agent) throw new Error("Missing test Agent");
  return agent.id;
}

function credential() {
  return {
    ciphertext: "encrypted-uat-refresh-pair",
    keyId: "key-2026-09",
    accessExpiresAt: new Date(clock.getTime() + 8 * 3_600_000),
    refreshExpiresAt: new Date(clock.getTime() + 180 * 86_400_000),
  };
}

async function completeFlow(
  accountId: string,
  githubUserId: string,
  intent: "create" | "reauthorize" | "replace" = "create",
) {
  const connections = service();
  const existing = await connections.getCurrentConnection(accountId, "github.com", "871235");
  let flow: GitHubAuthorizationFlowHandle;
  if (intent === "create") {
    flow = (await connections.createConnection(accountId, { appId: "871235", loginSessionHash: sessionHash })).flow;
  } else {
    if (!existing) throw new Error("Missing current connection for the flow");
    flow = await connections.beginAuthorizationFlow(accountId, existing.id, { intent, loginSessionHash: sessionHash });
  }
  const stateHash = sha256Hex(flow.state);
  const claim = await connections.claimOAuthCallback({ stateHash, loginSessionHash: sessionHash });
  const proof: GitHubOAuthCompletionProof = {
    connectionId: flow.connectionId,
    flowId: claim.flowId,
    stateHash,
    loginSessionHash: sessionHash,
    expectedAuthorizationVersion: claim.expectedAuthorizationVersion,
    githubUserId,
    githubLogin: "octocat",
    credential,
  };
  return { completion: await connections.completeAuthorization(accountId, proof), proof };
}

async function activeConnection(accountId: string, githubUserId = "424242") {
  const { completion } = await completeFlow(accountId, githubUserId);
  return completion.connection;
}

function bindingFor(agentId: string): GitHubRepositoryBinding[] {
  return [
    {
      bindingId: crypto.randomUUID(),
      installationId: "12345",
      repositoryId: "67890",
      fullNameDisplay: "team/service",
      agentScopes: [{ agentId, role: "code", access: "write", publish: "pull_request" }],
    },
  ];
}

function proofFor(
  connection: { id: string; authorizationVersion: string; githubUserId: string | null },
  bindings: GitHubRepositoryBinding[],
  verifiedAt = clock,
) {
  if (connection.githubUserId === null) throw new Error("An active connection has a GitHub user");
  return createGitHubRepositoryAdmissionProof({
    connectionId: connection.id,
    authorizationVersion: BigInt(connection.authorizationVersion),
    githubUserId: connection.githubUserId,
    bindings,
    verifiedAt,
  });
}

describe("GitHub connection lifecycle", () => {
  it("keeps a single current row per account, host, and app", async () => {
    const accountId = await createAccount("single@example.com");
    const connections = service();
    await connections.createConnection(accountId, { appId: "871235", loginSessionHash: sessionHash });
    await expect(
      connections.createConnection(accountId, { appId: "871235", loginSessionHash: sessionHash }),
    ).rejects.toMatchObject({ code: "GITHUB_CONNECTION_CONFLICT" });

    const pending = await connections.getCurrentConnection(accountId, "github.com", "871235");
    if (!pending) throw new Error("Missing pending connection");
    const revoked = await connections.disconnect(accountId, pending.id);
    expect(revoked.status).toBe("revoked");

    const recreated = await connections.createConnection(accountId, { appId: "871235", loginSessionHash: sessionHash });
    expect(recreated.connection.id).not.toBe(pending.id);
    const rows = await client.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.accountId, accountId));
    expect(rows).toHaveLength(2);
  });

  it("activates a pending connection exactly once and guards the flow", async () => {
    const accountId = await createAccount("activate@example.com");
    const connections = service();
    const { flow } = await connections.createConnection(accountId, { appId: "871235", loginSessionHash: sessionHash });
    const stateHash = sha256Hex(flow.state);

    await expect(connections.claimOAuthCallback({ stateHash, loginSessionHash: "b".repeat(64) })).rejects.toMatchObject(
      { code: "GITHUB_OAUTH_SESSION_MISMATCH" },
    );

    const claim = await connections.claimOAuthCallback({ stateHash, loginSessionHash: sessionHash });
    expect(claim.expectedAuthorizationVersion).toBe(1n);
    await expect(connections.claimOAuthCallback({ stateHash, loginSessionHash: sessionHash })).rejects.toMatchObject({
      code: "GITHUB_OAUTH_FLOW_INVALID",
    });

    const completion = await connections.completeAuthorization(accountId, {
      connectionId: flow.connectionId,
      flowId: claim.flowId,
      stateHash,
      loginSessionHash: sessionHash,
      expectedAuthorizationVersion: claim.expectedAuthorizationVersion,
      githubUserId: "424242",
      githubLogin: "octocat",
      credential,
    });
    expect(completion.connection.status).toBe("active");
    expect(completion.connection.authorizationVersion).toBe("2");
    expect(completion.connection.credentialGeneration).toBe("1");
    expect(completion.connection.nextRecheckAt).not.toBeNull();
    GitHubConnectionStatusSchema.parse(completion.connection);

    await expect(
      connections.completeAuthorization(accountId, {
        connectionId: flow.connectionId,
        flowId: claim.flowId,
        stateHash,
        loginSessionHash: sessionHash,
        expectedAuthorizationVersion: claim.expectedAuthorizationVersion,
        githubUserId: "424242",
        githubLogin: "octocat",
        credential,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_OAUTH_FLOW_INVALID" });
  });

  it("requires the same GitHub user for ordinary reauthorization", async () => {
    const accountId = await createAccount("reauth@example.com");
    const first = await activeConnection(accountId);
    await expect(completeFlow(accountId, "999999", "reauthorize")).rejects.toMatchObject({
      code: "GITHUB_IDENTITY_MISMATCH",
    });
    const [row] = await client.database.select().from(githubConnections).where(eq(githubConnections.id, first.id));
    expect(row).toMatchObject({
      status: "active",
      githubUserId: "424242",
      credentialCiphertext: "encrypted-uat-refresh-pair",
    });

    const reauthorized = await completeFlow(accountId, "424242", "reauthorize");
    expect(reauthorized.completion.connection.id).toBe(first.id);
    expect(reauthorized.completion.connection.credentialGeneration).toBe("2");
  });

  it("replaces the GitHub user atomically without inherited bindings", async () => {
    const accountId = await createAccount("replace@example.com");
    const agentId = await createAgent(accountId, "assistant");
    const first = await activeConnection(accountId);
    const bindings = bindingFor(agentId);
    await bindingsService().updateBindings(accountId, first.id, {
      expectedAuthorizationVersion: BigInt(first.authorizationVersion),
      bindings,
      admissionProof: proofFor(first, bindings),
    });

    const replaced = await completeFlow(accountId, "777777", "replace");
    expect(replaced.completion.supersededConnectionId).toBe(first.id);
    expect(replaced.completion.connection.id).not.toBe(first.id);
    expect(replaced.completion.connection.bindings).toEqual([]);
    expect(replaced.completion.connection.authorizationVersion).toBe("1");
    expect(replaced.completion.connection.credentialGeneration).toBe("1");
    expect(replaced.completion.connection.githubUserId).toBe("777777");

    const [oldRow] = await client.database.select().from(githubConnections).where(eq(githubConnections.id, first.id));
    expect(oldRow).toMatchObject({
      status: "superseded",
      credentialCiphertext: null,
      credentialKeyId: null,
      oauthStateHash: null,
      refreshStatus: "idle",
      nextRecheckAt: null,
    });
    const current = await service().getCurrentConnection(accountId, "github.com", "871235");
    expect(current?.id).toBe(replaced.completion.connection.id);
  });

  it("treats a same-user replace as ordinary reauthorization on the same row", async () => {
    const accountId = await createAccount("sameuser@example.com");
    const first = await activeConnection(accountId);
    const replaced = await completeFlow(accountId, "424242", "replace");
    expect(replaced.completion.supersededConnectionId).toBeNull();
    expect(replaced.completion.connection.id).toBe(first.id);
    expect(replaced.completion.connection.credentialGeneration).toBe("2");
  });

  it("never resurrects a disconnected row through a late OAuth callback", async () => {
    const accountId = await createAccount("late@example.com");
    const connections = service();
    const { flow } = await connections.createConnection(accountId, { appId: "871235", loginSessionHash: sessionHash });
    const stateHash = sha256Hex(flow.state);
    const claim = await connections.claimOAuthCallback({ stateHash, loginSessionHash: sessionHash });
    await connections.disconnect(accountId, flow.connectionId);
    await expect(
      connections.completeAuthorization(accountId, {
        connectionId: flow.connectionId,
        flowId: claim.flowId,
        stateHash,
        loginSessionHash: sessionHash,
        expectedAuthorizationVersion: claim.expectedAuthorizationVersion,
        githubUserId: "424242",
        githubLogin: "octocat",
        credential,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_OAUTH_FLOW_INVALID" });
    const [row] = await client.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, flow.connectionId));
    expect(row).toMatchObject({ status: "revoked", credentialCiphertext: null, oauthStateHash: null });
  });

  it("disconnects idempotently, clearing secrets, flow, and claim", async () => {
    const accountId = await createAccount("disconnect@example.com");
    const first = await activeConnection(accountId);
    const connections = service();
    const revoked = await connections.disconnect(accountId, first.id);
    expect(revoked.status).toBe("revoked");
    expect(BigInt(revoked.authorizationVersion)).toBe(BigInt(first.authorizationVersion) + 1n);
    const again = await connections.disconnect(accountId, first.id);
    expect(again.authorizationVersion).toBe(revoked.authorizationVersion);
    const [row] = await client.database.select().from(githubConnections).where(eq(githubConnections.id, first.id));
    expect(row).toMatchObject({
      credentialCiphertext: null,
      credentialKeyId: null,
      accessExpiresAt: null,
      oauthStateHash: null,
      oauthContext: null,
      refreshAttemptId: null,
      refreshStatus: "idle",
      nextRecheckAt: null,
    });
  });

  it("never exposes secrets on any returned DTO", async () => {
    const accountId = await createAccount("dto@example.com");
    const connections = service();
    const { connection: pending, flow } = await connections.createConnection(accountId, {
      appId: "871235",
      loginSessionHash: sessionHash,
      oauthSecret: () => ({ ciphertext: "encrypted-pkce-verifier", keyId: "key-2026-09" }),
    });
    const current = await connections.getCurrentConnection(accountId, "github.com", "871235");
    if (!current) throw new Error("Missing current connection");
    const dtos = [pending, current];
    const stateHash = sha256Hex(flow.state);
    const claim = await connections.claimOAuthCallback({ stateHash, loginSessionHash: sessionHash });
    const { connection } = await connections.completeAuthorization(accountId, {
      connectionId: flow.connectionId,
      flowId: claim.flowId,
      stateHash,
      loginSessionHash: sessionHash,
      expectedAuthorizationVersion: claim.expectedAuthorizationVersion,
      githubUserId: "424242",
      githubLogin: "octocat",
      credential,
    });
    dtos.push(connection, await connections.getConnectionStatus(accountId, connection.id));
    const secrets = [
      flow.state,
      sha256Hex(flow.state),
      sessionHash,
      "encrypted-uat-refresh-pair",
      "encrypted-pkce-verifier",
      "key-2026-09",
    ];
    for (const dto of dtos) {
      GitHubConnectionStatusSchema.parse(dto);
      const serialized = JSON.stringify(dto);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});

describe("GitHub connection SQL constraints", () => {
  it("enforces active completeness, secret pairs, decimal IDs, and bounded JSON", async () => {
    const accountId = await createAccount("constraints@example.com");
    const base = { accountId, githubHost: "github.com", appId: "871235" };
    const activeIdentity = { githubUserId: "424242", githubLogin: "octocat" };

    await expect(
      client.database
        .insert(githubConnections)
        .values({ ...base, status: "active", ...activeIdentity, nextRecheckAt: new Date() }),
    ).rejects.toThrow();

    await expect(
      client.database.insert(githubConnections).values({
        ...base,
        status: "active",
        ...activeIdentity,
        credentialCiphertext: "encrypted",
        accessExpiresAt: new Date(),
        refreshExpiresAt: new Date(),
        nextRecheckAt: new Date(),
      }),
    ).rejects.toThrow();

    await expect(
      client.database.insert(githubConnections).values({ accountId, githubHost: "github.com", appId: "87a235" }),
    ).rejects.toThrow();

    await expect(
      client.database.insert(githubConnections).values({ ...base, authorizationVersion: -1n }),
    ).rejects.toThrow();

    await expect(
      client.database.insert(githubConnections).values({ ...base, repositoryBindings: {} as never }),
    ).rejects.toThrow();

    await expect(
      client.database
        .insert(githubConnections)
        .values({ ...base, status: "active", ...activeIdentity, nextRecheckAt: null }),
    ).rejects.toThrow();
  });
});
