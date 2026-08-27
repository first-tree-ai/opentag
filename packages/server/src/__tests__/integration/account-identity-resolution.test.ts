import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { authIdentities, users } from "../../db/schema/index.js";
import { AuthIdentityService, type ExternalIdentity } from "../../services/auth/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const GOOGLE_ISSUER = "https://accounts.google.com";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let identities: AuthIdentityService;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
  identities = new AuthIdentityService(client.database);
}, 120_000);

afterAll(async () => {
  await client.sql.end();
  await testDatabase.stop();
});

beforeEach(async () => testDatabase.reset());

function googleIdentity(overrides: Partial<ExternalIdentity> = {}): ExternalIdentity {
  return {
    provider: "google",
    issuer: GOOGLE_ISSUER,
    subject: "google-subject",
    email: "person@example.com",
    emailVerified: true,
    displayName: "Person",
    ...overrides,
  };
}

async function readAccount(userId: string) {
  const [account] = await client.database
    .select({ email: users.email, emailVerified: users.emailVerified, id: users.id })
    .from(users)
    .where(eq(users.id, userId));
  return account;
}

describe("Account identity resolution under the one-email-per-Account invariant", () => {
  it("attaches a verified provider identity to the Account that already holds the address", async () => {
    // The bootstrap Account is created from an email alone, so its first Google sign-in is the exact path that
    // previously produced a duplicate Account and, once the unique index exists, a raw unique violation.
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Admin",
      email: "Admin@Example.com",
      workspaceDisplayName: "Example",
      workspaceName: "example",
    });

    const resolved = await identities.resolveOrCreate(
      googleIdentity({ email: "ADMIN@example.com", displayName: "Admin" }),
    );

    expect(resolved).toBe(bootstrap.userId);
    expect(await client.database.select().from(users)).toHaveLength(1);
    expect(await readAccount(bootstrap.userId)).toEqual({
      email: "admin@example.com",
      emailVerified: true,
      id: bootstrap.userId,
    });
    const attached = await client.database.select().from(authIdentities).where(eq(authIdentities.userId, resolved));
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ provider: "google", issuer: GOOGLE_ISSUER, subject: "google-subject" });
  });

  it("marks a newly created Account verified when the provider verified the address", async () => {
    const userId = await identities.resolveOrCreate(googleIdentity({ email: "Verified@Example.com" }));

    expect(await readAccount(userId)).toEqual({ email: "verified@example.com", emailVerified: true, id: userId });
  });

  it("marks an explicitly linked Account verified", async () => {
    const [account] = await client.database
      .insert(users)
      .values({ displayName: "Existing", email: "linked@example.com" })
      .returning({ id: users.id });
    if (!account) throw new Error("Account fixture was not created");
    expect((await readAccount(account.id))?.emailVerified).toBe(false);

    await identities.resolveOrCreate(googleIdentity({ email: "linked@example.com" }), account.id);

    expect(await readAccount(account.id)).toEqual({
      email: "linked@example.com",
      emailVerified: true,
      id: account.id,
    });
  });

  it("follows a provider email change and keeps the flag describing the stored address", async () => {
    const userId = await identities.resolveOrCreate(googleIdentity({ email: "before@example.com" }));

    await identities.resolveOrCreate(googleIdentity({ email: "After@Example.com" }));

    expect(await readAccount(userId)).toEqual({ email: "after@example.com", emailVerified: true, id: userId });
    const [identity] = await client.database
      .select({ email: authIdentities.email })
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    expect(identity?.email).toBe("after@example.com");
  });

  it("refuses a provider email change onto another Account instead of failing on the unique index", async () => {
    const occupantId = await identities.resolveOrCreate(
      googleIdentity({ email: "occupant@example.com", subject: "occupant-subject" }),
    );
    const moverId = await identities.resolveOrCreate(
      googleIdentity({ email: "mover@example.com", subject: "mover-subject" }),
    );

    await expect(
      identities.resolveOrCreate(googleIdentity({ email: "occupant@example.com", subject: "mover-subject" })),
    ).rejects.toMatchObject({ code: "AUTH_EMAIL_CONFLICT", statusCode: 409 });

    // The rejection is a decision, not a partial write: both Accounts keep the address they had.
    expect((await readAccount(occupantId))?.email).toBe("occupant@example.com");
    expect((await readAccount(moverId))?.email).toBe("mover@example.com");
  });

  it("reports a lost concurrent Account creation as a conflict, not a database error", async () => {
    // Two identities can both find the address unowned; no row exists to lock, so the unique index is the only
    // serialization point and the loser must still surface a typed decision.
    const results = await Promise.allSettled([
      identities.resolveOrCreate(googleIdentity({ email: "race@example.com", subject: "racer-one" })),
      identities.resolveOrCreate(googleIdentity({ email: "race@example.com", subject: "racer-two" })),
    ]);

    // The loser can land on either index: the `users` insert if it lost the address, or the identity insert if it
    // attached to the winner's Account and found the provider slot taken. Both are decisions, not database errors.
    for (const failure of results.filter((result) => result.status === "rejected")) {
      expect(failure.reason).toMatchObject({ statusCode: 409 });
      expect(["AUTH_EMAIL_CONFLICT", "AUTH_IDENTITY_CONFLICT"]).toContain(failure.reason.code);
    }
    expect(await client.database.select().from(users)).toHaveLength(1);
  });

  it("reports a lost concurrent provider email change as a conflict, not a database error", async () => {
    await identities.resolveOrCreate(googleIdentity({ email: "mover-one@example.com", subject: "mover-one" }));
    await identities.resolveOrCreate(googleIdentity({ email: "mover-two@example.com", subject: "mover-two" }));

    const results = await Promise.allSettled([
      identities.resolveOrCreate(googleIdentity({ email: "target@example.com", subject: "mover-one" })),
      identities.resolveOrCreate(googleIdentity({ email: "target@example.com", subject: "mover-two" })),
    ]);

    for (const failure of results.filter((result) => result.status === "rejected")) {
      expect(failure.reason).toMatchObject({ code: "AUTH_EMAIL_CONFLICT", statusCode: 409 });
    }
    const holders = await client.database.select().from(users).where(eq(users.email, "target@example.com"));
    expect(holders).toHaveLength(1);
  });

  it("refuses to hand an existing Account to a verified but untrusted provider", async () => {
    // Verification is the adapter's claim about the address; trust is OpenTag's claim about the adapter. Only the
    // second one may hand over an Account, so a new provider cannot acquire that authority by asserting the first.
    const ownerId = await identities.resolveOrCreate(
      googleIdentity({ email: "trusted@example.com", subject: "google-owner" }),
    );

    await expect(
      identities.resolveOrCreate({
        provider: "oidc",
        issuer: "https://oidc.example.com",
        subject: "oidc-subject",
        email: "trusted@example.com",
        emailVerified: true,
        displayName: "Impostor",
      }),
    ).rejects.toMatchObject({ code: "AUTH_EMAIL_CONFLICT", statusCode: 409 });

    const attached = await client.database.select().from(authIdentities).where(eq(authIdentities.userId, ownerId));
    expect(attached).toHaveLength(1);
    expect(attached[0]?.provider).toBe("google");
  });

  it("refuses to hand an existing Account to an unverified provider address", async () => {
    const ownerId = await identities.resolveOrCreate(
      googleIdentity({ email: "owner@example.com", subject: "owner-subject" }),
    );

    await expect(
      identities.resolveOrCreate(
        googleIdentity({ email: "owner@example.com", emailVerified: false, subject: "impostor-subject" }),
      ),
    ).rejects.toMatchObject({ code: "AUTH_EMAIL_CONFLICT", statusCode: 409 });

    expect(await client.database.select().from(users)).toHaveLength(1);
    const attached = await client.database.select().from(authIdentities).where(eq(authIdentities.userId, ownerId));
    expect(attached).toHaveLength(1);
  });
});
