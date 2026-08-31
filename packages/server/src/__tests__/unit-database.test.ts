import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountComputers,
  computerConnectCodes,
  computers,
  users,
  workspaceComputers,
  workspaces,
} from "../db/schema/index.js";
import {
  ensureSchemaWorkspaceId,
  insertSchemaWorkspaceComputer,
  lockSchemaWorkspaceComputer,
  schemaRequiredAgentProjection,
  schemaRequiredComputerProjection,
  schemaRequiredConnectCodeProjection,
  schemaRequiredSlackInstallationProjection,
  schemaWorkspaceIdForComputer,
  updateSchemaWorkspaceComputerInstallationForRepair,
} from "../db/schema-required-legacy.js";
import { isUniqueViolation } from "../db/unique-violation.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

describe("unit database harness", () => {
  let unitDatabase: UnitDatabase;

  beforeAll(async () => {
    unitDatabase = await createUnitDatabase();
  }, 60_000);

  afterAll(async () => {
    await unitDatabase?.close();
  });

  beforeEach(async () => {
    await unitDatabase.reset();
  });

  it("applies every checked-in migration", async () => {
    const applied = await unitDatabase.engine.query<{ count: number }>(
      "select count(*)::int as count from drizzle.__drizzle_migrations",
    );

    expect(applied.rows[0]?.count).toBeGreaterThan(0);
  });

  it("serves the Drizzle query builder the services are written against", async () => {
    const [inserted] = await unitDatabase.database
      .insert(users)
      .values({ displayName: "Harness User", email: "harness@example.com" })
      .returning();

    expect(inserted?.id).toMatch(/^[0-9a-f-]{36}$/u);

    const found = await unitDatabase.database.select().from(users).where(eq(users.email, "harness@example.com"));
    expect(found).toHaveLength(1);
  });

  it("rolls a failed transaction back", async () => {
    await expect(
      unitDatabase.database.transaction(async (transaction) => {
        await transaction.insert(users).values({ displayName: "Rolled Back", email: "rollback@example.com" });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    expect(await unitDatabase.database.select().from(users)).toHaveLength(0);
  });

  it("resolves execute() to rows, the way postgres-js does", async () => {
    // PGlite's own driver resolves to a { rows, fields, command, ... } envelope. Services are written
    // against postgres-js, so the harness unwraps it; without this a service would need a shape check
    // that never runs in production.
    const rows = await unitDatabase.database.execute(sql`select 1 as one, 2 as two`);

    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toEqual({ one: 1, two: 2 });
  });

  it("resolves execute() to rows inside a transaction too", async () => {
    await unitDatabase.database.transaction(async (transaction) => {
      const rows = await transaction.execute(sql`select 3 as three`);

      expect(Array.isArray(rows)).toBe(true);
      expect(rows[0]).toEqual({ three: 3 });
    });
  });

  it("clears application data between tests without losing the schema", async () => {
    await unitDatabase.database.insert(users).values({ displayName: "Transient", email: "transient@example.com" });
    await unitDatabase.reset();

    expect(await unitDatabase.database.select().from(users)).toHaveLength(0);
  });

  it("fills a schema-required Workspace from zero, named, computer, and connect-code candidates", async () => {
    const accountId = randomUUID();
    const now = new Date("2026-08-30T00:00:00.000Z");
    await unitDatabase.database.insert(users).values({
      id: accountId,
      displayName: "Schema account",
      email: "schema@example.com",
    });

    const created = await unitDatabase.database.transaction((transaction) =>
      ensureSchemaWorkspaceId(transaction, accountId, now),
    );
    expect(created).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await unitDatabase.database.select().from(workspaces)).toEqual([
      expect.objectContaining({
        id: created,
        name: `schema-${accountId}`,
        displayName: "Schema compatibility",
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    expect(
      await unitDatabase.database.transaction((transaction) => ensureSchemaWorkspaceId(transaction, accountId, now)),
    ).toBe(created);

    const namedAccountId = randomUUID();
    await unitDatabase.database.insert(users).values({
      id: namedAccountId,
      displayName: "Named account",
      email: "named@example.com",
    });
    const named = randomUUID();
    await unitDatabase.database.insert(workspaces).values({
      id: named,
      name: `schema-${namedAccountId}`,
      displayName: "Named candidate",
      createdAt: now,
      updatedAt: now,
    });
    expect(
      await unitDatabase.database.transaction((transaction) =>
        ensureSchemaWorkspaceId(transaction, namedAccountId, now),
      ),
    ).toBe(named);
  });

  it("uses computer and connect-code candidates and rejects ambiguous candidates", async () => {
    const accountId = randomUUID();
    const now = new Date("2026-08-30T00:00:00.000Z");
    await unitDatabase.database.insert(users).values({
      id: accountId,
      displayName: "Candidate account",
      email: "candidate@example.com",
    });
    const computerId = randomUUID();
    const workspaceId = randomUUID();
    await unitDatabase.database
      .insert(workspaces)
      .values({ id: workspaceId, name: "computer-candidate", displayName: "Computer candidate" });
    await unitDatabase.database.insert(computers).values({ id: computerId });
    await unitDatabase.database.insert(accountComputers).values({
      id: computerId,
      ownerAccountId: accountId,
      currentInstallationId: computerId,
      displayName: "Candidate computer",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "1.0.0",
    });
    await unitDatabase.database.insert(workspaceComputers).values({
      id: computerId,
      workspaceId,
      computerId,
      displayName: "Candidate computer",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "1.0.0",
      enrolledByUserId: accountId,
      enrolledAt: now,
      updatedAt: now,
    });
    expect(
      await unitDatabase.database.transaction((transaction) => ensureSchemaWorkspaceId(transaction, accountId, now)),
    ).toBe(workspaceId);

    const codeWorkspaceId = randomUUID();
    await unitDatabase.database
      .insert(workspaces)
      .values({ id: codeWorkspaceId, name: "code-candidate", displayName: "Code candidate" });
    await unitDatabase.database.insert(computerConnectCodes).values({
      workspaceId: codeWorkspaceId,
      tokenHash: "candidate-token",
      issuedByUserId: accountId,
      issuedByAccountId: accountId,
      mode: "create",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await expect(
      unitDatabase.database.transaction((transaction) => ensureSchemaWorkspaceId(transaction, accountId, now)),
    ).rejects.toMatchObject({
      name: "SchemaRequiredLegacyError",
      code: "SCHEMA_REQUIRED_LEGACY_AMBIGUOUS",
    });
    await expect(
      unitDatabase.database.transaction((transaction) => ensureSchemaWorkspaceId(transaction, randomUUID(), now)),
    ).rejects.toThrow("The Account for the schema-required Workspace fill is missing");
  });

  it("covers schema-required projections and computer enrollment helpers", async () => {
    const accountId = randomUUID();
    const computerId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date("2026-08-30T00:00:00.000Z");
    await unitDatabase.database.insert(users).values({
      id: accountId,
      displayName: "Projection account",
      email: "projection@example.com",
    });
    await unitDatabase.database
      .insert(workspaces)
      .values({ id: workspaceId, name: "projection", displayName: "Projection" });
    await unitDatabase.database.insert(computers).values({ id: computerId });
    await unitDatabase.database.insert(accountComputers).values({
      id: computerId,
      ownerAccountId: accountId,
      currentInstallationId: computerId,
      displayName: "Projection computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "1.0.0",
    });
    const enrollment = await unitDatabase.database.transaction((transaction) =>
      insertSchemaWorkspaceComputer(transaction, {
        arch: "x64",
        clientVersion: "1.0.0",
        computerId,
        displayName: "Projection computer",
        enrolledByUserId: accountId,
        now,
        platform: "linux",
        workspaceId,
      }),
    );
    expect(enrollment).toMatchObject({ id: expect.any(String) });
    expect(
      await unitDatabase.database.transaction((transaction) =>
        schemaWorkspaceIdForComputer(transaction, enrollment.id),
      ),
    ).toBe(workspaceId);

    const lockWorkspaceId = randomUUID();
    await unitDatabase.database.insert(workspaces).values({
      id: lockWorkspaceId,
      name: "lock-projection",
      displayName: "Lock projection",
    });
    await unitDatabase.database.insert(workspaceComputers).values({
      id: computerId,
      workspaceId: lockWorkspaceId,
      computerId,
      displayName: "Lock computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "1.0.0",
      enrolledByUserId: accountId,
    });
    expect(
      await unitDatabase.database.transaction((transaction) => lockSchemaWorkspaceComputer(transaction, computerId)),
    ).toMatchObject({
      id: computerId,
      ownerAccountId: accountId,
      workspaceId: lockWorkspaceId,
    });
    const replacementInstallationId = randomUUID();
    await unitDatabase.database.insert(computers).values({ id: replacementInstallationId });
    await unitDatabase.database.transaction((transaction) =>
      updateSchemaWorkspaceComputerInstallationForRepair(transaction, enrollment.id, replacementInstallationId),
    );
    expect(schemaRequiredAgentProjection({ id: computerId, workspaceId })).toEqual({
      workspaceId,
      workspaceComputerId: computerId,
    });
    expect(schemaRequiredComputerProjection(computerId)).toEqual({ workspaceComputerId: computerId });
    expect(schemaRequiredConnectCodeProjection(workspaceId)).toEqual({ workspaceId });
    expect(
      await unitDatabase.database.transaction((transaction) =>
        schemaRequiredSlackInstallationProjection(transaction, computerId),
      ),
    ).toEqual({
      workspaceId: lockWorkspaceId,
    });
    await expect(
      unitDatabase.database.transaction((transaction) => schemaWorkspaceIdForComputer(transaction, randomUUID())),
    ).rejects.toThrow("The schema-required Workspace fill for this Computer is missing");
    await expect(
      unitDatabase.database.transaction((transaction) =>
        updateSchemaWorkspaceComputerInstallationForRepair(transaction, randomUUID(), randomUUID()),
      ),
    ).rejects.toThrow("The schema-required Computer fill was not updated for repair");
  });

  it("classifies PostgreSQL unique violations through nested causes", () => {
    const root = { code: "23505", constraint_name: "users_email_unique" };
    expect(isUniqueViolation(root, "users_email_unique")).toBe(true);
    expect(isUniqueViolation({ cause: root }, "users_email_unique")).toBe(true);
    expect(isUniqueViolation({ code: "23505", constraint_name: "other" }, "users_email_unique")).toBe(false);
    expect(isUniqueViolation({ code: "23503", constraint_name: "users_email_unique" }, "users_email_unique")).toBe(
      false,
    );
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isUniqueViolation(cyclic, "users_email_unique")).toBe(false);
    expect(isUniqueViolation("not an error", "users_email_unique")).toBe(false);
  });

  it("reports impossible empty enrollment and lock results without hiding them", async () => {
    const transaction = {
      insert: () => ({
        values: () => ({
          returning: async () => [],
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => ({
                for: async () => [],
              }),
            }),
          }),
          where: () => ({
            limit: () => ({
              for: async () => [],
            }),
          }),
        }),
      }),
    } as never;
    await expect(
      insertSchemaWorkspaceComputer(transaction, {
        arch: "x64",
        clientVersion: "1.0.0",
        computerId: randomUUID(),
        displayName: "Impossible",
        enrolledByUserId: randomUUID(),
        now: new Date(),
        platform: "linux",
        workspaceId: randomUUID(),
      }),
    ).rejects.toThrow("Schema-required Computer fill was not created");
    await expect(
      updateSchemaWorkspaceComputerInstallationForRepair(transaction, randomUUID(), randomUUID()),
    ).rejects.toThrow("The schema-required Computer fill was not updated for repair");
    await expect(lockSchemaWorkspaceComputer(transaction, randomUUID())).resolves.toBeUndefined();
  });
});
