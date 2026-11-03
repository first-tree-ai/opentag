import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import { computerCredentials, computers, users } from "../db/schema/index.js";
import { ComputerService, deriveMachineFingerprintKey, MachineAuthService } from "../services/computers/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const NOW = new Date("2026-09-22T00:00:00.000Z");
const KEY = deriveMachineFingerprintKey("test-login-secret-that-is-long-enough-000");
const MACHINE = createHash("sha256").update("machine-a").digest("hex");
let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

function input(code: string, installationId: string, extra: Record<string, unknown> = {}) {
  return {
    code,
    installationId,
    displayName: "Workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
    reportOutcome: true as const,
    machineFingerprint: MACHINE,
    ...extra,
  };
}

async function account(email: string) {
  if (email === "owner@example.com") {
    return (await bootstrapInitialAdmin(unit.database, { email, displayName: "Owner" }, NOW)).userId;
  }
  const [row] = await unit.database
    .insert(users)
    .values({ email, displayName: "Other", status: "active", createdAt: NOW, updatedAt: NOW })
    .returning({ id: users.id });
  if (!row) throw new Error("user insert returned no row");
  return row.id;
}

async function connect(machine: MachineAuthService, accountId: string, installationId: string, extra = {}) {
  const issued = await machine.issueForAccount(accountId, {});
  return machine.exchangeConnectCode(input(issued.code, installationId, extra));
}

async function row(computerId: string) {
  const [found] = await unit.database.select().from(computers).where(eq(computers.id, computerId));
  if (!found) throw new Error("computer not found");
  return found;
}

async function seen(computerId: string, lastSeenAt: Date, online: boolean) {
  await unit.database
    .update(computers)
    .set({ currentInstanceId: online ? randomUUID() : null, connectedAt: lastSeenAt, lastSeenAt })
    .where(eq(computers.id, computerId));
}

async function liveComputers(accountId: string) {
  return (await unit.database.select().from(computers).where(eq(computers.ownerAccountId, accountId))).filter(
    (computer) => computer.deletedAt === null,
  );
}

async function fixture() {
  const accountId = await account("owner@example.com");
  const onCredentialRotated = vi.fn();
  const machine = new MachineAuthService(unit.database, {
    now: () => NOW,
    onCredentialRotated,
    machineFingerprintKey: KEY,
  });
  const first = await connect(machine, accountId, randomUUID());
  return { accountId, machine, first, onCredentialRotated };
}

describe("recognizing a machine after its local identity was lost", () => {
  it("repairs the one offline Computer with the same fingerprint, keeping its ID and last-online time", async () => {
    const f = await fixture();
    const lastOnline = new Date(NOW.getTime() - 3 * 86_400_000);
    await seen(f.first.computerId, lastOnline, false);
    const newInstallation = randomUUID();

    const result = await connect(f.machine, f.accountId, newInstallation);

    expect(result).toMatchObject({ outcome: "repaired", computerId: f.first.computerId });
    expect(await row(f.first.computerId)).toMatchObject({
      currentInstallationId: newInstallation,
      lastSeenAt: lastOnline,
      currentInstanceId: null,
    });
    expect(await liveComputers(f.accountId)).toHaveLength(1);
    await expect(f.machine.verifyMachineToken(f.first.machineToken)).rejects.toBeTruthy();
  });

  it("stores only a per-Account keyed hash, never the value the Client sent", async () => {
    const f = await fixture();
    const other = await account("other@example.com");
    const elsewhere = await connect(f.machine, other, randomUUID());

    const mine = (await row(f.first.computerId)).machineFingerprint;
    const theirs = (await row(elsewhere.computerId)).machineFingerprint;
    expect(mine).toMatch(/^[0-9a-f]{64}$/);
    expect(mine).not.toBe(MACHINE);
    expect(theirs).not.toBe(mine);
    // A match in another Account is impossible by construction, so it never raises an Account conflict.
    expect(elsewhere.outcome).toBe("created");
  });

  it("treats an online match as a clone and creates a new Computer without touching the original", async () => {
    const f = await fixture();
    await seen(f.first.computerId, NOW, true);
    const credentialsBefore = await unit.database
      .select()
      .from(computerCredentials)
      .where(eq(computerCredentials.computerId, f.first.computerId));
    f.onCredentialRotated.mockClear();

    const clone = await connect(f.machine, f.accountId, randomUUID());

    expect(clone.outcome).toBe("created");
    expect(clone.computerId).not.toBe(f.first.computerId);
    expect(
      await unit.database
        .select()
        .from(computerCredentials)
        .where(eq(computerCredentials.computerId, f.first.computerId)),
    ).toEqual(credentialsBefore);
    expect(f.onCredentialRotated).not.toHaveBeenCalledWith(f.first.computerId, expect.anything());
  });

  it("creates a new Computer when several offline Computers share the fingerprint", async () => {
    const f = await fixture();
    await seen(f.first.computerId, NOW, true);
    const second = await connect(f.machine, f.accountId, randomUUID());
    await seen(f.first.computerId, new Date(NOW.getTime() - 86_400_000), false);
    await seen(second.computerId, new Date(NOW.getTime() - 86_400_000), false);

    const third = await connect(f.machine, f.accountId, randomUUID());

    expect(third.outcome).toBe("created");
    expect(await liveComputers(f.accountId)).toHaveLength(3);
  });

  it("creates a new Computer when the offline match reports another name, platform, or architecture", async () => {
    for (const change of [{ displayName: "Build-runner-7" }, { platform: "darwin" }, { arch: "arm64" }]) {
      await unit.reset();
      const f = await fixture();
      await seen(f.first.computerId, new Date(NOW.getTime() - 86_400_000), false);

      const result = await connect(f.machine, f.accountId, randomUUID(), change);

      expect(result.outcome).toBe("created");
      expect(result.computerId).not.toBe(f.first.computerId);
    }
  });

  it("keeps today's behavior without a fingerprint or without a key", async () => {
    const f = await fixture();
    await seen(f.first.computerId, new Date(NOW.getTime() - 86_400_000), false);
    const unsent = await connect(f.machine, f.accountId, randomUUID(), { machineFingerprint: undefined });
    expect(unsent.outcome).toBe("created");

    const keyless = new MachineAuthService(unit.database, { now: () => NOW });
    const other = await connect(keyless, f.accountId, randomUUID());
    expect(other.outcome).toBe("created");
    expect((await row(other.computerId)).machineFingerprint).toBeNull();
    // An exchange without a fingerprint never clears the one already recorded.
    expect((await row(f.first.computerId)).machineFingerprint).not.toBeNull();
  });

  it("clears the fingerprint on delete and never returns it from the inventory", async () => {
    const f = await fixture();
    const stored = (await row(f.first.computerId)).machineFingerprint;
    const service = new ComputerService(unit.database, { getActiveUserById: vi.fn() }, { now: () => NOW });
    const inventory = JSON.stringify(await service.listAccountComputers(f.accountId, true, true, true));
    expect(stored).toBeTruthy();
    expect(inventory).not.toContain(String(stored));
    expect(inventory).not.toContain("machineFingerprint");

    await service.deleteComputer(f.accountId, f.first.computerId);

    expect((await row(f.first.computerId)).machineFingerprint).toBeNull();
    const after = await connect(f.machine, f.accountId, randomUUID());
    expect(after).toMatchObject({ outcome: "created" });
    expect(after.computerId).not.toBe(f.first.computerId);
  });
});
