import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  authIdentities,
  computers,
  invitationRedemptions,
  invitations,
  memberships,
  teams,
  users,
  workspaceComputers,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import {
  AuthIdentityService,
  AuthService,
  AuthTokenService,
  DevBrowserAuthService,
  PostAuthenticationService,
} from "../../services/auth/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { InvitationService } from "../../services/invitations/index.js";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "../../services/runtime-config/index.js";
import { TEAM_MEMBERSHIP_LIMIT, TeamMembershipService } from "../../services/teams/index.js";
import { WorkspaceAdminAccess } from "../../services/workspace-admin-access/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const now = new Date("2026-08-19T00:00:00.000Z");
let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());

beforeEach(async () => testDatabase.reset());

async function fixture() {
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(
    client.database,
    { displayName: "Bootstrap Admin", email: "admin@example.com", teamDisplayName: "Example", teamName: "example" },
    now,
  );
  const workspaceAdmins = new WorkspaceAdminAccess(client.database, { now: () => now });
  const teamService = new TeamMembershipService(client.database, { now: () => now, workspaceAdmins });
  const invitations = new InvitationService(
    client.database,
    teamService,
    new ApplicationCipher(new Uint8Array(32).fill(9)),
    "https://opentag.example.com",
    { now: () => now, workspaceAdmins },
  );
  return {
    ...client,
    bootstrap,
    teamService,
    workspaceAdmins,
    invitations,
    identities: new AuthIdentityService(client.database, { now: () => now }),
    postAuthentication: new PostAuthenticationService(client.database, invitations, workspaceAdmins),
  };
}

function google(subject: string, email = "same@example.com") {
  return {
    provider: "google" as const,
    issuer: "https://accounts.google.com",
    subject,
    email,
    displayName: `Google ${subject}`,
  };
}

describe("account identity and Team foundation persistence", () => {
  it("signs in exactly one existing development user and preserves live account authorization", async () => {
    const value = await fixture();
    try {
      const auth = new AuthService(
        value.database,
        new AuthTokenService("development-auth-secret-at-least-32-characters", 900, 3600),
      );
      const dev = new DevBrowserAuthService(value.database, auth, "ADMIN@EXAMPLE.COM");
      const tokens = await dev.signIn();
      await expect(auth.getAuthenticatedUser(tokens.accessToken)).resolves.toMatchObject({
        me: { user: { id: value.bootstrap.userId, email: "admin@example.com" } },
      });

      const [unassigned] = await value.database
        .insert(users)
        .values({ email: "unassigned@example.com", displayName: "Unassigned" })
        .returning();
      if (!unassigned) throw new Error("Unassigned user fixture was not created");
      const unassignedTokens = await new DevBrowserAuthService(value.database, auth, unassigned.email).signIn();
      await expect(auth.getAuthenticatedUser(unassignedTokens.accessToken)).resolves.toMatchObject({
        me: { user: { id: unassigned.id }, memberships: [] },
      });

      await value.database.update(users).set({ suspendedAt: now }).where(eq(users.id, value.bootstrap.userId));
      await expect(dev.signIn()).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });
      await value.database.update(users).set({ suspendedAt: null }).where(eq(users.id, value.bootstrap.userId));
      await value.database.insert(users).values({ email: "Admin@Example.com", displayName: "Duplicate" });
      await expect(dev.signIn()).rejects.toMatchObject({ code: "AUTH_DEV_USER_UNAVAILABLE" });
      await expect(
        new DevBrowserAuthService(value.database, auth, "missing@example.com").signIn(),
      ).rejects.toMatchObject({ code: "AUTH_DEV_USER_UNAVAILABLE" });
    } finally {
      await value.sql.end();
    }
  });

  it("uses provider identity rather than email as the global account key", async () => {
    const value = await fixture();
    try {
      const first = await value.identities.resolveOrCreate(google("subject-1"));
      expect(await value.identities.resolveOrCreate(google("subject-1"))).toBe(first);
      const second = await value.identities.resolveOrCreate(google("subject-2"));
      expect(second).not.toBe(first);
      expect(
        (await value.database.select().from(users)).filter((user) => user.email === "same@example.com"),
      ).toHaveLength(2);
      expect(await value.database.select().from(authIdentities)).toHaveLength(2);
      await expect(value.identities.resolveOrCreate(google("subject-1"), value.bootstrap.userId)).rejects.toMatchObject(
        {
          code: "AUTH_IDENTITY_CONFLICT",
        },
      );
    } finally {
      await value.sql.end();
    }
  });

  it("keeps a user-maintained display name while returning provider email updates to every reader", async () => {
    const value = await fixture();
    try {
      const userId = await value.identities.resolveOrCreate(google("profile", "old@example.com"));
      await value.postAuthentication.complete(userId, true);
      const primaryTeam = await value.teamService.createTeam(userId, {
        name: "profile-primary",
        displayName: "Profile Primary",
      });
      const auth = new AuthService(
        value.database,
        new AuthTokenService("development-auth-secret-at-least-32-characters", 900, 3600),
        { now: () => new Date("2026-08-19T01:00:00.000Z") },
      );

      await expect(auth.updateSelfProfile(userId, { displayName: "  Product Name  " })).resolves.toEqual({
        id: userId,
        email: "old@example.com",
        displayName: "Product Name",
      });
      const [selfUpdated] = await value.database.select().from(users).where(eq(users.id, userId));
      expect(selfUpdated?.updatedAt.toISOString()).toBe("2026-08-19T01:00:00.000Z");
      const returningIdentities = new AuthIdentityService(value.database, {
        now: () => new Date("2026-08-19T02:00:00.000Z"),
      });
      await returningIdentities.resolveOrCreate({
        ...google("profile", "new@example.com"),
        displayName: "Provider Name",
      });

      const [persisted] = await value.database.select().from(users).where(eq(users.id, userId));
      expect(persisted).toMatchObject({ email: "new@example.com", displayName: "Product Name" });
      await expect(value.teamService.listMembers(userId, primaryTeam.id)).resolves.toMatchObject({
        members: [{ userId, displayName: "Product Name" }],
      });

      const [secondTeam] = await value.database
        .insert(teams)
        .values({ name: "profile-second", displayName: "Profile Second" })
        .returning();
      if (!secondTeam) throw new Error("Second Team fixture was not created");
      await value.database
        .insert(memberships)
        .values({ teamId: secondTeam.id, userId, role: "member", status: "active" });
      await expect(value.teamService.listMembers(userId, secondTeam.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });

      const [computer] = await value.database
        .insert(computers)
        .values({
          id: crypto.randomUUID(),
          ownerUserId: userId,
          displayName: "profile-computer",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.1",
        })
        .returning();
      if (!computer) throw new Error("Computer fixture was not created");
      await value.database.insert(workspaceComputers).values({
        workspaceId: primaryTeam.id,
        computerId: computer.id,
        enrolledByUserId: userId,
        displayName: computer.displayName,
        platform: computer.platform,
        arch: computer.arch,
        clientVersion: computer.clientVersion,
      });
      const computerResult = await value.teamService.listComputers(userId, primaryTeam.id, true);
      expect(computerResult.computers.find((candidate) => candidate.id === computer.id)).toMatchObject({
        ownerUserId: userId,
        ownerDisplayName: "Product Name",
        providerReadiness: [
          { provider: "codex", status: "unavailable", observedAt: null },
          { provider: "claude-code", status: "unavailable", observedAt: null },
        ],
      });
      const agentService = new AgentService(value.database, {
        workspaceAdmins: value.workspaceAdmins,
        now: () => now,
      });
      await agentService.createForTeam(userId, primaryTeam.id, {
        computerId: computer.id,
        name: "profile-agent",
        displayName: "Profile Agent",
        runtimeProvider: "codex",
      });
      await expect(agentService.listForTeam(userId, primaryTeam.id)).resolves.toMatchObject({
        agents: [{ manager: { userId, displayName: "Product Name" } }],
      });
    } finally {
      await value.sql.end();
    }
  });

  it("establishes a default Workspace only from the Account new-row fact", async () => {
    const value = await fixture();
    try {
      const userId = await value.identities.resolveOrCreate(google("solo", "solo@example.com"));
      const first = await value.postAuthentication.complete(userId, true);
      const returning = await value.postAuthentication.complete(userId, false);
      const selectedTeamId = first.selectedTeamId;
      expect(selectedTeamId).toEqual(expect.any(String));
      expect(returning).toEqual({ userId });
      expect(await value.database.select().from(memberships).where(eq(memberships.userId, userId))).toEqual([
        expect.objectContaining({ teamId: selectedTeamId, role: "admin", status: "active" }),
      ]);
      expect(
        await value.database
          .select()
          .from(teams)
          .where(eq(teams.id, selectedTeamId ?? "")),
      ).toEqual([expect.objectContaining({ displayName: "Google solo's Workspace" })]);
      expect(await value.database.select().from(teams)).toHaveLength(2);
    } finally {
      await value.sql.end();
    }
  });

  it("does not backfill a Workspace for returning Accounts with zero Admin authority", async () => {
    const value = await fixture();
    try {
      const [unassigned, legacyMember, revokedAdmin] = await value.database
        .insert(users)
        .values([
          { email: "unassigned-returning@example.com", displayName: "Unassigned Returning" },
          { email: "legacy-member@example.com", displayName: "Legacy Member" },
          { email: "revoked-admin@example.com", displayName: "Revoked Admin" },
        ])
        .returning();
      if (!unassigned || !legacyMember || !revokedAdmin) throw new Error("Returning Account fixtures were not created");
      const [legacyWorkspace] = await value.database
        .insert(teams)
        .values({ name: "legacy-zero-admin", displayName: "Legacy Zero Admin" })
        .returning();
      if (!legacyWorkspace) throw new Error("Legacy Workspace fixture was not created");
      await value.database.insert(memberships).values([
        { teamId: legacyWorkspace.id, userId: legacyMember.id, role: "member", status: "active" },
        { teamId: legacyWorkspace.id, userId: revokedAdmin.id, role: "admin", status: "removed" },
      ]);
      const before = await value.database.select({ id: teams.id }).from(teams);

      await expect(value.postAuthentication.complete(unassigned.id, false)).resolves.toEqual({
        userId: unassigned.id,
      });
      await expect(value.postAuthentication.complete(legacyMember.id, false)).resolves.toEqual({
        userId: legacyMember.id,
      });
      await expect(value.postAuthentication.complete(revokedAdmin.id, false)).resolves.toEqual({
        userId: revokedAdmin.id,
      });

      expect(await value.database.select({ id: teams.id }).from(teams)).toHaveLength(before.length);
      const auth = new AuthService(
        value.database,
        new AuthTokenService("development-auth-secret-at-least-32-characters", 900, 3600),
        { workspaceAdmins: value.workspaceAdmins },
      );
      await expect(auth.getActiveUserById(unassigned.id)).resolves.toMatchObject({ memberships: [] });
      await expect(auth.getActiveUserById(legacyMember.id)).resolves.toMatchObject({ memberships: [] });
      await expect(auth.getActiveUserById(revokedAdmin.id)).resolves.toMatchObject({ memberships: [] });
    } finally {
      await value.sql.end();
    }
  });

  it("orders legacy /me Workspaces by setup completion, earliest grant, then UUID", async () => {
    const value = await fixture();
    try {
      const [account] = await value.database
        .insert(users)
        .values({ email: "ordered-workspaces@example.com", displayName: "Ordered Workspaces" })
        .returning();
      if (!account) throw new Error("Ordered Workspace Account fixture was not created");
      const workspaceIds = [
        "10000000-0000-4000-8000-000000000003",
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
      ] as const;
      await value.database.insert(teams).values([
        { id: workspaceIds[0], name: "setup-later", displayName: "Setup Later", setupCompletedAt: now },
        { id: workspaceIds[1], name: "setup-first", displayName: "Setup First", setupCompletedAt: now },
        { id: workspaceIds[2], name: "not-setup", displayName: "Not Setup" },
      ]);
      await value.database.insert(memberships).values([
        {
          teamId: workspaceIds[0],
          userId: account.id,
          role: "admin",
          status: "active",
          createdAt: new Date("2026-08-19T02:00:00.000Z"),
        },
        {
          teamId: workspaceIds[1],
          userId: account.id,
          role: "admin",
          status: "active",
          createdAt: new Date("2026-08-19T01:00:00.000Z"),
        },
        {
          teamId: workspaceIds[2],
          userId: account.id,
          role: "admin",
          status: "active",
          createdAt: new Date("2026-08-19T00:00:00.000Z"),
        },
      ]);
      const auth = new AuthService(
        value.database,
        new AuthTokenService("development-auth-secret-at-least-32-characters", 900, 3600),
        { workspaceAdmins: value.workspaceAdmins },
      );

      const me = await auth.getActiveUserById(account.id);
      expect(me.memberships.map(({ teamId }) => teamId)).toEqual([workspaceIds[1], workspaceIds[0], workspaceIds[2]]);
    } finally {
      await value.sql.end();
    }
  });

  it("creates a Team and its first admin membership in a single transaction", async () => {
    const value = await fixture();
    try {
      const userId = await value.identities.resolveOrCreate(google("solo", "solo@example.com"));
      const created = await value.teamService.createTeam(userId, {
        name: "  First-Tree  ",
        displayName: "  First Tree AI  ",
      });
      expect(created).toMatchObject({ name: "first-tree", displayName: "First Tree AI", role: "admin" });
      const active = await value.database
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")));
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ teamId: created.id, role: "admin", status: "active" });
      expect(await value.database.select().from(teams)).toHaveLength(2);
    } finally {
      await value.sql.end();
    }
  });

  it("rejects a case-insensitive Team name collision without leaving a half-created Team", async () => {
    const value = await fixture();
    try {
      const userId = await value.identities.resolveOrCreate(google("solo", "solo@example.com"));
      await expect(
        value.teamService.createTeam(userId, { name: "  EXAMPLE  ", displayName: "Collides With Bootstrap" }),
      ).rejects.toMatchObject({ code: "TEAM_NAME_CONFLICT", statusCode: 409 });
      expect(await value.database.select().from(teams)).toHaveLength(1);
      expect(await value.database.select().from(memberships).where(eq(memberships.userId, userId))).toHaveLength(0);
    } finally {
      await value.sql.end();
    }
  });

  it("holds the membership ceiling against invitation redemption and admin restore too", async () => {
    const value = await fixture();
    try {
      const userId = await value.identities.resolveOrCreate(google("solo", "solo@example.com"));
      for (let index = 0; index < TEAM_MEMBERSHIP_LIMIT; index += 1) {
        await value.teamService.createTeam(userId, { name: `team-${index}`, displayName: `Team ${index}` });
      }
      // Redemption raises the count, so it has to consult the same ceiling creation does.
      const invite = await value.invitations.create(value.bootstrap.userId, value.bootstrap.teamId);
      await expect(value.invitations.redeem(userId, invite.token, { ip: "127.0.0.1" })).rejects.toMatchObject({
        code: "TEAM_LIMIT_REACHED",
        statusCode: 409,
      });

      // So does an admin restoring a removed membership on a Team the saturated user does not hold.
      await value.database.insert(memberships).values({
        teamId: value.bootstrap.teamId,
        userId,
        role: "member",
        status: "removed",
        createdAt: now,
        updatedAt: now,
      });
      await expect(
        value.teamService.restore(value.bootstrap.userId, value.bootstrap.teamId, userId, "member"),
      ).rejects.toMatchObject({ code: "TEAM_LIMIT_REACHED", statusCode: 409 });
    } finally {
      await value.sql.end();
    }
  });

  it("keeps one user/Team lock order so post-auth and explicit redemption cannot deadlock", async () => {
    const value = await fixture();
    const second = createDatabaseClient(databaseUrl);
    let releaseHold: () => void = () => undefined;
    let signalUserLocked: () => void = () => undefined;
    const userLocked = new Promise<void>((resolve) => {
      signalUserLocked = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    try {
      const joiner = await value.identities.resolveOrCreate(google("racer", "racer@example.com"));
      const invite = await value.invitations.create(value.bootstrap.userId, value.bootstrap.teamId);

      // Mirror post-authentication: it locks the user row and only then redeems, which locks the Team.
      // Holding it between those two acquisitions is what exposes an inverted order on the explicit path.
      const viaPostAuth = value.database.transaction(async (transaction) => {
        await value.teamService.lockUserForMembershipWrite(transaction, joiner);
        signalUserLocked();
        await held;
        return value.invitations.redeemInTransaction(transaction, joiner, invite.token, { ip: "127.0.0.1" });
      });
      await userLocked;

      // The explicit path now wants the same user and Team. Under the old order it took the Team first and
      // the two transactions waited on each other; PostgreSQL would abort one with 40P01.
      const explicitTeams = new TeamMembershipService(second.database, { now: () => now });
      const explicitInvitations = new InvitationService(
        second.database,
        explicitTeams,
        new ApplicationCipher(new Uint8Array(32).fill(9)),
        "https://opentag.example.com",
        { now: () => now },
      );
      const viaExplicit = explicitInvitations.redeem(joiner, invite.token, { ip: "127.0.0.2" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseHold();

      await expect(viaPostAuth).resolves.toMatchObject({ membership: { teamId: value.bootstrap.teamId } });
      await expect(viaExplicit).resolves.toMatchObject({ membership: { teamId: value.bootstrap.teamId } });
      // One redemption transitions the membership; the other observes it already active.
      expect(
        await value.database
          .select()
          .from(memberships)
          .where(and(eq(memberships.userId, joiner), eq(memberships.status, "active"))),
      ).toHaveLength(1);
    } finally {
      releaseHold();
      await Promise.all([second.sql.end(), value.sql.end()]);
    }
  });

  it("stops one account from creating Teams without bound", async () => {
    const value = await fixture();
    try {
      const userId = await value.identities.resolveOrCreate(google("solo", "solo@example.com"));
      for (let index = 0; index < TEAM_MEMBERSHIP_LIMIT; index += 1) {
        await value.teamService.createTeam(userId, { name: `team-${index}`, displayName: `Team ${index}` });
      }
      await expect(
        value.teamService.createTeam(userId, { name: "one-too-many", displayName: "One Too Many" }),
      ).rejects.toMatchObject({ code: "TEAM_LIMIT_REACHED", statusCode: 409 });
      // The rejected name stays free, so a bounded account cannot squat the global namespace on the way out.
      expect(await value.database.select().from(teams).where(eq(teams.name, "one-too-many"))).toHaveLength(0);
      expect(
        await value.database
          .select()
          .from(memberships)
          .where(and(eq(memberships.userId, userId), eq(memberships.status, "active"))),
      ).toHaveLength(TEAM_MEMBERSHIP_LIMIT);
    } finally {
      await value.sql.end();
    }
  });

  it("lets an existing member create an additional Team and hold both memberships", async () => {
    const value = await fixture();
    try {
      const created = await value.teamService.createTeam(value.bootstrap.userId, {
        name: "second-team",
        displayName: "Second Team",
      });
      const active = await value.database
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, value.bootstrap.userId), eq(memberships.status, "active")));
      expect(active).toHaveLength(2);
      expect(active.map((membership) => membership.teamId).sort()).toEqual([value.bootstrap.teamId, created.id].sort());
      expect(active.every((membership) => membership.role === "admin")).toBe(true);
    } finally {
      await value.sql.end();
    }
  });

  it("lists active Workspace Computer enrollments independently of legacy member ownership", async () => {
    const value = await fixture();
    try {
      const [activeMember, removedMember, suspendedMember] = await value.database
        .insert(users)
        .values([
          { email: "active-computer@example.com", displayName: "Active Member" },
          { email: "removed-computer@example.com", displayName: "Removed Member" },
          { email: "suspended-computer@example.com", displayName: "Suspended Member", suspendedAt: now },
        ])
        .returning();
      if (!activeMember || !removedMember || !suspendedMember) throw new Error("User fixtures were not created");
      await value.database.insert(memberships).values([
        { teamId: value.bootstrap.teamId, userId: activeMember.id, role: "member", status: "active" },
        { teamId: value.bootstrap.teamId, userId: removedMember.id, role: "member", status: "removed" },
        { teamId: value.bootstrap.teamId, userId: suspendedMember.id, role: "member", status: "active" },
      ]);

      const adminComputerId = crypto.randomUUID();
      const activeComputerId = crypto.randomUUID();
      const removedComputerId = crypto.randomUUID();
      const suspendedComputerId = crypto.randomUUID();
      await value.database.insert(computers).values([
        {
          id: adminComputerId,
          ownerUserId: value.bootstrap.userId,
          displayName: "admin-unbound",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.1",
          currentInstanceId: crypto.randomUUID(),
          connectedAt: now,
          lastSeenAt: now,
        },
        {
          id: activeComputerId,
          ownerUserId: activeMember.id,
          displayName: "active-bound",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "0.0.1",
          currentInstanceId: crypto.randomUUID(),
          connectedAt: now,
          lastSeenAt: now,
        },
        {
          id: removedComputerId,
          ownerUserId: removedMember.id,
          displayName: "removed-unbound",
          platform: "win32",
          arch: "x64",
          clientVersion: "0.0.1",
          lastSeenAt: now,
        },
        {
          id: suspendedComputerId,
          ownerUserId: suspendedMember.id,
          displayName: "suspended-unbound",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.1",
          lastSeenAt: now,
        },
      ]);
      await value.database.insert(workspaceComputers).values([
        {
          workspaceId: value.bootstrap.teamId,
          computerId: adminComputerId,
          enrolledByUserId: value.bootstrap.userId,
          displayName: "admin-unbound",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.1",
          currentInstanceId: crypto.randomUUID(),
          connectedAt: now,
          lastSeenAt: now,
        },
        {
          workspaceId: value.bootstrap.teamId,
          computerId: activeComputerId,
          enrolledByUserId: activeMember.id,
          displayName: "active-bound",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "0.0.1",
          currentInstanceId: crypto.randomUUID(),
          connectedAt: now,
          lastSeenAt: now,
        },
        {
          workspaceId: value.bootstrap.teamId,
          computerId: removedComputerId,
          enrolledByUserId: removedMember.id,
          displayName: "removed-unbound",
          platform: "win32",
          arch: "x64",
          clientVersion: "0.0.1",
          enrolledAt: now,
          revokedByUserId: value.bootstrap.userId,
          revokedAt: now,
        },
      ]);
      const [agent] = await value.database
        .insert(agents)
        .values({
          teamId: value.bootstrap.teamId,
          managerUserId: activeMember.id,
          computerId: activeComputerId,
          name: "active-computer-agent",
          displayName: "Active Computer Agent",
          runtimeProvider: "codex",
        })
        .returning();
      if (!agent) throw new Error("Agent fixture was not created");
      await value.database.insert(agentRuntimeConfigs).values({ agentId: agent.id, ...DEFAULT_AGENT_RUNTIME_CONFIG });

      const result = await value.teamService.listComputers(value.bootstrap.userId, value.bootstrap.teamId);
      expect(result.computers.map((computer) => computer.id)).toEqual([activeComputerId, adminComputerId]);
      expect(result.computers.find((computer) => computer.id === adminComputerId)).toMatchObject({
        ownerUserId: value.bootstrap.userId,
        connectionStatus: "online",
        agentIds: [],
      });
      expect(result.computers.find((computer) => computer.id === activeComputerId)).toMatchObject({
        ownerUserId: activeMember.id,
        connectionStatus: "online",
        agentIds: [agent.id],
      });
      expect(result.computers.map((computer) => computer.id)).not.toContain(removedComputerId);
      expect(result.computers.map((computer) => computer.id)).not.toContain(suspendedComputerId);
    } finally {
      await value.sql.end();
    }
  });

  it("joins an invited Team without creating a personal Team and rotates bearer links", async () => {
    const value = await fixture();
    try {
      expect(await value.invitations.get(value.bootstrap.userId, value.bootstrap.teamId)).toBeUndefined();
      expect(await value.database.select().from(invitations)).toHaveLength(0);
      const firstInvite = await value.invitations.create(value.bootstrap.userId, value.bootstrap.teamId);
      expect(await value.invitations.get(value.bootstrap.userId, value.bootstrap.teamId)).toEqual(firstInvite);
      expect(await value.database.select().from(invitations)).toHaveLength(1);
      const nextInvite = await value.invitations.rotate(value.bootstrap.userId, value.bootstrap.teamId);
      expect(nextInvite.token).not.toBe(firstInvite.token);
      await expect(value.invitations.preview(firstInvite.token)).rejects.toMatchObject({ code: "INVITATION_INVALID" });

      const userId = await value.identities.resolveOrCreate(google("invitee", "invitee@example.com"));
      await value.postAuthentication.complete(userId, true, nextInvite.token, { ip: "127.0.0.1" });
      expect(await value.database.select().from(teams)).toHaveLength(1);
      const [membership] = await value.database
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.teamId, value.bootstrap.teamId)));
      expect(membership).toMatchObject({ role: "member", status: "active" });
      await expect(value.invitations.redeem(userId, nextInvite.token, { ip: "127.0.0.2" })).resolves.toMatchObject({
        membership: { teamId: value.bootstrap.teamId, role: "member" },
      });
      expect(await value.database.select().from(invitationRedemptions)).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("keeps invitation bearer reads and mutations admin-only", async () => {
    const value = await fixture();
    try {
      const [member] = await value.database
        .insert(users)
        .values({ email: "invitation-member@example.com", displayName: "Invitation Member" })
        .returning();
      if (!member) throw new Error("Member fixture was not created");
      await value.database
        .insert(memberships)
        .values({ teamId: value.bootstrap.teamId, userId: member.id, role: "member", status: "active" });

      await expect(value.invitations.get(member.id, value.bootstrap.teamId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      await expect(value.invitations.create(member.id, value.bootstrap.teamId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      await expect(value.invitations.rotate(member.id, value.bootstrap.teamId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      expect(await value.database.select().from(invitations)).toHaveLength(0);
    } finally {
      await value.sql.end();
    }
  });

  it("updates Team handles and display names without changing UUID-backed invitation identity", async () => {
    const value = await fixture();
    try {
      const [member] = await value.database
        .insert(users)
        .values({ email: "team-profile-member@example.com", displayName: "Team Profile Member" })
        .returning();
      if (!member) throw new Error("Member fixture was not created");
      await value.database
        .insert(memberships)
        .values({ teamId: value.bootstrap.teamId, userId: member.id, role: "member", status: "active" });
      await expect(
        value.teamService.updateTeamProfile(member.id, value.bootstrap.teamId, { displayName: "Denied" }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });

      const invitation = await value.invitations.create(value.bootstrap.userId, value.bootstrap.teamId);
      await expect(
        value.teamService.updateTeamProfile(value.bootstrap.userId, value.bootstrap.teamId, {
          name: "  RENAMED-TEAM  ",
          displayName: "  Renamed Team  ",
        }),
      ).resolves.toMatchObject({
        id: value.bootstrap.teamId,
        name: "renamed-team",
        displayName: "Renamed Team",
      });
      await expect(
        value.teamService.updateTeamProfile(value.bootstrap.userId, value.bootstrap.teamId, {
          displayName: "Renamed Team AI",
        }),
      ).resolves.toMatchObject({ name: "renamed-team", displayName: "Renamed Team AI" });
      await expect(value.invitations.preview(invitation.token)).resolves.toMatchObject({
        teamDisplayName: "Renamed Team AI",
      });

      const inviteeId = await value.identities.resolveOrCreate(google("renamed-team-invitee", "renamed@example.com"));
      await expect(value.invitations.redeem(inviteeId, invitation.token)).resolves.toMatchObject({
        membership: {
          teamId: value.bootstrap.teamId,
          teamName: "renamed-team",
          teamDisplayName: "Renamed Team AI",
        },
      });

      await value.database.insert(teams).values({ name: "reserved-name", displayName: "Reserved" });
      await expect(
        value.teamService.updateTeamProfile(value.bootstrap.userId, value.bootstrap.teamId, {
          name: "RESERVED-NAME",
        }),
      ).rejects.toMatchObject({ code: "TEAM_NAME_CONFLICT", statusCode: 409 });
      await expect(
        value.teamService.updateTeamProfile(value.bootstrap.userId, value.bootstrap.teamId, { name: "not url safe" }),
      ).rejects.toBeDefined();
    } finally {
      await value.sql.end();
    }
  });

  it("serializes Team profile rename with a concurrent admin downgrade", async () => {
    const value = await fixture();
    const revoker = createDatabaseClient(databaseUrl);
    let releaseRevocation: () => void = () => undefined;
    let releaseRename: () => void = () => undefined;
    let signalTeamLocked: () => void = () => undefined;
    const teamLocked = new Promise<void>((resolve) => {
      signalTeamLocked = resolve;
    });
    const releaseRevocationPromise = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    try {
      const [secondAdmin] = await value.database
        .insert(users)
        .values({ email: "team-profile-admin@example.com", displayName: "Team Profile Admin" })
        .returning();
      if (!secondAdmin) throw new Error("Second admin fixture was not created");
      await value.database
        .insert(memberships)
        .values({ teamId: value.bootstrap.teamId, userId: secondAdmin.id, role: "admin", status: "active" });

      const revocation = revoker.database.transaction(async (transaction) => {
        await transaction
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.id, value.bootstrap.teamId))
          .for("update");
        await transaction
          .update(memberships)
          .set({ role: "member" })
          .where(and(eq(memberships.teamId, value.bootstrap.teamId), eq(memberships.userId, secondAdmin.id)));
        signalTeamLocked();
        await releaseRevocationPromise;
      });
      await teamLocked;
      const staleRename = value.teamService.updateTeamProfile(secondAdmin.id, value.bootstrap.teamId, {
        name: "stale-rename",
      });
      let staleRenameSettled = false;
      void staleRename.then(
        () => {
          staleRenameSettled = true;
        },
        () => {
          staleRenameSettled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(staleRenameSettled).toBe(false);
      releaseRevocation();
      await revocation;
      await expect(staleRename).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });

      await value.teamService.changeRole(value.bootstrap.userId, value.bootstrap.teamId, secondAdmin.id, "admin");
      let signalAuthorityLocked: () => void = () => undefined;
      const authorityLocked = new Promise<void>((resolve) => {
        signalAuthorityLocked = resolve;
      });
      const releaseRenamePromise = new Promise<void>((resolve) => {
        releaseRename = resolve;
      });
      const renameService = new TeamMembershipService(value.database, {
        now: () => now,
        afterTeamProfileAuthorityLocked: async () => {
          signalAuthorityLocked();
          await releaseRenamePromise;
        },
      });
      const rename = renameService.updateTeamProfile(secondAdmin.id, value.bootstrap.teamId, {
        name: "winning-rename",
      });
      await authorityLocked;
      const downgrade = value.teamService.changeRole(
        value.bootstrap.userId,
        value.bootstrap.teamId,
        secondAdmin.id,
        "member",
      );
      let downgradeSettled = false;
      void downgrade.finally(() => {
        downgradeSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(downgradeSettled).toBe(false);
      releaseRename();
      await expect(rename).resolves.toMatchObject({ name: "winning-rename" });
      await expect(downgrade).resolves.toMatchObject({ role: "member" });
    } finally {
      releaseRevocation();
      releaseRename();
      await Promise.all([revoker.sql.end(), value.sql.end()]);
    }
  });

  it("serializes legacy Admin promotion with other grant writers and rejects suspended targets", async () => {
    const value = await fixture();
    let releasePromotion: () => void = () => undefined;
    try {
      const [target, suspendedTarget] = await value.database
        .insert(users)
        .values([
          { email: "promotion-target@example.com", displayName: "Promotion Target" },
          {
            email: "suspended-promotion-target@example.com",
            displayName: "Suspended Promotion Target",
            suspendedAt: now,
          },
        ])
        .returning();
      if (!target || !suspendedTarget) throw new Error("Promotion fixtures were not created");
      await value.database.insert(memberships).values([
        { teamId: value.bootstrap.teamId, userId: target.id, role: "member", status: "active" },
        { teamId: value.bootstrap.teamId, userId: suspendedTarget.id, role: "member", status: "active" },
      ]);

      await expect(
        value.teamService.changeRole(value.bootstrap.userId, value.bootstrap.teamId, suspendedTarget.id, "admin"),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });

      const extraWorkspaces = Array.from({ length: TEAM_MEMBERSHIP_LIMIT - 1 }, (_, index) => ({
        name: `promotion-workspace-${index}`,
        displayName: `Promotion Workspace ${index}`,
      }));
      const insertedWorkspaces = await value.database.insert(teams).values(extraWorkspaces).returning({ id: teams.id });
      await value.database.insert(memberships).values(
        insertedWorkspaces.map(({ id }) => ({
          teamId: id,
          userId: target.id,
          role: "admin" as const,
          status: "active" as const,
        })),
      );

      let signalAccountLocked: () => void = () => undefined;
      const accountLocked = new Promise<void>((resolve) => {
        signalAccountLocked = resolve;
      });
      const holdPromotion = new Promise<void>((resolve) => {
        releasePromotion = resolve;
      });
      const promotionService = new TeamMembershipService(value.database, {
        now: () => now,
        workspaceAdmins: value.workspaceAdmins,
        afterMembershipUserLocked: async () => {
          signalAccountLocked();
          await holdPromotion;
        },
      });
      const promotion = promotionService.changeRole(value.bootstrap.userId, value.bootstrap.teamId, target.id, "admin");
      await accountLocked;
      const competingGrant = value.teamService.createTeam(target.id, {
        name: "promotion-competing-grant",
        displayName: "Promotion Competing Grant",
      });
      let competingSettled = false;
      void competingGrant.then(
        () => {
          competingSettled = true;
        },
        () => {
          competingSettled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(competingSettled).toBe(false);
      releasePromotion();

      await expect(promotion).resolves.toMatchObject({ role: "admin", status: "active" });
      await expect(competingGrant).rejects.toMatchObject({ code: "TEAM_LIMIT_REACHED", statusCode: 409 });
      const activeAdminRows = await value.database
        .select({ teamId: memberships.teamId })
        .from(memberships)
        .where(and(eq(memberships.userId, target.id), eq(memberships.role, "admin"), eq(memberships.status, "active")));
      expect(activeAdminRows).toHaveLength(TEAM_MEMBERSHIP_LIMIT);
    } finally {
      releasePromotion();
      await value.sql.end();
    }
  });

  it("enforces last-admin and restore invariants without creator-owned Agent blocking", async () => {
    const value = await fixture();
    try {
      await expect(value.teamService.leave(value.bootstrap.userId, value.bootstrap.teamId)).rejects.toMatchObject({
        code: "MEMBERSHIP_LAST_ADMIN",
      });

      const [secondAdmin] = await value.database
        .insert(users)
        .values({ email: "second@example.com", displayName: "Second Admin" })
        .returning();
      const [member] = await value.database
        .insert(users)
        .values({ email: "member@example.com", displayName: "Member" })
        .returning();
      if (!secondAdmin || !member) throw new Error("User fixtures were not created");
      await value.database.insert(memberships).values([
        { teamId: value.bootstrap.teamId, userId: secondAdmin.id, role: "admin", status: "active" },
        { teamId: value.bootstrap.teamId, userId: member.id, role: "member", status: "active" },
      ]);

      const invitation = await value.invitations.create(value.bootstrap.userId, value.bootstrap.teamId);
      await expect(value.teamService.leave(member.id, value.bootstrap.teamId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await value.database
        .update(memberships)
        .set({ status: "left" })
        .where(and(eq(memberships.teamId, value.bootstrap.teamId), eq(memberships.userId, member.id)));
      expect(await value.invitations.redeem(member.id, invitation.token)).toMatchObject({
        membership: { role: "member" },
      });

      const [computer] = await value.database
        .insert(computers)
        .values({
          id: crypto.randomUUID(),
          ownerUserId: member.id,
          displayName: "member-workstation",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.1",
        })
        .returning();
      if (!computer) throw new Error("Computer fixture was not created");
      const [agent] = await value.database
        .insert(agents)
        .values({
          teamId: value.bootstrap.teamId,
          managerUserId: member.id,
          computerId: computer.id,
          name: "member-agent",
          displayName: "Member Agent",
          runtimeProvider: "codex",
        })
        .returning();
      if (!agent) throw new Error("Agent fixture was not created");
      await value.database.insert(agentRuntimeConfigs).values({ agentId: agent.id, ...DEFAULT_AGENT_RUNTIME_CONFIG });
      await value.teamService.remove(secondAdmin.id, value.bootstrap.teamId, member.id);
      await expect(value.invitations.redeem(member.id, invitation.token)).rejects.toMatchObject({
        code: "MEMBERSHIP_FORBIDDEN",
      });
      await expect(
        value.teamService.restore(secondAdmin.id, value.bootstrap.teamId, member.id, "member"),
      ).resolves.toMatchObject({
        status: "active",
        role: "member",
      });
    } finally {
      await value.sql.end();
    }
  });

  it("serializes concurrent Admin departures so one active Admin always remains", async () => {
    const value = await fixture();
    try {
      const [secondAdmin] = await value.database
        .insert(users)
        .values({ email: "last-admin-race@example.com", displayName: "Last Admin Race" })
        .returning();
      if (!secondAdmin) throw new Error("Second Admin fixture was not created");
      await value.database
        .insert(memberships)
        .values({ teamId: value.bootstrap.teamId, userId: secondAdmin.id, role: "admin", status: "active" });

      const outcomes = await Promise.allSettled([
        value.teamService.leave(value.bootstrap.userId, value.bootstrap.teamId),
        value.teamService.leave(secondAdmin.id, value.bootstrap.teamId),
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const [rejected] = outcomes.filter(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({ reason: { code: "MEMBERSHIP_LAST_ADMIN", statusCode: 409 } });
      const activeAdmins = await value.database
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.teamId, value.bootstrap.teamId),
            eq(memberships.role, "admin"),
            eq(memberships.status, "active"),
          ),
        );
      expect(activeAdmins).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("serializes Agent creation with departure without treating the creator as an owner", async () => {
    const value = await fixture();
    try {
      const [member] = await value.database
        .insert(users)
        .values({ email: "concurrent-member@example.com", displayName: "Concurrent Member" })
        .returning();
      if (!member) throw new Error("Member fixture was not created");
      await value.database
        .insert(memberships)
        .values({ teamId: value.bootstrap.teamId, userId: member.id, role: "admin", status: "active" });
      const [computer] = await value.database
        .insert(computers)
        .values({
          id: crypto.randomUUID(),
          ownerUserId: member.id,
          displayName: "concurrent-workstation",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.1",
        })
        .returning();
      if (!computer) throw new Error("Computer fixture was not created");
      await value.database.insert(workspaceComputers).values({
        workspaceId: value.bootstrap.teamId,
        computerId: computer.id,
        enrolledByUserId: member.id,
        displayName: computer.displayName,
        platform: computer.platform,
        arch: computer.arch,
        clientVersion: computer.clientVersion,
      });

      let signalLocked: () => void = () => undefined;
      let releaseCreate: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      const agentService = new AgentService(value.database, {
        workspaceAdmins: value.workspaceAdmins,
        now: () => now,
        afterMembershipLocked: async () => {
          signalLocked();
          await release;
        },
      });
      const creating = agentService.createForTeam(member.id, value.bootstrap.teamId, {
        computerId: computer.id,
        name: "concurrent-agent",
        displayName: "Concurrent Agent",
        runtimeProvider: "codex",
      });
      await locked;
      const leaving = value.teamService.leave(member.id, value.bootstrap.teamId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseCreate();

      await expect(creating).resolves.toMatchObject({ managerUserId: member.id });
      await expect(leaving).resolves.toBeUndefined();
      const [membership] = await value.database
        .select()
        .from(memberships)
        .where(and(eq(memberships.teamId, value.bootstrap.teamId), eq(memberships.userId, member.id)));
      expect(membership?.status).toBe("left");
    } finally {
      await value.sql.end();
    }
  });

  it("rechecks admin authority after a concurrent revocation wins the lock", async () => {
    const value = await fixture();
    try {
      const [secondAdmin, member] = await value.database
        .insert(users)
        .values([
          { email: "revoked-admin@example.com", displayName: "Revoked Admin" },
          { email: "authority-target@example.com", displayName: "Authority Target" },
        ])
        .returning();
      if (!secondAdmin || !member) throw new Error("Authority fixtures were not created");
      await value.database.insert(memberships).values([
        { teamId: value.bootstrap.teamId, userId: secondAdmin.id, role: "admin", status: "active" },
        { teamId: value.bootstrap.teamId, userId: member.id, role: "member", status: "active" },
      ]);

      let releaseAdminRows: () => void = () => undefined;
      let signalRowsLocked: () => void = () => undefined;
      const rowsLocked = new Promise<void>((resolve) => {
        signalRowsLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseAdminRows = resolve;
      });
      const holder = value.database.transaction(async (transaction) => {
        await transaction
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(
            and(
              eq(memberships.teamId, value.bootstrap.teamId),
              eq(memberships.status, "active"),
              eq(memberships.role, "admin"),
            ),
          )
          .orderBy(asc(memberships.userId))
          .for("update");
        signalRowsLocked();
        await release;
      });
      await rowsLocked;

      const revocation = value.teamService.remove(value.bootstrap.userId, value.bootstrap.teamId, secondAdmin.id);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const staleMutation = value.teamService.changeRole(secondAdmin.id, value.bootstrap.teamId, member.id, "admin");
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseAdminRows();

      await holder;
      await expect(revocation).resolves.toBeUndefined();
      await expect(staleMutation).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      const rows = await value.database
        .select()
        .from(memberships)
        .where(eq(memberships.teamId, value.bootstrap.teamId));
      expect(rows.find((row) => row.userId === secondAdmin.id)?.status).toBe("removed");
      expect(rows.find((row) => row.userId === member.id)?.role).toBe("member");
    } finally {
      await value.sql.end();
    }
  });
});
