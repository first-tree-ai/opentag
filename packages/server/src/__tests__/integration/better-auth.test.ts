import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createBetterAuth } from "../../auth/better-auth.js";
import { BetterAuthSessionTokens } from "../../auth/session-tokens.js";
import { createDatabaseClient } from "../../db/client.js";
import { authIdentities, authSessions, users, workspaceAdminGrants } from "../../db/schema/index.js";
import { createUserAuthPreHandler, resolveAuthenticatedUserId } from "../../plugins/user-auth.js";
import { AuthService, DevBrowserAuthService, PostAuthenticationService } from "../../services/auth/index.js";
import { WorkspaceAdminAccess } from "../../services/workspace-admin-access/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const GOOGLE_ISSUER = "https://accounts.google.com";
const PUBLIC_URL = "http://localhost:8000";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/** The composition the server runs. */
function sessionAuthService(auth: ReturnType<typeof createAuth>): AuthService {
  return new AuthService(client.database, new BetterAuthSessionTokens(auth, client.database));
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
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    ...(devSignIn ? { devSignIn } : {}),
    google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
  });
}

/** Collects whatever a preHandler writes back, which is all these tests need from a reply. */
function replyStub(): FastifyReply {
  const written: string[] = [];
  const reply = {
    getHeader: () => written,
    header: (_name: string, value: string[]) => {
      written.splice(0, written.length, ...value);
      return reply;
    },
  };
  return reply as unknown as FastifyReply;
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
    const authService = sessionAuthService(auth);

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

    const exchanged = await sessionAuthService(createAuth()).exchangeConnectCode(bootstrap.connectCode);

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
    const authService = sessionAuthService(createAuth());
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

  it("lets one of two concurrent refreshes win, and never resurrects a revoked credential", async () => {
    /*
     * Verifying and then replacing decides both of these on stale information: two refreshes that verify the same
     * token would each go on to mint a session, and a revocation landing between verification and replacement would be
     * undone by the replacement. The withdrawal is the gate instead, so exactly one caller can proceed.
     */
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Admin",
      email: "admin@example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    });
    const authService = sessionAuthService(createAuth());
    const initial = await authService.exchangeConnectCode(bootstrap.connectCode);

    const raced = await Promise.allSettled([
      authService.refresh(initial.refreshToken),
      authService.refresh(initial.refreshToken),
    ]);

    const won = raced.filter((outcome) => outcome.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect(raced.filter((outcome) => outcome.status === "rejected")[0]).toMatchObject({
      reason: { code: "AUTH_INVALID_TOKEN" },
    });
    const live = await client.database.select().from(authSessions).where(eq(authSessions.userId, bootstrap.userId));
    expect(live).toHaveLength(1);

    // A refresh that starts against a credential something else has already revoked must not hand back access.
    const survivor = won[0] as PromiseFulfilledResult<{ refreshToken: string }>;
    await client.database.delete(authSessions).where(eq(authSessions.token, survivor.value.refreshToken));
    await expect(authService.refresh(survivor.value.refreshToken)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    expect(await client.database.select().from(authSessions)).toHaveLength(0);
  });

  it("does not let a junk bearer header turn a cookie request into a CLI one", async () => {
    /*
     * Better Auth reads the header and the cookie, and on an invalid bearer it answers from the cookie. Deciding the
     * transport from the header merely being present would therefore let a caller holding only the HttpOnly session
     * cookie attach any `Authorization` value and be treated as the CLI: no origin check, no double-submit token, and
     * mutations allowed. The transport is chosen before anything authenticates, so a presented bearer stands alone.
     */
    await seedLegacyAccount("google-subject-transport", "transport@example.com", "Transport Account");
    const developer = new DevBrowserAuthService(client.database, "transport@example.com");
    const auth = createAuth(() => developer.resolveUserId());
    // Signed by Better Auth rather than assembled here, so this is the cookie a real browser would present.
    const signedIn = await auth.handler(
      new Request(`${PUBLIC_URL}/api/v1/auth/dev/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(signedIn.status).toBe(200);
    const cookie = cookieHeader(signedIn);
    const preHandler = createUserAuthPreHandler(sessionAuthService(auth), {
      betterAuth: auth,
      publicOrigin: PUBLIC_URL,
      secureCookies: false,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
    });
    const mutation = (headers: Record<string, string>) =>
      preHandler({ headers, method: "POST" } as unknown as FastifyRequest, replyStub());

    // The cookie is genuinely good: without the header it reaches the browser path and is refused only for the token.
    await expect(mutation({ cookie, origin: PUBLIC_URL })).rejects.toMatchObject({ statusCode: 403 });

    /*
     * With a junk bearer alongside it, the request must be rejected as a bearer credential rather than falling through
     * to that same cookie — the fallback is what would skip the origin and double-submit checks entirely.
     *
     * The token has to carry a `.` and a bad signature. Better Auth's bearer plugin signs a dotless token and installs
     * it as the session cookie, which overwrites the real one and then fails on its own; only a token it reads as
     * signed-but-invalid is dropped, leaving the genuine cookie to answer for the request. That is the shape an
     * attacker would send, so it is the shape this asserts on.
     */
    await expect(mutation({ authorization: "Bearer forged.signature", cookie })).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
      statusCode: 401,
    });
  });

  it("forwards the renewed session cookie, so an active browser is not signed out on the original schedule", async () => {
    /*
     * Better Auth extends a session as it is used and reports the replacement cookie in response headers. A
     * result-only `getSession` throws those away, and the failure is silent: the row keeps moving while the browser
     * keeps the cookie it was first given, so an active user is signed out at the original expiry and the renewed row
     * is left behind. Nothing about the initial TTL catches that — only the header bridge does.
     */
    await seedLegacyAccount("google-subject-renewal", "renewal@example.com", "Renewal Account");
    const developer = new DevBrowserAuthService(client.database, "renewal@example.com");
    const auth = createAuth(() => developer.resolveUserId());
    const signedIn = await auth.handler(
      new Request(`${PUBLIC_URL}/api/v1/auth/dev/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const cookie = cookieHeader(signedIn);

    /*
     * Aged past `updateAge` by moving the expiry back, which is what Better Auth actually reads:
     * `expiresAt - expiresIn + updateAge <= now` is its condition for refreshing.
     */
    const aged = new Date(Date.now() + (SESSION_TTL_SECONDS - 2 * 24 * 60 * 60) * 1000);
    await client.database.update(authSessions).set({ expiresAt: aged });

    const reply = replyStub();
    await createUserAuthPreHandler(sessionAuthService(auth), {
      betterAuth: auth,
      publicOrigin: PUBLIC_URL,
      secureCookies: false,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
    })({ headers: { cookie }, method: "GET" } as unknown as FastifyRequest, reply);

    // The row moved forward, which is the half that used to happen silently on its own.
    const [renewed] = await client.database.select().from(authSessions);
    expect(renewed?.expiresAt.getTime()).toBeGreaterThan(aged.getTime());

    // And the browser was told: the replacement cookie has to reach the reply, or it keeps the one that expires first.
    const written = ([] as string[]).concat((reply.getHeader("set-cookie") ?? []) as string[]);
    const sessionCookieName = (await auth.$context).authCookies.sessionToken.name;
    const forwarded = written.find((value) => value.startsWith(`${sessionCookieName}=`));
    expect(forwarded, "the renewed session cookie was not forwarded to the browser").toBeDefined();

    // What it forwarded is a working credential, not just any cookie.
    const replacement = forwarded?.split(";", 1)[0] ?? "";
    await expect(auth.api.getSession({ headers: new Headers({ cookie: replacement }) })).resolves.toMatchObject({
      user: { email: "renewal@example.com" },
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

  it("refuses to create a second Account for an address one already holds", async () => {
    /*
     * The resolver that used to serialize on the address is gone, and Better Auth's linking does not order two
     * concurrent first sign-ins for the same one. The database enforces the invariant now — case-insensitively, so a
     * writer that skipped normalization cannot get in through a casing variant either.
     */
    await seedLegacyAccount("google-subject-twin-a", "twin@example.com", "Twin One");

    await expect(seedLegacyAccount("google-subject-twin-b", "TWIN@example.com", "Twin Two")).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23505" }),
    });
    expect(await client.database.select().from(users)).toHaveLength(1);
  });

  it("refuses development sign-in when the configured Account does not exist", async () => {
    const developer = new DevBrowserAuthService(client.database, "absent@example.com");
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
