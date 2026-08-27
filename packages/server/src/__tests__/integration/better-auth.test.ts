import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
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

function createAuth(devSignIn?: () => Promise<string>) {
  return createBetterAuth(client.database, {
    onSessionCreating: (userId) => postAuthentication.ensureAccountReady(userId).then(() => undefined),
    publicUrl: PUBLIC_URL,
    secret: "better-auth-integration-secret-at-least-32-characters",
    secureCookies: false,
    ...(devSignIn ? { devSignIn } : {}),
    google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
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
