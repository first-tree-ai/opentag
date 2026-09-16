import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { githubConnections } from "../db/schema/index.js";
import { GITHUB_CONNECTION_ERROR_CODES } from "../services/github/errors.js";
import { GitHubConnectionService } from "../services/github/github-connection-service.js";
import { GitHubOAuthService } from "../services/github/github-oauth-service.js";
import { sha256Hex } from "../services/github/hashes.js";
import {
  createAccount,
  GITHUB_TEST_APP_ID,
  stubGitHubApi,
  testCredentialCipher,
  tokenMaterial,
} from "./support/github-fixtures.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
const cipher = testCredentialCipher();
const REDIRECT_URI = "https://opentag.example.com/api/v1/integrations/github/oauth/callback";
const sessionSecret = "session-secret";
const loginSessionHash = sha256Hex(`account:${sessionSecret}`);

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unit?.close();
});

beforeEach(async () => {
  await unit.reset();
});

function oauthService(api: ReturnType<typeof stubGitHubApi>) {
  const connections = new GitHubConnectionService(unit.database, {
    now: () => new Date("2026-09-16T00:00:00.000Z"),
  });
  const service = new GitHubOAuthService({
    connections,
    cipher,
    api: api.asClient(),
    clientId: "Iv1.client",
    redirectUri: REDIRECT_URI,
  });
  return { connections, service };
}

async function accountId(): Promise<string> {
  return (await createAccount(unit)).id;
}

describe("GitHubOAuthService.startAuthorization", () => {
  it("builds the real authorize URL with state and an S256 challenge, sealing the verifier", async () => {
    const api = stubGitHubApi();
    const { service } = oauthService(api);
    const id = await accountId();
    const started = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    const url = new URL(started.authorizationUrl);
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.client");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = url.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = url.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the state hash and the sealed verifier persist — never the raw values.
    const [row] = await unit.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, started.connectionId));
    expect(row?.oauthStateHash).toBe(sha256Hex(state as string));
    expect(row?.oauthContextCiphertext).toBeTruthy();
    expect(row?.oauthStateHash).not.toBe(state);
    expect(row?.oauthContextCiphertext).not.toContain(state as string);
  });

  it("restarts the in-flight flow of a pending connection instead of creating a second row", async () => {
    const api = stubGitHubApi();
    const { service } = oauthService(api);
    const id = await accountId();
    const first = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    const second = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    expect(second.connectionId).toBe(first.connectionId);
    expect(new URL(second.authorizationUrl).searchParams.get("state")).not.toBe(
      new URL(first.authorizationUrl).searchParams.get("state"),
    );
    const rows = await unit.database.select().from(githubConnections);
    expect(rows).toHaveLength(1);
  });

  it("refuses a create flow over an active connection and requires an existing one to reauthorize", async () => {
    const api = stubGitHubApi();
    api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const { service } = oauthService(api);
    const id = await accountId();
    await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    const started = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    await service.completeCallback(id, callbackFromUrl(started.authorizationUrl));
    await expect(
      service.startAuthorization(id, {
        intent: "create",
        returnSurface: "account-integrations",
        agentId: null,
        loginSessionHash,
        appId: GITHUB_TEST_APP_ID,
      }),
    ).rejects.toMatchObject({ code: GITHUB_CONNECTION_ERROR_CODES.CONNECTION_CONFLICT });
    const other = await createAccount(unit);
    await expect(
      service.startAuthorization(other.id, {
        intent: "reauthorize",
        returnSurface: "account-integrations",
        agentId: null,
        loginSessionHash,
        appId: GITHUB_TEST_APP_ID,
      }),
    ).rejects.toMatchObject({ code: GITHUB_CONNECTION_ERROR_CODES.CONNECTION_NOT_FOUND });
  });
});

function callbackFromUrl(authorizationUrl: string): { state: string; code: string; loginSessionHash: string } {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("authorize URL carries no state");
  return { state, code: "oauth-code", loginSessionHash };
}

describe("GitHubOAuthService.completeCallback", () => {
  it("exchanges once, seals the credential, activates, and rejects a replayed callback", async () => {
    const api = stubGitHubApi();
    api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const { service } = oauthService(api);
    const id = await accountId();
    const started = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    // The sealed verifier opens to the PKCE secret whose challenge the URL carried.
    const challenge = new URL(started.authorizationUrl).searchParams.get("code_challenge");
    const result = await service.completeCallback(id, callbackFromUrl(started.authorizationUrl));
    expect(result.connectionId).toBe(started.connectionId);
    expect(result.supersededConnectionId).toBeNull();
    const sentVerifier = api.exchangeCodeForUserToken.mock.calls[0]?.[0]?.codeVerifier as string;
    expect(createHash("sha256").update(sentVerifier, "utf8").digest("base64url")).toBe(challenge);
    expect(api.exchangeCodeForUserToken).toHaveBeenCalledTimes(1);

    const [row] = await unit.database.select().from(githubConnections);
    expect(row?.status).toBe("active");
    expect(row?.githubUserId).toBe("42");
    expect(row?.githubLogin).toBe("octocat");
    expect(row?.oauthStateHash).toBeNull();
    expect(row?.oauthContextCiphertext).toBeNull();
    const opened = cipher.decryptUserCredential(
      {
        connectionId: row?.id as string,
        accountId: id,
        githubHost: "github.com",
        appId: GITHUB_TEST_APP_ID,
        githubUserId: "42",
      },
      { ciphertext: row?.credentialCiphertext as string, keyId: row?.credentialKeyId as string },
    );
    expect(opened).toEqual({ accessToken: "ghu_access", refreshToken: "ghr_refresh" });

    // A replayed callback can never reach the exchange again.
    await expect(service.completeCallback(id, callbackFromUrl(started.authorizationUrl))).rejects.toMatchObject({
      code: GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
    });
    expect(api.exchangeCodeForUserToken).toHaveBeenCalledTimes(1);
  });

  it("completes a same-user reauthorization and keeps bindings", async () => {
    const api = stubGitHubApi();
    api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const { service } = oauthService(api);
    const id = await accountId();
    const created = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    await service.completeCallback(id, callbackFromUrl(created.authorizationUrl));
    // The owner's repository scopes carry their explicit task delegation; reauthorization must not
    // silently drop either.
    const delegated = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000aa",
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [
        {
          agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
          role: "code" as const,
          access: "write" as const,
          publish: "pull_request" as const,
          taskDelegation: {
            imSenders: [{ bindingId: "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b", senderId: "ou_teammate" }],
            sessionAgents: ["2b74b32f-a7d8-4585-92fb-5ecbf1677b35"],
          },
        },
      ],
    };
    await unit.database
      .update(githubConnections)
      .set({ repositoryBindings: [delegated] })
      .where(eq(githubConnections.id, created.connectionId));
    const reauth = await service.startAuthorization(id, {
      intent: "reauthorize",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    expect(reauth.connectionId).toBe(created.connectionId);
    api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial({ accessToken: "ghu_next" }));
    const result = await service.completeCallback(id, callbackFromUrl(reauth.authorizationUrl));
    expect(result.connectionId).toBe(created.connectionId);
    const [row] = await unit.database.select().from(githubConnections);
    expect(row?.status).toBe("active");
    expect(row?.authorizationVersion).toBe(3n);
    expect(row?.repositoryBindings).toEqual([delegated]);
  });

  it("rejects a reauthorization that returns a different user and requires explicit replace", async () => {
    const api = stubGitHubApi();
    api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const { service } = oauthService(api);
    const id = await accountId();
    const created = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    await service.completeCallback(id, callbackFromUrl(created.authorizationUrl));
    // The owner's repository scopes carry their explicit task delegation; reauthorization must not
    // silently drop either.
    const delegated = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000aa",
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [
        {
          agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
          role: "code" as const,
          access: "write" as const,
          publish: "pull_request" as const,
          taskDelegation: {
            imSenders: [{ bindingId: "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b", senderId: "ou_teammate" }],
            sessionAgents: ["2b74b32f-a7d8-4585-92fb-5ecbf1677b35"],
          },
        },
      ],
    };
    await unit.database
      .update(githubConnections)
      .set({ repositoryBindings: [delegated] })
      .where(eq(githubConnections.id, created.connectionId));
    const reauth = await service.startAuthorization(id, {
      intent: "reauthorize",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    api.getAuthenticatedUser.mockResolvedValue({ id: "77", login: "impostor" });
    await expect(service.completeCallback(id, callbackFromUrl(reauth.authorizationUrl))).rejects.toMatchObject({
      code: GITHUB_CONNECTION_ERROR_CODES.IDENTITY_MISMATCH,
    });
    // The failed completion voided the flow; the active credential is untouched.
    const [row] = await unit.database.select().from(githubConnections);
    expect(row?.status).toBe("active");
    expect(row?.githubUserId).toBe("42");
    expect(row?.oauthStateHash).toBeNull();
    expect(row?.credentialCiphertext).toBeTruthy();
  });

  it("replaces explicitly: the old row supersedes without bindings and a fresh connection activates", async () => {
    const api = stubGitHubApi();
    api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const { service } = oauthService(api);
    const id = await accountId();
    const created = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    await service.completeCallback(id, callbackFromUrl(created.authorizationUrl));
    // Seed a binding so the replace must prove it is not inherited.
    await unit.database
      .update(githubConnections)
      .set({
        repositoryBindings: [
          {
            bindingId: crypto.randomUUID(),
            installationId: "55123456",
            repositoryId: "987654321",
            fullNameDisplay: "octocat/hello-world",
            agentScopes: [
              {
                agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
                role: "code",
                access: "write",
                publish: "direct",
              },
            ],
          },
        ],
      })
      .where(eq(githubConnections.id, created.connectionId));
    const replace = await service.startAuthorization(id, {
      intent: "replace",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    api.getAuthenticatedUser.mockResolvedValue({ id: "77", login: "new-user" });
    const result = await service.completeCallback(id, callbackFromUrl(replace.authorizationUrl));
    expect(result.supersededConnectionId).toBe(created.connectionId);
    expect(result.connectionId).not.toBe(created.connectionId);
    const rows = await unit.database.select().from(githubConnections);
    const oldRow = rows.find((row) => row.id === created.connectionId);
    const newRow = rows.find((row) => row.id === result.connectionId);
    expect(oldRow?.status).toBe("superseded");
    expect(oldRow?.credentialCiphertext).toBeNull();
    expect(newRow?.status).toBe("active");
    expect(newRow?.githubUserId).toBe("77");
    expect(newRow?.repositoryBindings).toEqual([]);
    expect(newRow?.authorizationVersion).toBe(1n);
  });

  it("voids the flow when the exchange fails and never leaks code or state into the error", async () => {
    const api = stubGitHubApi();
    api.exchangeCodeForUserToken.mockRejectedValue(
      new (await import("../services/github/github-api-client.js")).GitHubApiClientError(
        "GITHUB_UPSTREAM_UNAVAILABLE",
        "The GitHub request failed",
      ),
    );
    const { service } = oauthService(api);
    const id = await accountId();
    const started = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") as string;
    const error = await service
      .completeCallback(id, { state, code: "oauth-code-secret", loginSessionHash })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: GITHUB_CONNECTION_ERROR_CODES.UPSTREAM_UNAVAILABLE });
    expect(JSON.stringify(error)).not.toContain("oauth-code-secret");
    expect(JSON.stringify(error)).not.toContain(state);
    const [row] = await unit.database.select().from(githubConnections);
    expect(row?.status).toBe("pending");
    expect(row?.oauthStateHash).toBeNull();
    expect(row?.oauthContextCiphertext).toBeNull();
  });

  it("binds the flow to the login session that started it", async () => {
    const api = stubGitHubApi();
    api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    api.getAuthenticatedUser.mockResolvedValue({ id: "42", login: "octocat" });
    const { service } = oauthService(api);
    const id = await accountId();
    const started = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    await expect(
      service.completeCallback(id, {
        state: new URL(started.authorizationUrl).searchParams.get("state") as string,
        code: "oauth-code",
        loginSessionHash: sha256Hex("account:other-session"),
      }),
    ).rejects.toMatchObject({ code: GITHUB_CONNECTION_ERROR_CODES.OAUTH_SESSION_MISMATCH });
    expect(api.exchangeCodeForUserToken).not.toHaveBeenCalled();
    // And the callback of another Account cannot complete this Account's flow.
    const other = await createAccount(unit);
    await expect(service.completeCallback(other.id, callbackFromUrl(started.authorizationUrl))).rejects.toMatchObject({
      code: GITHUB_CONNECTION_ERROR_CODES.OAUTH_SESSION_MISMATCH,
    });
    expect(api.exchangeCodeForUserToken).not.toHaveBeenCalled();
  });
});

describe("GitHubOAuthService.abortCallback", () => {
  it("voids a denied flow and reports its fixed return surface", async () => {
    const api = stubGitHubApi();
    const { service } = oauthService(api);
    const id = await accountId();
    const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
    const started = await service.startAuthorization(id, {
      intent: "create",
      returnSurface: "agent-integrations",
      agentId,
      loginSessionHash,
      appId: GITHUB_TEST_APP_ID,
    });
    const aborted = await service.abortCallback(id, {
      state: new URL(started.authorizationUrl).searchParams.get("state") as string,
      loginSessionHash,
    });
    expect(aborted).toEqual({ returnSurface: "agent-integrations", agentId });
    const [row] = await unit.database.select().from(githubConnections);
    expect(row?.status).toBe("pending");
    expect(row?.oauthStateHash).toBeNull();
    // A second denial of the same state finds no flow.
    expect(
      await service.abortCallback(id, {
        state: new URL(started.authorizationUrl).searchParams.get("state") as string,
        loginSessionHash,
      }),
    ).toBeNull();
  });
});
