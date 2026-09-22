import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import { agents, computerConnectCodes, computers, users } from "../db/schema/index.js";
import { ComputerService, MachineAuthService } from "../services/computers/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const NOW = new Date("2026-09-22T00:00:00.000Z");
let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());
function input(code: string, installationId = randomUUID()) {
  return {
    code,
    installationId,
    displayName: "Workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
  };
}
async function fixture() {
  const owner = await bootstrapInitialAdmin(unit.database, { email: "owner@example.com", displayName: "Owner" }, NOW);
  const machine = new MachineAuthService(unit.database, { now: () => NOW });
  const issued = await machine.issueForAccount(owner.userId, {});
  const exchange = await machine.exchangeConnectCode(input(issued.code));
  const onComputerDisconnected = vi.fn();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new ComputerService(
    unit.database,
    { getActiveUserById: vi.fn() },
    { now: () => NOW, onComputerDisconnected, logger },
  );
  return { accountId: owner.userId, exchange, machine, service, onComputerDisconnected, logger };
}

describe("explicit Computer disconnection", () => {
  it("revokes access and pending repairs, preserves Agent bindings, and reconnects the same identity", async () => {
    const f = await fixture();
    const computerId = f.exchange.computerId;
    const [agent] = await unit.database
      .insert(agents)
      .values({
        name: "writer",
        runtimeProvider: "codex",
        displayName: "Writer",
        createdByUserId: f.accountId,
        computerId,
      })
      .returning();
    if (!agent) throw new Error("Agent insert returned no row");
    const oldRepair = await f.machine.issueForAccount(f.accountId, { mode: "repair", targetComputerId: computerId });
    await f.service.disconnectComputer(f.accountId, computerId);
    expect(f.onComputerDisconnected).toHaveBeenCalledWith(computerId);
    await expect(f.machine.verifyMachineToken(f.exchange.machineToken)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    await expect(f.service.assertActiveCredential(f.exchange)).rejects.toMatchObject({
      code: "COMPUTER_NOT_REGISTERED",
    });
    expect((await f.service.listAccountComputers(f.accountId)).computers).toEqual([]);
    const listed = await f.service.listAccountComputers(f.accountId, true, true, true);
    expect(listed.computers).toHaveLength(1);
    expect(listed.computers[0]).toMatchObject({
      computerId,
      connectionStatus: "disconnected",
      agentIds: [agent?.id],
      connectedAt: null,
    });
    expect((await f.machine.getConnectCodeStatusForAccount(f.accountId, oldRepair.connectCodeId)).state).toBe(
      "revoked",
    );
    const fresh = await f.machine.issueForAccount(f.accountId, { mode: "repair", targetComputerId: computerId });
    const reconnected = await f.machine.exchangeConnectCode(input(fresh.code));
    expect(reconnected.computerId).toBe(computerId);
    expect((await f.service.listAccountComputers(f.accountId, false, false, true)).computers[0]).toMatchObject({
      connectionStatus: "offline",
      agentIds: [agent?.id],
    });
    await expect(f.machine.verifyMachineToken(reconnected.machineToken)).resolves.toMatchObject({ computerId });
    // Revocation stays effective after reconnect: old commands cannot rotate away the new credential.
    await expect(f.machine.exchangeConnectCode(input(oldRepair.code))).rejects.toMatchObject({
      code: "AUTH_INVALID_CODE",
    });
    const [bound] = await unit.database.select().from(agents).where(eq(agents.id, agent.id));
    expect(bound?.computerId).toBe(computerId);
  });

  it("is idempotent and keeps revocation committed when the live connection close fails", async () => {
    const f = await fixture();
    f.onComputerDisconnected.mockRejectedValue(new Error("socket unavailable"));
    await f.service.disconnectComputer(f.accountId, f.exchange.computerId);
    await f.service.disconnectComputer(f.accountId, f.exchange.computerId);
    expect(f.logger.warn).toHaveBeenCalledTimes(2);
    const [row] = await unit.database.select().from(computers).where(eq(computers.id, f.exchange.computerId));
    expect(row).toMatchObject({ disconnectedAt: NOW, deletedAt: null, currentInstanceId: null });
    await expect(f.machine.verifyMachineToken(f.exchange.machineToken)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
  });

  it("does not disclose or revoke another Account's computer and rejects Cloud computers", async () => {
    const f = await fixture();
    const [other] = await unit.database
      .insert(users)
      .values({ email: "other@example.com", displayName: "Other" })
      .returning();
    if (!other) throw new Error("Account insert returned no row");
    await expect(f.service.disconnectComputer(other.id, f.exchange.computerId)).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
      statusCode: 404,
    });
    await expect(f.service.disconnectComputer(f.accountId, randomUUID())).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
    });
    await expect(f.machine.verifyMachineToken(f.exchange.machineToken)).resolves.toBeDefined();
    await unit.database.update(computers).set({ kind: "cloud" }).where(eq(computers.id, f.exchange.computerId));
    await expect(f.service.disconnectComputer(f.accountId, f.exchange.computerId)).rejects.toMatchObject({
      code: "COMPUTER_NOT_DISCONNECTABLE",
    });
    expect(f.onComputerDisconnected).not.toHaveBeenCalled();
  });

  it("allows deleting an unused disconnected computer and prevents its repair", async () => {
    const f = await fixture();
    await f.service.disconnectComputer(f.accountId, f.exchange.computerId);
    const repair = await f.machine.issueForAccount(f.accountId, {
      mode: "repair",
      targetComputerId: f.exchange.computerId,
    });
    await f.service.deleteComputer(f.accountId, f.exchange.computerId);
    expect((await f.service.listAccountComputers(f.accountId, false, true, true)).computers).toEqual([]);
    await expect(f.machine.exchangeConnectCode(input(repair.code))).rejects.toMatchObject({
      code: "AUTH_INVALID_CODE",
    });
    const [code] = await unit.database
      .select()
      .from(computerConnectCodes)
      .where(eq(computerConnectCodes.id, repair.connectCodeId));
    expect(code?.revokedAt).toEqual(NOW);
  });
});
