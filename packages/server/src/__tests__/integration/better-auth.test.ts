import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createBetterAuth } from "../../auth/better-auth.js";
import { BetterAuthSessionTokens, BridgedSessionTokens } from "../../auth/session-tokens.js";
import { createDatabaseClient } from "../../db/client.js";
import { authIdentities, authSessions, users, workspaceAdminGrants } from "../../db/schema/index.js";
import { resolveAuthenticatedUserId } from "../../plugins/user-auth.js";
import {
  AuthService,
  AuthTokenService,
  DevBrowserAuthService,
  PostAuthenticationService,
} from "../../services/auth/index.js";
import { WorkspaceAdminAccess } from "../../services/workspace-admin-access/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const GOOGLE_ISSUER = "https://accounts.google.com";
const PUBLIC_URL = "http://localhost:8000";
const LEGACY_SECRET = "legacy-jwt-secret-of-at-least-32-characters";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/** The composition the server runs: Better Auth issues, and credentials it did not issue still verify. */
function bridgedAuthService(auth: ReturnType<typeof createAuth>): AuthService {
  return new AuthService(
    client.database,
    new BridgedSessionTokens(new BetterAuthSessionTokens(auth), new AuthTokenService(LEGACY_SECRET, 900, 3600)),
  );
}

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let postAuthentication: PostAuthenticationService;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
  postAuthentication = new PostAuthenticationService(client.database, new WorkspaceAdminAccess(client.database));
}, 120_000);

afterAll(async () => {
  await client.sql.end();
  await testDatabase.stop();
});

beforeEach(async () => {
  await testDatabase.reset();
});

function createAuth(
  devSignIn?: () => Promise<string>,
  legacyUpgrade?: (refreshToken: string) => Promise<{ expiresAt: Date; userId: string }>,
) {
  return createBetterAuth(client.database, {
    onSessionCreating: (userId) => postAuthentication.ensureAccountReady(userId).then(() => undefined),
    publicUrl: PUBLIC_URL,
    secret: "better-auth-integration-secret-at-least-32-characters",
    secureCookies: false,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    ...(devSignIn ? { devSignIn } : {}),
    ...(legacyUpgrade ? { legacyUpgrade: { resolveCredential: legacyUpgrade, serialize: serializeExchange } } : {}),
    google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
  });
}

/** The lock the composition root supplies, so a raced exchange is serialized here exactly as it is in production. */
function serializeExchange<T>(key: string, run: () => Promise<T>): Promise<T> {
  return client.database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return run();
  });
}

/** Replays a response's cookies the way a browser would send them back. */
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

/** Writes the exact row shape the pre-migration identity resolver produced. */
async function seedLegacyAccount(subject: string, email: string, displayName: string): Promise<string> {
  const [user] = await client.database.insert(users).values({ email, displayName }).returning({ id: users.id });
  if (!user) throw new Error("User insert did not return a row");
  await client.database.insert(authIdentities).values({
    userId: user.id,
    provider: "google",
    issuer: GOOGLE_ISSUER,
    subject,
    email,
  });
  return user.id;
}

describe("Better Auth over the existing Account tables", () => {
  it("resolves an Account seeded by the pre-migration identity resolver", async () => {
    const subject = "google-subject-legacy";
    const userId = await seedLegacyAccount(subject, "legacy@example.com", "Legacy Account");
    const auth = createAuth();
    const context = await auth.$context;

    const account = await context.internalAdapter.findAccountByKey({ accountId: subject, issuer: GOOGLE_ISSUER });

    // The pre-migration triple is byte-for-byte what Better Auth's Google provider writes, so the existing row is
    // found rather than a second Account being created for the same person.
    expect(account).toMatchObject({ accountId: subject, providerId: "google", issuer: GOOGLE_ISSUER, userId });
    expect(await client.database.select().from(users)).toHaveLength(1);
  });

  it("reads the Account through the mapped user model", async () => {
    const userId = await seedLegacyAccount("google-subject-profile", "profile@example.com", "Profile Account");
    const auth = createAuth();
    const context = await auth.$context;

    const user = await context.internalAdapter.findUserById(userId);

    // `name` is the `display_name` column; `emailVerified` and `image` are the columns migration 0018 added.
    expect(user).toMatchObject({
      email: "profile@example.com",
      id: userId,
      name: "Profile Account",
    });
  });

  it("issues a session into auth_sessions and reads it back from a bearer token", async () => {
    const userId = await seedLegacyAccount("google-subject-session", "session@example.com", "Session Account");
    const auth = createAuth();
    const context = await auth.$context;

    const session = await context.internalAdapter.createSession(userId);
    expect(session.token).toBeTruthy();

    const persisted = await client.database.select().from(authSessions).where(eq(authSessions.userId, userId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.token).toBe(session.token);

    const resolved = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${session.token}` }),
    });

    expect(resolved?.user).toMatchObject({ email: "session@example.com", id: userId, name: "Session Account" });
    expect(resolved?.session.token).toBe(session.token);
  });

  it("rejects an unknown bearer token", async () => {
    const auth = createAuth();

    const resolved = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${randomUUID()}` }),
    });

    expect(resolved).toBeNull();
  });

  it("refuses to issue a session for a suspended Account", async () => {
    const userId = await seedLegacyAccount("google-subject-suspended", "suspended@example.com", "Suspended Account");
    await client.database.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, userId));
    const auth = createAuth();
    const context = await auth.$context;

    // The hook aborts the sign-in, so no token ever exists to authenticate with.
    await expect(context.internalAdapter.createSession(userId)).rejects.toMatchObject({
      code: "AUTH_USER_SUSPENDED",
      statusCode: 403,
    });
    expect(await client.database.select().from(authSessions).where(eq(authSessions.userId, userId))).toHaveLength(0);
  });

  it("provisions a never-granted Account before its first session exists", async () => {
    /*
     * Better Auth owns account creation on its own sign-in paths, so first-time provisioning happens at session
     * issuance rather than in the legacy resolver. This is about an Account that has never been provisioned; the
     * revocation case below is what shows the rule is "never granted", not "no active grant".
     */
    const userId = await seedLegacyAccount("google-subject-grant", "grant@example.com", "Grant Account");
    expect(await client.database.select().from(workspaceAdminGrants)).toHaveLength(0);
    const auth = createAuth();
    const context = await auth.$context;

    const session = await context.internalAdapter.createSession(userId);

    expect(session.token).toBeTruthy();
    const grants = await client.database
      .select()
      .from(workspaceAdminGrants)
      .where(and(eq(workspaceAdminGrants.userId, userId), isNull(workspaceAdminGrants.revokedAt)));
    expect(grants).toHaveLength(1);

    // Idempotent: a returning Account keeps the one grant it already had.
    await context.internalAdapter.createSession(userId);
    expect(await client.database.select().from(workspaceAdminGrants)).toHaveLength(1);
  });

  it("does not restore a Workspace grant that was revoked", async () => {
    /*
     * "Has no active grant" is not the same as "is new". Provisioning on that basis would hand a revoked Account a
     * fresh Workspace and Admin grant on its next sign-in, undoing the revocation. Only an Account with no grant in
     * its history is new.
     */
    const userId = await seedLegacyAccount("google-subject-revoked", "revoked@example.com", "Revoked Account");
    const auth = createAuth();
    const context = await auth.$context;
    await context.internalAdapter.createSession(userId);
    const [granted] = await client.database
      .select({ id: workspaceAdminGrants.id })
      .from(workspaceAdminGrants)
      .where(eq(workspaceAdminGrants.userId, userId));
    if (!granted) throw new Error("The Account was not provisioned");

    await client.database
      .update(workspaceAdminGrants)
      .set({ revokedAt: new Date(), revokedByUserId: userId })
      .where(eq(workspaceAdminGrants.id, granted.id));

    await context.internalAdapter.createSession(userId);

    const grants = await client.database
      .select()
      .from(workspaceAdminGrants)
      .where(eq(workspaceAdminGrants.userId, userId));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.revokedAt).not.toBeNull();
  });

  it("refuses a session's identity once the Account is suspended", async () => {
    /*
     * Routes that authenticate outside the preHandler — the Slack callback is one — must get the same answer it
     * would give. Trusting the id on the session would let an Account suspended after issuance pass an identity check
     * and reach the side effects behind it before any later authority check ran.
     */
    const userId = await seedLegacyAccount("google-subject-live", "live@example.com", "Live Account");
    const auth = createAuth();
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession(userId);
    const request = { headers: { cookie: "", authorization: `Bearer ${session.token}` } } as unknown as FastifyRequest;
    const authService = new AuthService(client.database, {
      issuePairForUser: async () => ({ accessToken: "", refreshToken: "", expiresIn: 0 }),
      rotate: async () => ({ accessToken: "", refreshToken: "", expiresIn: 0 }),
      verifyAccess: async () => ({ expiresAt: new Date(), userId }),
      verifyRefresh: async () => ({ expiresAt: new Date(), userId }),
    });

    expect(await resolveAuthenticatedUserId(request, authService, { betterAuth: auth })).toBe(userId);

    await client.database.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, userId));

    await expect(resolveAuthenticatedUserId(request, authService, { betterAuth: auth })).rejects.toMatchObject({
      code: "AUTH_USER_SUSPENDED",
      statusCode: 403,
    });
  });

  it("hands the CLI a revocable session through the connect-code contract it already speaks", async () => {
    /*
     * The response keeps its four fields, so a CLI built before the cutover stores and presents this unchanged. What
     * changed is what the token is: a row the server can revoke, rather than a signature it can only wait out.
     */
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Admin",
      email: "admin@example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    });
    const auth = createAuth();
    const authService = bridgedAuthService(auth);

    const exchanged = await authService.exchangeConnectCode(bootstrap.connectCode);

    expect(exchanged.tokenType).toBe("Bearer");
    expect(exchanged.expiresIn).toBeGreaterThan(0);
    // One credential, not a pair: a session is revocable, so there is nothing for a second token to protect against.
    expect(exchanged.refreshToken).toBe(exchanged.accessToken);

    const persisted = await client.database
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, bootstrap.userId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.token).toBe(exchanged.accessToken);

    // The same token authenticates as a bearer credential, which is how the CLI already sends it.
    const resolved = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${exchanged.accessToken}` }),
    });
    expect(resolved?.user.id).toBe(bootstrap.userId);

    // Revocation is immediate, which the stateless pair could never offer.
    await (await auth.$context).internalAdapter.deleteSession(exchanged.accessToken);
    await expect(authService.getAuthenticatedUser(exchanged.accessToken)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
  });

  it("gives a CLI credential the lifetime the refresh token used to carry", async () => {
    /*
     * One credential replaces a pair, so this lifetime has to carry what the refresh token's did: how long a CLI may
     * go unused and still be signed in. Better Auth's own default is seven days, which would have shortened that from
     * thirty without anyone choosing it, and left a CLI idle for longer unable to refresh at all.
     */
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Admin",
      email: "admin@example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    });
    const before = Date.now();

    const exchanged = await bridgedAuthService(createAuth()).exchangeConnectCode(bootstrap.connectCode);

    expect(exchanged.expiresIn).toBeGreaterThan(SESSION_TTL_SECONDS - 60);
    expect(exchanged.expiresIn).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
    const [session] = await client.database.select().from(authSessions);
    const lifetimeMs = (session?.expiresAt.getTime() ?? 0) - before;
    expect(lifetimeMs).toBeGreaterThan((SESSION_TTL_SECONDS - 60) * 1000);
    expect(lifetimeMs).toBeLessThanOrEqual((SESSION_TTL_SECONDS + 60) * 1000);
  });

  it("withdraws the CLI credential a refresh replaces, leaving one live session", async () => {
    /*
     * Access and refresh carry the same token, so a refresh replaces the only credential the CLI has. Issuing without
     * withdrawing would leave the presented one valid until its own expiry: revoking what the CLI currently holds
     * would not lock out a copy taken before its last refresh, and every refresh would leave another live row behind.
     */
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Admin",
      email: "admin@example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    });
    const authService = bridgedAuthService(createAuth());
    const initial = await authService.exchangeConnectCode(bootstrap.connectCode);

    const renewed = await authService.refresh(initial.refreshToken);

    expect(renewed.accessToken).not.toBe(initial.accessToken);
    const live = await client.database.select().from(authSessions).where(eq(authSessions.userId, bootstrap.userId));
    expect(live.map(({ token }) => token)).toEqual([renewed.accessToken]);
    // Started one at a time: building both promises up front leaves the second rejecting while nothing is awaiting it.
    for (const present of [
      () => authService.getAuthenticatedUser(initial.accessToken),
      () => authService.refresh(initial.refreshToken),
    ]) {
      await expect(present()).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    }
    await expect(authService.getAuthenticatedUser(renewed.accessToken)).resolves.toMatchObject({
      me: { user: { id: bootstrap.userId } },
    });
  });

  it("upgrades a credential the previous revision issued the first time it is refreshed", async () => {
    /*
     * A CLI that has not reached the server since the cutover still holds a signed pair. Verification falls back to the
     * legacy signature, and because issuance only ever produces a session, refreshing is what moves it across.
     */
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Admin",
      email: "admin@example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    });
    const auth = createAuth();
    const legacy = new AuthTokenService(LEGACY_SECRET, 900, 3600);
    const legacyPair = await legacy.issuePairForUser(bootstrap.userId);
    const authService = bridgedAuthService(auth);

    const refreshed = await authService.refresh(legacyPair.refreshToken);

    expect(refreshed.accessToken).not.toBe(legacyPair.accessToken);
    const persisted = await client.database
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, bootstrap.userId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.token).toBe(refreshed.accessToken);

    // The legacy access token still authenticates until it expires, so the rollout signs nobody out.
    await expect(authService.getAuthenticatedUser(legacyPair.accessToken)).resolves.toMatchObject({
      me: { user: { id: bootstrap.userId } },
    });
  });

  it("never persists provider credentials on the identity row", async () => {
    const userId = await seedLegacyAccount("google-subject-tokens", "tokens@example.com", "Token Account");
    const auth = createAuth();
    const context = await auth.$context;

    await context.internalAdapter.updateAccount(
      (await context.internalAdapter.findAccountByUserId(userId))[0]?.id ?? "",
      {
        accessToken: "google-access-token",
        refreshToken: "google-refresh-token",
        idToken: "google-id-token",
        accessTokenExpiresAt: new Date(),
        refreshTokenExpiresAt: new Date(),
      },
    );

    const [stored] = await client.database.select().from(authIdentities).where(eq(authIdentities.userId, userId));
    expect(stored).toMatchObject({
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
  });

  it("lowercases an email written through Better Auth", async () => {
    const auth = createAuth();
    const context = await auth.$context;

    const created = await context.internalAdapter.createUser(
      { email: "Mixed.Casing@Example.com", name: "Mixed Casing" },
      { method: "oauth", oauth: { providerId: "google", profile: { sub: "google-subject-casing" } } },
    );

    expect(created.email).toBe("mixed.casing@example.com");
    const [stored] = await client.database.select().from(users).where(eq(users.id, created.id));
    expect(stored?.email).toBe("mixed.casing@example.com");
  });

  it("signs the configured development Account in with a session that sign-out revokes", async () => {
    const configured = await seedLegacyAccount("google-subject-dev", "dev@example.com", "Dev Account");
    const other = await seedLegacyAccount("google-subject-other", "other@example.com", "Other Account");
    // Mixed casing on purpose: the resolver matches on the normalized address, as the configured value is unnormalized.
    const developer = new DevBrowserAuthService(client.database, "DEV@Example.com");
    const auth = createAuth(() => developer.resolveUserId());

    const signIn = await auth.handler(
      new Request(`${PUBLIC_URL}/api/v1/auth/dev/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The endpoint takes no input, so a caller naming another Account still gets the configured one.
        body: JSON.stringify({ userId: other }),
      }),
    );
    expect(signIn.status).toBe(200);

    const issued = await client.database.select().from(authSessions);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.userId).toBe(configured);

    /*
     * The credential has to be the one Better Auth itself understands. A session token written into OpenTag's own
     * cookie would still authenticate through the legacy fallback, so the sign-in would look correct — but `getSession`
     * would not see it, and sign-out would have nothing to revoke.
     */
    const cookie = cookieHeader(signIn);
    await expect(auth.api.getSession({ headers: new Headers({ cookie }) })).resolves.toMatchObject({
      user: { email: "dev@example.com", id: configured },
    });

    const signOut = await auth.handler(
      new Request(`${PUBLIC_URL}/api/v1/auth/sign-out`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(signOut.status).toBe(200);
    expect(await client.database.select().from(authSessions)).toHaveLength(0);
    await expect(auth.api.getSession({ headers: new Headers({ cookie }) })).resolves.toBeNull();
  });

  it("upgrades a browser the previous revision signed in, without asking it to sign in again", async () => {
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Browser",
      email: "browser@example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    });
    const legacy = new AuthTokenService(LEGACY_SECRET, 900, 3600);
    const legacyPair = await legacy.issuePairForUser(bootstrap.userId);
    const authService = bridgedAuthService(createAuth());
    const auth = createAuth(undefined, async (refreshToken) => {
      const identity = await legacy.verifyRefresh(refreshToken);
      return { expiresAt: identity.expiresAt, userId: (await authService.getActiveUserById(identity.userId)).user.id };
    });

    const upgrade = await auth.handler(
      new Request(`${PUBLIC_URL}/api/v1/auth/legacy/upgrade`, {
        method: "POST",
        // The origin a browser actually sends, so a trusted-origin rejection would surface here rather than in staging.
        headers: { "content-type": "application/json", origin: PUBLIC_URL },
        body: JSON.stringify({ refreshToken: legacyPair.refreshToken }),
      }),
    );

    expect(upgrade.status).toBe(200);
    const cookie = cookieHeader(upgrade);
    await expect(auth.api.getSession({ headers: new Headers({ cookie }) })).resolves.toMatchObject({
      user: { id: bootstrap.userId },
    });
    // The same Account, not a second one: the upgrade must not read as a new person signing in.
    expect(await client.database.select().from(users)).toHaveLength(1);
  });

  it("converges a replayed or raced upgrade on one session that sign-out ends", async () => {
    /*
     * A stateless refresh token has nothing to consume, so nothing stops it being presented twice — a replay, or two
     * requests from the same browser that met a 401 together. Each exchange that minted its own session would leave
     * every row but the last invisible to the browser that created it, and therefore alive after the sign-out meant to
     * end it. That is the orphan-session failure this endpoint exists to remove, reintroduced by concurrency.
     */
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Browser",
      email: "browser@example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    });
    const legacy = new AuthTokenService(LEGACY_SECRET, 900, 3600);
    const legacyPair = await legacy.issuePairForUser(bootstrap.userId);
    const authService = bridgedAuthService(createAuth());
    const auth = createAuth(undefined, async (refreshToken) => {
      const identity = await legacy.verifyRefresh(refreshToken);
      return { expiresAt: identity.expiresAt, userId: (await authService.getActiveUserById(identity.userId)).user.id };
    });
    const upgrade = () =>
      auth.handler(
        new Request(`${PUBLIC_URL}/api/v1/auth/legacy/upgrade`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: PUBLIC_URL },
          body: JSON.stringify({ refreshToken: legacyPair.refreshToken }),
        }),
      );

    const [first, second] = await Promise.all([upgrade(), upgrade()]);
    const replay = await upgrade();

    for (const response of [first, second, replay]) expect(response.status).toBe(200);
    const sessions = await client.database.select().from(authSessions);
    expect(sessions).toHaveLength(1);
    // Every exchange hands back the one session, so no browser is left holding a cookie for a row nothing else knows.
    for (const response of [first, second, replay]) {
      await expect(
        auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(response) }) }),
      ).resolves.toMatchObject({ session: { token: sessions[0]?.token }, user: { id: bootstrap.userId } });
    }

    const signOut = await auth.handler(
      new Request(`${PUBLIC_URL}/api/v1/auth/sign-out`, {
        method: "POST",
        headers: { cookie: cookieHeader(first), "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(signOut.status).toBe(200);
    expect(await client.database.select().from(authSessions)).toHaveLength(0);
  });

  it("refuses to upgrade a refresh credential that does not verify", async () => {
    const legacy = new AuthTokenService(LEGACY_SECRET, 900, 3600);
    const authService = bridgedAuthService(createAuth());
    const auth = createAuth(undefined, async (refreshToken) => {
      const identity = await legacy.verifyRefresh(refreshToken);
      return { expiresAt: identity.expiresAt, userId: (await authService.getActiveUserById(identity.userId)).user.id };
    });

    const forged = await auth.handler(
      new Request(`${PUBLIC_URL}/api/v1/auth/legacy/upgrade`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: `${randomUUID()}.${randomUUID()}.${randomUUID()}` }),
      }),
    );

    // Nothing else guards this endpoint, so a token that does not verify must produce no session at all.
    expect(forged.status).toBe(401);
    expect(await client.database.select().from(authSessions)).toHaveLength(0);
    expect(forged.headers.getSetCookie()).toEqual([]);
  });

  it("refuses development sign-in when the configured Account is ambiguous", async () => {
    await seedLegacyAccount("google-subject-twin-a", "twin@example.com", "Twin One");
    await seedLegacyAccount("google-subject-twin-b", "TWIN@example.com", "Twin Two");
    const developer = new DevBrowserAuthService(client.database, "twin@example.com");
    const auth = createAuth(() => developer.resolveUserId());

    const response = await auth.handler(
      new Request(`${PUBLIC_URL}/api/v1/auth/dev/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    // Reported as the answerable failure it is, so a misconfigured email is not logged as an internal server error.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "AUTH_DEV_USER_UNAVAILABLE" });
    expect(await client.database.select().from(authSessions)).toHaveLength(0);
  });
});
