import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  accountComputers,
  agents,
  computerConnectCodes,
  computerCredentials,
  computers,
  imBindings,
  sessionPlacements,
  sessions,
  users,
  workspaceAdminGrants,
  workspaceComputerCredentials,
  workspaceComputers,
  workspaces,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { AgentService } from "../../services/agents/index.js";
import { AuthServiceError } from "../../services/auth/index.js";
import { MachineAuthService } from "../../services/computers/index.js";
import { OnboardingResetService } from "../../services/onboarding-lab/index.js";
import { bootstrapTestAccount as bootstrapInitialAdmin } from "../test-account.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

interface SeededAccount {
  accountId: string;
  agentId: string;
  computerId: string;
  enrollmentId: string;
  imBindingId: string;
  machineToken: string;
  outstandingConnectCode: string;
  sessionId: string;
  workspaceId: string;
}

async function fixture(
  options: {
    afterCleanup?: (context: {
      database: DatabaseClient;
      agents: AgentService;
      machineAuth: MachineAuthService;
      lab: SeededAccount;
    }) => Promise<void>;
    afterVerified?: () => Promise<void>;
    closeEnrollment?: (enrollmentId: string) => Promise<boolean>;
  } = {},
) {
  const client = createDatabaseClient(databaseUrl);
  const registry = new ConnectionRegistry();
  const closeEnrollment = vi.fn(
    options.closeEnrollment ?? ((enrollmentId: string) => registry.closeEnrollment(enrollmentId)),
  );
  const machineAuth = new MachineAuthService(client.database);
  const agentService = new AgentService(client.database);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Lab",
    email: "onboarding-test@company.example",
    workspaceDisplayName: "Lab",
    workspaceName: "lab",
  });
  const lab = await seedAccount(client.database, agentService, machineAuth, {
    accountId: bootstrap.userId,
    agentName: "lab-agent",
    externalAppId: "cli_lab",
  });
  const interleave = options.afterCleanup;
  const reset = new OnboardingResetService({
    ...(interleave
      ? {
          afterCleanup: async () => interleave({ database: client.database, agents: agentService, machineAuth, lab }),
        }
      : {}),
    ...(options.afterVerified ? { afterVerified: options.afterVerified } : {}),
    agents: agentService,
    database: client.database,
    environment: "staging",
    registry: { closeEnrollment },
  });
  return { ...client, agentService, closeEnrollment, lab, machineAuth, registry, reset };
}

async function seedAccount(
  database: DatabaseClient,
  agentService: AgentService,
  machineAuth: MachineAuthService,
  input: { accountId: string; agentName: string; externalAppId: string },
): Promise<SeededAccount> {
  const computerId = crypto.randomUUID();
  const issued = await machineAuth.issueForAccount(input.accountId, {});
  const enrollment = await machineAuth.exchangeConnectCode({
    code: issued.code,
    computerId,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const outstanding = await machineAuth.issueForAccount(input.accountId, {});
  const agent = await agentService.createForAccount(input.accountId, {
    computerId: enrollment.workspaceComputerId,
    displayName: "Lab Agent",
    name: input.agentName,
    runtimeProvider: "codex",
  });
  const now = new Date();
  const [imBinding] = await database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: input.externalAppId,
      externalBotId: "bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "encrypted-credential",
      grantedCapabilities: ["im:message"],
      setupAttemptId: crypto.randomUUID(),
      setupIntent: "create",
      setupState: "succeeded",
      setupOwnerInstanceId: crypto.randomUUID(),
      setupOwnerHeartbeatAt: now,
      encryptedSetupContext: "encrypted-setup-context",
      setupExpiresAt: new Date(now.getTime() + 600_000),
      activatedAt: now,
    })
    .returning({ id: imBindings.id });
  if (!imBinding) throw new Error("IM binding fixture was not created");
  const [session] = await database
    .insert(sessions)
    .values({ imBindingId: imBinding.id, channelId: "channel-1", conversationKind: "channel", kind: "channel" })
    .returning({ id: sessions.id });
  if (!session) throw new Error("Session fixture was not created");
  await database.insert(sessionPlacements).values({
    sessionId: session.id,
    workspaceComputerId: enrollment.workspaceComputerId,
    computerId: enrollment.workspaceComputerId,
    generation: 1,
  });
  await database.update(workspaces).set({ setupCompletedAt: now }).where(eq(workspaces.id, enrollment.workspaceId));
  await database.update(users).set({ setupCompletedAt: now }).where(eq(users.id, input.accountId));
  return {
    accountId: input.accountId,
    agentId: agent.id,
    computerId,
    enrollmentId: enrollment.workspaceComputerId,
    imBindingId: imBinding.id,
    machineToken: enrollment.machineToken,
    outstandingConnectCode: outstanding.code,
    sessionId: session.id,
    workspaceId: enrollment.workspaceId,
  };
}

async function seedOtherAccount(
  database: DatabaseClient,
  agentService: AgentService,
  machineAuth: MachineAuthService,
): Promise<SeededAccount> {
  const [account] = await database
    .insert(users)
    .values({ displayName: "Other", email: "other@example.com" })
    .returning({ id: users.id });
  if (!account) throw new Error("Other Account fixture was not created");
  return seedAccount(database, agentService, machineAuth, {
    accountId: account.id,
    agentName: "other-agent",
    externalAppId: "cli_other",
  });
}

async function facts(database: DatabaseClient, scope: SeededAccount) {
  const [
    activeAgents,
    activeBindings,
    openSessions,
    ownedComputers,
    activeCredentials,
    usableCodes,
    workspaceRow,
    bindingRow,
  ] = await Promise.all([
    database
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.createdByUserId, scope.accountId), eq(agents.status, "active"))),
    database
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(and(eq(imBindings.agentId, scope.agentId), eq(imBindings.status, "active"))),
    database
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, scope.sessionId), isNull(sessions.endedAt))),
    database
      .select({ id: accountComputers.id })
      .from(accountComputers)
      .where(eq(accountComputers.ownerAccountId, scope.accountId)),
    database
      .select({ id: computerCredentials.id })
      .from(computerCredentials)
      .innerJoin(accountComputers, eq(accountComputers.id, computerCredentials.computerId))
      .where(and(eq(accountComputers.ownerAccountId, scope.accountId), isNull(computerCredentials.revokedAt))),
    database
      .select({ id: computerConnectCodes.id })
      .from(computerConnectCodes)
      .where(
        and(
          eq(computerConnectCodes.issuedByAccountId, scope.accountId),
          isNull(computerConnectCodes.consumedAt),
          isNull(computerConnectCodes.revokedAt),
        ),
      ),
    database
      .select({ setupCompletedAt: workspaces.setupCompletedAt })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId)),
    database
      .select({
        status: imBindings.status,
        encryptedCredential: imBindings.encryptedCredential,
        encryptedSetupContext: imBindings.encryptedSetupContext,
      })
      .from(imBindings)
      .where(eq(imBindings.id, scope.imBindingId)),
  ]);
  const [accountRow] = await database
    .select({ setupCompletedAt: users.setupCompletedAt })
    .from(users)
    .where(eq(users.id, scope.accountId));
  return {
    activeAgents: activeAgents.length,
    activeBindings: activeBindings.length,
    openSessions: openSessions.length,
    ownedComputers: ownedComputers.length,
    activeCredentials: activeCredentials.length,
    usableCodes: usableCodes.length,
    setupCompletedAt: workspaceRow[0]?.setupCompletedAt ?? null,
    accountSetupCompletedAt: accountRow?.setupCompletedAt ?? null,
    binding: bindingRow[0],
  };
}

async function legacySnapshot(database: DatabaseClient, scope: SeededAccount) {
  const [workspace, computer, credentials] = await Promise.all([
    database.select().from(workspaces).where(eq(workspaces.id, scope.workspaceId)),
    database.select().from(workspaceComputers).where(eq(workspaceComputers.id, scope.enrollmentId)),
    database
      .select()
      .from(workspaceComputerCredentials)
      .where(eq(workspaceComputerCredentials.workspaceComputerId, scope.enrollmentId)),
  ]);
  return { workspace, computer, credentials };
}

describe("staging Onboarding Lab reset", () => {
  it("returns only canonical Account resources to a verified first-run state", async () => {
    const value = await fixture();
    const before = await facts(value.database, value.lab);
    const legacyBefore = await legacySnapshot(value.database, value.lab);
    expect(before).toMatchObject({ activeAgents: 1, activeBindings: 1, openSessions: 1, ownedComputers: 1 });
    expect(before.setupCompletedAt).not.toBeNull();
    expect(before.accountSetupCompletedAt).not.toBeNull();

    await value.reset.resetOnboarding(value.lab.accountId);

    const after = await facts(value.database, value.lab);
    expect(after).toMatchObject({
      activeAgents: 0,
      activeBindings: 0,
      openSessions: 0,
      ownedComputers: 1,
      activeCredentials: 0,
      usableCodes: 0,
      accountSetupCompletedAt: null,
    });
    expect(after.setupCompletedAt).toEqual(before.setupCompletedAt);
    expect(await legacySnapshot(value.database, value.lab)).toEqual(legacyBefore);
    expect(after.binding).toMatchObject({
      status: "disabled",
      encryptedCredential: null,
      encryptedSetupContext: null,
    });
    expect(value.closeEnrollment).toHaveBeenCalledWith(value.lab.enrollmentId);
  });

  it("retains historical identity rows that no longer satisfy an active fact", async () => {
    const value = await fixture();

    await value.reset.resetOnboarding(value.lab.accountId);

    const [account] = await value.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, value.lab.accountId));
    const [agent] = await value.database
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, value.lab.agentId));
    const [computer] = await value.database
      .select({ id: computers.id })
      .from(computers)
      .where(eq(computers.id, value.lab.computerId));
    const [session] = await value.database
      .select({ endedAt: sessions.endedAt })
      .from(sessions)
      .where(eq(sessions.id, value.lab.sessionId));
    expect(account?.id).toBe(value.lab.accountId);
    expect(agent?.status).toBe("deleted");
    expect(computer?.id).toBe(value.lab.computerId);
    expect(session?.endedAt).not.toBeNull();
  });

  it("invalidates the previous machine token and the outstanding connect code", async () => {
    const value = await fixture();
    await expect(value.machineAuth.verifyMachineToken(value.lab.machineToken)).resolves.toMatchObject({
      computerId: value.lab.computerId,
    });

    await value.reset.resetOnboarding(value.lab.accountId);

    await expect(value.machineAuth.verifyMachineToken(value.lab.machineToken)).rejects.toBeInstanceOf(AuthServiceError);
    await expect(
      value.machineAuth.exchangeConnectCode({
        code: value.lab.outstandingConnectCode,
        computerId: value.lab.computerId,
        displayName: "workstation",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.2",
      }),
    ).rejects.toBeInstanceOf(AuthServiceError);
  });

  it("repairs the stable logical Computer after reset without creating a new legacy projection", async () => {
    const value = await fixture();
    await value.reset.resetOnboarding(value.lab.accountId);

    const issued = await value.machineAuth.issueForAccount(value.lab.accountId, {
      mode: "repair",
      targetComputerId: value.lab.enrollmentId,
    });
    const reconnected = await value.machineAuth.exchangeConnectCode({
      code: issued.code,
      computerId: value.lab.computerId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    });

    expect(reconnected.computerId).toBe(value.lab.computerId);
    expect(reconnected.workspaceComputerId).toBe(value.lab.enrollmentId);
    expect(reconnected.machineToken).not.toBe(value.lab.machineToken);
    const rows = await value.database
      .select({ id: computers.id })
      .from(computers)
      .where(eq(computers.id, value.lab.computerId));
    expect(rows).toHaveLength(1);
  });

  it("succeeds when it runs again on an already reset Account", async () => {
    const value = await fixture();

    await value.reset.resetOnboarding(value.lab.accountId);
    await expect(value.reset.resetOnboarding(value.lab.accountId)).resolves.toBeUndefined();

    const after = await facts(value.database, value.lab);
    expect(after.accountSetupCompletedAt).toBeNull();
    expect(after.setupCompletedAt).not.toBeNull();
  });

  it("keeps setup completion until cleanup is verified and converges on retry", async () => {
    let failNext = true;
    const value = await fixture({
      closeEnrollment: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("The Computer connection could not be closed");
        }
        return true;
      },
    });

    await expect(value.reset.resetOnboarding(value.lab.accountId)).rejects.toThrow(
      "The Computer connection could not be closed",
    );
    const staged = await facts(value.database, value.lab);
    expect(staged.accountSetupCompletedAt).not.toBeNull();
    expect(staged).toMatchObject({ activeAgents: 0, ownedComputers: 1, activeCredentials: 0 });

    await value.reset.resetOnboarding(value.lab.accountId);

    expect((await facts(value.database, value.lab)).accountSetupCompletedAt).toBeNull();
  });

  it("refuses to clear setup completion when a writer interleaves before the commit", async () => {
    // The same Account asks for a Computer connect command mid-reset, from another session or tab.
    let interleaved = false;
    const value = await fixture({
      afterCleanup: async ({ lab, machineAuth }) => {
        if (interleaved) return;
        interleaved = true;
        await machineAuth.issueForAccount(lab.accountId, {});
      },
    });

    await expect(value.reset.resetOnboarding(value.lab.accountId)).rejects.toMatchObject({
      code: "ONBOARDING_RESET_UNVERIFIED",
    });

    const staged = await facts(value.database, value.lab);
    expect(staged.accountSetupCompletedAt).not.toBeNull();
    expect(staged.usableCodes).toBe(1);

    // The retry revokes the interleaved code and converges.
    await value.reset.resetOnboarding(value.lab.accountId);
    expect(await facts(value.database, value.lab)).toMatchObject({ accountSetupCompletedAt: null, usableCodes: 0 });
  });

  it("holds the scope lock across verification and the setup marker", async () => {
    let pending: Promise<unknown> | undefined;
    let settled = false;
    let blockedWhileCommitting: boolean | undefined;
    const value = await fixture({
      afterVerified: async () => {
        // A writer that starts between verification and the marker must wait for this commit.
        pending = value.machineAuth.issueForAccount(value.lab.accountId, {}).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        blockedWhileCommitting = !settled;
      },
    });

    await value.reset.resetOnboarding(value.lab.accountId);
    await pending;

    expect(blockedWhileCommitting).toBe(true);
    // The interleaved command belongs to the new run: the marker cleared before it was issued.
    expect(await facts(value.database, value.lab)).toMatchObject({ accountSetupCompletedAt: null, usableCodes: 1 });
  });

  it("leaves another Account's resources unchanged", async () => {
    const value = await fixture();
    const other = await seedOtherAccount(value.database, value.agentService, value.machineAuth);

    await value.reset.resetOnboarding(value.lab.accountId);

    const untouched = await facts(value.database, other);
    expect(untouched).toMatchObject({
      activeAgents: 1,
      activeBindings: 1,
      openSessions: 1,
      ownedComputers: 1,
      activeCredentials: 1,
      usableCodes: 1,
    });
    expect(untouched.setupCompletedAt).not.toBeNull();
    await expect(value.machineAuth.verifyMachineToken(other.machineToken)).resolves.toMatchObject({
      computerId: other.computerId,
    });
  });

  it("refuses outside staging, whichever Account asks", async () => {
    const value = await fixture();
    const other = await seedOtherAccount(value.database, value.agentService, value.machineAuth);
    for (const environment of ["dev", "prod"] as const) {
      const guarded = new OnboardingResetService({
        agents: value.agentService,
        database: value.database,
        environment,
      });

      await expect(guarded.resetOnboarding(value.lab.accountId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(guarded.resetOnboarding(other.accountId)).rejects.toMatchObject({ statusCode: 404 });
      // Re-boarding is the lighter operation, not the less guarded one.
      await expect(guarded.reboard(value.lab.accountId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(guarded.reboard(other.accountId)).rejects.toMatchObject({ statusCode: 404 });
    }

    expect((await facts(value.database, value.lab)).activeAgents).toBe(1);
    expect((await facts(value.database, other)).activeAgents).toBe(1);
  });

  it("leaves another tester's Account untouched, so two testers never collide", async () => {
    const value = await fixture();
    const [other] = await value.database
      .insert(users)
      .values({ displayName: "Other tester", email: "other-tester@company.example" })
      .returning({ id: users.id });
    if (!other) throw new Error("Second tester fixture was not created");
    const second = await seedAccount(value.database, value.agentService, value.machineAuth, {
      accountId: other.id,
      agentName: "other-agent",
      externalAppId: "cli_other",
    });
    const before = await facts(value.database, second);

    await value.reset.resetOnboarding(value.lab.accountId);

    expect(await facts(value.database, value.lab)).toMatchObject({ activeAgents: 0, ownedComputers: 1 });
    expect(await facts(value.database, second)).toEqual(before);

    // And the second tester resets their own Account without disturbing the first, in either order.
    await value.reset.resetOnboarding(other.id);
    expect(await facts(value.database, second)).toMatchObject({ activeAgents: 0, ownedComputers: 1 });
  });

  it("resets every Computer owned by the Account instead of selecting one Workspace scope", async () => {
    const value = await fixture();
    const second = await seedAccount(value.database, value.agentService, value.machineAuth, {
      accountId: value.lab.accountId,
      agentName: "second-agent",
      externalAppId: "cli_second",
    });
    expect(await facts(value.database, value.lab)).toMatchObject({ activeAgents: 2, ownedComputers: 2 });

    await value.reset.resetOnboarding(value.lab.accountId);

    expect(await facts(value.database, value.lab)).toMatchObject({
      activeAgents: 0,
      ownedComputers: 2,
      activeCredentials: 0,
      accountSetupCompletedAt: null,
    });
    await expect(value.machineAuth.verifyMachineToken(second.machineToken)).rejects.toBeInstanceOf(AuthServiceError);
  });

  it("closes the live Computer connection in the registry", async () => {
    const value = await fixture();
    const socket = { close: vi.fn(), readyState: 1, terminate: vi.fn() };
    await value.registry.register(
      {
        computerId: value.lab.computerId,
        workspaceComputerId: value.lab.enrollmentId,
        workspaceId: value.lab.workspaceId,
        instanceId: crypto.randomUUID(),
        lastHeartbeatAt: Date.now(),
        socket: socket as never,
      },
      async () => undefined,
    );
    expect(value.registry.currentInstanceId(value.lab.enrollmentId)).toBeDefined();

    await value.reset.resetOnboarding(value.lab.accountId);

    expect(socket.close).toHaveBeenCalledWith(4002, "Machine credential rotated or revoked");
    expect(value.registry.currentInstanceId(value.lab.enrollmentId)).toBeUndefined();
  });

  it("does not read grants or rewrite historical Workspace evidence", async () => {
    const value = await fixture();
    const [foreign] = await value.database
      .insert(users)
      .values({ displayName: "Foreign", email: "foreign@example.com" })
      .returning({ id: users.id });
    if (!foreign) throw new Error("Foreign Account fixture was not created");
    await value.database.insert(agents).values({
      workspaceId: value.lab.workspaceId,
      createdByUserId: foreign.id,
      workspaceComputerId: value.lab.enrollmentId,
      computerId: value.lab.enrollmentId,
      name: "foreign-agent",
      displayName: "Foreign Agent",
      runtimeProvider: "codex",
      status: "deleted",
    });
    const grantedAt = new Date("2026-07-01T00:00:00.000Z");
    await value.database.insert(workspaceAdminGrants).values([
      {
        workspaceId: value.lab.workspaceId,
        userId: value.lab.accountId,
        grantedByUserId: value.lab.accountId,
        grantedAt,
      },
      {
        workspaceId: value.lab.workspaceId,
        userId: foreign.id,
        grantedByUserId: foreign.id,
        grantedAt,
      },
    ]);
    await value.database.insert(workspaceComputerCredentials).values({
      workspaceComputerId: value.lab.enrollmentId,
      secretHash: "a".repeat(64),
      issuedByUserId: foreign.id,
      issuedAt: grantedAt,
    });
    const legacyBefore = await legacySnapshot(value.database, value.lab);
    const grantsBefore = await value.database.select().from(workspaceAdminGrants);

    await value.reset.resetOnboarding(value.lab.accountId);

    expect(await legacySnapshot(value.database, value.lab)).toEqual(legacyBefore);
    expect(await value.database.select().from(workspaceAdminGrants)).toEqual(grantsBefore);
    expect(await facts(value.database, value.lab)).toMatchObject({
      activeAgents: 0,
      accountSetupCompletedAt: null,
      setupCompletedAt: expect.any(Date),
    });
  });

  it("clears setup for an Account with no Workspace, grant, Agent, or Computer", async () => {
    const value = await fixture();
    const [empty] = await value.database
      .insert(users)
      .values({
        displayName: "Empty",
        email: "empty@example.com",
        setupCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
      })
      .returning({ id: users.id });
    if (!empty) throw new Error("Empty Account fixture was not created");

    await value.reset.resetOnboarding(empty.id);

    const [row] = await value.database.select().from(users).where(eq(users.id, empty.id));
    expect(row?.setupCompletedAt).toBeNull();
  });
});

describe("re-boarding an Account without taking anything down", () => {
  it("clears setup completion and keeps every resource the Account has", async () => {
    const value = await fixture();
    const before = await facts(value.database, value.lab);
    expect(before).toMatchObject({ activeAgents: 1, activeBindings: 1, openSessions: 1, ownedComputers: 1 });
    expect(before.accountSetupCompletedAt).not.toBeNull();
    expect(before.activeCredentials).toBeGreaterThan(0);

    await value.reset.reboard(value.lab.accountId);

    const after = await facts(value.database, value.lab);
    // The whole point: onboarding is reachable again, and nothing had to be rebuilt to get there.
    expect(after.accountSetupCompletedAt).toBeNull();
    expect(after).toMatchObject({
      activeAgents: before.activeAgents,
      activeBindings: before.activeBindings,
      openSessions: before.openSessions,
      ownedComputers: before.ownedComputers,
      // Still enrolled: the machine token survives, so the Computer is not connected again.
      activeCredentials: before.activeCredentials,
    });
    expect(after.binding).toMatchObject({ status: before.binding?.status });
    // A reset closes the live enrollment; re-boarding has no reason to.
    expect(value.closeEnrollment).not.toHaveBeenCalled();
  });
});
