import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computerConnectCodes, computerCredentials, computers, users } from "../db/schema/index.js";
import { isUniqueViolation } from "../db/unique-violation.js";
import { MachineAuthService } from "../services/computers/index.js";
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

  it("issues and exchanges a connect code into an Account-owned Computer", async () => {
    const accountId = randomUUID();
    const now = new Date("2026-08-30T00:00:00.000Z");
    await unitDatabase.database.insert(users).values({
      id: accountId,
      displayName: "Connect account",
      email: "connect@example.com",
    });

    const machine = new MachineAuthService(unitDatabase.database, { now: () => now });
    const issued = await machine.issueForAccount(accountId, {});
    expect(issued.code).toMatch(/^otcc_/u);
    const installationId = randomUUID();
    const exchange = await machine.exchangeConnectCode({
      code: issued.code,
      installationId,
      displayName: "Unit computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    });
    expect(exchange.machineToken).toMatch(/^otmc_/u);
    await expect(machine.verifyMachineToken(exchange.machineToken)).resolves.toMatchObject({
      computerId: exchange.computerId,
      installationId,
    });
    expect(await unitDatabase.database.select().from(computers)).toEqual([
      expect.objectContaining({
        id: exchange.computerId,
        ownerAccountId: accountId,
        currentInstallationId: installationId,
      }),
    ]);
    expect(await unitDatabase.database.select().from(computerCredentials)).toHaveLength(1);
    expect(await unitDatabase.database.select().from(computerConnectCodes)).toEqual([
      expect.objectContaining({
        issuedByAccountId: accountId,
        mode: "create",
        consumedComputerId: exchange.computerId,
      }),
    ]);
  });

  it("fails closed for a missing Account, an unowned repair target, and a second binding of one installation", async () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const machine = new MachineAuthService(unitDatabase.database, { now: () => now });
    await expect(machine.issueForAccount(randomUUID(), {})).rejects.toMatchObject({ code: "AUTH_USER_SUSPENDED" });

    const accountId = randomUUID();
    await unitDatabase.database.insert(users).values({
      id: accountId,
      displayName: "Guarded account",
      email: "guarded@example.com",
    });
    await expect(
      machine.issueForAccount(accountId, { mode: "repair", targetComputerId: randomUUID() }),
    ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND" });

    const first = await machine.exchangeConnectCode({
      code: (await machine.issueForAccount(accountId, {})).code,
      installationId: randomUUID(),
      displayName: "First",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    });
    await expect(
      machine.exchangeConnectCode({
        code: (await machine.issueForAccount(accountId, {})).code,
        installationId: first.installationId,
        displayName: "Second",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.2",
      }),
    ).rejects.toThrow();
    expect(await unitDatabase.database.select().from(computers)).toHaveLength(1);
  });

  it("repairs the same Computer by rotating its installation identity and credentials", async () => {
    const accountId = randomUUID();
    const now = new Date("2026-08-30T00:00:00.000Z");
    await unitDatabase.database.insert(users).values({
      id: accountId,
      displayName: "Repair account",
      email: "repair@example.com",
    });
    const machine = new MachineAuthService(unitDatabase.database, { now: () => now });
    const created = await machine.exchangeConnectCode({
      code: (await machine.issueForAccount(accountId, {})).code,
      installationId: randomUUID(),
      displayName: "Repairable",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    });
    const repairedInstallationId = randomUUID();
    const repaired = await machine.exchangeConnectCode({
      code: (await machine.issueForAccount(accountId, { mode: "repair", targetComputerId: created.computerId })).code,
      installationId: repairedInstallationId,
      displayName: "Repairable",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    });
    expect(repaired.computerId).toBe(created.computerId);
    expect(repaired.installationId).toBe(repairedInstallationId);
    await expect(machine.verifyMachineToken(created.machineToken)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    await expect(machine.verifyMachineToken(repaired.machineToken)).resolves.toMatchObject({
      computerId: created.computerId,
      installationId: repairedInstallationId,
    });
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
});
