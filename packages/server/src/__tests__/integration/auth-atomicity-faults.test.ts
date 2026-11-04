import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { RouteRateLimiter, registerBrowserAuthRoutes } from "../../api/browser-auth.js";
import { RequestValidationError } from "../../api/request-validation.js";
import { createBetterAuth } from "../../auth/better-auth.js";
import { BetterAuthSessionTokens } from "../../auth/session-tokens.js";
import { createDatabaseClient } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { AccountSetupService } from "../../services/setup/account-setup-service.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const ORIGIN = "http://localhost:8000",
  PASSWORD = "Fixture-only-password-123";
let pg: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let admin: ReturnType<typeof createDatabaseClient>;
const closes: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
  client = createDatabaseClient(pg.databaseUrl, { max: 1, statementTimeoutMs: 250, queryTimeoutMs: 2000 });
  admin = createDatabaseClient(pg.databaseUrl, { max: 2 });
}, 120000);
beforeEach(async () => pg.reset());
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
afterAll(async () => {
  await Promise.all([client?.sql.end(), admin?.sql.end()]);
  await pg?.stop();
});
function authFor(database = client.database) {
  return createBetterAuth(database, {
    publicUrl: ORIGIN,
    secret: "fixture-only-audit-auth-secret-at-least-32-characters",
    secureCookies: false,
    sessionTtlSeconds: 3600,
    emailPassword: true,
    google: { clientId: "fixture", clientSecret: "fixture" },
  });
}
function appFor(auth = authFor()) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RequestValidationError) return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
    const status =
      error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
    return reply.code(status).send({ error: { code } });
  });
  registerBrowserAuthRoutes(app, {
    betterAuth: { instance: auth, publicUrl: ORIGIN },
    publicOrigin: ORIGIN,
    secureCookies: false,
    sessionTtlSeconds: 3600,
    passwordSignIn: true,
    googleSignIn: true,
    rateLimiter: new RouteRateLimiter(100),
  });
  closes.push(() => app.close());
  return app;
}
const address = () => `atomic-${randomUUID()}@example.test`;
function signup(app: ReturnType<typeof appFor>, email: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/email/sign-up",
    headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD, displayName: "Fixture", ...extra },
  });
}
function signin(app: ReturnType<typeof appFor>, email: string, password = PASSWORD) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/email/sign-in",
    headers: { origin: ORIGIN },
    payload: { email, password },
  });
}
async function counts() {
  const [row] =
    await admin.sql`select (select count(*)::int from users) as users, (select count(*)::int from auth_identities) as identities, (select count(*)::int from auth_sessions) as sessions`;
  return row;
}
async function lock(table: "users" | "auth_identities" | "auth_sessions" | "auth_verifications") {
  const entered = deferred(),
    release = deferred();
  const task = admin.sql.begin(async (tx) => {
    await tx.unsafe(`lock table ${table} in access exclusive mode`);
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return async () => {
    release.resolve();
    await task;
  };
}

it.each(["users", "auth_identities", "auth_sessions"] as const)(
  "rolls back signup at %s failure, publishes no cookies, and retries on max=1",
  async (table) => {
    const auth = authFor(),
      app = appFor(auth),
      email = address(),
      unlock = await lock(table);
    try {
      const response = await signup(app, email);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      await unlock();
    }
    expect(await counts()).toMatchObject({ users: 0, identities: 0, sessions: 0 });
    const succeeded = await signup(app, email);
    expect(succeeded.statusCode).toBe(204);
    expect(succeeded.headers["set-cookie"]).toBeDefined();
    expect(await counts()).toMatchObject({ users: 1, identities: 1, sessions: 1 });
    expect(
      (
        await admin.sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'`
      )[0]?.n,
    ).toBe(0);
  },
);

it("does not publish signup cookies when the actual COMMIT fails", async () => {
  await admin.sql.unsafe(
    "create function auth_commit_fault() returns trigger language plpgsql as $$ begin raise exception 'controlled commit failure' using errcode = '40001'; return new; end $$",
  );
  await admin.sql.unsafe(
    "create constraint trigger auth_commit_fault after insert on auth_sessions deferrable initially deferred for each row execute function auth_commit_fault()",
  );
  const app = appFor(),
    email = address();
  try {
    const response = await signup(app, email);
    expect(response.statusCode).toBe(503);
    expect(response.headers["set-cookie"]).toBeUndefined();
  } finally {
    await admin.sql.unsafe("drop trigger auth_commit_fault on auth_sessions");
    await admin.sql.unsafe("drop function auth_commit_fault()");
  }
  expect(await counts()).toMatchObject({ users: 0, identities: 0, sessions: 0 });
  expect((await signup(app, email)).statusCode).toBe(204);
});

it("classifies a native slow user INSERT as unavailable, preserving normal duplicate and credential decisions", async () => {
  await admin.sql.unsafe(
    "create function auth_slow_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(2); return new; end $$",
  );
  await admin.sql.unsafe(
    "create trigger auth_slow_insert before insert on users for each row execute function auth_slow_insert()",
  );
  const app = appFor(),
    email = address();
  try {
    const response = await signup(app, email);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(response.headers["set-cookie"]).toBeUndefined();
  } finally {
    await admin.sql.unsafe("drop trigger auth_slow_insert on users");
    await admin.sql.unsafe("drop function auth_slow_insert()");
  }
  expect(await counts()).toMatchObject({ users: 0, identities: 0, sessions: 0 });
  expect((await signup(app, email)).statusCode).toBe(204);
  expect((await signup(app, email)).statusCode).toBe(409);
  expect((await signin(app, email, "wrong-password")).statusCode).toBe(401);
});

it("returns the actual suspension decision only after a correct password", async () => {
  const app = appFor(),
    email = address();
  expect((await signup(app, email)).statusCode).toBe(204);
  await client.database.update(users).set({ suspendedAt: new Date() }).where(eq(users.email, email));
  const denied = await signin(app, email);
  expect(denied.statusCode).toBe(403);
  expect(denied.json()).toMatchObject({ error: { code: "AUTH_USER_SUSPENDED" } });
  expect(denied.headers["set-cookie"]).toBeUndefined();
  expect((await signin(app, email, "wrong-password")).statusCode).toBe(401);
  expect((await counts())?.sessions).toBe(1);
  await client.database.update(users).set({ suspendedAt: null }).where(eq(users.email, email));
  expect((await signin(app, email)).statusCode).toBe(204);
});

it("keeps Google configuration separate from a native state-write failure", async () => {
  const app = appFor(),
    unlock = await lock("auth_verifications");
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(response.headers["set-cookie"]).toBeUndefined();
  } finally {
    await unlock();
  }
  expect((await app.inject({ method: "GET", url: "/api/v1/auth/google/start" })).statusCode).toBe(302);
});

it("permits one concurrent same-email creation and no stranded loser", async () => {
  const other = createDatabaseClient(pg.databaseUrl, { max: 1, statementTimeoutMs: 2000 });
  closes.push(() => other.sql.end());
  const first = appFor(),
    second = appFor(authFor(other.database)),
    email = address();
  const responses = await Promise.all([signup(first, email), signup(second, email)]);
  expect(responses.filter((response) => response.statusCode === 204)).toHaveLength(1);
  const failed = responses.find((response) => response.statusCode !== 204);
  assert(failed);
  expect([409, 503]).toContain(failed.statusCode);
  expect(failed.headers["set-cookie"]).toBeUndefined();
  expect(await counts()).toMatchObject({ users: 1, identities: 1, sessions: 1 });
  expect((await signup(first, email)).statusCode).toBe(409);
});

it("keeps suspension internal and uses the same Account gate for server token issuance", async () => {
  const auth = authFor(),
    app = appFor(auth),
    email = address();
  expect((await signup(app, email, { suspendedAt: null })).statusCode).toBe(400);
  const forbidden = await auth.handler(
    new Request(`${ORIGIN}/api/v1/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD, name: "Fixture", suspendedAt: new Date().toISOString() }),
    }),
  );
  expect(forbidden.status).toBe(400);
  expect(forbidden.headers.getSetCookie()).toEqual([]);
  expect((await counts())?.users).toBe(0);
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/v1/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD, name: "Fixture" }),
    }),
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { user: Record<string, unknown> };
  expect(payload.user).not.toHaveProperty("suspendedAt");
  const [user] = await client.database.select().from(users);
  assert(user);
  expect(user.suspendedAt).toBeNull();
  const context = await auth.$context;
  expect(await context.internalAdapter.findUserById(user.id)).toHaveProperty("suspendedAt", null);
  const tokens = new BetterAuthSessionTokens(auth, client.database);
  await expect(tokens.issuePairForUser(user.id)).resolves.toBeDefined();
  await client.database.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, user.id));
  await expect(tokens.issuePairForUser(user.id)).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
});

it("rolls back a first Google user and identity together and can restart the sign-in", async () => {
  const auth = authFor(),
    context = await auth.$context;
  await admin.sql.unsafe(
    "create function auth_slow_link() returns trigger language plpgsql as $$ begin perform pg_sleep(2); return new; end $$",
  );
  await admin.sql.unsafe(
    "create trigger auth_slow_link before insert on auth_identities for each row execute function auth_slow_link()",
  );
  const input: Parameters<typeof handleOAuthUserInfo>[1] = {
    account: {
      accountId: "fixture-google-subject",
      issuer: "https://accounts.google.com",
      providerId: "google",
      scope: null,
      idToken: null,
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      password: null,
    },
    userInfo: { id: "fixture-google-subject", email: address(), emailVerified: true, name: "Fixture", image: null },
  };
  try {
    const result = await handleOAuthUserInfo({ context } as Parameters<typeof handleOAuthUserInfo>[0], input);
    expect(result.error).toBeTruthy();
  } finally {
    await admin.sql.unsafe("drop trigger auth_slow_link on auth_identities");
    await admin.sql.unsafe("drop function auth_slow_link()");
  }
  expect(await counts()).toMatchObject({ users: 0, identities: 0, sessions: 0 });
  const result = await handleOAuthUserInfo({ context } as Parameters<typeof handleOAuthUserInfo>[0], input);
  expect(result.error).toBeFalsy();
  expect(await counts()).toMatchObject({ users: 1, identities: 1, sessions: 1 });
});

it("validates setup only under the Account lock and preserves idempotent concurrent completion", async () => {
  const userId = randomUUID();
  await client.database.insert(users).values({ id: userId, email: address(), displayName: "Fixture" });
  const agent = await new AgentService(client.database).createForAccount(userId, {
    name: "setup",
    displayName: "Setup",
    runtimeProvider: "codex",
  });
  const setup = new AccountSetupService(client.database);
  const previous = client.sql.options.debug;
  let reads = 0;
  client.sql.options.debug = (_id, query) => {
    if (query.startsWith("select") && query.includes('from "agents"')) reads += 1;
  };
  try {
    const completed = await setup.completeForAccount(userId, agent.id);
    expect(reads).toBe(1);
    expect(await setup.completeForAccount(userId, randomUUID())).toEqual(completed);
    expect(reads).toBe(1);
  } finally {
    client.sql.options.debug = previous;
  }
  await client.database.update(users).set({ setupCompletedAt: null }).where(eq(users.id, userId));
  const other = createDatabaseClient(pg.databaseUrl, { max: 1 });
  closes.push(() => other.sql.end());
  const [a, b] = await Promise.all([
    setup.completeForAccount(userId, agent.id),
    new AccountSetupService(other.database).completeForAccount(userId, agent.id),
  ]);
  expect(a).toEqual(b);
});
