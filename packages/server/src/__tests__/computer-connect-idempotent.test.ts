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

function input(code: string, installationId: string, extra: { machineToken?: string; reportOutcome?: true } = {}) {
  return {
    code,
    installationId,
    displayName: "Workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
    ...extra,
  };
}

async function fixture() {
  const owner = await bootstrapInitialAdmin(unit.database, { email: "owner@example.com", displayName: "Owner" }, NOW);
  const onCredentialRotated = vi.fn();
  const machine = new MachineAuthService(unit.database, { now: () => NOW, onCredentialRotated });
  const installationId = randomUUID();
  const first = await machine.exchangeConnectCode(
    input((await machine.issueForAccount(owner.userId, {})).code, installationId, { reportOutcome: true }),
  );
  if (first.outcome !== "created") throw new Error("first exchange did not create a Computer");
  return { accountId: owner.userId, machine, installationId, first, onCredentialRotated };
}

async function markOnline(computerId: string, lastSeenAt = NOW) {
  await unit.database
    .update(computers)
    .set({ currentInstanceId: randomUUID(), connectedAt: lastSeenAt, lastSeenAt })
    .where(eq(computers.id, computerId));
}

async function codeRow(connectCodeId: string) {
  const [row] = await unit.database
    .select()
    .from(computerConnectCodes)
    .where(eq(computerConnectCodes.id, connectCodeId));
  return row;
}

async function computerCount(accountId: string) {
  return (await unit.database.select().from(computers).where(eq(computers.ownerAccountId, accountId))).length;
}

async function liveCredentialIds(computerId: string) {
  const rows = await unit.database
    .select()
    .from(computerCredentials)
    .where(eq(computerCredentials.computerId, computerId));
  return rows.filter((row) => row.revokedAt === null).map((row) => row.id);
}

describe("idempotent create-mode Computer connect", () => {
  it("reports an online Computer whose current credential is presented as already connected, redeeming the code without rotation", async () => {
    const f = await fixture();
    await markOnline(f.first.computerId);
    const credentialsBefore = await liveCredentialIds(f.first.computerId);
    const issued = await f.machine.issueForAccount(f.accountId, {});
    f.onCredentialRotated.mockClear();

    const result = await f.machine.exchangeConnectCode(
      input(issued.code, f.installationId, { machineToken: f.first.machineToken, reportOutcome: true }),
    );

    expect(result).toMatchObject({ outcome: "already_connected", computerId: f.first.computerId });
    expect("machineToken" in result).toBe(false);
    // The code is redeemed by this exact Computer so the issuing page reaches its connected state,
    // but the credential is kept: no rotation and no reconnect.
    expect(await codeRow(issued.connectCodeId)).toMatchObject({
      consumedAt: NOW,
      consumedComputerId: f.first.computerId,
    });
    expect(await liveCredentialIds(f.first.computerId)).toEqual(credentialsBefore);
    expect(await computerCount(f.accountId)).toBe(1);
    expect(f.onCredentialRotated).not.toHaveBeenCalled();
    expect(await f.machine.getConnectCodeStatusForAccount(f.accountId, issued.connectCodeId)).toMatchObject({
      state: "redeemed",
      computerId: f.first.computerId,
    });
  });

  it("repairs in place when the Computer is offline, keeping its ID and rotating its credential", async () => {
    const f = await fixture();
    await markOnline(f.first.computerId, new Date(NOW.getTime() - 5 * 60_000));
    const issued = await f.machine.issueForAccount(f.accountId, {});

    const result = await f.machine.exchangeConnectCode(
      input(issued.code, f.installationId, { machineToken: f.first.machineToken, reportOutcome: true }),
    );

    expect(result).toMatchObject({ outcome: "repaired", computerId: f.first.computerId });
    expect(await computerCount(f.accountId)).toBe(1);
    expect(await codeRow(issued.connectCodeId)).toMatchObject({
      consumedAt: NOW,
      consumedComputerId: f.first.computerId,
    });
    await expect(f.machine.verifyMachineToken(f.first.machineToken)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    if (result.outcome !== "repaired") throw new Error("expected repair");
    await expect(f.machine.verifyMachineToken(result.machineToken)).resolves.toMatchObject({
      computerId: f.first.computerId,
      installationId: f.installationId,
    });
  });

  it("repairs a Server-side disconnected Computer in place and clears the disconnection", async () => {
    const f = await fixture();
    const service = new ComputerService(unit.database, { getActiveUserById: vi.fn() }, { now: () => NOW });
    await service.disconnectComputer(f.accountId, f.first.computerId);
    const issued = await f.machine.issueForAccount(f.accountId, {});

    const result = await f.machine.exchangeConnectCode(
      input(issued.code, f.installationId, { machineToken: f.first.machineToken, reportOutcome: true }),
    );

    expect(result).toMatchObject({ outcome: "repaired", computerId: f.first.computerId });
    const [row] = await unit.database.select().from(computers).where(eq(computers.id, f.first.computerId));
    expect(row).toMatchObject({ disconnectedAt: null, currentInstallationId: f.installationId });
  });

  it("repairs instead of reporting already connected when the running daemon has another version", async () => {
    const f = await fixture();
    await markOnline(f.first.computerId);
    await unit.database.update(computers).set({ clientVersion: "0.0.1" }).where(eq(computers.id, f.first.computerId));
    const issued = await f.machine.issueForAccount(f.accountId, {});

    const result = await f.machine.exchangeConnectCode(
      input(issued.code, f.installationId, { machineToken: f.first.machineToken, reportOutcome: true }),
    );

    expect(result).toMatchObject({ outcome: "repaired", computerId: f.first.computerId });
  });

  it("ignores capability build metadata when comparing the running version", async () => {
    const f = await fixture();
    await markOnline(f.first.computerId);
    const issued = await f.machine.issueForAccount(f.accountId, {});
    const result = await f.machine.exchangeConnectCode({
      ...input(issued.code, f.installationId, { machineToken: f.first.machineToken, reportOutcome: true }),
      clientVersion: "0.0.2+opentag-connect-runtime-v1",
    });
    expect(result.outcome).toBe("already_connected");
  });

  it("repairs instead of reporting already connected when the presented token is not current", async () => {
    const f = await fixture();
    await markOnline(f.first.computerId);
    const issued = await f.machine.issueForAccount(f.accountId, {});

    const withoutToken = await f.machine.exchangeConnectCode(
      input(issued.code, f.installationId, { reportOutcome: true }),
    );

    expect(withoutToken).toMatchObject({ outcome: "repaired", computerId: f.first.computerId });
  });

  it("keeps the legacy response shape for Clients that did not ask for an outcome", async () => {
    const f = await fixture();
    const issued = await f.machine.issueForAccount(f.accountId, {});

    const legacy = await f.machine.exchangeConnectCode(input(issued.code, f.installationId));

    expect(legacy.computerId).toBe(f.first.computerId);
    if (legacy.outcome === "already_connected") throw new Error("legacy exchange cannot report already connected");
    expect(legacy).not.toHaveProperty("outcome");
    expect(legacy.machineToken).toMatch(/^otmc_/);
  });

  it("refuses a code from another Account without consuming it or touching the bound Computer", async () => {
    const f = await fixture();
    await markOnline(f.first.computerId);
    const [other] = await unit.database
      .insert(users)
      .values({ email: "other@example.com", displayName: "Other" })
      .returning();
    if (!other) throw new Error("Account insert returned no row");
    const issued = await f.machine.issueForAccount(other.id, {});
    const [before] = await unit.database.select().from(computers).where(eq(computers.id, f.first.computerId));

    for (const extra of [{ machineToken: f.first.machineToken, reportOutcome: true as const }, {}]) {
      await expect(f.machine.exchangeConnectCode(input(issued.code, f.installationId, extra))).rejects.toMatchObject({
        code: "COMPUTER_ACCOUNT_CONFLICT",
        statusCode: 409,
      });
    }
    // A fresh installation identity cannot launder the machine either while it presents the other token.
    await expect(
      f.machine.exchangeConnectCode(
        input(issued.code, randomUUID(), { machineToken: f.first.machineToken, reportOutcome: true }),
      ),
    ).rejects.toMatchObject({ code: "COMPUTER_ACCOUNT_CONFLICT" });

    expect(await codeRow(issued.connectCodeId)).toMatchObject({ consumedAt: null });
    expect(await computerCount(other.id)).toBe(0);
    const [after] = await unit.database.select().from(computers).where(eq(computers.id, f.first.computerId));
    expect(after).toEqual(before);
    await expect(f.machine.verifyMachineToken(f.first.machineToken)).resolves.toMatchObject({
      computerId: f.first.computerId,
    });
  });

  it("repairs the original Computer while the local installation ID is intact, keeping its last-online time", async () => {
    const f = await fixture();
    const lastOnline = new Date(NOW.getTime() - 3 * 86_400_000);
    await markOnline(f.first.computerId, lastOnline);

    const result = await f.machine.exchangeConnectCode(
      input((await f.machine.issueForAccount(f.accountId, {})).code, f.installationId, { reportOutcome: true }),
    );

    expect(result).toMatchObject({ outcome: "repaired", computerId: f.first.computerId });
    const [row] = await unit.database.select().from(computers).where(eq(computers.id, f.first.computerId));
    expect(row).toMatchObject({ lastSeenAt: lastOnline, currentInstanceId: null, connectedAt: null });
    expect(await computerCount(f.accountId)).toBe(1);
  });

  it("keeps the last-online time through a targeted repair code", async () => {
    const f = await fixture();
    const lastOnline = new Date(NOW.getTime() - 3 * 86_400_000);
    await markOnline(f.first.computerId, lastOnline);
    const issued = await f.machine.issueForAccount(f.accountId, {
      mode: "repair",
      targetComputerId: f.first.computerId,
    });

    await f.machine.exchangeConnectCode(input(issued.code, f.installationId, { reportOutcome: true }));

    const [row] = await unit.database.select().from(computers).where(eq(computers.id, f.first.computerId));
    expect(row).toMatchObject({ lastSeenAt: lastOnline, currentInstanceId: null });
  });

  it("creates a new Computer when the local installation ID is lost, leaving the old one offline and untouched", async () => {
    const f = await fixture();
    const lastOnline = new Date(NOW.getTime() - 3 * 86_400_000);
    await unit.database
      .update(computers)
      .set({ currentInstanceId: null, connectedAt: lastOnline, lastSeenAt: lastOnline })
      .where(eq(computers.id, f.first.computerId));
    const [before] = await unit.database.select().from(computers).where(eq(computers.id, f.first.computerId));
    const credentialsBefore = await liveCredentialIds(f.first.computerId);
    f.onCredentialRotated.mockClear();

    // Same machine, name, platform, and architecture; only the local identity is gone.
    const result = await f.machine.exchangeConnectCode(
      input((await f.machine.issueForAccount(f.accountId, {})).code, randomUUID(), { reportOutcome: true }),
    );

    expect(result.outcome).toBe("created");
    expect(result.computerId).not.toBe(f.first.computerId);
    expect(await computerCount(f.accountId)).toBe(2);
    const [after] = await unit.database.select().from(computers).where(eq(computers.id, f.first.computerId));
    expect(after).toEqual(before);
    expect(await liveCredentialIds(f.first.computerId)).toEqual(credentialsBefore);
    expect(f.onCredentialRotated).not.toHaveBeenCalledWith(f.first.computerId, expect.anything());
  });

  it("creates a new Computer for another Account's code when the local identity is lost, without a conflict", async () => {
    const f = await fixture();
    const [before] = await unit.database.select().from(computers).where(eq(computers.id, f.first.computerId));
    const [other] = await unit.database
      .insert(users)
      .values({ email: "other@example.com", displayName: "Other", createdAt: NOW, updatedAt: NOW })
      .returning({ id: users.id });
    if (!other) throw new Error("user insert returned no row");

    const result = await f.machine.exchangeConnectCode(
      input((await f.machine.issueForAccount(other.id, {})).code, randomUUID(), { reportOutcome: true }),
    );

    expect(result.outcome).toBe("created");
    expect(await computerCount(other.id)).toBe(1);
    const [after] = await unit.database.select().from(computers).where(eq(computers.id, f.first.computerId));
    expect(after).toEqual(before);
  });

  it("creates a new Computer for an installation whose previous Computer was deleted", async () => {
    const f = await fixture();
    await unit.database.update(computers).set({ deletedAt: NOW }).where(eq(computers.id, f.first.computerId));
    const issued = await f.machine.issueForAccount(f.accountId, {});

    const result = await f.machine.exchangeConnectCode(input(issued.code, f.installationId, { reportOutcome: true }));

    expect(result.outcome).toBe("created");
    expect(result.computerId).not.toBe(f.first.computerId);
  });

  it("binds a targeted Agent through repair in place rather than reporting already connected", async () => {
    const f = await fixture();
    await markOnline(f.first.computerId);
    const [agent] = await unit.database
      .insert(agents)
      .values({ name: "writer", runtimeProvider: "codex", displayName: "Writer", createdByUserId: f.accountId })
      .returning();
    if (!agent) throw new Error("Agent insert returned no row");
    const issued = await f.machine.issueForAccount(f.accountId, { targetAgentId: agent.id });

    const result = await f.machine.exchangeConnectCode(
      input(issued.code, f.installationId, { machineToken: f.first.machineToken, reportOutcome: true }),
    );

    expect(result).toMatchObject({ outcome: "repaired", computerId: f.first.computerId, agentId: agent.id });
    const [bound] = await unit.database.select().from(agents).where(eq(agents.id, agent.id));
    expect(bound?.computerId).toBe(f.first.computerId);
    expect(await codeRow(issued.connectCodeId)).toMatchObject({ consumedComputerId: f.first.computerId });
  });

  it("still rejects expired and used codes before classifying the installation", async () => {
    const f = await fixture();
    await markOnline(f.first.computerId);
    const issued = await f.machine.issueForAccount(f.accountId, {});
    await unit.database
      .update(computerConnectCodes)
      .set({ createdAt: new Date(NOW.getTime() - 30 * 60_000), expiresAt: new Date(NOW.getTime() - 1) })
      .where(eq(computerConnectCodes.id, issued.connectCodeId));
    await expect(
      f.machine.exchangeConnectCode(
        input(issued.code, f.installationId, { machineToken: f.first.machineToken, reportOutcome: true }),
      ),
    ).rejects.toMatchObject({ code: "AUTH_CODE_EXPIRED" });
  });
});
