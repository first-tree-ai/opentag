import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import { agents, authIdentities, computers, memberships, teams, users } from "../../db/schema/index.js";
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
    postAuthentication: new PostAuthenticationService(client.database, invitations, {
      membershipService: teamService,
      now: () => now,
    }),
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
      await expect(new DevBrowserAuthService(value.database, auth, unassigned.email).signIn()).rejects.toMatchObject({
        code: "AUTH_MEMBERSHIP_REQUIRED",
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

  it("atomically creates one personal Team for a solo sign-in and no duplicate for a returning user", async () => {
    const value = await fixture();
    try {
      const userId = await value.identities.resolveOrCreate(google("solo", "solo@example.com"));
      const first = await value.postAuthentication.complete(userId);
      expect(first.selectedTeamId).toBeDefined();
      expect(await value.postAuthentication.complete(userId)).toEqual({ userId });
      const active = await value.database
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")));
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ role: "admin" });
      expect(await value.database.select().from(teams)).toHaveLength(2);
    } finally {
      await value.sql.end();
    }
  });

  it("joins an invited Team without creating a personal Team and rotates bearer links", async () => {
    const value = await fixture();
    try {
      const firstInvite = await value.invitations.getOrCreate(value.bootstrap.userId, value.bootstrap.teamId);
      expect(await value.invitations.getOrCreate(value.bootstrap.userId, value.bootstrap.teamId)).toEqual(firstInvite);
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

      const invitation = await value.invitations.getOrCreate(value.bootstrap.userId, value.bootstrap.teamId);
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
        .values({ teamId: value.bootstrap.teamId, userId: member.id, role: "member", status: "active" });
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
