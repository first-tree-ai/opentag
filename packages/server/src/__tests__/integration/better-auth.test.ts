import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBetterAuth } from "../../auth/better-auth.js";
import { createDatabaseClient } from "../../db/client.js";
import { authIdentities, authSessions, users } from "../../db/schema/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const GOOGLE_ISSUER = "https://accounts.google.com";
const PUBLIC_URL = "http://localhost:8000";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);

afterAll(async () => {
  await client.sql.end();
  await testDatabase.stop();
});

beforeEach(async () => {
  await testDatabase.reset();
});

function createAuth() {
  return createBetterAuth(client.database, {
    publicUrl: PUBLIC_URL,
    secret: "better-auth-integration-secret-at-least-32-characters",
    secureCookies: false,
    google: { clientId: "google-client-id", clientSecret: "google-client-secret" },
  });
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

    // The hook refuses the write, so no token ever exists to authenticate with.
    expect(await context.internalAdapter.createSession(userId)).toBeNull();
    expect(await client.database.select().from(authSessions).where(eq(authSessions.userId, userId))).toHaveLength(0);
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
});
