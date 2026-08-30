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
  accountComputers,
  agents,
  authIdentities,
  authSessions,
  computerConnectCodes,
  computerCredentials,
  users,
  workspaceComputers,
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
import { projectedComputerId } from "../services/computers/ownership-projections.js";
import {
  projectComputerImCliReadiness,
  projectComputerProviderReadiness,
} from "../services/computers/provider-readiness.js";
import { OnboardingResetError, OnboardingResetService } from "../services/onboarding-lab/index.js";
import { WorkspaceSetupService, WorkspaceSetupServiceError } from "../services/workspaces/index.js";
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

function enrollmentInput(code: string, computerId = randomUUID(), version = "0.0.2") {
  return {
    code,
    computerId: computerId as TestUuid,
    displayName: "Workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: version,
  };
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
    const computerId = randomUUID();
    const enrollment = await value.machine.exchangeConnectCode(enrollmentInput(value.issued.code, computerId));
    expect(enrollment).toMatchObject({
      computerId,
      workspaceId: expect.any(String),
      machineToken: expect.stringMatching(/^otmc_/),
    });
    await expect(value.machine.verifyMachineToken(enrollment.machineToken)).resolves.toMatchObject({
      computerId,
      workspaceComputerId: enrollment.workspaceComputerId,
    });
    await expect(value.machine.verifyMachineToken("bad-token")).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    await expect(value.machine.verifyMachineToken(`${enrollment.machineToken}x`)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    const tampered = `${enrollment.machineToken.slice(0, -1)}${enrollment.machineToken.endsWith("A") ? "B" : "A"}`;
    await expect(value.machine.verifyMachineToken(tampered)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    const repair = await value.machine.issueForAccount(value.bootstrap.userId, {
      mode: "repair",
      targetComputerId: enrollment.workspaceComputerId,
    });
    const replacement = await value.machine.exchangeConnectCode(enrollmentInput(repair.code, randomUUID(), "0.0.2"));
    await expect(value.machine.verifyMachineToken(enrollment.machineToken)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    await expect(value.machine.verifyMachineToken(replacement.machineToken)).resolves.toMatchObject({
      workspaceComputerId: enrollment.workspaceComputerId,
    });
    expect(await unit.database.select().from(computerCredentials)).toHaveLength(2);
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
        enrollmentInput(expired.code),
      ),
    ).rejects.toMatchObject({ code: "AUTH_CODE_EXPIRED" });
    const first = await value.machine.exchangeConnectCode(enrollmentInput(value.issued.code));
    const duplicate = await value.machine.issueForAccount(value.bootstrap.userId, {});
    await expect(
      value.machine.exchangeConnectCode(enrollmentInput(duplicate.code, first.computerId as TestUuid)),
    ).rejects.toThrow("Failed query");
    const repairCode = await value.machine.issueForAccount(value.bootstrap.userId, {
      mode: "repair",
      targetComputerId: first.workspaceComputerId,
    });
    const [other] = await unit.database
      .insert(users)
      .values({ email: "repair-owner@example.com", displayName: "Other" })
      .returning({ id: users.id });
    if (!other) throw new Error("repair owner fixture missing");
    await unit.database
      .update(accountComputers)
      .set({ ownerAccountId: other.id })
      .where(eq(accountComputers.id, first.workspaceComputerId));
    await expect(value.machine.exchangeConnectCode(enrollmentInput(repairCode.code))).rejects.toMatchObject({
      code: "AUTH_INVALID_CODE",
    });
  });

  it("runs credential-rotation callbacks and builds safe Computer connect commands", async () => {
    const rotated = vi.fn();
    const value = await machineFixture();
    const machine = new MachineAuthService(unit.database, { onCredentialRotated: rotated });
    const issued = await machine.issueForAccount(value.bootstrap.userId, {});
    await machine.exchangeConnectCode(enrollmentInput(issued.code));
    expect(rotated).toHaveBeenCalledOnce();
    const { buildComputerConnectCommand } = await import("../services/computers/machine-auth-service.js");
    expect(
      buildComputerConnectCommand({ code: "abc", environment: "staging", publicUrl: "https://dev.example.com" }),
    ).toContain("opentag-staging computer connect");
    expect(
      buildComputerConnectCommand({ code: "a'; echo nope", environment: "prod", publicUrl: "https://example.com/a b" }),
    ).toContain("'a'\\''; echo nope'");
    expect(
      buildComputerConnectCommand({ code: "abc", environment: "dev", publicUrl: "http://127.0.0.1:8000" }),
    ).toContain("dev-install.sh");
  });

  it("consumes one machine connect code when two exchanges race", async () => {
    const value = await machineFixture();
    const input = enrollmentInput(value.issued.code);
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
    const target = await value.machine.exchangeConnectCode(enrollmentInput(value.issued.code));
    await expect(
      value.machine.issueForAccount(value.bootstrap.userId, { mode: "repair" } as never),
    ).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
    });
    await expect(
      value.machine.issueForAccount(value.bootstrap.userId, { mode: "repair", targetComputerId: randomUUID() }),
    ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND" });
    await expect(value.machine.exchangeConnectCode(enrollmentInput("otcc_missing"))).rejects.toMatchObject({
      code: "AUTH_INVALID_CODE",
    });
    await expect(
      value.machine.exchangeConnectCode(enrollmentInput(value.issued.code, randomUUID(), "0.0.1")),
    ).rejects.toMatchObject({ code: "CLIENT_VERSION_UNSUPPORTED" });
    await expect(
      value.machine.exchangeConnectCode(enrollmentInput(value.issued.code, target.computerId as TestUuid)),
    ).rejects.toMatchObject({ code: "AUTH_CODE_CONSUMED" });
    const fresh = await value.machine.issueForAccount(value.bootstrap.userId, {});
    await unit.database.update(users).set({ suspendedAt: NOW }).where(eq(users.id, value.bootstrap.userId));
    await expect(value.machine.exchangeConnectCode(enrollmentInput(fresh.code))).rejects.toMatchObject({
      code: "AUTH_USER_SUSPENDED",
    });
  });

  it("registers, heartbeats, disconnects, lists, and fences Computer credentials", async () => {
    const value = await machineFixture();
    const computerId = randomUUID();
    const enrollment = await value.machine.exchangeConnectCode(enrollmentInput(value.issued.code, computerId));
    const service = new ComputerService(
      unit.database,
      { getActiveUserById: vi.fn() },
      { now: () => NOW, presenceTimeoutMs: 1000 },
    );
    const frame = {
      type: "computer:register" as const,
      requestId: randomUUID(),
      computerId,
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
    await expect(service.register(enrollment, { ...frame, computerId: randomUUID() })).rejects.toMatchObject({
      code: "COMPUTER_IDENTITY_CONFLICT",
    });
    await service.register(enrollment, frame);
    await unit.database.insert(agents).values([
      {
        workspaceId: enrollment.workspaceId,
        createdByUserId: value.bootstrap.userId,
        workspaceComputerId: enrollment.workspaceComputerId,
        computerId: enrollment.workspaceComputerId,
        name: "one",
        displayName: "One",
        runtimeProvider: "codex",
      },
      {
        workspaceId: enrollment.workspaceId,
        createdByUserId: value.bootstrap.userId,
        workspaceComputerId: enrollment.workspaceComputerId,
        computerId: enrollment.workspaceComputerId,
        name: "two",
        displayName: "Two",
        runtimeProvider: "codex",
      },
    ]);
    expect(await service.heartbeat(enrollment, frame.instanceId)).toBe(true);
    expect(await service.heartbeat(enrollment, randomUUID())).toBe(false);
    expect(await service.disconnect(enrollment.workspaceComputerId, frame.instanceId)).toBe(true);
    expect(await service.disconnect(enrollment.workspaceComputerId, frame.instanceId)).toBe(false);
    await expect(service.listAccountComputers(value.bootstrap.userId)).resolves.toMatchObject({
      computers: [
        { connectionStatus: "offline", agentIds: expect.arrayContaining([expect.any(String), expect.any(String)]) },
      ],
    });
    await service.register(enrollment, { ...frame, instanceId: randomUUID() });
    const listed = await service.listAccountComputers(value.bootstrap.userId, true);
    expect(listed.computers[0]).toMatchObject({
      connectionStatus: "online",
      agentIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
      providerReadiness: expect.any(Array),
      imCliReadiness: expect.any(Array),
    });
    await expect(service.assertActiveCredential(enrollment)).resolves.toBeUndefined();
    await unit.database
      .update(computerCredentials)
      .set({ revokedAt: NOW, revokedByUserId: value.bootstrap.userId })
      .where(eq(computerCredentials.id, enrollment.credentialId));
    await expect(service.assertActiveCredential(enrollment)).rejects.toMatchObject({ code: "COMPUTER_NOT_REGISTERED" });
    await expect(service.register(enrollment, frame)).rejects.toMatchObject({ code: "COMPUTER_NOT_REGISTERED" });
  });

  it("projects readiness for online and offline Computers and detects missing ownership projections", async () => {
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
    await expect(projectedComputerId(unit.database as never, randomUUID())).rejects.toThrow("projection is missing");
    expect(() => rejectUnsupportedClientVersion("0.0.1")).toThrow(AuthServiceError);
  });
});

describe("Onboarding Lab and setup services", () => {
  it("resets owned active resources, revokes credentials and codes, and clears setup", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const firstCode = await machine.issueForAccount(bootstrap.userId, {});
    const enrolled = await machine.exchangeConnectCode(enrollmentInput(firstCode.code));
    const secondCode = await machine.issueForAccount(bootstrap.userId, {});
    const [workspace] = await unit.database
      .select({ id: workspaceComputers.workspaceId })
      .from(workspaceComputers)
      .where(eq(workspaceComputers.id, enrolled.workspaceComputerId));
    if (!workspace) throw new Error("workspace fixture missing");
    const [agent] = await unit.database
      .insert(agents)
      .values({
        workspaceId: workspace.id,
        createdByUserId: bootstrap.userId,
        workspaceComputerId: enrolled.workspaceComputerId,
        computerId: enrolled.workspaceComputerId,
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
      registry: { closeEnrollment: close },
    });
    await reset.resetOnboarding(bootstrap.userId);
    expect(suspend).toHaveBeenCalledWith(bootstrap.userId, agent.id);
    expect(remove).toHaveBeenCalledWith(bootstrap.userId, agent.id);
    expect(close).toHaveBeenCalledWith(enrolled.workspaceComputerId);
    const [user] = await unit.database.select().from(users).where(eq(users.id, bootstrap.userId));
    const [computer] = await unit.database
      .select()
      .from(accountComputers)
      .where(eq(accountComputers.id, enrolled.workspaceComputerId));
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
    const enrolled = await machine.exchangeConnectCode(enrollmentInput(issued.code));
    const [workspace] = await unit.database
      .select({ id: workspaceComputers.workspaceId })
      .from(workspaceComputers)
      .where(eq(workspaceComputers.id, enrolled.workspaceComputerId));
    if (!workspace) throw new Error("workspace fixture missing");
    await unit.database.insert(agents).values({
      workspaceId: workspace.id,
      createdByUserId: bootstrap.userId,
      workspaceComputerId: enrolled.workspaceComputerId,
      computerId: enrolled.workspaceComputerId,
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

  it("completes setup only for an owned active Agent with a ready handoff", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const issued = await machine.issueForAccount(bootstrap.userId, {});
    const enrolled = await machine.exchangeConnectCode(enrollmentInput(issued.code));
    const [workspace] = await unit.database
      .select({ id: workspaceComputers.workspaceId })
      .from(workspaceComputers)
      .where(eq(workspaceComputers.id, enrolled.workspaceComputerId));
    if (!workspace) throw new Error("workspace fixture missing");
    const [agent] = await unit.database
      .insert(agents)
      .values({
        workspaceId: workspace.id,
        createdByUserId: bootstrap.userId,
        workspaceComputerId: enrolled.workspaceComputerId,
        computerId: enrolled.workspaceComputerId,
        name: "setup",
        displayName: "Setup",
        runtimeProvider: "codex",
        status: "active",
      })
      .returning();
    if (!agent) throw new Error("agent fixture missing");
    const ready = { getHandoffForAgent: vi.fn().mockResolvedValue({ handoffReady: true }) } as never;
    const setup = new WorkspaceSetupService(unit.database, ready, { now: () => NOW });
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
    await expect(setup.completeForAccount(other.id, randomUUID())).rejects.toMatchObject({
      code: "WORKSPACE_SETUP_AGENT_NOT_FOUND",
    });
    await unit.database.update(users).set({ setupCompletedAt: null }).where(eq(users.id, bootstrap.userId));
    const notReady = new WorkspaceSetupService(unit.database, {
      getHandoffForAgent: vi.fn().mockResolvedValue({ handoffReady: false }),
    } as never);
    await expect(notReady.completeForAccount(bootstrap.userId, agent.id)).rejects.toMatchObject({
      code: "WORKSPACE_SETUP_NOT_READY",
    });
    expect(new WorkspaceSetupServiceError("WORKSPACE_SETUP_NOT_READY", 409, "x")).toBeInstanceOf(Error);
    expect(new OnboardingResetError("ONBOARDING_RESET_UNVERIFIED", 409, "x")).toBeInstanceOf(Error);
  });

  it("rechecks the setup Agent under lock before writing the completion marker", async () => {
    const bootstrap = await account();
    const machine = new MachineAuthService(unit.database, { now: () => NOW });
    const issued = await machine.issueForAccount(bootstrap.userId, {});
    const enrolled = await machine.exchangeConnectCode(enrollmentInput(issued.code));
    const [workspace] = await unit.database
      .select({ id: workspaceComputers.workspaceId })
      .from(workspaceComputers)
      .where(eq(workspaceComputers.id, enrolled.workspaceComputerId));
    if (!workspace) throw new Error("workspace fixture missing");
    const [agent] = await unit.database
      .insert(agents)
      .values({
        workspaceId: workspace.id,
        createdByUserId: bootstrap.userId,
        workspaceComputerId: enrolled.workspaceComputerId,
        computerId: enrolled.workspaceComputerId,
        name: "race",
        displayName: "Race",
        runtimeProvider: "codex",
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent fixture missing");
    const getHandoffForAgent = vi.fn(async () => {
      await unit.database.delete(agents).where(eq(agents.id, agent.id));
      return { handoffReady: true };
    });
    const setup = new WorkspaceSetupService(unit.database, { getHandoffForAgent } as never, { now: () => NOW });
    await expect(setup.completeForAccount(bootstrap.userId, agent.id)).rejects.toMatchObject({
      code: "WORKSPACE_SETUP_AGENT_NOT_FOUND",
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
