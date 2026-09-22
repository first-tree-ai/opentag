import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import { agents, computerConnectCodes, computerCredentials, computers, users } from "../db/schema/index.js";
import { ComputerService, MachineAuthService } from "../services/computers/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const NOW = new Date("2026-09-22T00:00:00.000Z");
let unit: UnitDatabase;

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

type TestUuid = `${string}-${string}-${string}-${string}-${string}`;

function exchangeInput(code: string, installationId: string = randomUUID()) {
  return {
    code,
    installationId: installationId as TestUuid,
    displayName: "Workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
  };
}

async function connectedComputer(
  options: { onComputerDeleted?: (computerId: string) => void; logger?: ReturnType<typeof testLogger> } = {},
) {
  const owner = await bootstrapInitialAdmin(unit.database, { email: "owner@example.com", displayName: "Owner" }, NOW);
  const machine = new MachineAuthService(unit.database, { now: () => NOW });
  const issued = await machine.issueForAccount(owner.userId, {});
  const installationId = randomUUID();
  const exchange = await machine.exchangeConnectCode(exchangeInput(issued.code, installationId));
  const service = new ComputerService(
    unit.database,
    { getActiveUserById: vi.fn() },
    { now: () => NOW, onComputerDeleted: options.onComputerDeleted, logger: options.logger },
  );
  return { exchange, installationId, machine, ownerId: owner.userId, service };
}

function testLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function registerFrame(installationId: string) {
  return {
    type: "computer:register" as const,
    requestId: randomUUID(),
    installationId,
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
}

describe("ComputerService.deleteComputer", () => {
  it("revokes the machine credential so every later request from the Computer fails with 401", async () => {
    const onComputerDeleted = vi.fn();
    const value = await connectedComputer({ onComputerDeleted });
    await value.service.register(value.exchange, registerFrame(value.installationId));
    const pendingRepair = await value.machine.issueForAccount(value.ownerId, {
      mode: "repair",
      targetComputerId: value.exchange.computerId,
    });

    await expect(value.service.deleteComputer(value.ownerId, value.exchange.computerId)).resolves.toEqual({
      computerId: value.exchange.computerId,
      revokedCredentialCount: 1,
    });

    expect(onComputerDeleted).toHaveBeenCalledWith(value.exchange.computerId);
    await expect(value.machine.verifyMachineToken(value.exchange.machineToken)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
      statusCode: 401,
    });
    // Register and heartbeat keep their own fence even if a stale auth context slips through.
    await expect(value.service.assertActiveCredential(value.exchange)).rejects.toMatchObject({
      code: "COMPUTER_NOT_REGISTERED",
    });
    await expect(value.service.listAccountComputers(value.ownerId)).resolves.toEqual({ computers: [] });

    const [row] = await unit.database.select().from(computers).where(eq(computers.id, value.exchange.computerId));
    expect(row).toMatchObject({ deletedAt: NOW, currentInstanceId: null, connectedAt: null });
    const credentials = await unit.database
      .select()
      .from(computerCredentials)
      .where(eq(computerCredentials.computerId, value.exchange.computerId));
    expect(credentials.every((credential) => credential.revokedAt?.getTime() === NOW.getTime())).toBe(true);
    const [code] = await unit.database
      .select()
      .from(computerConnectCodes)
      .where(eq(computerConnectCodes.id, pendingRepair.connectCodeId));
    expect(code?.revokedAt).toEqual(NOW);
    await expect(value.machine.exchangeConnectCode(exchangeInput(pendingRepair.code))).rejects.toMatchObject({
      code: "AUTH_INVALID_CODE",
      statusCode: 401,
    });
  });

  it("keeps a committed deletion when the post-deletion hook fails, and logs the failure", async () => {
    const logger = testLogger();
    const value = await connectedComputer({
      logger,
      onComputerDeleted: () => {
        throw new Error("registry unavailable");
      },
    });

    await expect(value.service.deleteComputer(value.ownerId, value.exchange.computerId)).resolves.toMatchObject({
      computerId: value.exchange.computerId,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: value.ownerId, computerId: value.exchange.computerId }),
      "Computer deleted",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ computerId: value.exchange.computerId, err: expect.any(Error) }),
      "Post-deletion hook failed; the Computer stays deleted",
    );
    await expect(value.machine.verifyMachineToken(value.exchange.machineToken)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("never revives a deleted Computer but lets the same machine connect again as a new one", async () => {
    const value = await connectedComputer();
    await value.service.deleteComputer(value.ownerId, value.exchange.computerId);

    await expect(
      value.machine.issueForAccount(value.ownerId, { mode: "repair", targetComputerId: value.exchange.computerId }),
    ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND", statusCode: 404 });

    const fresh = await value.machine.issueForAccount(value.ownerId, {});
    const reconnected = await value.machine.exchangeConnectCode(exchangeInput(fresh.code, value.installationId));
    expect(reconnected.computerId).not.toBe(value.exchange.computerId);
    const listed = await value.service.listAccountComputers(value.ownerId);
    expect(listed.computers.map((computer) => computer.computerId)).toEqual([reconnected.computerId]);
  });

  it("refuses a Computer that still hosts Agents and ignores deleted Agents", async () => {
    const value = await connectedComputer();
    const [agent] = await unit.database
      .insert(agents)
      .values({
        createdByUserId: value.ownerId,
        computerId: value.exchange.computerId,
        name: "bound",
        displayName: "Bound",
        runtimeProvider: "codex",
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error("Agent insert did not return a row");

    await expect(value.service.deleteComputer(value.ownerId, value.exchange.computerId)).rejects.toMatchObject({
      code: "COMPUTER_IN_USE",
      statusCode: 409,
    });
    await expect(value.machine.verifyMachineToken(value.exchange.machineToken)).resolves.toMatchObject({
      computerId: value.exchange.computerId,
    });

    await unit.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, agent.id));
    await expect(value.service.deleteComputer(value.ownerId, value.exchange.computerId)).resolves.toMatchObject({
      computerId: value.exchange.computerId,
    });
  });

  it("answers 404 for a missing, foreign, or already deleted Computer", async () => {
    const onComputerDeleted = vi.fn();
    const value = await connectedComputer({ onComputerDeleted });
    const unregistered = await unit.database
      .insert(computers)
      .values({
        ownerAccountId: value.ownerId,
        kind: "local",
        currentInstallationId: randomUUID(),
        displayName: "Other",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.2",
      })
      .returning({ id: computers.id });
    const unregisteredId = unregistered[0]?.id;
    if (!unregisteredId) throw new Error("Computer insert did not return a row");

    await expect(value.service.deleteComputer(value.ownerId, randomUUID())).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
      statusCode: 404,
    });
    const otherId = randomUUID();
    await unit.database.insert(users).values({ id: otherId, email: "other@example.com", displayName: "Other" });
    await expect(value.service.deleteComputer(otherId, value.exchange.computerId)).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
      statusCode: 404,
    });
    await value.service.deleteComputer(value.ownerId, value.exchange.computerId);
    await expect(value.service.deleteComputer(value.ownerId, value.exchange.computerId)).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
      statusCode: 404,
    });
    expect(onComputerDeleted).toHaveBeenCalledTimes(1);
    // A Computer without an active credential can still be deleted; nothing is left to revoke.
    await expect(value.service.deleteComputer(value.ownerId, unregisteredId)).resolves.toEqual({
      computerId: unregisteredId,
      revokedCredentialCount: 0,
    });
  });

  it("refuses to delete a Cloud Computer", async () => {
    const value = await connectedComputer();
    const [cloud] = await unit.database
      .insert(computers)
      .values({
        ownerAccountId: value.ownerId,
        kind: "cloud",
        currentInstallationId: randomUUID(),
        displayName: "Cloud",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.2",
      })
      .returning({ id: computers.id });
    if (!cloud) throw new Error("Computer insert did not return a row");

    await expect(value.service.deleteComputer(value.ownerId, cloud.id)).rejects.toMatchObject({
      code: "COMPUTER_NOT_DELETABLE",
      statusCode: 409,
    });
  });
});
