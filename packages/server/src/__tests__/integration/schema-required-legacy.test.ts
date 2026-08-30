import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  accountComputers,
  computerConnectCodes,
  workspaceAdminGrants,
  workspaceComputerCredentials,
  workspaceComputers,
  workspaces,
} from "../../db/schema/index.js";
import { ensureSchemaWorkspaceId, SchemaRequiredLegacyError } from "../../db/schema-required-legacy.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function account(database: ReturnType<typeof createDatabaseClient>["database"]) {
  return bootstrapInitialAdmin(database, { displayName: "Admin", email: "admin@example.com" });
}

function exchangeInput(code: string, computerId = randomUUID()) {
  return {
    arch: "arm64",
    clientVersion: "0.0.2",
    code,
    computerId,
    displayName: "initial-name",
    platform: "darwin" as const,
  };
}

describe("schema-required legacy compatibility seam", () => {
  it("keeps production Account bootstrap free of Workspace and grant provisioning", async () => {
    const client = createDatabaseClient(databaseUrl);
    try {
      await account(client.database);
      expect(await client.database.select().from(workspaces)).toEqual([]);
      expect(await client.database.select().from(workspaceAdminGrants)).toEqual([]);
    } finally {
      await client.sql.end();
    }
  });

  it("serializes concurrent zero-candidate issuance onto one schema-only Workspace without grants", async () => {
    const first = createDatabaseClient(databaseUrl);
    const second = createDatabaseClient(databaseUrl);
    try {
      const bootstrap = await account(first.database);
      const [left, right] = await Promise.all([
        new MachineAuthService(first.database).issueForAccount(bootstrap.userId, {}),
        new MachineAuthService(second.database).issueForAccount(bootstrap.userId, {}),
      ]);
      const codes = await first.database
        .select({ workspaceId: computerConnectCodes.workspaceId })
        .from(computerConnectCodes)
        .where(eq(computerConnectCodes.issuedByAccountId, bootstrap.userId));
      expect(left.code).not.toBe(right.code);
      expect(new Set(codes.map(({ workspaceId }) => workspaceId))).toHaveLength(1);
      expect(await first.database.select().from(workspaces)).toHaveLength(1);
      expect(await first.database.select().from(workspaceAdminGrants)).toEqual([]);
    } finally {
      await first.sql.end();
      await second.sql.end();
    }
  });

  it("rolls a zero-candidate fill back with its transaction and retries deterministically", async () => {
    const client = createDatabaseClient(databaseUrl);
    try {
      const bootstrap = await account(client.database);
      await expect(
        client.database.transaction(async (transaction) => {
          await ensureSchemaWorkspaceId(transaction, bootstrap.userId, new Date("2026-08-30T00:00:00.000Z"));
          throw new Error("injected failure");
        }),
      ).rejects.toThrow("injected failure");
      expect(await client.database.select().from(workspaces)).toEqual([]);

      await new MachineAuthService(client.database).issueForAccount(bootstrap.userId, {});
      expect(await client.database.select().from(workspaces)).toHaveLength(1);
    } finally {
      await client.sql.end();
    }
  });

  it("fails closed for multiple ordered candidates without creating a code or choosing authority", async () => {
    const client = createDatabaseClient(databaseUrl);
    try {
      const bootstrap = await account(client.database);
      const legacy = await client.database
        .insert(workspaces)
        .values([
          { displayName: "Legacy A", name: "legacy-a" },
          { displayName: "Legacy B", name: "legacy-b" },
        ])
        .returning({ id: workspaces.id });
      const expiresAt = new Date(Date.now() + 60_000);
      await client.database.insert(computerConnectCodes).values(
        legacy.map(({ id }, index) => ({
          expiresAt,
          issuedByAccountId: bootstrap.userId,
          issuedByUserId: bootstrap.userId,
          mode: "create" as const,
          tokenHash: `candidate-${index}`,
          workspaceId: id,
        })),
      );

      const beforeCodes = await client.database.select().from(computerConnectCodes);
      await expect(
        new MachineAuthService(client.database).issueForAccount(bootstrap.userId, {}),
      ).rejects.toBeInstanceOf(SchemaRequiredLegacyError);
      expect(await client.database.select().from(computerConnectCodes)).toEqual(beforeCodes);
      expect(await client.database.select().from(workspaces)).toHaveLength(2);
      expect(await client.database.select().from(workspaceAdminGrants)).toEqual([]);
    } finally {
      await client.sql.end();
    }
  });

  it("writes fixed required fields once and never mirrors observations or repair installation identity", async () => {
    const client = createDatabaseClient(databaseUrl);
    try {
      const bootstrap = await account(client.database);
      const machineAuth = new MachineAuthService(client.database);
      const issued = await machineAuth.issueForAccount(bootstrap.userId, {});
      const created = await machineAuth.exchangeConnectCode(exchangeInput(issued.code));
      const [legacyBefore] = await client.database
        .select()
        .from(workspaceComputers)
        .where(eq(workspaceComputers.id, created.workspaceComputerId));
      if (!legacyBefore) throw new Error("schema-required Computer fill was not created");

      const service = new ComputerService(client.database, { getActiveUserById: async () => Promise.reject() });
      await service.register(created, {
        arch: "x64",
        capabilities: { imCredentialGrant: 0 },
        clientVersion: "0.0.2",
        computerId: created.computerId,
        displayName: "observed-name",
        instanceId: randomUUID(),
        platform: "linux",
        protocolVersion: 2,
        requestId: randomUUID(),
        requiredServerCapabilities: [],
        supportedCapabilities: { imCredentialGrant: { max: 1, min: 1 } },
        type: "computer:register",
      });
      const repair = await machineAuth.issueForAccount(bootstrap.userId, {
        mode: "repair",
        targetComputerId: created.workspaceComputerId,
      });
      const replacementInstallationId = randomUUID();
      await machineAuth.exchangeConnectCode({
        ...exchangeInput(repair.code, replacementInstallationId),
        clientVersion: "9.9.9",
        displayName: "repair-name",
        platform: "linux",
      });

      const [legacyAfter] = await client.database
        .select()
        .from(workspaceComputers)
        .where(eq(workspaceComputers.id, created.workspaceComputerId));
      expect(legacyAfter).toEqual(legacyBefore);
      const [canonical] = await client.database
        .select()
        .from(accountComputers)
        .where(eq(accountComputers.id, created.workspaceComputerId));
      expect(canonical).toMatchObject({
        clientVersion: "9.9.9",
        currentInstallationId: replacementInstallationId,
        displayName: "repair-name",
        platform: "linux",
      });
      expect(await client.database.select().from(workspaceComputerCredentials)).toEqual([]);
      expect(await client.database.select().from(workspaceAdminGrants)).toEqual([]);
    } finally {
      await client.sql.end();
    }
  });
});
