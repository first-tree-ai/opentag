import {
  CLOUD_IDENTITY_CAPABILITY_HEADER,
  HTTP_PATHS,
  PROVIDER_READINESS_V2_HEADER,
  RUNTIME_PROTOCOL_V2,
} from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createBetterAuth } from "../../auth/better-auth.js";
import { BetterAuthSessionTokens } from "../../auth/session-tokens.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  computerConnectCodes,
  computerCredentials,
  computers,
  imBindings,
  sandboxes,
  sessions,
  users,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { AuthService, generateSecret, hashSecret } from "../../services/auth/index.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { SandboxService } from "../../services/sandboxes/index.js";
import { SessionService } from "../../services/sessions/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const betterAuthSecret = "cloud-identities-test-secret-at-least-32-ch";
const runnerVersion = "0.0.5";
const storageBase = "gs://opentag-e2-test/sandboxes";
let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function fixture(enabled = true) {
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
  });
  const auth = new AuthService(
    client.database,
    new BetterAuthSessionTokens(
      createBetterAuth(client.database, {
        onSessionCreating: async () => {},
        publicUrl: "http://localhost:8000",
        secret: betterAuthSecret,
        secureCookies: false,
        sessionTtlSeconds: 3600,
      }),
      client.database,
    ),
  );
  const cloudIdentities = enabled
    ? { enabled: true as const, runnerVersion, storageBase }
    : { enabled: false as const };
  const machineAuth = new MachineAuthService(client.database);
  const computersService = new ComputerService(client.database, auth, { cloudIdentities });
  const agentsService = new AgentService(client.database, { cloudIdentitiesEnabled: enabled });
  const sessionsService = new SessionService(client.database);
  const sandboxesService = new SandboxService(client.database, sessionsService, { cloudIdentities });
  return {
    ...client,
    auth,
    bootstrap,
    machineAuth,
    computers: computersService,
    agents: agentsService,
    sandboxes: sandboxesService,
    cloudIdentities,
  };
}

function exchangeInput(code: string, installationId: string) {
  return {
    code,
    installationId,
    displayName: "workstation" as const,
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
  };
}

async function insertAccount(value: Awaited<ReturnType<typeof fixture>>, email: string, displayName: string) {
  const [account] = await value.database.insert(users).values({ displayName, email }).returning({ id: users.id });
  if (!account) throw new Error("Account fixture missing");
  return { userId: account.id };
}

async function seedLocalComputer(value: Awaited<ReturnType<typeof fixture>>, ownerAccountId = value.bootstrap.userId) {
  const issued = await value.machineAuth.issueForAccount(ownerAccountId, {});
  return value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, crypto.randomUUID()));
}

async function seedCloudBinding(value: Awaited<ReturnType<typeof fixture>>, accountId = value.bootstrap.userId) {
  const cloud = await value.computers.ensureCloudComputerForAccount(accountId);
  const agent = await value.agents.createForAccount(accountId, {
    name: `pi-${crypto.randomUUID().slice(0, 8)}`,
    displayName: "Cloud Pi",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  const now = new Date();
  const [binding] = await value.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "app",
      externalBotId: "bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "test",
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: imBindings.id });
  if (!binding) throw new Error("IM binding fixture missing");
  return { cloud, agent, bindingId: binding.id };
}

describe("Cloud identities", () => {
  it("migrates a clean database that can store Cloud Computers and Sandboxes", async () => {
    const value = await fixture();
    try {
      const ensured = await value.computers.ensureCloudComputerForAccount(value.bootstrap.userId);
      expect(ensured).toMatchObject({ kind: "cloud", platform: "linux", connectionStatus: "online" });
      const [row] = await value.database.select().from(computers).where(eq(computers.id, ensured.computerId));
      expect(row).toMatchObject({
        kind: "cloud",
        platform: "linux",
        arch: "x64",
        clientVersion: runnerVersion,
        currentInstanceId: null,
        connectedAt: null,
        lastSeenAt: null,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("ensures one Cloud Computer per Account under concurrency and keeps identity stable", async () => {
    const value = await fixture();
    try {
      const [first, second, third] = await Promise.all([
        value.computers.ensureCloudComputerForAccount(value.bootstrap.userId),
        value.computers.ensureCloudComputerForAccount(value.bootstrap.userId),
        value.computers.ensureCloudComputerForAccount(value.bootstrap.userId),
      ]);
      expect(new Set([first.computerId, second.computerId, third.computerId]).size).toBe(1);
      const [stored] = await value.database
        .select()
        .from(computers)
        .where(and(eq(computers.ownerAccountId, value.bootstrap.userId), eq(computers.kind, "cloud")));
      expect(stored?.id).toBe(first.computerId);
      const later = new ComputerService(value.database, value.auth, {
        cloudIdentities: { enabled: true, runnerVersion: "0.0.6" },
      });
      const again = await later.ensureCloudComputerForAccount(value.bootstrap.userId);
      expect(again.computerId).toBe(first.computerId);
      const [unchanged] = await value.database.select().from(computers).where(eq(computers.id, first.computerId));
      expect(unchanged?.currentInstallationId).toBe(stored?.currentInstallationId);
      expect(unchanged?.clientVersion).toBe(runnerVersion);
    } finally {
      await value.sql.end();
    }
  });

  it("isolates Cloud Computers by Account and refuses suspended Accounts", async () => {
    const value = await fixture();
    try {
      const other = await insertAccount(value, "other@example.com", "Other");
      const [mine, theirs] = await Promise.all([
        value.computers.ensureCloudComputerForAccount(value.bootstrap.userId),
        value.computers.ensureCloudComputerForAccount(other.userId),
      ]);
      expect(mine.computerId).not.toBe(theirs.computerId);
      await value.database.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, value.bootstrap.userId));
      await expect(value.computers.ensureCloudComputerForAccount(value.bootstrap.userId)).rejects.toMatchObject({
        code: "AUTH_USER_SUSPENDED",
        statusCode: 403,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("hides Cloud Computers from legacy lists and projects logical online without Runner proof", async () => {
    const value = await fixture();
    try {
      const local = await seedLocalComputer(value);
      const cloud = await value.computers.ensureCloudComputerForAccount(value.bootstrap.userId);
      const legacy = await value.computers.listAccountComputers(value.bootstrap.userId);
      expect(legacy.computers.map((row) => row.computerId)).toEqual([local.computerId]);
      expect(legacy.computers[0]?.kind).toBeUndefined();
      const capable = await value.computers.listAccountComputers(value.bootstrap.userId, true, true);
      const cloudRow = capable.computers.find((row) => row.computerId === cloud.computerId);
      const localRow = capable.computers.find((row) => row.computerId === local.computerId);
      expect(cloudRow).toMatchObject({
        kind: "cloud",
        connectionStatus: "online",
        connectedAt: null,
        lastSeenAt: null,
      });
      expect(cloudRow?.providerReadiness?.every((row) => row.status === "unavailable")).toBe(true);
      expect(localRow?.kind).toBe("local");
    } finally {
      await value.sql.end();
    }
  });

  it("refuses Local connect, repair, register, heartbeat, disconnect, and fabricated Cloud credentials", async () => {
    const value = await fixture();
    try {
      const cloud = await value.computers.ensureCloudComputerForAccount(value.bootstrap.userId);
      const [cloudRow] = await value.database.select().from(computers).where(eq(computers.id, cloud.computerId));
      if (!cloudRow) throw new Error("Cloud Computer missing");
      await expect(
        value.machineAuth.issueForAccount(value.bootstrap.userId, {
          mode: "repair",
          targetComputerId: cloud.computerId,
        }),
      ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND" });

      const now = new Date();
      await value.database.insert(computerConnectCodes).values({
        tokenHash: hashSecret("otcc_issued-before-upgrade-cloud"),
        issuedByAccountId: value.bootstrap.userId,
        mode: "repair",
        targetComputerId: cloud.computerId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      });
      await expect(
        value.machineAuth.exchangeConnectCode(exchangeInput("otcc_issued-before-upgrade-cloud", crypto.randomUUID())),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_CODE" });
      const [afterRepair] = await value.database.select().from(computers).where(eq(computers.id, cloud.computerId));
      expect(afterRepair?.currentInstallationId).toBe(cloudRow.currentInstallationId);
      expect(afterRepair?.clientVersion).toBe(runnerVersion);

      const issued = await value.machineAuth.issueForAccount(value.bootstrap.userId, {});
      await expect(
        value.machineAuth.exchangeConnectCode(exchangeInput(issued.code, cloudRow.currentInstallationId)),
      ).rejects.toMatchObject({ code: "COMPUTER_IDENTITY_CONFLICT" });

      const secret = generateSecret(32);
      const credentialId = crypto.randomUUID();
      await value.database.insert(computerCredentials).values({
        id: credentialId,
        computerId: cloud.computerId,
        secretHash: hashSecret(secret),
        issuedByUserId: value.bootstrap.userId,
        issuedAt: now,
      });
      const token = `otmc_${credentialId}.${secret}`;
      await expect(value.machineAuth.verifyMachineToken(token)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
      const context = {
        credentialId,
        computerId: cloud.computerId,
        installationId: cloudRow.currentInstallationId,
      };
      await expect(
        value.computers.register(context, {
          type: "computer:register",
          requestId: crypto.randomUUID(),
          installationId: cloudRow.currentInstallationId,
          instanceId: crypto.randomUUID(),
          displayName: "hijack",
          platform: "linux",
          arch: "arm64",
          clientVersion: "0.0.2",
          capabilities: { imCredentialGrant: 0 },
          protocolVersion: RUNTIME_PROTOCOL_V2,
          supportedCapabilities: { imCredentialGrant: { min: 1, max: 1 } },
          requiredServerCapabilities: [],
        }),
      ).rejects.toMatchObject({ code: "COMPUTER_NOT_REGISTERED" });
      await expect(value.computers.heartbeat(context, crypto.randomUUID())).rejects.toMatchObject({
        code: "COMPUTER_NOT_REGISTERED",
      });
      await expect(value.computers.disconnect(cloud.computerId, crypto.randomUUID())).resolves.toBe(false);
      const [untouched] = await value.database.select().from(computers).where(eq(computers.id, cloud.computerId));
      expect(untouched?.displayName).toBe("Cloud");
      expect(untouched?.arch).toBe("x64");
      expect(untouched?.currentInstanceId).toBeNull();
      const legacy = await value.computers.listAccountComputers(value.bootstrap.userId);
      expect(legacy.computers.map((row) => row.computerId)).not.toContain(cloud.computerId);
    } finally {
      await value.sql.end();
    }
  });

  it("keeps normal Local register and repair working", async () => {
    const value = await fixture();
    try {
      const connected = await seedLocalComputer(value);
      const repaired = await value.machineAuth.issueForAccount(value.bootstrap.userId, {
        mode: "repair",
        targetComputerId: connected.computerId,
      });
      const next = await value.machineAuth.exchangeConnectCode(exchangeInput(repaired.code, crypto.randomUUID()));
      expect(next.computerId).toBe(connected.computerId);
      expect(next.machineToken.startsWith("otmc_")).toBe(true);
    } finally {
      await value.sql.end();
    }
  });

  it("gates Cloud Agent create and leaves known Cloud IDs unusable when the flag is off", async () => {
    const open = await fixture(true);
    try {
      const cloud = await open.computers.ensureCloudComputerForAccount(open.bootstrap.userId);
      const closed = new AgentService(open.database, { cloudIdentitiesEnabled: false });
      await expect(
        closed.createForAccount(open.bootstrap.userId, {
          name: "known-cloud",
          displayName: "Known Cloud",
          runtimeProvider: "pi",
          computerId: cloud.computerId,
        }),
      ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND" });
      const disabledComputers = new ComputerService(open.database, open.auth, { cloudIdentities: { enabled: false } });
      await expect(disabledComputers.ensureCloudComputerForAccount(open.bootstrap.userId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
    } finally {
      await open.sql.end();
    }
  });

  it("ensures a Sandbox in the same transaction, converges concurrently, and rolls back the Session on failure", async () => {
    const value = await fixture();
    try {
      const seeded = await seedCloudBinding(value);
      const request = {
        imBindingId: seeded.bindingId,
        channelId: "oc_channel",
        conversationKind: "dm" as const,
        kind: "channel" as const,
      };
      const [one, two] = await Promise.all([
        value.sandboxes.ensureForAccount(value.bootstrap.userId, request),
        value.sandboxes.ensureForAccount(value.bootstrap.userId, request),
      ]);
      expect(one.sandboxId).toBe(two.sandboxId);
      expect(one.sessionId).toBe(two.sessionId);
      expect(one.storageUri).toBe(`${storageBase}/${one.sandboxId}`);
      expect(one.lifecycle).toBe("unallocated");
      expect(one.computerId).toBe(seeded.cloud.computerId);
      const read = await value.sandboxes.getForAccount(value.bootstrap.userId, one.sandboxId);
      expect(read.storageUri).toBe(one.storageUri);

      const failingSessions = new SessionService(value.database);
      const failing = new SandboxService(value.database, failingSessions, {
        cloudIdentities: value.cloudIdentities,
        afterSessionEnsured: async () => {
          throw new Error("sandbox insert aborted");
        },
      });
      const failingRequest = { ...request, channelId: "oc_fail" };
      await expect(failing.ensureForAccount(value.bootstrap.userId, failingRequest)).rejects.toThrow(
        "sandbox insert aborted",
      );
      const leftover = await value.database.select().from(sessions).where(eq(sessions.channelId, "oc_fail"));
      expect(leftover).toEqual([]);
    } finally {
      await value.sql.end();
    }
  });

  it("does not disclose foreign Sandboxes and rejects invalid conversationKind aliasing", async () => {
    const value = await fixture();
    try {
      const seeded = await seedCloudBinding(value);
      const created = await value.sandboxes.ensureForAccount(value.bootstrap.userId, {
        imBindingId: seeded.bindingId,
        channelId: "oc_channel",
        conversationKind: "dm",
        kind: "channel",
      });
      const other = await insertAccount(value, "other-sandbox@example.com", "Other");
      await expect(value.sandboxes.getForAccount(other.userId, created.sandboxId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(value.sandboxes.getForAccount(value.bootstrap.userId, crypto.randomUUID())).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      await expect(
        value.sandboxes.ensureForAccount(value.bootstrap.userId, {
          imBindingId: seeded.bindingId,
          channelId: "oc_channel",
          conversationKind: "channel",
          kind: "channel",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
      const closed = new SandboxService(value.database, new SessionService(value.database), {
        cloudIdentities: { enabled: false },
      });
      await expect(closed.getForAccount(value.bootstrap.userId, created.sandboxId)).resolves.toMatchObject({
        sandboxId: created.sandboxId,
      });
      await expect(
        closed.ensureForAccount(value.bootstrap.userId, {
          imBindingId: seeded.bindingId,
          channelId: "oc_new",
          conversationKind: "dm",
          kind: "channel",
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    } finally {
      await value.sql.end();
    }
  });

  it("enforces synthetic resource uniqueness without allocating compute", async () => {
    const value = await fixture();
    try {
      const first = await seedCloudBinding(value);
      const secondAgent = await value.agents.createForAccount(value.bootstrap.userId, {
        name: "pi-two",
        displayName: "Cloud Pi Two",
        runtimeProvider: "pi",
        computerId: first.cloud.computerId,
      });
      const now = new Date();
      const [secondBinding] = await value.database
        .insert(imBindings)
        .values({
          agentId: secondAgent.id,
          provider: "feishu",
          status: "active",
          externalAppId: "app-2",
          externalBotId: "bot-2",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential: "test",
          activatedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: imBindings.id });
      if (!secondBinding) throw new Error("second binding missing");
      const sandboxA = await value.sandboxes.ensureForAccount(value.bootstrap.userId, {
        imBindingId: first.bindingId,
        channelId: "oc_a",
        conversationKind: "dm",
        kind: "channel",
      });
      const sandboxB = await value.sandboxes.ensureForAccount(value.bootstrap.userId, {
        imBindingId: secondBinding.id,
        channelId: "oc_b",
        conversationKind: "dm",
        kind: "channel",
      });
      expect(sandboxA.storageUri).not.toBe(sandboxB.storageUri);
      const resourceName = "projects/p/locations/us-west1/services/synthetic";
      await value.database
        .update(sandboxes)
        .set({ currentResourceName: resourceName, currentResourceUid: "uid-1" })
        .where(eq(sandboxes.id, sandboxA.sandboxId));
      await expect(
        value.database
          .update(sandboxes)
          .set({ currentResourceName: resourceName, currentResourceUid: "uid-2" })
          .where(eq(sandboxes.id, sandboxB.sandboxId)),
      ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
    } finally {
      await value.sql.end();
    }
  });

  it("requires Account authentication on Cloud identity HTTP routes", async () => {
    const value = await fixture();
    try {
      const app = createApp({
        authService: value.auth,
        computerService: value.computers,
        sandboxService: value.sandboxes,
        agentService: value.agents,
      });
      try {
        const unauthenticated = await app.inject({ method: "PUT", url: HTTP_PATHS.accountCloudComputer });
        expect(unauthenticated.statusCode).toBe(401);
        const listed = await app.inject({
          method: "GET",
          url: HTTP_PATHS.accountComputers,
          headers: { authorization: "Bearer missing", [PROVIDER_READINESS_V2_HEADER]: "2" },
        });
        expect(listed.statusCode).toBe(401);
        expect(listed.json().computers).toBeUndefined();
      } finally {
        await app.close();
      }
    } finally {
      await value.sql.end();
    }
  });

  it("does not treat readiness v2 as Cloud capability", async () => {
    const value = await fixture();
    try {
      await value.computers.ensureCloudComputerForAccount(value.bootstrap.userId);
      const app = createApp({
        authService: {
          getAuthenticatedUser: async () => ({
            tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
            me: {
              user: { id: value.bootstrap.userId, email: "admin@example.com", displayName: "Admin" },
              setupCompletedAt: null,
            },
          }),
          exchangeConnectCode: async () => {
            throw new Error("unused");
          },
          refresh: async () => {
            throw new Error("unused");
          },
          getActiveUserById: async () => ({
            user: { id: value.bootstrap.userId, email: "admin@example.com", displayName: "Admin" },
            setupCompletedAt: null,
          }),
          updateSelfProfile: async () => {
            throw new Error("unused");
          },
        },
        computerService: value.computers,
      });
      try {
        const v2 = await app.inject({
          method: "GET",
          url: HTTP_PATHS.accountComputers,
          headers: { authorization: "Bearer access", [PROVIDER_READINESS_V2_HEADER]: "2" },
        });
        expect(v2.statusCode).toBe(200);
        expect(v2.json().computers).toEqual([]);
        const capable = await app.inject({
          method: "GET",
          url: HTTP_PATHS.accountComputers,
          headers: { authorization: "Bearer access", [CLOUD_IDENTITY_CAPABILITY_HEADER]: "1" },
        });
        expect(capable.json().computers).toHaveLength(1);
        expect(capable.json().computers[0].kind).toBe("cloud");
      } finally {
        await app.close();
      }
    } finally {
      await value.sql.end();
    }
  });
});
