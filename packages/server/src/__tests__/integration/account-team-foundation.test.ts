import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import {
  agentRuntimeConfigs,
  agents,
  authIdentities,
  computers,
  invitations,
  memberships,
  teams,
  users,
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
import { TeamMembershipService } from "../../services/teams/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const now = new Date("2026-08-19T00:00:00.000Z");
let container: StartedPostgreSqlContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  databaseUrl = container.getConnectionUri();
}, 120_000);

afterAll(async () => container.stop());

beforeEach(async () => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("drop schema if exists public cascade");
    await sql.unsafe("drop schema if exists drizzle cascade");
    await sql.unsafe("create schema public");
  } finally {
    await sql.end();
  }
});

async function fixture() {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(
    client.database,
    { displayName: "Bootstrap Admin", email: "admin@example.com", teamDisplayName: "Example", teamName: "example" },
    now,
  );
  const teamService = new TeamMembershipService(client.database, { now: () => now });
  const invitations = new InvitationService(
    client.database,
    teamService,
    new ApplicationCipher(new Uint8Array(32).fill(9)),
    "https://opentag.example.com",
    { now: () => now },
  );
  return {
    ...client,
    bootstrap,
    teamService,
    invitations,
    identities: new AuthIdentityService(client.database, { now: () => now }),
    postAuthentication: new PostAuthenticationService(client.database, invitations),
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

  it("never provisions a Team for a solo sign-in, leaving creation an explicit user action", async () => {
    const value = await fixture();
    try {
      const userId = await value.identities.resolveOrCreate(google("solo", "solo@example.com"));
      expect(await value.postAuthentication.complete(userId)).toEqual({ userId });
      expect(await value.postAuthentication.complete(userId)).toEqual({ userId });
      expect(await value.database.select().from(memberships).where(eq(memberships.userId, userId))).toHaveLength(0);
      expect(await value.database.select().from(teams)).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("creates a Team and its first admin membership in a single transaction", async () => {
    const value = await fixture();
    try {
      const userId = await value.identities.resolveOrCreate(google("solo", "solo@example.com"));
      await value.postAuthentication.complete(userId);
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

  it("lists every Computer owned by an active Team member independently of Agent binding", async () => {
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
      await value.postAuthentication.complete(userId, nextInvite.token, { ip: "127.0.0.1" });
      expect(await value.database.select().from(teams)).toHaveLength(1);
      const [membership] = await value.database
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.teamId, value.bootstrap.teamId)));
      expect(membership).toMatchObject({ role: "member", status: "active" });
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
        code: "MEMBERSHIP_FORBIDDEN",
      });
      await expect(value.invitations.create(member.id, value.bootstrap.teamId)).rejects.toMatchObject({
        code: "MEMBERSHIP_FORBIDDEN",
      });
      await expect(value.invitations.rotate(member.id, value.bootstrap.teamId)).rejects.toMatchObject({
        code: "MEMBERSHIP_FORBIDDEN",
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
      ).rejects.toMatchObject({ code: "MEMBERSHIP_FORBIDDEN", statusCode: 403 });

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
      await expect(staleRename).rejects.toMatchObject({ code: "MEMBERSHIP_FORBIDDEN", statusCode: 403 });

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

  it("enforces last-admin, active-Agent, left, removed, and restore invariants", async () => {
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
      await value.teamService.leave(member.id, value.bootstrap.teamId);
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
      await expect(value.teamService.remove(secondAdmin.id, value.bootstrap.teamId, member.id)).rejects.toMatchObject({
        code: "MEMBERSHIP_ACTIVE_AGENTS",
      });
      await value.database.update(agents).set({ deletedAt: now }).where(eq(agents.id, agent.id));
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

  it("serializes Agent creation with departure so an active Agent cannot be orphaned", async () => {
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

      let signalLocked: () => void = () => undefined;
      let releaseCreate: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      const agentService = new AgentService(value.database, {
        membershipService: value.teamService,
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
      await expect(leaving).rejects.toMatchObject({ code: "MEMBERSHIP_ACTIVE_AGENTS" });
      const [membership] = await value.database
        .select()
        .from(memberships)
        .where(and(eq(memberships.teamId, value.bootstrap.teamId), eq(memberships.userId, member.id)));
      expect(membership?.status).toBe("active");
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
      await expect(staleMutation).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_FOUND" });
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
