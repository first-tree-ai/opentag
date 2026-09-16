/*
 * Account-facing GitHub integration HTTP surface: deployment availability, authenticated management
 * routes, the public OAuth callback, and the webhook ingress.
 *
 * The suite runs the real routes, the real connection/bindings/refresh state machine, and a real
 * PostgreSQL (PGlite) schema; only the GitHub origin is stubbed. It asserts the boundaries the
 * management plane must never lose: Account authentication on every management route, browser CSRF,
 * cross-Account isolation, one-time callback claims, authoritative admission instead of forged
 * installation IDs, CAS-fenced bindings, fail-closed replacement cleanup, and raw-body HMAC
 * verification on the webhook.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { GitHubIntegrationAvailability } from "@opentag/shared";
import {
  GITHUB_INTEGRATION_AUTHORIZATION_PATH,
  GITHUB_INTEGRATION_BINDINGS_PATH,
  GITHUB_INTEGRATION_DISCONNECT_PATH,
  GITHUB_INTEGRATION_PATH,
  GITHUB_INTEGRATION_REPOSITORIES_PATH,
  GITHUB_OAUTH_CALLBACK_PATH,
  GITHUB_WEBHOOK_PATH,
  type GitHubConnectionStatus,
  type GitHubRepositoryBinding,
} from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { githubConnections } from "../db/schema/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { GitHubBindingsService } from "../services/github/github-bindings-service.js";
import { GitHubConnectionService } from "../services/github/github-connection-service.js";
import { GitHubManagementService } from "../services/github/github-management-service.js";
import { GitHubOAuthService } from "../services/github/github-oauth-service.js";
import { GitHubConnectionRecheckStore } from "../services/github/github-recheck-store.js";
import { GitHubWebhookService } from "../services/github/github-webhook.js";
import { GitHubRepositoryAdmissionService } from "../services/github/repository-admission.js";
import { GitHubCredentialCipher } from "../services/github-credential-material.js";
import { signedInBrowser } from "./signed-in-browser.js";
import {
  createAccount,
  GITHUB_TEST_APP_ID,
  installation,
  installationsPage,
  repositoriesPage,
  repository,
  stubGitHubApi,
  tokenMaterial,
} from "./support/github-fixtures.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const NOW = new Date("2026-09-16T00:00:00.000Z");
const REDIRECT_URI = "https://opentag.example.com/api/v1/integrations/github/oauth/callback";
const PUBLIC_ORIGIN = "https://opentag.example.com";
const OAUTH_COOKIE = "opentag_github_oauth_context";
const ACCESS_TOKEN = "token-owner";
const OTHER_TOKEN = "token-other";
const GITHUB_USER_ONE = "42";
const GITHUB_USER_TWO = "77";

interface AccountFixture {
  id: string;
  email: string;
}

let unit: UnitDatabase;
const apps: ReturnType<typeof createApp>[] = [];
const cipher = new GitHubCredentialCipher(new ApplicationCipher(Buffer.alloc(32, 3)));

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await unit?.close();
});

beforeEach(async () => {
  await unit.reset();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function authService(accounts: { owner: AccountFixture; other: AccountFixture }): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    updateSelfProfile: vi.fn(),
    getActiveUserById: vi.fn(async (userId: string) => ({
      user: { id: userId, email: `${userId}@example.com`, displayName: "Owner" },
      setupCompletedAt: null,
    })),
    getAuthenticatedUser: vi.fn(async (token: string) => {
      const account = token === OTHER_TOKEN ? accounts.other : accounts.owner;
      if (token !== OTHER_TOKEN && token !== ACCESS_TOKEN) throw new Error("Unknown test token");
      return {
        tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
        me: {
          user: { id: account.id, email: account.email, displayName: "Owner" },
          setupCompletedAt: null,
        },
      };
    }),
  };
}

function buildManagement(api: ReturnType<typeof stubGitHubApi>) {
  const now = () => NOW;
  const connections = new GitHubConnectionService(unit.database, { now });
  const bindings = new GitHubBindingsService(unit.database, { now });
  const admission = new GitHubRepositoryAdmissionService({ api: api.asClient(), appId: GITHUB_TEST_APP_ID, now });
  const oauth = new GitHubOAuthService({
    connections,
    cipher,
    api: api.asClient(),
    clientId: "Iv1.client",
    redirectUri: REDIRECT_URI,
  });
  return new GitHubManagementService({
    database: unit.database,
    appId: GITHUB_TEST_APP_ID,
    connections,
    bindings,
    oauth,
    admission,
    cipher,
    now,
  });
}

async function appFixture(options: { withManagement?: boolean; withWebhook?: boolean } = {}) {
  const owner = await createAccount(unit, "owner@example.com");
  const other = await createAccount(unit, "other@example.com");
  const api = stubGitHubApi();
  const availability: GitHubIntegrationAvailability = options.withManagement
    ? { available: true, githubHost: "github.com", appId: GITHUB_TEST_APP_ID }
    : { available: false, githubHost: "github.com", appId: null };
  const management = options.withManagement ? buildManagement(api) : undefined;
  const recheckStore = new GitHubConnectionRecheckStore(unit.database, { now: () => NOW });
  const webhook = options.withWebhook
    ? new GitHubWebhookService({ webhookSecret: "webhook-secret", recheckStore, now: () => NOW })
    : undefined;
  const app = createApp({
    authService: authService({ owner, other }),
    githubIntegrations: {
      availability,
      publicOrigin: PUBLIC_ORIGIN,
      secureCookies: true,
      ...(management ? { management } : {}),
      ...(webhook ? { webhook } : {}),
    },
  });
  apps.push(app);
  return { app, api, owner, other, management, webhook, recheckStore };
}

function ownerHeaders(token = ACCESS_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

function cookieValue(response: { headers: Record<string, unknown> }): string {
  const cookies = ([] as string[]).concat((response.headers["set-cookie"] ?? []) as string | string[]);
  const cookie = cookies.find((value) => value.startsWith(`${OAUTH_COOKIE}=`));
  if (!cookie) throw new Error("The authorization start did not set the OAuth context cookie");
  return cookie.slice(0, cookie.indexOf(";"));
}

function stateFromAuthorizeUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("The authorize URL carries no state");
  return state;
}

function locationOf(response: { headers: Record<string, unknown> }): URL {
  const location = response.headers.location;
  if (typeof location !== "string") throw new Error("The callback did not redirect");
  return new URL(location);
}

async function startAuthorization(
  app: ReturnType<typeof createApp>,
  input: {
    intent: "create" | "reauthorize" | "replace";
    token?: string;
    returnSurface?: string;
    agentId?: string | null;
  } = {
    intent: "create",
  },
) {
  const response = await app.inject({
    method: "POST",
    url: GITHUB_INTEGRATION_AUTHORIZATION_PATH,
    headers: ownerHeaders(input.token),
    payload: {
      intent: input.intent,
      returnSurface: input.returnSurface ?? "account-integrations",
      agentId: input.agentId ?? null,
    },
  });
  if (response.statusCode !== 200) throw new Error(`Authorize start failed with ${response.statusCode}`);
  const body = response.json() as { authorizationUrl: string; connectionId: string; expiresAt: string };
  return { ...body, state: stateFromAuthorizeUrl(body.authorizationUrl), cookie: cookieValue(response) };
}

async function completeCallback(
  app: ReturnType<typeof createApp>,
  input: { state: string; cookie: string; token?: string; code?: string; error?: string },
) {
  const query = new URLSearchParams();
  if (input.code !== undefined) query.set("code", input.code);
  if (input.error !== undefined) query.set("error", input.error);
  query.set("state", input.state);
  return app.inject({
    method: "GET",
    url: `${GITHUB_OAUTH_CALLBACK_PATH}?${query.toString()}`,
    headers: { ...ownerHeaders(input.token), cookie: input.cookie },
  });
}

/** An active connection for the owner, created through the real start/callback round trip. */
async function activeConnection(fixture: Awaited<ReturnType<typeof appFixture>>, githubUserId = GITHUB_USER_ONE) {
  fixture.api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
  fixture.api.getAuthenticatedUser.mockResolvedValue({ id: githubUserId, login: `user-${githubUserId}` });
  const started = await startAuthorization(fixture.app);
  const callback = await completeCallback(fixture.app, {
    state: started.state,
    cookie: started.cookie,
    code: "code-once",
  });
  const location = locationOf(callback);
  if (location.searchParams.get("github_oauth") !== "success") {
    throw new Error(`Activation failed: ${location.toString()}`);
  }
  const [row] = await unit.database
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.accountId, fixture.owner.id));
  if (!row) throw new Error("The activated connection row is missing");
  return row;
}

async function createAgent(accountId: string, name = "reviewer") {
  const { agents } = await import("../db/schema/index.js");
  const [agent] = await unit.database
    .insert(agents)
    .values({ createdByUserId: accountId, name, displayName: name, runtimeProvider: "codex" })
    .returning();
  if (!agent) throw new Error("The test Agent was not inserted");
  return agent;
}

function bindingDocument(agentId: string, overrides: Partial<GitHubRepositoryBinding> = {}): GitHubRepositoryBinding[] {
  return [
    {
      bindingId: randomUUID(),
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [{ agentId, role: "code", access: "write", publish: "pull_request" }],
      ...overrides,
    },
  ];
}

describe("GitHub integration availability and authentication", () => {
  it("serves explicit unavailable availability with a null connection, never a 404 or a demo", async () => {
    const { app } = await appFixture();
    const response = await app.inject({ method: "GET", url: GITHUB_INTEGRATION_PATH, headers: ownerHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      availability: { available: false, githubHost: "github.com", appId: null },
      connection: null,
    });
    expect(response.body).not.toContain("client");
  });

  it("keeps management routes mounted while the integration is unavailable", async () => {
    const { app } = await appFixture();
    const response = await app.inject({
      method: "POST",
      url: GITHUB_INTEGRATION_AUTHORIZATION_PATH,
      headers: ownerHeaders(),
      payload: { intent: "create" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("GITHUB_INTEGRATION_UNAVAILABLE");
  });

  it("rejects unauthenticated management reads and writes", async () => {
    const { app, api } = await appFixture({ withManagement: true });
    for (const request of [
      { method: "GET" as const, url: GITHUB_INTEGRATION_PATH },
      { method: "GET" as const, url: GITHUB_INTEGRATION_REPOSITORIES_PATH },
      {
        method: "POST" as const,
        url: GITHUB_INTEGRATION_AUTHORIZATION_PATH,
        payload: { intent: "create" },
      },
      {
        method: "PUT" as const,
        url: GITHUB_INTEGRATION_BINDINGS_PATH,
        payload: { expectedAuthorizationVersion: "1", bindings: [] },
      },
      { method: "POST" as const, url: GITHUB_INTEGRATION_DISCONNECT_PATH },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
    }
    expect(api.exchangeCodeForUserToken).not.toHaveBeenCalled();
  });
});

describe("GitHub integration browser mutation security", () => {
  it("requires the double-submit CSRF token for a browser authorization start", async () => {
    const owner = await createAccount(unit, "browser-owner@example.com");
    const api = stubGitHubApi();
    const app = createApp({
      authService: authService({ owner, other: owner }),
      betterAuth: signedInBrowser(owner.id),
      browserAuth: { publicOrigin: PUBLIC_ORIGIN, secureCookies: true, sessionTtlSeconds: 3_600 },
      githubIntegrations: {
        availability: { available: true, githubHost: "github.com", appId: GITHUB_TEST_APP_ID },
        publicOrigin: PUBLIC_ORIGIN,
        secureCookies: true,
        management: buildManagement(api),
      },
    });
    apps.push(app);

    const rejected = await app.inject({
      method: "POST",
      url: GITHUB_INTEGRATION_AUTHORIZATION_PATH,
      headers: { cookie: "opentag.session_token=session; opentag_csrf=csrf" },
      payload: { intent: "create" },
    });
    expect(rejected.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "POST",
      url: GITHUB_INTEGRATION_AUTHORIZATION_PATH,
      headers: {
        cookie: "opentag.session_token=session; opentag_csrf=csrf",
        origin: PUBLIC_ORIGIN,
        "x-opentag-csrf": "csrf",
      },
      payload: { intent: "create" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(new URL((accepted.json() as { authorizationUrl: string }).authorizationUrl).origin).toBe(
      "https://github.com",
    );
  });
});

describe("GitHub OAuth callback", () => {
  it("activates a connection once and rejects a replayed callback without leaking its inputs", async () => {
    const fixture = await appFixture({ withManagement: true });
    fixture.api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    fixture.api.getAuthenticatedUser.mockResolvedValue({ id: GITHUB_USER_ONE, login: "octocat" });
    const started = await startAuthorization(fixture.app);
    expect(started.authorizationUrl).toContain("code_challenge_method=S256");

    const first = await completeCallback(fixture.app, {
      state: started.state,
      cookie: started.cookie,
      code: "secret-code",
    });
    const firstLocation = locationOf(first);
    expect(firstLocation.pathname).toBe("/account");
    expect(firstLocation.searchParams.get("github_oauth")).toBe("success");
    expect(firstLocation.toString()).not.toContain("secret-code");
    expect(firstLocation.toString()).not.toContain(started.state);
    expect(first.body).not.toContain("secret-code");

    const replay = await completeCallback(fixture.app, {
      state: started.state,
      cookie: started.cookie,
      code: "secret-code",
    });
    expect(locationOf(replay).searchParams.get("github_oauth")).toBe("error");
    expect(locationOf(replay).toString()).not.toContain("secret-code");
    expect(fixture.api.exchangeCodeForUserToken).toHaveBeenCalledTimes(1);

    const [row] = await unit.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.accountId, fixture.owner.id));
    expect(row?.status).toBe("active");
    expect(row?.githubUserId).toBe(GITHUB_USER_ONE);
    expect(row?.credentialCiphertext).toBeTruthy();
  });

  it("maps a GitHub denial to a fixed surface without exchanging a code", async () => {
    const fixture = await appFixture({ withManagement: true });
    const started = await startAuthorization(fixture.app, {
      intent: "create",
      returnSurface: "agent-integrations",
      agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
    });
    const denied = await completeCallback(fixture.app, {
      state: started.state,
      cookie: started.cookie,
      error: "access_denied",
    });
    const location = locationOf(denied);
    expect(location.pathname).toBe("/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/integrations");
    expect(location.searchParams.get("github_oauth")).toBe("error");
    expect(location.searchParams.get("github_oauth_error")).toBe("GITHUB_OAUTH_DENIED");
    expect(fixture.api.exchangeCodeForUserToken).not.toHaveBeenCalled();
  });

  it("refuses a callback claimed by another authenticated Account", async () => {
    const fixture = await appFixture({ withManagement: true });
    fixture.api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    fixture.api.getAuthenticatedUser.mockResolvedValue({ id: GITHUB_USER_ONE, login: "octocat" });
    const started = await startAuthorization(fixture.app);
    const response = await completeCallback(fixture.app, {
      state: started.state,
      cookie: started.cookie,
      token: OTHER_TOKEN,
      code: "secret-code",
    });
    const location = locationOf(response);
    expect(location.searchParams.get("github_oauth")).toBe("error");
    expect(fixture.api.exchangeCodeForUserToken).not.toHaveBeenCalled();
    const rows = await unit.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.accountId, fixture.owner.id));
    expect(rows[0]?.status).toBe("pending");
  });

  it("redirects an unauthenticated callback to a fixed surface and never completes it", async () => {
    const fixture = await appFixture({ withManagement: true });
    fixture.api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    const started = await startAuthorization(fixture.app);
    const response = await fixture.app.inject({
      method: "GET",
      url: `${GITHUB_OAUTH_CALLBACK_PATH}?code=secret-code&state=${encodeURIComponent(started.state)}`,
      headers: { cookie: started.cookie },
    });
    const location = locationOf(response);
    expect(location.searchParams.get("github_oauth_error")).toBe("GITHUB_OAUTH_AUTHENTICATION_REQUIRED");
    expect(fixture.api.exchangeCodeForUserToken).not.toHaveBeenCalled();
  });
});

describe("GitHub repository discovery and bindings", () => {
  it("paginates installations and repositories with an opaque cursor", async () => {
    const fixture = await appFixture({ withManagement: true });
    await activeConnection(fixture);
    fixture.api.listUserInstallations.mockResolvedValue(
      installationsPage([
        installation({ installationId: "111" }),
        installation({ installationId: "222", accountLogin: "second-org" }),
      ]),
    );
    fixture.api.listInstallationRepositories.mockResolvedValue(
      repositoriesPage([repository({ repositoryId: "900", fullName: "octocat/hello-world" })], 250),
    );

    const first = await fixture.app.inject({
      method: "GET",
      url: GITHUB_INTEGRATION_REPOSITORIES_PATH,
      headers: ownerHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json() as { installations: unknown[]; repositories: unknown[]; nextCursor: string | null };
    expect(firstPage.installations).toHaveLength(2);
    expect(firstPage.repositories).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(first.body).not.toContain("ghu_");

    fixture.api.listInstallationRepositories.mockResolvedValue(
      repositoriesPage([repository({ repositoryId: "901", fullName: "second-org/tool" })], 250),
    );
    const second = await fixture.app.inject({
      method: "GET",
      url: `${GITHUB_INTEGRATION_REPOSITORIES_PATH}?cursor=${encodeURIComponent(firstPage.nextCursor as string)}`,
      headers: ownerHeaders(),
    });
    expect(second.statusCode).toBe(200);
    const secondPage = second.json() as { repositories: { repositoryId: string }[] };
    expect(secondPage.repositories.map((entry) => entry.repositoryId)).toEqual(["901"]);
  });

  it("rejects an installation that belongs to a different App instead of trusting discovery", async () => {
    const fixture = await appFixture({ withManagement: true });
    await activeConnection(fixture);
    fixture.api.listUserInstallations.mockResolvedValue(installationsPage([installation({ appId: "999999" })]));
    const response = await fixture.app.inject({
      method: "GET",
      url: GITHUB_INTEGRATION_REPOSITORIES_PATH,
      headers: ownerHeaders(),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("GITHUB_APP_IDENTITY_MISMATCH");
  });

  it("mints admission from live GitHub state and persists explicit task delegation", async () => {
    const fixture = await appFixture({ withManagement: true });
    const connection = await activeConnection(fixture);
    const agent = await createAgent(fixture.owner.id);
    const delegatedAgent = await createAgent(fixture.owner.id, "collaborator");
    fixture.api.listUserInstallations.mockResolvedValue(installationsPage([installation()]));
    fixture.api.listInstallationRepositories.mockResolvedValue(repositoriesPage([repository()]));

    const body = {
      expectedAuthorizationVersion: connection.authorizationVersion.toString(),
      bindings: bindingDocument(agent.id, {
        agentScopes: [
          {
            agentId: agent.id,
            role: "code",
            access: "write",
            publish: "pull_request",
            taskDelegation: {
              imSenders: [{ bindingId: randomUUID(), senderId: "ou_delegated" }],
              sessionAgents: [delegatedAgent.id],
            },
          },
        ],
      }),
    };
    const response = await fixture.app.inject({
      method: "PUT",
      url: GITHUB_INTEGRATION_BINDINGS_PATH,
      headers: ownerHeaders(),
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    const status = response.json() as GitHubConnectionStatus;
    expect(status.bindings).toHaveLength(1);
    expect(status.bindings[0]?.agentScopes[0]?.taskDelegation).toEqual(
      body.bindings[0]?.agentScopes[0]?.taskDelegation,
    );
    expect(status.authorizationVersion).not.toBe(body.expectedAuthorizationVersion);

    const stale = await fixture.app.inject({
      method: "PUT",
      url: GITHUB_INTEGRATION_BINDINGS_PATH,
      headers: ownerHeaders(),
      payload: body,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("GITHUB_AUTHORIZATION_VERSION_CONFLICT");

    // The Server-internal runtime interface exposes the exact Agent scopes and fencing versions
    // the proxy needs, including the owner's delegation, without any HTTP token export.
    const runtime = await fixture.management?.getAgentBindings(connection.id, agent.id);
    expect(runtime).not.toBeNull();
    expect(runtime?.repositories).toHaveLength(1);
    expect(runtime?.repositories[0]?.scopes[0]?.taskDelegation?.imSenders).toHaveLength(1);
    expect(runtime?.repositories[0]?.repositoryId).toBe("987654321");
    const otherAgentBindings = await fixture.management?.getAgentBindings(connection.id, delegatedAgent.id);
    expect(otherAgentBindings?.repositories).toEqual([]);
    expect(otherAgentBindings?.connectionId).toBe(connection.id);
  });

  it("rejects a forged installation, a foreign Agent, and a foreign connection", async () => {
    const fixture = await appFixture({ withManagement: true });
    const connection = await activeConnection(fixture);
    const agent = await createAgent(fixture.owner.id);
    fixture.api.listUserInstallations.mockResolvedValue(installationsPage([installation()]));
    fixture.api.listInstallationRepositories.mockResolvedValue(repositoriesPage([repository()]));

    const forged = await fixture.app.inject({
      method: "PUT",
      url: GITHUB_INTEGRATION_BINDINGS_PATH,
      headers: ownerHeaders(),
      payload: {
        expectedAuthorizationVersion: connection.authorizationVersion.toString(),
        bindings: bindingDocument(agent.id, { installationId: "999999" }),
      },
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.json().error.code).toBe("GITHUB_ADMISSION_INSTALLATION_MISSING");

    const foreignAgent = await createAgent(fixture.other.id, "foreign");
    const foreign = await fixture.app.inject({
      method: "PUT",
      url: GITHUB_INTEGRATION_BINDINGS_PATH,
      headers: ownerHeaders(),
      payload: {
        expectedAuthorizationVersion: connection.authorizationVersion.toString(),
        bindings: bindingDocument(foreignAgent.id),
      },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("GITHUB_AGENT_OWNERSHIP_INVALID");

    const otherConnection = await fixture.app.inject({
      method: "POST",
      url: GITHUB_INTEGRATION_DISCONNECT_PATH,
      headers: ownerHeaders(OTHER_TOKEN),
    });
    expect(otherConnection.statusCode).toBe(204);
    const ownerStillThere = await unit.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, connection.id));
    expect(ownerStillThere[0]?.status).toBe("active");
  });
});

describe("GitHub connection lifecycle", () => {
  it("replaces a connection explicitly, clearing the superseded row and its bindings", async () => {
    const fixture = await appFixture({ withManagement: true });
    const original = await activeConnection(fixture);
    const agent = await createAgent(fixture.owner.id);
    fixture.api.listUserInstallations.mockResolvedValue(installationsPage([installation()]));
    fixture.api.listInstallationRepositories.mockResolvedValue(repositoriesPage([repository()]));
    await fixture.app.inject({
      method: "PUT",
      url: GITHUB_INTEGRATION_BINDINGS_PATH,
      headers: ownerHeaders(),
      payload: {
        expectedAuthorizationVersion: original.authorizationVersion.toString(),
        bindings: bindingDocument(agent.id),
      },
    });

    fixture.api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    fixture.api.getAuthenticatedUser.mockResolvedValue({ id: GITHUB_USER_TWO, login: "different-user" });
    const started = await startAuthorization(fixture.app, { intent: "replace" });
    const callback = await completeCallback(fixture.app, {
      state: started.state,
      cookie: started.cookie,
      code: "replace-code",
    });
    expect(locationOf(callback).searchParams.get("github_oauth")).toBe("success");

    const [superseded] = await unit.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, original.id));
    expect(superseded?.status).toBe("superseded");
    expect(superseded?.credentialCiphertext).toBeNull();
    expect(superseded?.refreshExpiresAt).toBeNull();
    expect(superseded?.oauthStateHash).toBeNull();

    const [replacement] = await unit.database
      .select()
      .from(githubConnections)
      .where(and(eq(githubConnections.accountId, fixture.owner.id), eq(githubConnections.status, "active")));
    expect(replacement?.id).not.toBe(original.id);
    expect(replacement?.githubUserId).toBe(GITHUB_USER_TWO);
    expect(replacement?.repositoryBindings).toEqual([]);

    const overview = await fixture.app.inject({
      method: "GET",
      url: GITHUB_INTEGRATION_PATH,
      headers: ownerHeaders(),
    });
    const status = (overview.json() as { connection: GitHubConnectionStatus }).connection;
    expect(status.githubUserId).toBe(GITHUB_USER_TWO);
    expect(status.bindings).toEqual([]);
  });

  it("requires an explicit replace flow when reauthorization returns another GitHub user", async () => {
    const fixture = await appFixture({ withManagement: true });
    await activeConnection(fixture);
    fixture.api.exchangeCodeForUserToken.mockResolvedValue(tokenMaterial());
    fixture.api.getAuthenticatedUser.mockResolvedValue({ id: GITHUB_USER_TWO, login: "different-user" });
    const started = await startAuthorization(fixture.app, { intent: "reauthorize" });
    const callback = await completeCallback(fixture.app, {
      state: started.state,
      cookie: started.cookie,
      code: "reauth-code",
    });
    expect(locationOf(callback).searchParams.get("github_oauth")).toBe("error");
    expect(locationOf(callback).searchParams.get("github_oauth_error")).toBe("GITHUB_IDENTITY_MISMATCH");
    const rows = await unit.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.accountId, fixture.owner.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.githubUserId).toBe(GITHUB_USER_ONE);
  });

  it("disconnects idempotently and reports no connection afterward", async () => {
    const fixture = await appFixture({ withManagement: true });
    await activeConnection(fixture);
    const first = await fixture.app.inject({
      method: "POST",
      url: GITHUB_INTEGRATION_DISCONNECT_PATH,
      headers: ownerHeaders(),
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as GitHubConnectionStatus).status).toBe("revoked");
    const second = await fixture.app.inject({
      method: "POST",
      url: GITHUB_INTEGRATION_DISCONNECT_PATH,
      headers: ownerHeaders(),
    });
    expect(second.statusCode).toBe(204);
  });
});

describe("GitHub webhook ingress", () => {
  it("verifies the raw-body HMAC and marks an authoritative recheck without restoring access", async () => {
    const fixture = await appFixture({ withManagement: true, withWebhook: true });
    const connection = await activeConnection(fixture);
    // The webhook resolves affected connections through their bindings, so install one first.
    await unit.database
      .update(githubConnections)
      .set({ repositoryBindings: bindingDocument("1a63a21e-f6c7-4474-91ea-4dabf0566a24") })
      .where(eq(githubConnections.id, connection.id));
    const payload = Buffer.from(JSON.stringify({ action: "deleted", installation: { id: 55123456 } }), "utf8");
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(payload).digest("hex")}`;

    const forged = await fixture.app.inject({
      method: "POST",
      url: GITHUB_WEBHOOK_PATH,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
        "x-github-event": "installation",
      },
      payload,
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().status).toBe("rejected");

    const accepted = await fixture.app.inject({
      method: "POST",
      url: GITHUB_WEBHOOK_PATH,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-event": "installation",
        "x-github-delivery": "delivery-1",
      },
      payload,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "processed", recheckMarkedConnections: 1 });

    // The event only requested a recheck; the credential and status are untouched until the worker
    // authoritatively decides.
    const [row] = await unit.database.select().from(githubConnections).where(eq(githubConnections.id, connection.id));
    expect(row?.status).toBe("active");
    expect(row?.credentialCiphertext).toBe(connection.credentialCiphertext);
    expect(row?.recheckRequired).toBe(true);
  });

  it("invalidates fail-closed on a provider-attested authorization revocation", async () => {
    const fixture = await appFixture({ withManagement: true, withWebhook: true });
    const connection = await activeConnection(fixture);
    const payload = Buffer.from(JSON.stringify({ action: "revoked", sender: { id: Number(GITHUB_USER_ONE) } }), "utf8");
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(payload).digest("hex")}`;
    const response = await fixture.app.inject({
      method: "POST",
      url: GITHUB_WEBHOOK_PATH,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-event": "github_app_authorization",
        "x-github-delivery": "delivery-2",
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "processed", invalidatedConnections: 1 });
    const [row] = await unit.database.select().from(githubConnections).where(eq(githubConnections.id, connection.id));
    expect(row?.status).toBe("reauthorization_required");
    expect(row?.credentialCiphertext).toBeNull();
    expect(row?.authorizationVersion).toBe(connection.authorizationVersion + 1n);
  });
});
