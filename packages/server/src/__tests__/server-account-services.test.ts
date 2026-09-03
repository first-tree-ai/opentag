import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BootstrapAdminInputSchema, bootstrapInitialAdmin } from "../admin/bootstrap.js";
import { createBetterAuth, type OpenTagBetterAuth } from "../auth/better-auth.js";
import { betterAuthFailure, callBetterAuth, sendBetterAuthResponse } from "../auth/fastify-handler.js";
import { BetterAuthSessionTokens } from "../auth/session-tokens.js";
import {
  accountCliLoginCodes,
  agents,
  authIdentities,
  authSessions,
  computerConnectCodes,
  computerCredentials,
  computers,
  users,
} from "../db/schema/index.js";
import {
  AuthService,
  AuthServiceError,
  type AuthTokenProvider,
  ConnectCodeService,
  DevBrowserAuthService,
  hashSecret,
  issueConnectCodeInTransaction,
  PostAuthenticationService,
} from "../services/auth/index.js";
import { ComputerService, MachineAuthService } from "../services/computers/index.js";
import { rejectUnsupportedClientVersion } from "../services/computers/machine-auth-service.js";
import {
  projectComputerImCliReadiness,
  projectComputerProviderReadiness,
} from "../services/computers/provider-readiness.js";
import { OnboardingResetError, OnboardingResetService } from "../services/onboarding-reset/index.js";
import { AccountSetupService, AccountSetupServiceError } from "../services/setup/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const SECRET = "server-account-unit-secret-at-least-32-characters";
let unit: UnitDatabase;

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

async function account(input: { email?: string; displayName?: string } = {}) {
  return bootstrapInitialAdmin(
    unit.database,
    {
      email: input.email ?? "owner@example.com",
      displayName: input.displayName ?? "Owner",
    },
    NOW,
  );
}

function authTokens(database = unit.database, now = NOW) {
  return new BetterAuthSessionTokens(
    createBetterAuth(database, {
      onSessionCreating: async () => {},
      publicUrl: "http://localhost:8000",
      secret: SECRET,
      secureCookies: false,
      sessionTtlSeconds: 3600,
    }),
    database,
    { now: () => now },
  );
}

async function machineFixture() {
  const bootstrap = await account();
  const machine = new MachineAuthService(unit.database, { now: () => NOW });
  const issued = await machine.issueForAccount(bootstrap.userId, {});
  return { bootstrap, issued, machine };
}

type TestUuid = `${string}-${string}-${string}-${string}-${string}`;

function exchangeInput(code: string, installationId = randomUUID(), version = "0.0.2") {
  return {
    code,
    installationId: installationId as TestUuid,
    displayName: "Workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: version,
  };
}

/**
 * Preserves the real PGlite transaction for every read and write except the `computers` update,
 * whose builder is replaced so the repair path can be driven into its fail-closed branches on an
 * engine whose native unique-violation shape differs from PostgreSQL's.
 */
function withComputerUpdateFailure(mode: "empty_returning" | "unique_violation") {
  const database = new Proxy(unit.database, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (callback: (transaction: unknown) => Promise<unknown>) =>
        target.transaction(async (transaction: unknown) => {
          const proxied = new Proxy(transaction as Record<PropertyKey, unknown>, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty !== "update") return Reflect.get(txTarget, txProperty, txReceiver);
              return (table: unknown) => {
                if (table !== computers) {
                  return (Reflect.get(txTarget, txProperty, txReceiver) as (t: unknown) => unknown).call(
                    txTarget,
                    table,
                  );
                }
                const builder: Record<string, unknown> = {};
                builder.set = () => builder;
                builder.where = () => builder;
                builder.returning = async () => {
                  if (mode === "unique_violation") {
                    throw Object.assign(
                      new Error(
                        'duplicate key value violates unique constraint "computers_current_installation_id_unique"',
                      ),
                      { code: "23505", constraint_name: "computers_current_installation_id_unique" },
                    );
                  }
                  return [];
                };
                return builder;
              };
            },
          });
          return callback(proxied);
        });
    },
  });
  return { machine: new MachineAuthService(database as never, { now: () => NOW }) };
}

/**
 * Runs a deletion in the gap between a service's preflight reads and its locked write, so tests can
 * prove the in-transaction recheck is what refuses a target that vanished mid-flight. Every other
 * call passes through to the real PGlite database.
 */
function deletingOnTransaction(deleteBeforeTransaction: () => Promise<void>) {
  return new Proxy(unit.database, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (callback: (transaction: unknown) => Promise<unknown>) =>
        deleteBeforeTransaction().then(() => target.transaction(callback as never));
    },
  }) as never;
}

describe("bootstrap and account authentication services", () => {
  it("normalizes bootstrap input, issues a hashed connect code, and rejects a second bootstrap", async () => {
    const result = await bootstrapInitialAdmin(
      unit.database,
      { email: "  ADMIN@Example.COM ", displayName: "  Admin  " },
      NOW,
    );
    expect(result.userId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 900_000));
    const [user] = await unit.database.select().from(users);
    const [code] = await unit.database.select().from(accountCliLoginCodes);
    expect(user).toMatchObject({ email: "admin@example.com", displayName: "Admin" });
    expect(code).toMatchObject({
      userId: result.userId,
      issuedByUserId: result.userId,
      tokenHash: hashSecret(result.connectCode),
    });
    expect(code?.tokenHash).not.toBe(result.connectCode);
    await expect(
      bootstrapInitialAdmin(unit.database, { email: "other@example.com", displayName: "Other" }, NOW),
    ).rejects.toThrow("already been completed");
  });

  it("validates bootstrap input and connect-code TTL at the boundary", async () => {
    expect(() => BootstrapAdminInputSchema.parse({ email: "not-an-email", displayName: "" })).toThrow();
    await expect(
      bootstrapInitialAdmin(unit.database, { email: "x@example.com", displayName: "x", connectCodeTtlSeconds: 0 }, NOW),
    ).rejects.toThrow();
    await expect(
      unit.database.transaction((tx) =>
        issueConnectCodeInTransaction(tx, { issuerUserId: randomUUID(), userId: randomUUID(), ttlSeconds: 1.5 }, NOW),
      ),
    ).rejects.toThrow("positive integer");
  });

  it("covers AuthService connect-code decisions and live account checks", async () => {
    const bootstrap = await account();
    const provider: AuthTokenProvider = {
      issuePairForUser: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", expiresIn: 900 })),
      rotate: vi.fn(async () => ({ accessToken: "next", refreshToken: "next", expiresIn: 900 })),
      verifyAccess: vi.fn(async () => ({ userId: bootstrap.userId, expiresAt: new Date(NOW.getTime() + 1000) })),
      verifyRefresh: vi.fn(async () => ({ userId: bootstrap.userId, expiresAt: new Date(NOW.getTime() + 1000) })),
    };
    const auth = new AuthService(unit.database, provider, { now: () => NOW });
    await expect(auth.exchangeConnectCode("invalid")).rejects.toMatchObject({ code: "AUTH_INVALID_CODE" });
    await expect(
      auth.exchangeConnectCode((await unit.database.select().from(accountCliLoginCodes))[0]?.tokenHash ?? ""),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CODE" });
    const issued = await new ConnectCodeService(unit.database, { now: () => NOW }).issueForUser(bootstrap.userId);
    await expect(auth.exchangeConnectCode(issued.code, randomUUID())).rejects.toMatchObject({
      code: "AUTH_USER_MISMATCH",
      statusCode: 409,
    });
    expect(
      (await unit.database.select().from(accountCliLoginCodes)).find((row) => row.tokenHash === hashSecret(issued.code))
        ?.consumedAt,
    ).toBeNull();
    await expect(auth.exchangeConnectCode(issued.code, bootstrap.userId)).resolves.toMatchObject({
      tokenType: "Bearer",
      accessToken: "access",
    });
    await expect(auth.exchangeConnectCode(issued.code)).rejects.toMatchObject({ code: "AUTH_CODE_CONSUMED" });
    await expect(auth.refresh("refresh")).resolves.toMatchObject({ tokenType: "Bearer", accessToken: "next" });
    await expect(auth.issueTokensForUser(bootstrap.userId)).resolves.toMatchObject({ tokenType: "Bearer" });
    await expect(auth.getAuthenticatedUser("access")).resolves.toMatchObject({
      me: { user: { id: bootstrap.userId } },
    });
    await expect(auth.updateSelfProfile(bootstrap.userId, { displayName: "  Updated  " })).resolves.toMatchObject({
      displayName: "Updated",
    });
    await expect(auth.updateSelfProfile(randomUUID(), { displayName: "Missing" })).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
  });

  it("rejects expired, missing, and suspended authentication records", async () => {
    const bootstrap = await account();
    const issuer = new ConnectCodeService(unit.database, { now: () => NOW });
    const expired = await issuer.issueForUser(bootstrap.userId);
    await unit.database
      .update(accountCliLoginCodes)
      .set({ expiresAt: new Date(NOW.getTime() + 1) })
      .where(eq(accountCliLoginCodes.tokenHash, hashSecret(expired.code)));
    const auth = new AuthService(unit.database, authTokens(), { now: () => new Date(NOW.getTime() + 2) });
    await expect(auth.exchangeConnectCode(expired.code)).rejects.toMatchObject({ code: "AUTH_CODE_EXPIRED" });
    await expect(auth.getActiveUserById(randomUUID())).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    const suspendedTokens = authTokens();
    const suspendedPair = await suspendedTokens.issuePairForUser(bootstrap.userId);
    await unit.database.update(users).set({ suspendedAt: NOW }).where(eq(users.id, bootstrap.userId));
    await expect(issuer.issueForUser(bootstrap.userId)).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
    await expect(auth.issueTokensForUser(bootstrap.userId)).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
    await expect(
      new AuthService(unit.database, suspendedTokens).getAuthenticatedUser(suspendedPair.accessToken),
    ).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
  });

  it("covers ConnectCodeService missing users and session token rotation/expiry", async () => {
    const issuer = new ConnectCodeService(unit.database, { now: () => NOW });
    await expect(issuer.issueForUser(randomUUID())).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
    const bootstrap = await account();
    const tokens = authTokens();
    const session = await tokens.issuePairForUser(bootstrap.userId);
    await expect(tokens.verifyAccess(session.accessToken)).resolves.toMatchObject({ userId: bootstrap.userId });
    await expect(tokens.rotate(session.accessToken, bootstrap.userId)).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
    await expect(tokens.rotate(session.accessToken, bootstrap.userId)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    await expect(tokens.verifyRefresh("missing")).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    await unit.database.update(authSessions).set({ expiresAt: NOW }).where(eq(authSessions.userId, bootstrap.userId));
    await expect(tokens.verifyAccess(session.accessToken)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
  });

  it("handles token-provider issuance failure without inventing a session", async () => {
    const bootstrap = await account();
    const failing = {
      ...authTokens(),
      issuePairForUser: vi.fn().mockRejectedValue(new Error("issue failed")),
    } as unknown as AuthTokenProvider;
    const auth = new AuthService(unit.database, failing, { now: () => NOW });
    const code = (await unit.database.select().from(accountCliLoginCodes))[0];
    await expect(auth.exchangeConnectCode(code ? "wrong" : "wrong")).rejects.toMatchObject({
      code: "AUTH_INVALID_CODE",
    });
    const issued = await new ConnectCodeService(unit.database, { now: () => NOW }).issueForUser(bootstrap.userId);
    await expect(auth.exchangeConnectCode(issued.code)).rejects.toThrow("issue failed");
    const [stored] = await unit.database
      .select()
      .from(accountCliLoginCodes)
      .where(eq(accountCliLoginCodes.tokenHash, hashSecret(issued.code)));
    expect(stored?.consumedAt).toEqual(NOW);
  });
});

describe("machine authentication and Computer services", () => {
  it("issues and exchanges create codes, rotates credentials, and verifies machine tokens", async () => {
    const value = await machineFixture();
    const installationId = randomUUID();
    const exchange = await value.machine.exchangeConnectCode(exchangeInput(value.issued.code, installationId));
    expect(exchange).toMatchObject({
      computerId: expect.any(String),
      installationId,
      machineToken: expect.stringMatching(/^otmc_/),
    });
    await expect(value.machine.verifyMachineToken(exchange.machineToken)).resolves.toMatchObject({
      computerId: exchange.computerId,
      installationId,
    });
    await expect(value.machine.verifyMachineToken("bad-token")).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    await expect(value.machine.verifyMachineToken(`${exchange.machineToken}x`)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    const tampered = `${exchange.machineToken.slice(0, -1)}${exchange.machineToken.endsWith("A") ? "B" : "A"}`;
    await expect(value.machine.verifyMachineToken(tampered)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    const repair = await value.machine.issueForAccount(value.bootstrap.userId, {
      mode: "repair",
      targetComputerId: exchange.computerId,
    });
    const replacement = await value.machine.exchangeConnectCode(exchangeInput(repair.code, randomUUID(), "0.0.2"));
    await expect(value.machine.verifyMachineToken(exchange.machineToken)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    await expect(value.machine.verifyMachineToken(replacement.machineToken)).resolves.toMatchObject({
      computerId: exchange.computerId,
    });
    expect(await unit.database.select().from(computerCredentials)).toHaveLength(2);
  });

  it("compactly embeds an explicit Agent target and binds it atomically at redemption", async () => {
    const bootstrap = await account();
    const [target] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: bootstrap.userId,
        displayName: "Setup Agent",
        name: "setup-agent",
        runtimeProvider: "codex",
      })
      .returning({ id: agents.id });
    if (!target) throw new Error("Agent insert did not return a row");
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const issued = await machine.issueForAccount(bootstrap.userId, { targetAgentId: target.id });
    expect(issued.code).toMatch(/^otcc_[A-Za-z0-9_-]{43}$/u);
    expect(issued.code).toHaveLength(48);
    expect(issued.code).not.toContain(target.id);
    expect((await unit.database.select().from(computerConnectCodes))[0]?.tokenHash).toBe(hashSecret(issued.code));

    const connected = await machine.exchangeConnectCode(exchangeInput(issued.code));
    expect(connected).toMatchObject({ agentId: target.id, computerId: expect.any(String) });
    const [bound] = await unit.database.select().from(agents).where(eq(agents.id, target.id));
    expect(bound).toMatchObject({ computerId: connected.computerId, revision: 2 });
  });

  it("redeems the previous textual targeted-code format during a rolling upgrade", async () => {
    const bootstrap = await account();
    const [target] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: bootstrap.userId,
        displayName: "Legacy Setup Agent",
        name: "legacy-setup-agent",
        runtimeProvider: "codex",
      })
      .returning({ id: agents.id });
    if (!target) throw new Error("Agent insert did not return a row");
    const legacyCode = `otcc_${"a".repeat(32)}.${target.id}`;
    await unit.database.insert(computerConnectCodes).values({
      tokenHash: hashSecret(legacyCode),
      issuedByAccountId: bootstrap.userId,
      mode: "create",
      targetComputerId: null,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000),
    });

    const connected = await new MachineAuthService(unit.database, { now: () => NOW }).exchangeConnectCode(
      exchangeInput(legacyCode),
    );

    expect(connected.agentId).toBe(target.id);
    const [bound] = await unit.database.select().from(agents).where(eq(agents.id, target.id));
    expect(bound?.computerId).toBe(connected.computerId);
  });

  it("rejects a bound or foreign Agent before issuing a targeted create code", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const generic = await machine.issueForAccount(bootstrap.userId, {});
    const connected = await machine.exchangeConnectCode(exchangeInput(generic.code));
    const [bound] = await unit.database
      .insert(agents)
      .values({
        computerId: connected.computerId,
        createdByUserId: bootstrap.userId,
        displayName: "Bound Agent",
        name: "bound-agent",
        runtimeProvider: "codex",
      })
      .returning({ id: agents.id });
    if (!bound) throw new Error("bound Agent fixture missing");
    await expect(machine.issueForAccount(bootstrap.userId, { targetAgentId: bound.id })).rejects.toMatchObject({
      code: "AGENT_LIFECYCLE_CONFLICT",
      statusCode: 409,
    });

    const [other] = await unit.database
      .insert(users)
      .values({ email: "target-owner@example.com", displayName: "Other" })
      .returning({ id: users.id });
    if (!other) throw new Error("target owner fixture missing");
    const [foreign] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: other.id,
        displayName: "Foreign Agent",
        name: "foreign-agent",
        runtimeProvider: "codex",
      })
      .returning({ id: agents.id });
    if (!foreign) throw new Error("foreign Agent fixture missing");
    await expect(machine.issueForAccount(bootstrap.userId, { targetAgentId: foreign.id })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("rolls back Computer creation when a targeted Agent changes before redemption", async () => {
    const bootstrap = await account();
    const [target] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: bootstrap.userId,
        displayName: "Setup Agent",
        name: "setup-agent",
        runtimeProvider: "codex",
      })
      .returning({ id: agents.id });
    if (!target) throw new Error("Agent insert did not return a row");
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const targeted = await machine.issueForAccount(bootstrap.userId, { targetAgentId: target.id });
    const generic = await machine.issueForAccount(bootstrap.userId, {});
    const existing = await machine.exchangeConnectCode(exchangeInput(generic.code));
    await unit.database.update(agents).set({ computerId: existing.computerId }).where(eq(agents.id, target.id));
    const computersBefore = await unit.database.select().from(computers);
    const credentialsBefore = await unit.database.select().from(computerCredentials);

    await expect(machine.exchangeConnectCode(exchangeInput(targeted.code))).rejects.toMatchObject({
      code: "AUTH_INVALID_CODE",
    });

    expect(await unit.database.select().from(computers)).toHaveLength(computersBefore.length);
    expect(await unit.database.select().from(computerCredentials)).toHaveLength(credentialsBefore.length);
    const [code] = await unit.database
      .select()
      .from(computerConnectCodes)
      .where(eq(computerConnectCodes.tokenHash, hashSecret(targeted.code)));
    expect(code?.consumedAt).toBeNull();
    const [unchanged] = await unit.database.select().from(agents).where(eq(agents.id, target.id));
    expect(unchanged?.computerId).toBe(existing.computerId);
  });

  it("reports expiry, duplicate installation, and repaired ownership conflicts", async () => {
    const value = await machineFixture();
    const expired = await value.machine.issueForAccount(value.bootstrap.userId, {});
    await unit.database
      .update(computerConnectCodes)
      .set({ expiresAt: new Date(NOW.getTime() + 1000) })
      .where(eq(computerConnectCodes.tokenHash, hashSecret(expired.code)));
    await expect(
      new MachineAuthService(unit.database, { now: () => new Date(NOW.getTime() + 2000) }).exchangeConnectCode(
        exchangeInput(expired.code),
      ),
    ).rejects.toMatchObject({ code: "AUTH_CODE_EXPIRED" });
    const first = await value.machine.exchangeConnectCode(exchangeInput(value.issued.code));
    const duplicate = await value.machine.issueForAccount(value.bootstrap.userId, {});
    // The embedded engine reports driver-shaped unique violations; the mapped 409 is covered by the
    // integration suite against a real PostgreSQL. Here the fail-closed rejection is what matters.
    await expect(
      value.machine.exchangeConnectCode(exchangeInput(duplicate.code, first.installationId as TestUuid)),
    ).rejects.toThrow();
    const repairCode = await value.machine.issueForAccount(value.bootstrap.userId, {
      mode: "repair",
      targetComputerId: first.computerId,
    });
    const [other] = await unit.database
      .insert(users)
      .values({ email: "repair-owner@example.com", displayName: "Other" })
      .returning({ id: users.id });
    if (!other) throw new Error("repair owner fixture missing");
    await unit.database.update(computers).set({ ownerAccountId: other.id }).where(eq(computers.id, first.computerId));
    await expect(value.machine.exchangeConnectCode(exchangeInput(repairCode.code))).rejects.toMatchObject({
      code: "AUTH_INVALID_CODE",
    });
  });

  it("maps a repair update rejected as a duplicate installation to a 409 and rolls everything back", async () => {
    const value = await machineFixture();
    const first = await value.machine.exchangeConnectCode(exchangeInput(value.issued.code));
    const repairCode = await value.machine.issueForAccount(value.bootstrap.userId, {
      mode: "repair",
      targetComputerId: first.computerId,
    });
    const failing = withComputerUpdateFailure("unique_violation");

    await expect(
      failing.machine.exchangeConnectCode(exchangeInput(repairCode.code, randomUUID())),
    ).rejects.toMatchObject({ code: "COMPUTER_IDENTITY_CONFLICT", statusCode: 409 });

    const [code] = await unit.database
      .select()
      .from(computerConnectCodes)
      .where(eq(computerConnectCodes.tokenHash, hashSecret(repairCode.code)));
    expect(code).toMatchObject({ consumedAt: null, consumedComputerId: null });
    const [computer] = await unit.database.select().from(computers).where(eq(computers.id, first.computerId));
    expect(computer).toMatchObject({ currentInstallationId: first.installationId });
    expect(await unit.database.select().from(computerCredentials)).toHaveLength(1);
  });

  it("fails closed when the repair update returns no row and rolls everything back", async () => {
    const value = await machineFixture();
    const first = await value.machine.exchangeConnectCode(exchangeInput(value.issued.code));
    const repairCode = await value.machine.issueForAccount(value.bootstrap.userId, {
      mode: "repair",
      targetComputerId: first.computerId,
    });
    const failing = withComputerUpdateFailure("empty_returning");

    await expect(failing.machine.exchangeConnectCode(exchangeInput(repairCode.code, randomUUID()))).rejects.toThrow(
      "The repaired Computer does not match its issuing Account",
    );

    const [code] = await unit.database
      .select()
      .from(computerConnectCodes)
      .where(eq(computerConnectCodes.tokenHash, hashSecret(repairCode.code)));
    expect(code).toMatchObject({ consumedAt: null, consumedComputerId: null });
    const [computer] = await unit.database.select().from(computers).where(eq(computers.id, first.computerId));
    expect(computer).toMatchObject({ currentInstallationId: first.installationId });
    expect(await unit.database.select().from(computerCredentials)).toHaveLength(1);
  });

  it("rejects a repair that reuses an installation already bound to another Computer", async () => {
    const value = await machineFixture();
    const first = await value.machine.exchangeConnectCode(exchangeInput(value.issued.code));
    const secondIssued = await value.machine.issueForAccount(value.bootstrap.userId, {});
    const second = await value.machine.exchangeConnectCode(exchangeInput(secondIssued.code));
    const repairCode = await value.machine.issueForAccount(value.bootstrap.userId, {
      mode: "repair",
      targetComputerId: second.computerId,
    });
    /* The embedded engine surfaces driver-shaped unique violations, so this asserts the fail-closed
       rejection and the rollback; the mapped 409 for the same branch is covered by the integration
       suite against a real PostgreSQL. */
    await expect(
      value.machine.exchangeConnectCode(exchangeInput(repairCode.code, first.installationId as TestUuid)),
    ).rejects.toThrow();

    const credentials = await unit.database.select().from(computerCredentials);
    expect(credentials).toHaveLength(2);
    const [computer] = await unit.database.select().from(computers).where(eq(computers.id, second.computerId));
    expect(computer).toMatchObject({ currentInstallationId: second.installationId });
    await expect(value.machine.verifyMachineToken(second.machineToken)).resolves.toMatchObject({
      computerId: second.computerId,
      installationId: second.installationId,
    });
  });

  it("runs credential-rotation callbacks and builds safe Computer connect commands", async () => {
    const rotated = vi.fn();
    const value = await machineFixture();
    const machine = new MachineAuthService(unit.database, { onCredentialRotated: rotated });
    const issued = await machine.issueForAccount(value.bootstrap.userId, {});
    await machine.exchangeConnectCode(exchangeInput(issued.code));
    expect(rotated).toHaveBeenCalledOnce();
    const { buildComputerConnectCommand } = await import("../services/computers/machine-auth-service.js");
    const mirror = "https://mirror.example/releases/";
    expect(
      buildComputerConnectCommand({
        code: "abc",
        downloadBaseUrl: mirror,
        environment: "staging",
        publicUrl: "https://dev.example.com",
      }),
    ).toContain('"$HOME/.local/bin/opentag-staging" connect');
    // The installer lands in a file so a failed download stops the chain instead of falling through
    // to the Client already on disk, which `curl … | sh &&` would do.
    expect(
      buildComputerConnectCommand({
        code: "abc",
        downloadBaseUrl: mirror,
        environment: "staging",
        publicUrl: "https://dev.example.com",
      }),
    ).toBe(
      'opentag_installer="$(mktemp)" && curl -fsSL https://mirror.example/releases/staging/install.sh -o "$opentag_installer"' +
        ' && sh "$opentag_installer" && rm -f "$opentag_installer"' +
        ' && PATH="$HOME/.local/bin${PATH:+:$PATH}" "$HOME/.local/bin/opentag-staging" connect --server https://dev.example.com -- abc',
    );
    expect(
      buildComputerConnectCommand({
        code: "a'; echo nope",
        downloadBaseUrl: mirror,
        environment: "prod",
        publicUrl: "https://example.com/a b",
      }),
    ).toContain("'a'\\''; echo nope'");
    expect(
      buildComputerConnectCommand({
        code: "abc",
        downloadBaseUrl: mirror,
        environment: "dev",
        publicUrl: "http://127.0.0.1:8000",
      }),
    ).toContain("dev-install.sh");
  });

  it("consumes one machine connect code when two exchanges race", async () => {
    const value = await machineFixture();
    const input = exchangeInput(value.issued.code);
    const outcomes = await Promise.allSettled([
      value.machine.exchangeConnectCode(input),
      value.machine.exchangeConnectCode(input),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")[0]).toMatchObject({
      reason: { code: "AUTH_CODE_CONSUMED" },
    });
  });

  it("covers machine-code rejection branches and account ownership fences", async () => {
    const value = await machineFixture();
    await expect(value.machine.issueForAccount(randomUUID(), {})).rejects.toMatchObject({
      code: "AUTH_USER_SUSPENDED",
    });
    const target = await value.machine.exchangeConnectCode(exchangeInput(value.issued.code));
    await expect(
      value.machine.issueForAccount(value.bootstrap.userId, { mode: "repair" } as never),
    ).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
    });
    await expect(
      value.machine.issueForAccount(value.bootstrap.userId, { mode: "repair", targetComputerId: randomUUID() }),
    ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND" });
    await expect(value.machine.exchangeConnectCode(exchangeInput("otcc_missing"))).rejects.toMatchObject({
      code: "AUTH_INVALID_CODE",
    });
    await expect(
      value.machine.exchangeConnectCode(exchangeInput(value.issued.code, randomUUID(), "0.0.1")),
    ).rejects.toMatchObject({ code: "CLIENT_VERSION_UNSUPPORTED" });
    await expect(
      value.machine.exchangeConnectCode(exchangeInput(value.issued.code, target.computerId as TestUuid)),
    ).rejects.toMatchObject({ code: "AUTH_CODE_CONSUMED" });
    const fresh = await value.machine.issueForAccount(value.bootstrap.userId, {});
    await unit.database.update(users).set({ suspendedAt: NOW }).where(eq(users.id, value.bootstrap.userId));
    await expect(value.machine.exchangeConnectCode(exchangeInput(fresh.code))).rejects.toMatchObject({
      code: "AUTH_USER_SUSPENDED",
    });
  });

  it("registers, heartbeats, disconnects, lists, and fences Computer credentials", async () => {
    const value = await machineFixture();
    const installationId = randomUUID();
    const exchange = await value.machine.exchangeConnectCode(exchangeInput(value.issued.code, installationId));
    const service = new ComputerService(
      unit.database,
      { getActiveUserById: vi.fn() },
      { now: () => NOW, presenceTimeoutMs: 1000 },
    );
    expect(await service.accountInFirstSetup(exchange.computerId)).toBe(true);
    expect(await service.accountInFirstSetup(randomUUID())).toBe(false);
    const frame = {
      type: "computer:register" as const,
      requestId: randomUUID(),
      installationId,
      instanceId: randomUUID(),
      displayName: "Desk",
      platform: "linux" as const,
      arch: "x64",
      clientVersion: "0.0.2",
      capabilities: { imCredentialGrant: 0 as const },
      protocolVersion: 2,
      supportedCapabilities: { imCredentialGrant: { min: 1, max: 1 } },
      requiredServerCapabilities: [],
    };
    await expect(service.register(exchange, { ...frame, installationId: randomUUID() })).rejects.toMatchObject({
      code: "COMPUTER_IDENTITY_CONFLICT",
    });
    await service.register(exchange, frame);
    await unit.database.insert(agents).values([
      {
        createdByUserId: value.bootstrap.userId,
        computerId: exchange.computerId,
        name: "one",
        displayName: "One",
        runtimeProvider: "codex",
      },
      {
        createdByUserId: value.bootstrap.userId,
        computerId: exchange.computerId,
        name: "two",
        displayName: "Two",
        runtimeProvider: "codex",
      },
    ]);
    expect(await service.heartbeat(exchange, frame.instanceId)).toBe(true);
    expect(await service.heartbeat(exchange, randomUUID())).toBe(false);
    expect(await service.disconnect(exchange.computerId, frame.instanceId)).toBe(true);
    expect(await service.disconnect(exchange.computerId, frame.instanceId)).toBe(false);
    await expect(service.listAccountComputers(value.bootstrap.userId)).resolves.toMatchObject({
      computers: [
        { connectionStatus: "offline", agentIds: expect.arrayContaining([expect.any(String), expect.any(String)]) },
      ],
    });
    await service.register(exchange, { ...frame, instanceId: randomUUID() });
    const listed = await service.listAccountComputers(value.bootstrap.userId, true);
    expect(listed.computers[0]).toMatchObject({
      connectionStatus: "online",
      agentIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
      providerReadiness: expect.any(Array),
      imCliReadiness: expect.any(Array),
    });
    await unit.database.update(users).set({ setupCompletedAt: NOW }).where(eq(users.id, value.bootstrap.userId));
    expect(await service.accountInFirstSetup(exchange.computerId)).toBe(false);
    await expect(service.assertActiveCredential(exchange)).resolves.toBeUndefined();
    await unit.database
      .update(computerCredentials)
      .set({ revokedAt: NOW, revokedByUserId: value.bootstrap.userId })
      .where(eq(computerCredentials.id, exchange.credentialId));
    await expect(service.assertActiveCredential(exchange)).rejects.toMatchObject({ code: "COMPUTER_NOT_REGISTERED" });
    await expect(service.register(exchange, frame)).rejects.toMatchObject({ code: "COMPUTER_NOT_REGISTERED" });
  });

  it("projects readiness for online and offline Computers", async () => {
    const observed = new Date("2026-08-30T01:00:00.000Z");
    const source = {
      providerReadiness: vi.fn(() => [
        { observation: { provider: "codex" as const, status: "ready" as const }, observedAt: observed.getTime() },
      ]),
      imCliReadiness: vi.fn(() => [
        { observation: { provider: "feishu" as const, status: "ready" as const }, observedAt: observed.getTime() },
      ]),
    };
    expect(projectComputerProviderReadiness("c", "offline", observed, source)).toEqual([
      { provider: "codex", status: "unavailable", observedAt: null },
      { provider: "claude-code", status: "unavailable", observedAt: null },
    ]);
    expect(projectComputerImCliReadiness("c", "offline", observed, source)).toEqual([
      { provider: "feishu", status: "unavailable", observedAt: null },
      { provider: "slack", status: "unavailable", observedAt: null },
    ]);
    expect(projectComputerProviderReadiness("c", "online", observed, source)).toMatchObject([
      { provider: "codex", status: "ready" },
      { provider: "claude-code", status: "checking" },
    ]);
    expect(projectComputerImCliReadiness("c", "online", observed, source)).toMatchObject([
      { provider: "feishu", status: "ready" },
      { provider: "slack", status: "checking" },
    ]);
    expect(() => rejectUnsupportedClientVersion("0.0.1")).toThrow(AuthServiceError);
  });
});

describe("Onboarding reset and setup services", () => {
  it("reboards a staging Account without deleting its existing resources", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const issued = await machine.issueForAccount(bootstrap.userId, {});
    const exchange = await machine.exchangeConnectCode(exchangeInput(issued.code));
    await unit.database.update(users).set({ setupCompletedAt: NOW }).where(eq(users.id, bootstrap.userId));

    const reboard = new OnboardingResetService({
      agents: { suspendById: vi.fn(), deleteById: vi.fn() },
      database: unit.database,
      environment: "staging",
      now: () => NOW,
    });
    await reboard.reboard(bootstrap.userId);

    const [user] = await unit.database.select().from(users).where(eq(users.id, bootstrap.userId));
    expect(user?.setupCompletedAt).toBeNull();
    expect((await unit.database.select().from(computers)).map((row) => row.id)).toContain(exchange.computerId);
    expect((await unit.database.select().from(computerCredentials)).length).toBe(1);
    expect((await unit.database.select().from(computerConnectCodes)).length).toBe(1);

    const disabled = new OnboardingResetService({
      agents: { suspendById: vi.fn(), deleteById: vi.fn() },
      database: unit.database,
      environment: "prod",
    });
    await expect(disabled.reboard(bootstrap.userId)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await unit.database.update(users).set({ suspendedAt: NOW }).where(eq(users.id, bootstrap.userId));
    await expect(reboard.reboard(bootstrap.userId)).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
  });

  it("resets owned active resources, revokes credentials and codes, and clears setup", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const firstCode = await machine.issueForAccount(bootstrap.userId, {});
    const exchange = await machine.exchangeConnectCode(exchangeInput(firstCode.code));
    const secondCode = await machine.issueForAccount(bootstrap.userId, {});
    const [agent] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: bootstrap.userId,
        computerId: exchange.computerId,
        name: "agent",
        displayName: "Agent",
        runtimeProvider: "codex",
        status: "active",
      })
      .returning();
    if (!agent) throw new Error("agent fixture missing");
    await unit.database.update(users).set({ setupCompletedAt: NOW }).where(eq(users.id, bootstrap.userId));
    const suspend = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn(async (_userId: string, id: string) => {
      await unit.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, id));
    });
    const close = vi.fn().mockResolvedValue(true);
    const reset = new OnboardingResetService({
      agents: { suspendById: suspend, deleteById: remove },
      database: unit.database,
      environment: "staging",
      now: () => NOW,
      registry: { closeComputer: close },
    });
    await reset.resetOnboarding(bootstrap.userId);
    expect(suspend).toHaveBeenCalledWith(bootstrap.userId, agent.id);
    expect(remove).toHaveBeenCalledWith(bootstrap.userId, agent.id);
    expect(close).toHaveBeenCalledWith(exchange.computerId);
    const [user] = await unit.database.select().from(users).where(eq(users.id, bootstrap.userId));
    const [computer] = await unit.database.select().from(computers).where(eq(computers.id, exchange.computerId));
    expect(user?.setupCompletedAt).toBeNull();
    expect(computer).toMatchObject({ currentInstanceId: null, connectedAt: null });
    expect((await unit.database.select().from(computerCredentials)).every((row) => row.revokedAt)).toBe(true);
    expect(
      (await unit.database.select().from(computerConnectCodes))
        .filter((row) => row.consumedAt === null)
        .every((row) => row.revokedAt),
    ).toBe(true);
    expect(secondCode.code).toMatch(/^otcc_/u);
  });

  it("keeps setup when cleanup verification fails, refuses non-staging, and handles suspended accounts", async () => {
    const bootstrap = await account();
    await unit.database
      .update(users)
      .set({ setupCompletedAt: NOW, suspendedAt: NOW })
      .where(eq(users.id, bootstrap.userId));
    const disabled = new OnboardingResetService({
      agents: { suspendById: vi.fn(), deleteById: vi.fn() },
      database: unit.database,
      environment: "prod",
    });
    await expect(disabled.resetOnboarding(bootstrap.userId)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const staging = new OnboardingResetService({
      agents: { suspendById: vi.fn(), deleteById: vi.fn() },
      database: unit.database,
      environment: "staging",
    });
    await expect(staging.resetOnboarding(bootstrap.userId)).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
    const [empty] = await unit.database
      .insert(users)
      .values({ email: "other@example.com", displayName: "Other", setupCompletedAt: NOW })
      .returning({ id: users.id });
    if (!empty) throw new Error("empty Account fixture missing");
    const hook = vi.fn().mockRejectedValue(new Error("interleaved"));
    const clean = new OnboardingResetService({
      afterVerified: hook,
      agents: { suspendById: vi.fn(), deleteById: vi.fn() },
      database: unit.database,
      environment: "staging",
      now: () => NOW,
    });
    await expect(clean.resetOnboarding(empty.id)).rejects.toThrow("interleaved");
    const [still] = await unit.database.select().from(users).where(eq(users.id, empty.id));
    expect(still?.setupCompletedAt).toEqual(NOW);
  });

  it("reports active resources when an Agent lifecycle fails to remove them", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const issued = await machine.issueForAccount(bootstrap.userId, {});
    const exchange = await machine.exchangeConnectCode(exchangeInput(issued.code));
    await unit.database.insert(agents).values({
      createdByUserId: bootstrap.userId,
      computerId: exchange.computerId,
      name: "stuck",
      displayName: "Stuck",
      runtimeProvider: "codex",
      status: "active",
    });
    const reset = new OnboardingResetService({
      agents: { suspendById: vi.fn(), deleteById: vi.fn() },
      database: unit.database,
      environment: "staging",
      now: () => NOW,
    });
    await expect(reset.resetOnboarding(bootstrap.userId)).rejects.toMatchObject({
      code: "ONBOARDING_RESET_UNVERIFIED",
      statusCode: 409,
    });
  });

  it("adopts an owned active Agent with no handoff or runtime gate, and refuses every other target", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const issued = await machine.issueForAccount(bootstrap.userId, {});
    const exchange = await machine.exchangeConnectCode(exchangeInput(issued.code));
    const [agent] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: bootstrap.userId,
        computerId: exchange.computerId,
        name: "setup",
        displayName: "Setup",
        runtimeProvider: "codex",
        status: "active",
      })
      .returning();
    if (!agent) throw new Error("agent fixture missing");
    // No binding, no handoff, no runtime observation exists for this Agent at all: adoption opens
    // normal app access on ownership and active status alone.
    const setup = new AccountSetupService(unit.database, { now: () => NOW });
    const [other] = await unit.database
      .insert(users)
      .values({ email: "setup-other@example.com", displayName: "Other" })
      .returning({ id: users.id });
    if (!other) throw new Error("other Account fixture missing");
    await expect(setup.completeForAccount(bootstrap.userId, agent.id)).resolves.toEqual({
      setupCompletedAt: NOW.toISOString(),
    });
    await expect(setup.completeForAccount(bootstrap.userId, agent.id)).resolves.toEqual({
      setupCompletedAt: NOW.toISOString(),
    });
    // Once granted, admission never reopens: suspending the adopted Agent afterwards changes nothing.
    await unit.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, agent.id));
    await expect(setup.completeForAccount(bootstrap.userId, agent.id)).resolves.toEqual({
      setupCompletedAt: NOW.toISOString(),
    });
    // A foreign Account cannot adopt someone else's Agent, and a missing id is indistinguishable.
    await expect(setup.completeForAccount(other.id, agent.id)).rejects.toMatchObject({
      code: "ACCOUNT_SETUP_AGENT_NOT_FOUND",
      statusCode: 404,
    });
    await expect(setup.completeForAccount(other.id, randomUUID())).rejects.toMatchObject({
      code: "ACCOUNT_SETUP_AGENT_NOT_FOUND",
      statusCode: 404,
    });
    // An inactive target fails closed even for its owner (this Account has not completed setup).
    const [suspended] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: other.id,
        name: "retired",
        displayName: "Retired",
        runtimeProvider: "codex",
        status: "suspended",
      })
      .returning({ id: agents.id });
    if (!suspended) throw new Error("suspended Agent fixture missing");
    await expect(setup.completeForAccount(other.id, suspended.id)).rejects.toMatchObject({
      code: "ACCOUNT_SETUP_AGENT_NOT_FOUND",
      statusCode: 404,
    });
    expect(new AccountSetupServiceError("ACCOUNT_SETUP_AGENT_NOT_FOUND", 404, "x")).toBeInstanceOf(Error);
    expect(new OnboardingResetError("ONBOARDING_RESET_UNVERIFIED", 409, "x")).toBeInstanceOf(Error);
  });

  it("adopts an owned active Agent that has no Computer bound yet", async () => {
    const bootstrap = await account();
    const [unbound] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: bootstrap.userId,
        name: "unbound",
        displayName: "Unbound",
        runtimeProvider: "codex",
        status: "active",
      })
      .returning({ id: agents.id });
    if (!unbound) throw new Error("unbound Agent fixture missing");
    const setup = new AccountSetupService(unit.database, { now: () => NOW });
    await expect(setup.completeForAccount(bootstrap.userId, unbound.id)).resolves.toEqual({
      setupCompletedAt: NOW.toISOString(),
    });
  });

  it("rechecks the setup Agent under lock before writing the completion marker", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const issued = await machine.issueForAccount(bootstrap.userId, {});
    const exchange = await machine.exchangeConnectCode(exchangeInput(issued.code));
    const [agent] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: bootstrap.userId,
        computerId: exchange.computerId,
        name: "race",
        displayName: "Race",
        runtimeProvider: "codex",
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent fixture missing");
    // The Agent vanishes between the preflight ownership read and the locked write, which is the
    // race the in-transaction recheck exists to refuse.
    const database = deletingOnTransaction(() =>
      unit.database
        .delete(agents)
        .where(eq(agents.id, agent.id))
        .then(() => undefined),
    );
    const setup = new AccountSetupService(database, { now: () => NOW });
    await expect(setup.completeForAccount(bootstrap.userId, agent.id)).rejects.toMatchObject({
      code: "ACCOUNT_SETUP_AGENT_NOT_FOUND",
    });
    const [surviving] = await unit.database
      .select({ setupCompletedAt: users.setupCompletedAt })
      .from(users)
      .where(eq(users.id, bootstrap.userId));
    expect(surviving?.setupCompletedAt).toBeNull();
  });

  it("rechecks the Account itself under lock before writing the completion marker", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const issued = await machine.issueForAccount(bootstrap.userId, {});
    const exchange = await machine.exchangeConnectCode(exchangeInput(issued.code));
    const [agent] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: bootstrap.userId,
        computerId: exchange.computerId,
        name: "vanishing",
        displayName: "Vanishing",
        runtimeProvider: "codex",
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent fixture missing");
    const database = deletingOnTransaction(async () => {
      await unit.database.delete(agents).where(eq(agents.createdByUserId, bootstrap.userId));
      await unit.database.delete(computerCredentials).where(eq(computerCredentials.issuedByUserId, bootstrap.userId));
      await unit.database
        .delete(computerConnectCodes)
        .where(eq(computerConnectCodes.issuedByAccountId, bootstrap.userId));
      await unit.database.delete(computers).where(eq(computers.ownerAccountId, bootstrap.userId));
      await unit.database.delete(accountCliLoginCodes).where(eq(accountCliLoginCodes.userId, bootstrap.userId));
      await unit.database.delete(users).where(eq(users.id, bootstrap.userId));
    });
    const setup = new AccountSetupService(database, { now: () => NOW });
    await expect(setup.completeForAccount(bootstrap.userId, agent.id)).rejects.toMatchObject({
      code: "ACCOUNT_SETUP_AGENT_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("small authentication service boundaries", () => {
  it("resolves only the single configured development Account", async () => {
    const bootstrap = await account({ email: "DEV@Example.com" });
    await expect(new DevBrowserAuthService(unit.database, "dev@example.com").resolveUserId()).resolves.toBe(
      bootstrap.userId,
    );
    await expect(new DevBrowserAuthService(unit.database, "missing@example.com").resolveUserId()).rejects.toMatchObject(
      { code: "AUTH_DEV_USER_UNAVAILABLE" },
    );
    const [duplicate] = await unit.database
      .insert(users)
      .values({ email: "duplicate@example.com", displayName: "Duplicate" })
      .returning({ id: users.id });
    if (!duplicate) throw new Error("duplicate fixture missing");
    await expect(new DevBrowserAuthService(unit.database, "duplicate@example.com").resolveUserId()).resolves.toBe(
      duplicate.id,
    );
  });

  it("locks active Accounts in post-authentication hooks", async () => {
    const service = new PostAuthenticationService(unit.database);
    const bootstrap = await account();
    await expect(service.complete(bootstrap.userId, false)).resolves.toEqual({ userId: bootstrap.userId });
    await expect(service.ensureAccountReady(randomUUID())).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
    await unit.database.update(users).set({ suspendedAt: NOW }).where(eq(users.id, bootstrap.userId));
    await expect(service.completeInTransaction(unit.database as never, bootstrap.userId, true)).rejects.toMatchObject({
      code: "AUTH_USER_SUSPENDED",
    });
  });

  it("runs the internal development sign-in plugin through Better Auth", async () => {
    const bootstrap = await account();
    const auth = createBetterAuth(unit.database, {
      onSessionCreating: async () => {},
      publicUrl: "http://localhost:8000",
      secret: SECRET,
      secureCookies: false,
      sessionTtlSeconds: 600,
      devSignIn: async () => bootstrap.userId,
    });
    const response = await auth.handler(
      new Request("http://localhost:8000/api/v1/auth/dev/sign-in", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: bootstrap.userId });
    expect(await unit.database.select().from(authSessions)).toHaveLength(1);
    const missing = createBetterAuth(unit.database, {
      onSessionCreating: async () => {},
      publicUrl: "http://localhost:8000",
      secret: SECRET,
      secureCookies: false,
      sessionTtlSeconds: 600,
      devSignIn: async () => randomUUID(),
    });
    const missingResponse = await missing.handler(
      new Request("http://localhost:8000/api/v1/auth/dev/sign-in", { method: "POST" }),
    );
    expect(missingResponse.status).toBe(401);
    const suspended = createBetterAuth(unit.database, {
      onSessionCreating: async () => {},
      publicUrl: "http://localhost:8000",
      secret: SECRET,
      secureCookies: false,
      sessionTtlSeconds: 600,
      devSignIn: async () => {
        throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "suspended", 403);
      },
    });
    const suspendedResponse = await suspended.handler(
      new Request("http://localhost:8000/api/v1/auth/dev/sign-in", { method: "POST" }),
    );
    expect(suspendedResponse.status).toBe(403);
  });

  it("covers Better Auth request forwarding and response/error bridges", async () => {
    const seen: Request[] = [];
    const auth = {
      handler: vi.fn(async (request: Request) => {
        seen.push(request);
        return new Response("payload", { status: 201, headers: { "x-answer": "yes", "set-cookie": "a=1; Path=/" } });
      }),
      $context: Promise.resolve({ authCookies: { sessionToken: { name: "session" } } }),
    } as unknown as OpenTagBetterAuth;
    const request = {
      url: "/api/v1/auth/callback/google",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10" },
      body: Buffer.from('{"x":1}'),
    } as unknown as FastifyRequest;
    const forwarded = await callBetterAuth(auth, "https://public.example", request);
    expect(forwarded.status).toBe(201);
    expect(seen[0]?.url).toBe("https://public.example/api/v1/auth/callback/google");
    const overridden = await callBetterAuth(auth, "https://public.example", request, {
      path: "/sign-out",
      method: "POST",
      body: { ok: true },
    });
    expect(overridden.status).toBe(201);
    expect(seen[1]?.url).toBe("https://public.example/api/v1/auth/sign-out");
    const written: Record<string, unknown> = {};
    const replyMock = {
      status: vi.fn((value) => {
        written.status = value;
        return reply;
      }),
      header: vi.fn((name, value) => {
        written[name] = value;
        return reply;
      }),
      send: vi.fn((value) => {
        written.body = value;
        return reply;
      }),
      getHeader: vi.fn(() => undefined),
    };
    const reply = replyMock as unknown as FastifyReply;
    await sendBetterAuthResponse(
      reply,
      new Response("hello", { status: 202, headers: { "x-test": "ok", "set-cookie": "b=2; Path=/" } }),
    );
    expect(written.status).toBe(202);
    expect(replyMock.send).toHaveBeenCalledWith(expect.any(Buffer));
    await sendBetterAuthResponse(reply, new Response(null, { status: 204 }));
    const fallback = new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "fallback", 401);
    await expect(
      betterAuthFailure(
        new Response(JSON.stringify({ code: "AUTH_INVALID_TOKEN", message: "bad" }), { status: 401 }),
        fallback,
      ),
    ).resolves.toMatchObject({ message: "bad", statusCode: 401 });
    await expect(betterAuthFailure(new Response("not-json", { status: 500 }), fallback)).resolves.toBe(fallback);
  });
});

describe("Better Auth configuration helpers", () => {
  it("runs the configured session hook and strips provider credentials", async () => {
    const called: string[] = [];
    const bootstrap = await account();
    const auth = createBetterAuth(unit.database, {
      onSessionCreating: async (id) => {
        called.push(id);
      },
      publicUrl: "http://localhost:8000",
      secret: SECRET,
      secureCookies: false,
      sessionTtlSeconds: 120,
      emailPassword: true,
      google: { clientId: "id", clientSecret: "secret" },
    });
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession(bootstrap.userId);
    expect(session.userId).toBe(bootstrap.userId);
    expect(called).toEqual([bootstrap.userId]);
    expect(context.authCookies.sessionToken.name).toBeTruthy();
    await expect(context.internalAdapter.findUserById(randomUUID())).resolves.toBeNull();
    await expect(context.internalAdapter.updateUser(bootstrap.userId, { name: "Changed" })).resolves.toBeTruthy();
    const identity = await context.internalAdapter.createAccount({
      userId: bootstrap.userId,
      providerId: "google",
      accountId: "hook-subject",
      issuer: "https://accounts.google.com",
      accessToken: "secret-token",
      refreshToken: "refresh-token",
      idToken: "id-token",
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
    });
    expect(identity).toBeTruthy();
    const [stored] = await unit.database
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, bootstrap.userId));
    expect(stored).toMatchObject({
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
  });
});

describe("bootstrap CLI entrypoint", () => {
  it("loads configuration, migrates, bootstraps, prints, and closes its client", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const end = vi.fn(async () => {});
    const parse = vi.fn(() => ({ databaseUrl: "postgresql://unit", migrationsDirectory: "/migrations" }));
    const migrate = vi.fn(async () => {});
    const bootstrap = vi.fn(async () => ({ connectCode: "throwaway", expiresAt: NOW, userId: "user-id" }));
    vi.resetModules();
    vi.doMock("../config.js", () => ({ parseDatabaseConfig: parse }));
    vi.doMock("../db/migrate.js", () => ({ migrateDatabase: migrate }));
    vi.doMock("../db/client.js", () => ({ createDatabaseClient: vi.fn(() => ({ database: {}, sql: { end } })) }));
    vi.doMock("../admin/bootstrap.js", () => ({
      BootstrapAdminInputSchema: { parse: vi.fn((input) => input) },
      bootstrapInitialAdmin: bootstrap,
    }));
    process.env.OPENTAG_BOOTSTRAP_DISPLAY_NAME = "Unit Admin";
    process.env.OPENTAG_BOOTSTRAP_EMAIL = "unit@example.com";
    const entrypoint = "../admin/bootstrap-cli.js";
    await import(entrypoint);
    expect(parse).toHaveBeenCalled();
    expect(migrate).toHaveBeenCalledWith("postgresql://unit", "/migrations");
    expect(bootstrap).toHaveBeenCalledWith({}, { displayName: "Unit Admin", email: "unit@example.com" });
    expect(output).toHaveBeenCalledWith(expect.stringContaining("throwaway"));
    expect(end).toHaveBeenCalledOnce();
    output.mockRestore();
    delete process.env.OPENTAG_BOOTSTRAP_DISPLAY_NAME;
    delete process.env.OPENTAG_BOOTSTRAP_EMAIL;
    vi.doUnmock("../config.js");
    vi.doUnmock("../db/migrate.js");
    vi.doUnmock("../db/client.js");
    vi.doUnmock("../admin/bootstrap.js");
  });
});
