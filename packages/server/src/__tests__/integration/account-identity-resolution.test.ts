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

/**
 * Runs two resolutions that are both past the address lookup before either writes.
 *
 * Only usable when the two target *different* addresses. Resolutions claiming the same address serialize on it by
 * design, so the second cannot reach this point until the first commits, and the barrier would never release — the
 * bounded wait turns that misuse into a fast failure instead of a hung suite.
 */
async function raceAtAddressLookup(
  first: (service: AuthIdentityService) => Promise<unknown>,
  second: (service: AuthIdentityService) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  let arrived = 0;
  let release: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const bothArrived = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  const timer = setTimeout(
    () => reject(new Error("Both resolutions never reached the address lookup; do they claim the same address?")),
    5_000,
  );
  const barrier = async () => {
    arrived += 1;
    if (arrived >= 2) release();
    await bothArrived;
  };
  const service = new AuthIdentityService(client.database, { afterAccountLookup: barrier });
  try {
    return await Promise.allSettled([first(service), second(service)]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Proves the second resolution is blocked by the first one's address claim, then lets both finish.
 *
 * Concurrency here cannot be shown by starting two promises: the first may simply commit before the second reads, and
 * the outcome would then be identical with no lock at all. This holds the first transaction inside its claim, starts
 * the second, and requires it to make no progress while the claim is held — which is the property, not the outcome.
 */
async function serializedOnAddressClaim(
  first: (service: AuthIdentityService) => Promise<unknown>,
  second: (service: AuthIdentityService) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  let announceHolding: () => void = () => undefined;
  const holdingClaim = new Promise<void>((resolve) => {
    announceHolding = resolve;
  });
  let releaseClaim: () => void = () => undefined;
  const claimReleased = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });

  const holder = new AuthIdentityService(client.database, {
    afterAccountLookup: async () => {
      announceHolding();
      await claimReleased;
    },
  });
  const firstResult = first(holder).then(
    (value) => ({ status: "fulfilled", value }) as PromiseFulfilledResult<unknown>,
    (reason) => ({ status: "rejected", reason }) as PromiseRejectedResult,
  );
  await holdingClaim;

  let secondSettled = false;
  const secondResult = second(identities).then(
    (value) => {
      secondSettled = true;
      return { status: "fulfilled", value } as PromiseFulfilledResult<unknown>;
    },
    (reason) => {
      secondSettled = true;
      return { status: "rejected", reason } as PromiseRejectedResult;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(secondSettled, "the second resolution ran while the first held the address claim").toBe(false);

  releaseClaim();
  return Promise.all([firstResult, secondResult]);
}

function typedConflicts(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => {
      expect(result.reason).toMatchObject({ statusCode: 409 });
      return String((result.reason as { code: string }).code);
    });
}

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

  it("creates one Account when two first sign-ins race for the same address", async () => {
    // No row exists to lock, so without serializing on the address itself both would read it as free and create an
    // Account each. They serialize instead: the first creates, and the second sees that Account rather than a gap.
    const results = await serializedOnAddressClaim(
      (service) => service.resolveOrCreate(googleIdentity({ email: "race@example.com", subject: "racer-one" })),
      (service) => service.resolveOrCreate(googleIdentity({ email: "race@example.com", subject: "racer-two" })),
    );

    // One Account, and the second subject is refused rather than becoming a second Google identity on it.
    expect(typedConflicts(results)).toEqual(["AUTH_IDENTITY_CONFLICT"]);
    expect(await client.database.select().from(users)).toHaveLength(1);
    expect(await client.database.select().from(authIdentities)).toHaveLength(1);
  });

  it("reports a lost concurrent provider email change as a conflict, not a database error", async () => {
    await identities.resolveOrCreate(googleIdentity({ email: "mover-one@example.com", subject: "mover-one" }));
    await identities.resolveOrCreate(googleIdentity({ email: "mover-two@example.com", subject: "mover-two" }));

    const results = await serializedOnAddressClaim(
      (service) => service.resolveOrCreate(googleIdentity({ email: "target@example.com", subject: "mover-one" })),
      (service) => service.resolveOrCreate(googleIdentity({ email: "target@example.com", subject: "mover-two" })),
    );

    expect(typedConflicts(results)).toEqual(["AUTH_EMAIL_CONFLICT"]);
    const holders = await client.database.select().from(users).where(eq(users.email, "target@example.com"));
    expect(holders).toHaveLength(1);
  });

  it("reports a swap of two Account addresses as a conflict, not a deadlock", async () => {
    const leftId = await identities.resolveOrCreate(googleIdentity({ email: "left@example.com", subject: "left" }));
    const rightId = await identities.resolveOrCreate(googleIdentity({ email: "right@example.com", subject: "right" }));

    // Each Account moves onto the address the other is leaving. The two claims are different keys, so neither waits
    // on the other and no cycle exists; each simply reads the other still holding its address and refuses. Both moves
    // fail by decision rather than by database error, and neither Account may end up moved.
    const results = await raceAtAddressLookup(
      (service) => service.resolveOrCreate(googleIdentity({ email: "right@example.com", subject: "left" })),
      (service) => service.resolveOrCreate(googleIdentity({ email: "left@example.com", subject: "right" })),
    );

    expect(typedConflicts(results)).toEqual(["AUTH_EMAIL_CONFLICT", "AUTH_EMAIL_CONFLICT"]);
    expect((await readAccount(leftId))?.email).toBe("left@example.com");
    expect((await readAccount(rightId))?.email).toBe("right@example.com");
  });

  it("heals an Account a previous server revision left unverified on the next sign-in", async () => {
    // Migration 0019 backfills once, and the previous revision keeps serving afterwards without maintaining the flag.
    // The returning-identity path is what makes that self-correcting rather than permanent.
    const userId = await identities.resolveOrCreate(googleIdentity({ email: "healed@example.com", subject: "healed" }));
    await client.database.update(users).set({ emailVerified: false }).where(eq(users.id, userId));

    await identities.resolveOrCreate(googleIdentity({ email: "healed@example.com", subject: "healed" }));

    expect(await readAccount(userId)).toEqual({ email: "healed@example.com", emailVerified: true, id: userId });
  });

  it("refuses to pick between two Accounts already sharing an address", async () => {
    /*
     * Until the uniqueness index lands one deployment later, a writer predating this resolver can leave two Accounts
     * on one address. Attaching to either would hand ownership to whichever row the database returned first, so the
     * resolver must refuse instead of choosing — including for a fully trusted, verified identity.
     */
    const [first] = await client.database
      .insert(users)
      .values({ displayName: "First", email: "shared@example.com" })
      .returning({ id: users.id });
    const [second] = await client.database
      .insert(users)
      .values({ displayName: "Second", email: "SHARED@example.com" })
      .returning({ id: users.id });

    await expect(
      identities.resolveOrCreate(googleIdentity({ email: "shared@example.com", subject: "shared-subject" })),
    ).rejects.toMatchObject({ code: "AUTH_EMAIL_CONFLICT", statusCode: 409 });

    // Nothing was attached, so an operator still sees the two rows the index migration will report by id.
    expect(await client.database.select().from(authIdentities)).toHaveLength(0);
    expect(await client.database.select().from(users)).toHaveLength(2);
    expect([first?.id, second?.id].every(Boolean)).toBe(true);
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
