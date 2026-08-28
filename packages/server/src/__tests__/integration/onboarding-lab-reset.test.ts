import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  agents,
  computerConnectCodes,
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
import { OnboardingResetError, OnboardingResetService } from "../../services/onboarding-lab/index.js";
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
    workspaceId: bootstrap.workspaceId,
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
  input: { accountId: string; workspaceId: string; agentName: string; externalAppId: string },
): Promise<SeededAccount> {
  const computerId = crypto.randomUUID();
  const issued = await machineAuth.issueForWorkspaceAdmin(input.accountId, input.workspaceId);
  const enrollment = await machineAuth.exchangeConnectCode({
    code: issued.code,
    computerId,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.1",
  });
  const outstanding = await machineAuth.issueForWorkspaceAdmin(input.accountId, input.workspaceId);
  const agent = await agentService.createForWorkspace(input.accountId, input.workspaceId, {
    computerId,
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
  await database
    .insert(sessionPlacements)
    .values({ sessionId: session.id, workspaceComputerId: enrollment.workspaceComputerId, generation: 1 });
  await database.update(workspaces).set({ setupCompletedAt: now }).where(eq(workspaces.id, input.workspaceId));
  return {
    accountId: input.accountId,
    agentId: agent.id,
    computerId,
    enrollmentId: enrollment.workspaceComputerId,
    imBindingId: imBinding.id,
    machineToken: enrollment.machineToken,
    outstandingConnectCode: outstanding.code,
    sessionId: session.id,
    workspaceId: input.workspaceId,
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
  const [workspace] = await database
    .insert(workspaces)
    .values({ name: "other", displayName: "Other" })
    .returning({ id: workspaces.id });
  if (!account || !workspace) throw new Error("Other Account fixture was not created");
  await database
    .insert(workspaceAdminGrants)
    .values({ workspaceId: workspace.id, userId: account.id, grantedByUserId: account.id });
  return seedAccount(database, agentService, machineAuth, {
    accountId: account.id,
    workspaceId: workspace.id,
    agentName: "other-agent",
    externalAppId: "cli_other",
  });
}

async function facts(database: DatabaseClient, scope: SeededAccount) {
  const [
    activeAgents,
    activeBindings,
    openSessions,
    activeEnrollments,
    activeCredentials,
    usableCodes,
    workspaceRow,
    bindingRow,
  ] = await Promise.all([
    database
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, scope.workspaceId), eq(agents.status, "active"))),
    database
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(and(eq(imBindings.agentId, scope.agentId), eq(imBindings.status, "active"))),
    database
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, scope.sessionId), isNull(sessions.endedAt))),
    database
      .select({ id: workspaceComputers.id })
      .from(workspaceComputers)
      .where(and(eq(workspaceComputers.workspaceId, scope.workspaceId), isNull(workspaceComputers.revokedAt))),
    database
      .select({ id: workspaceComputerCredentials.id })
      .from(workspaceComputerCredentials)
      .innerJoin(workspaceComputers, eq(workspaceComputers.id, workspaceComputerCredentials.workspaceComputerId))
      .where(
        and(eq(workspaceComputers.workspaceId, scope.workspaceId), isNull(workspaceComputerCredentials.revokedAt)),
      ),
    database
      .select({ id: computerConnectCodes.id })
      .from(computerConnectCodes)
      .where(
        and(
          eq(computerConnectCodes.workspaceId, scope.workspaceId),
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
  return {
    activeAgents: activeAgents.length,
    activeBindings: activeBindings.length,
    openSessions: openSessions.length,
    activeEnrollments: activeEnrollments.length,
    activeCredentials: activeCredentials.length,
    usableCodes: usableCodes.length,
    setupCompletedAt: workspaceRow[0]?.setupCompletedAt ?? null,
    binding: bindingRow[0],
  };
}

describe("staging Onboarding Lab reset", () => {
  it("returns the Lab Account to a verified first-run state", async () => {
    const value = await fixture();
    const before = await facts(value.database, value.lab);
    expect(before).toMatchObject({ activeAgents: 1, activeBindings: 1, openSessions: 1, activeEnrollments: 1 });
    expect(before.setupCompletedAt).not.toBeNull();

    await value.reset.resetOnboarding(value.lab.accountId);

    const after = await facts(value.database, value.lab);
    expect(after).toMatchObject({
      activeAgents: 0,
      activeBindings: 0,
      openSessions: 0,
      activeEnrollments: 0,
      activeCredentials: 0,
      usableCodes: 0,
      setupCompletedAt: null,
    });
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
        clientVersion: "0.0.1",
      }),
    ).rejects.toBeInstanceOf(AuthServiceError);
  });

  it("reuses the stable Computer identity for the next enrollment", async () => {
    const value = await fixture();
    await value.reset.resetOnboarding(value.lab.accountId);

    const issued = await value.machineAuth.issueForWorkspaceAdmin(value.lab.accountId, value.lab.workspaceId);
    const reconnected = await value.machineAuth.exchangeConnectCode({
      code: issued.code,
      computerId: value.lab.computerId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    });

    expect(reconnected.computerId).toBe(value.lab.computerId);
    expect(reconnected.workspaceComputerId).not.toBe(value.lab.enrollmentId);
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

    expect((await facts(value.database, value.lab)).setupCompletedAt).toBeNull();
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
    expect(staged.setupCompletedAt).not.toBeNull();
    expect(staged).toMatchObject({ activeAgents: 0, activeEnrollments: 0 });

    await value.reset.resetOnboarding(value.lab.accountId);

    expect((await facts(value.database, value.lab)).setupCompletedAt).toBeNull();
  });

  it("refuses to clear setup completion when a writer interleaves before the commit", async () => {
    // Another tester on the shared Account asks for a Computer connect command mid-reset.
    let interleaved = false;
    const value = await fixture({
      afterCleanup: async ({ lab, machineAuth }) => {
        if (interleaved) return;
        interleaved = true;
        await machineAuth.issueForWorkspaceAdmin(lab.accountId, lab.workspaceId);
      },
    });

    await expect(value.reset.resetOnboarding(value.lab.accountId)).rejects.toMatchObject({
      code: "ONBOARDING_RESET_UNVERIFIED",
    });

    const staged = await facts(value.database, value.lab);
    expect(staged.setupCompletedAt).not.toBeNull();
    expect(staged.usableCodes).toBe(1);

    // The retry revokes the interleaved code and converges.
    await value.reset.resetOnboarding(value.lab.accountId);
    expect(await facts(value.database, value.lab)).toMatchObject({ setupCompletedAt: null, usableCodes: 0 });
  });

  it("holds the scope lock across verification and the setup marker", async () => {
    let pending: Promise<unknown> | undefined;
    let settled = false;
    let blockedWhileCommitting: boolean | undefined;
    const value = await fixture({
      afterVerified: async () => {
        // A writer that starts between verification and the marker must wait for this commit.
        pending = value.machineAuth.issueForWorkspaceAdmin(value.lab.accountId, value.lab.workspaceId).finally(() => {
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
    expect(await facts(value.database, value.lab)).toMatchObject({ setupCompletedAt: null, usableCodes: 1 });
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
      activeEnrollments: 1,
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
    }

    expect((await facts(value.database, value.lab)).activeAgents).toBe(1);
    expect((await facts(value.database, other)).activeAgents).toBe(1);
  });

  it("reports a Lab Account with no active scope as a retryable ownership inconsistency", async () => {
    const value = await fixture();
    const now = new Date();
    await value.database
      .update(workspaceAdminGrants)
      .set({ revokedByUserId: value.lab.accountId, revokedAt: now })
      .where(
        and(
          eq(workspaceAdminGrants.workspaceId, value.lab.workspaceId),
          eq(workspaceAdminGrants.userId, value.lab.accountId),
        ),
      );

    // The canonical resolver answers 404 here; the Lab has already identified this Account, so it
    // must surface the retryable ownership error rather than look like an unauthorized Account.
    await expect(value.reset.resetOnboarding(value.lab.accountId)).rejects.toMatchObject({
      code: "ONBOARDING_RESET_OWNERSHIP_INCONSISTENT",
      statusCode: 409,
    });
    expect(await facts(value.database, value.lab)).toMatchObject({ activeAgents: 1, activeEnrollments: 1 });
    expect((await facts(value.database, value.lab)).setupCompletedAt).not.toBeNull();
  });

  it("leaves another tester's Account untouched, so two testers never collide", async () => {
    const value = await fixture();
    const [other] = await value.database
      .insert(users)
      .values({ displayName: "Other tester", email: "other-tester@company.example" })
      .returning({ id: users.id });
    if (!other) throw new Error("Second tester fixture was not created");
    const [otherWorkspace] = await value.database
      .insert(workspaces)
      .values({ name: "other", displayName: "Other" })
      .returning({ id: workspaces.id });
    if (!otherWorkspace) throw new Error("Second tester scope fixture was not created");
    await value.database
      .insert(workspaceAdminGrants)
      .values({ workspaceId: otherWorkspace.id, userId: other.id, grantedByUserId: other.id });
    const second = await seedAccount(value.database, value.agentService, value.machineAuth, {
      accountId: other.id,
      workspaceId: otherWorkspace.id,
      agentName: "other-agent",
      externalAppId: "cli_other",
    });
    const before = await facts(value.database, second);

    await value.reset.resetOnboarding(value.lab.accountId);

    expect(await facts(value.database, value.lab)).toMatchObject({ activeAgents: 0, activeEnrollments: 0 });
    expect(await facts(value.database, second)).toEqual(before);

    // And the second tester resets their own Account without disturbing the first, in either order.
    await value.reset.resetOnboarding(other.id);
    expect(await facts(value.database, second)).toMatchObject({ activeAgents: 0, activeEnrollments: 0 });
  });

  it("refuses to proceed when the Lab Account owns more than one active scope", async () => {
    const value = await fixture();
    const [second] = await value.database
      .insert(workspaces)
      .values({ name: "second", displayName: "Second" })
      .returning({ id: workspaces.id });
    if (!second) throw new Error("Second scope fixture was not created");
    await value.database
      .insert(workspaceAdminGrants)
      .values({ workspaceId: second.id, userId: value.lab.accountId, grantedByUserId: value.lab.accountId });

    // The canonical seam would still pick one scope; reset must refuse rather than reset whichever
    // one selection happens to return.
    await expect(value.reset.resetOnboarding(value.lab.accountId)).rejects.toMatchObject({
      code: "ONBOARDING_RESET_OWNERSHIP_INCONSISTENT",
    });
    expect((await facts(value.database, value.lab)).activeAgents).toBe(1);
  });

  it("refuses to proceed when the Lab Account scope is not owned exclusively", async () => {
    const value = await fixture();
    const [intruder] = await value.database
      .insert(users)
      .values({ displayName: "Intruder", email: "intruder@example.com" })
      .returning({ id: users.id });
    if (!intruder) throw new Error("Intruder fixture was not created");
    await value.database
      .insert(workspaceAdminGrants)
      .values({ workspaceId: value.lab.workspaceId, userId: intruder.id, grantedByUserId: intruder.id });

    await expect(value.reset.resetOnboarding(value.lab.accountId)).rejects.toBeInstanceOf(OnboardingResetError);
    expect((await facts(value.database, value.lab)).activeAgents).toBe(1);
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
});
