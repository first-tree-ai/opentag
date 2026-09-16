import type { GitHubRepositoryBinding } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { agents, githubConnections, users } from "../../db/schema/index.js";
import {
  createGitHubRepositoryAdmissionProof,
  GitHubBindingsService,
  GitHubConnectionRecheckStore,
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

async function activeConnection(accountId: string, githubUserId = "424242", appId = "871235") {
  const connections = service();
  const { flow } = await connections.createConnection(accountId, { appId, loginSessionHash: sessionHash });
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
  const { connection } = await connections.completeAuthorization(accountId, proof);
  return connection;
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

describe("GitHub bindings configuration", () => {
  it("serializes conflicting Tree assignments across two current App connections", async () => {
    const accountId = await createAccount("one-tree@example.com");
    const agentId = await createAgent(accountId, "assistant");
    const first = await activeConnection(accountId);
    const second = await activeConnection(accountId, "424242", "871236");
    const grant = (connection: typeof first, repositoryId: string) => {
      const bindings: GitHubRepositoryBinding[] = bindingFor(agentId).map((binding) => ({
        ...binding,
        repositoryId,
        agentScopes: [{ agentId, role: "context_tree", access: "read", branch: "refs/heads/master" }],
      }));
      return bindingsService().updateBindings(accountId, connection.id, {
        expectedAuthorizationVersion: BigInt(connection.authorizationVersion),
        bindings,
        admissionProof: proofFor(connection, bindings),
      });
    };
    const outcomes = await Promise.allSettled([grant(first, "67890"), grant(second, "67891")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "GITHUB_INPUT_INVALID" } });
  });
  it("does not retarget an existing binding ID to a different repository", async () => {
    const accountId = await createAccount("stable-binding@example.com");
    const connection = await activeConnection(accountId);
    const bindings = bindingFor(await createAgent(accountId, "assistant"));
    const updated = await bindingsService().updateBindings(accountId, connection.id, {
      expectedAuthorizationVersion: BigInt(connection.authorizationVersion),
      bindings,
      admissionProof: proofFor(connection, bindings),
    });
    const retargeted = bindings.map((binding) => ({ ...binding, repositoryId: "67891" }));
    await expect(
      bindingsService().updateBindings(accountId, connection.id, {
        expectedAuthorizationVersion: BigInt(updated.authorizationVersion),
        bindings: retargeted,
        admissionProof: proofFor(updated, retargeted),
      }),
    ).rejects.toMatchObject({ code: "GITHUB_INPUT_INVALID" });
    expect((await service().getConnectionStatus(accountId, connection.id)).bindings).toEqual(bindings);
  });

  it("bounds an expired OAuth sweep and leaves remaining rows for the next batch", async () => {
    for (let index = 0; index < 3; index++) {
      const accountId = await createAccount(`bounded-sweep-${index}@example.com`);
      await service().createConnection(accountId, { appId: "871235", loginSessionHash: sessionHash });
    }
    clock = new Date(clock.getTime() + 11 * 60_000);
    const store = new GitHubConnectionRecheckStore(client.database, { now: () => clock });
    expect(await store.sweepExpiredOAuthFlows({ limit: 2 })).toEqual({ clearedFlows: 0, deletedPending: 2 });
    expect(await store.sweepExpiredOAuthFlows({ limit: 2 })).toEqual({ clearedFlows: 0, deletedPending: 1 });
    await expect(store.sweepExpiredOAuthFlows({ limit: 0 })).rejects.toThrow();
  });
  it("applies updates with a bound proof, sorted agent locking, and version CAS", async () => {
    const accountId = await createAccount("bindings@example.com");
    const agentId = await createAgent(accountId, "assistant");
    const connection = await activeConnection(accountId);
    const bindings = bindingFor(agentId);

    const updated = await bindingsService().updateBindings(accountId, connection.id, {
      expectedAuthorizationVersion: BigInt(connection.authorizationVersion),
      bindings,
      admissionProof: proofFor(connection, bindings),
    });
    expect(updated.authorizationVersion).toBe("3");
    expect(updated.bindings).toHaveLength(1);
    expect(updated.credentialGeneration).toBe(connection.credentialGeneration);

    await expect(
      bindingsService().updateBindings(accountId, connection.id, {
        expectedAuthorizationVersion: BigInt(connection.authorizationVersion),
        bindings,
        admissionProof: proofFor(connection, bindings),
      }),
    ).rejects.toMatchObject({ code: "GITHUB_AUTHORIZATION_VERSION_CONFLICT" });

    const staleProofAt = new Date(clock.getTime() - 6 * 60_000);
    await expect(
      bindingsService().updateBindings(accountId, connection.id, {
        expectedAuthorizationVersion: 3n,
        bindings,
        admissionProof: proofFor(updated, bindings, staleProofAt),
      }),
    ).rejects.toMatchObject({ code: "GITHUB_ADMISSION_PROOF_STALE" });

    await expect(
      bindingsService().updateBindings(accountId, connection.id, {
        expectedAuthorizationVersion: 3n,
        bindings,
        admissionProof: { ...proofFor(updated, bindings), bindingsHash: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "GITHUB_ADMISSION_PROOF_INVALID" });

    await expect(
      bindingsService().updateBindings(accountId, connection.id, {
        expectedAuthorizationVersion: 3n,
        bindings,
        admissionProof: { ...proofFor(updated, bindings), authorizationVersion: 2n },
      }),
    ).rejects.toMatchObject({ code: "GITHUB_ADMISSION_PROOF_INVALID" });
  });

  it("denies cross-account reads and cross-account Agent grants", async () => {
    const ownerId = await createAccount("owner@example.com");
    const strangerId = await createAccount("stranger@example.com");
    const strangerAgent = await createAgent(strangerId, "stranger-agent");
    const connection = await activeConnection(ownerId);

    await expect(service().getConnectionStatus(strangerId, connection.id)).rejects.toMatchObject({
      code: "GITHUB_CONNECTION_NOT_FOUND",
    });

    const bindings = bindingFor(strangerAgent);
    await expect(
      bindingsService().updateBindings(ownerId, connection.id, {
        expectedAuthorizationVersion: BigInt(connection.authorizationVersion),
        bindings,
        admissionProof: proofFor(connection, bindings),
      }),
    ).rejects.toMatchObject({ code: "GITHUB_AGENT_OWNERSHIP_INVALID" });

    const ownBindings = bindingFor(await createAgent(ownerId, "own-agent"));
    await expect(
      bindingsService().updateBindings(strangerId, connection.id, {
        expectedAuthorizationVersion: BigInt(connection.authorizationVersion),
        bindings: ownBindings,
        admissionProof: proofFor(connection, ownBindings),
      }),
    ).rejects.toMatchObject({ code: "GITHUB_CONNECTION_NOT_FOUND" });

    const [row] = await client.database.select().from(githubConnections).where(eq(githubConnections.id, connection.id));
    expect(row?.repositoryBindings).toEqual([]);
  });

  it("rejects configuration changes on a non-active connection", async () => {
    const accountId = await createAccount("pending@example.com");
    const agentId = await createAgent(accountId, "assistant");
    const connections = service();
    const { connection } = await connections.createConnection(accountId, {
      appId: "871235",
      loginSessionHash: sessionHash,
    });
    const bindings = bindingFor(agentId);
    await expect(
      bindingsService().updateBindings(accountId, connection.id, {
        expectedAuthorizationVersion: BigInt(connection.authorizationVersion),
        bindings,
        admissionProof: {
          connectionId: connection.id,
          authorizationVersion: BigInt(connection.authorizationVersion),
          githubUserId: "424242",
          bindingsHash: "0".repeat(64),
          verifiedAt: clock,
        },
      }),
    ).rejects.toMatchObject({ code: "GITHUB_CONNECTION_STATE_INVALID" });
  });

  it("sweeps expired pending rows and clears dead flows without touching live ones", async () => {
    const pendingAccountId = await createAccount("sweep-pending@example.com");
    const activeAccountId = await createAccount("sweep-active@example.com");
    const connections = service();
    const recheck = new GitHubConnectionRecheckStore(client.database, { now: () => clock });
    const { connection: pending } = await connections.createConnection(pendingAccountId, {
      appId: "871235",
      loginSessionHash: sessionHash,
    });

    const active = await activeConnection(activeAccountId);
    clock = new Date(clock.getTime() + 11 * 60_000);
    const flow = await connections.beginAuthorizationFlow(activeAccountId, active.id, {
      intent: "reauthorize",
      loginSessionHash: sessionHash,
    });
    clock = new Date(clock.getTime() + 11 * 60_000);

    const swept = await recheck.sweepExpiredOAuthFlows();
    expect(swept).toEqual({ clearedFlows: 1, deletedPending: 1 });

    const [pendingRow] = await client.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, pending.id));
    expect(pendingRow).toBeUndefined();
    const [activeRow] = await client.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, flow.connectionId));
    expect(activeRow).toMatchObject({
      status: "active",
      oauthStateHash: null,
      credentialCiphertext: "encrypted-uat-refresh-pair",
    });

    const recreated = await connections.createConnection(pendingAccountId, {
      appId: "871235",
      loginSessionHash: sessionHash,
    });
    expect(recreated.connection.status).toBe("pending");
  });
});
