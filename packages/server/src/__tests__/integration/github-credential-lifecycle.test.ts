import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { githubConnections, users } from "../../db/schema/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import {
  type GitHubAuthorizationFlowHandle,
  GitHubConnectionService,
} from "../../services/github/github-connection-service.js";
import { sha256Hex } from "../../services/github/hashes.js";
import { GitHubCredentialCipher, type GitHubUserCredentialBinding } from "../../services/github-credential-material.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let accountId: string;
const clock = new Date("2030-01-01T00:00:00Z");
const sessionHash = "a".repeat(64);
const cipher = new GitHubCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(17)));
const tokens = { accessToken: "test-access", refreshToken: "test-refresh" };
const credential = (binding: GitHubUserCredentialBinding) => ({
  ...cipher.encryptUserCredential(binding, tokens),
  accessExpiresAt: new Date(clock.getTime() + 3_600_000),
  refreshExpiresAt: new Date(clock.getTime() + 86_400_000),
});

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
  const [account] = await client.database
    .insert(users)
    .values({ displayName: "Account", email: "sealed@example.com" })
    .returning();
  if (!account) throw new Error("Missing test Account");
  accountId = account.id;
});

function service() {
  return new GitHubConnectionService(client.database, { now: () => clock });
}
function context(connectionId: string, githubUserId: string): GitHubUserCredentialBinding {
  return { connectionId, accountId, appId: "123", githubHost: "github.com", githubUserId };
}
async function proof(flow: GitHubAuthorizationFlowHandle, githubUserId: string) {
  const stateHash = sha256Hex(flow.state);
  const claim = await service().claimOAuthCallback({ stateHash, loginSessionHash: sessionHash });
  return {
    connectionId: flow.connectionId,
    flowId: flow.flowId,
    stateHash,
    loginSessionHash: sessionHash,
    expectedAuthorizationVersion: claim.expectedAuthorizationVersion,
    githubUserId,
    githubLogin: "owner",
    credential,
  };
}
async function row(id: string) {
  const [value] = await client.database.select().from(githubConnections).where(eq(githubConnections.id, id));
  if (!value) throw new Error("Missing test connection");
  return value;
}
function sealed(value: Awaited<ReturnType<typeof row>>) {
  if (!value.credentialCiphertext || !value.credentialKeyId) throw new Error("Missing test credential");
  return { ciphertext: value.credentialCiphertext, keyId: value.credentialKeyId };
}

describe("GitHub encrypted connection lifecycle", () => {
  it("binds PKCE after both the connection ID and OAuth flow ID have been allocated", async () => {
    const verifier = "v".repeat(43);
    const { flow } = await service().createConnection(accountId, {
      appId: "123",
      loginSessionHash: sessionHash,
      oauthSecret: (binding) => cipher.encryptOAuthSecret(binding, verifier),
    });
    const claim = await service().claimOAuthCallback({
      stateHash: sha256Hex(flow.state),
      loginSessionHash: sessionHash,
    });
    if (!claim.oauthSecret) throw new Error("Missing test PKCE slot");
    expect(
      cipher.decryptOAuthSecret(
        { connectionId: flow.connectionId, accountId, githubHost: "github.com", appId: "123", flowId: flow.flowId },
        claim.oauthSecret,
      ),
    ).toBe(verifier);
  });

  it("seals replacement credentials against the new connection and user, and clears the old pair", async () => {
    const { flow } = await service().createConnection(accountId, { appId: "123", loginSessionHash: sessionHash });
    const first = await service().completeAuthorization(accountId, await proof(flow, "456"));
    expect(
      cipher.decryptUserCredential(context(first.connection.id, "456"), sealed(await row(first.connection.id))),
    ).toEqual(tokens);
    const replace = await service().beginAuthorizationFlow(accountId, first.connection.id, {
      intent: "replace",
      loginSessionHash: sessionHash,
    });
    const second = await service().completeAuthorization(accountId, await proof(replace, "457"));
    expect(second.connection.id).not.toBe(first.connection.id);
    const stored = sealed(await row(second.connection.id));
    expect(cipher.decryptUserCredential(context(second.connection.id, "457"), stored)).toEqual(tokens);
    expect(() => cipher.decryptUserCredential(context(first.connection.id, "457"), stored)).toThrow(/authenticated/);
    expect(await row(first.connection.id)).toMatchObject({
      status: "superseded",
      credentialCiphertext: null,
      credentialKeyId: null,
    });
  });

  it("retains the active connection when replacement encryption fails", async () => {
    const { flow } = await service().createConnection(accountId, { appId: "123", loginSessionHash: sessionHash });
    const first = await service().completeAuthorization(accountId, await proof(flow, "456"));
    const replace = await service().beginAuthorizationFlow(accountId, first.connection.id, {
      intent: "replace",
      loginSessionHash: sessionHash,
    });
    const completion = await proof(replace, "457");
    await expect(
      service().completeAuthorization(accountId, {
        ...completion,
        credential: () => {
          throw new Error("Encryption unavailable");
        },
      }),
    ).rejects.toThrow("Encryption unavailable");
    expect((await row(first.connection.id)).status).toBe("active");
    expect(
      cipher.decryptUserCredential(context(first.connection.id, "456"), sealed(await row(first.connection.id))),
    ).toEqual(tokens);
  });
});
