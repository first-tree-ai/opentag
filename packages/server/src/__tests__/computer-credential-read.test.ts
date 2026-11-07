import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computerCredentials, computers, users } from "../db/schema/index.js";
import { ComputerService } from "../services/computers/index.js";
import type { ComputerAuthContext } from "../services/computers/machine-auth-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

async function fixture(kind: "local" | "cloud" = "local") {
  const accountId = randomUUID();
  const context: ComputerAuthContext = {
    computerId: randomUUID(),
    installationId: randomUUID(),
    credentialId: randomUUID(),
    kind,
  };
  await unit.database.insert(users).values({ id: accountId, email: "credential@example.com", displayName: "Owner" });
  await unit.database.insert(computers).values({
    id: context.computerId,
    ownerAccountId: accountId,
    kind,
    currentInstallationId: context.installationId,
    displayName: "Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.0",
  });
  if (kind === "local") {
    await unit.database.insert(computerCredentials).values({
      id: context.credentialId,
      computerId: context.computerId,
      issuedByUserId: accountId,
      secretHash: randomUUID(),
    });
  }
  return { accountId, context };
}

describe("Computer business-frame credential admission", () => {
  it("uses one read without a transaction for default and explicit Local contexts", async () => {
    const { context } = await fixture();
    const cloudHook = vi.fn();
    const service = new ComputerService(unit.database, {} as never, { assertCloudControlCredential: cloudHook });
    const select = vi.spyOn(unit.database, "select");
    const transaction = vi.spyOn(unit.database, "transaction");
    try {
      for (const kind of [undefined, "local"] as const) {
        select.mockClear();
        await expect(service.assertActiveCredential({ ...context, kind })).resolves.toBeUndefined();
        expect(select).toHaveBeenCalledTimes(1);
      }
      expect(transaction).not.toHaveBeenCalled();
      expect(cloudHook).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      transaction.mockRestore();
    }
  });

  it.each(["credential", "computer", "installation", "kind", "revocation", "deletion"])(
    "rejects a Local %s mismatch",
    async (mismatch) => {
      const { context, accountId } = await fixture();
      if (mismatch === "credential") context.credentialId = randomUUID();
      if (mismatch === "computer") context.computerId = randomUUID();
      if (mismatch === "installation") context.installationId = randomUUID();
      if (mismatch === "kind") {
        await unit.database.update(computers).set({ kind: "cloud" }).where(eq(computers.id, context.computerId));
      }
      if (mismatch === "revocation") {
        await unit.database
          .update(computerCredentials)
          .set({ revokedAt: new Date(), revokedByUserId: accountId })
          .where(eq(computerCredentials.id, context.credentialId));
      }
      if (mismatch === "deletion") {
        await unit.database
          .update(computers)
          .set({ deletedAt: new Date() })
          .where(eq(computers.id, context.computerId));
      }
      await expect(
        new ComputerService(unit.database, {} as never).assertActiveCredential(context),
      ).rejects.toMatchObject({
        code: "COMPUTER_NOT_REGISTERED",
        statusCode: 409,
      });
    },
  );

  it("rejects a credential belonging to another Computer", async () => {
    const { context, accountId } = await fixture();
    const [other] = await unit.database
      .insert(computers)
      .values({
        ownerAccountId: accountId,
        currentInstallationId: randomUUID(),
        displayName: "Other",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.0",
      })
      .returning();
    if (!other) throw new Error("Missing Computer fixture");
    await unit.database
      .update(computerCredentials)
      .set({ computerId: other.id })
      .where(eq(computerCredentials.id, context.credentialId));
    await expect(new ComputerService(unit.database, {} as never).assertActiveCredential(context)).rejects.toMatchObject(
      { code: "COMPUTER_NOT_REGISTERED" },
    );
  });

  it("revalidates Cloud authority on every admission without requiring a Local credential row", async () => {
    const { context } = await fixture("cloud");
    context.credentialId = "deployment-control-credential";
    const hook = vi.fn();
    const service = new ComputerService(unit.database, {} as never, { assertCloudControlCredential: hook });
    const transaction = vi.spyOn(unit.database, "transaction");
    const select = vi.spyOn(unit.database, "select");
    try {
      await service.assertActiveCredential(context);
      expect(select).toHaveBeenCalledTimes(1);
      expect(transaction).not.toHaveBeenCalled();
      expect(hook).toHaveBeenCalledWith(context);
      const revoked = new Error("Control credential revoked");
      hook.mockRejectedValueOnce(revoked);
      await expect(service.assertActiveCredential(context)).rejects.toBe(revoked);
      expect(hook).toHaveBeenCalledTimes(2);
    } finally {
      transaction.mockRestore();
      select.mockRestore();
    }
  });

  it.each(["hook", "computer", "kind", "installation", "deletion"])("fails closed for Cloud %s", async (mismatch) => {
    const { context } = await fixture("cloud");
    const hook = vi.fn();
    if (mismatch === "computer") context.computerId = randomUUID();
    if (mismatch === "installation") context.installationId = randomUUID();
    if (mismatch === "kind") {
      await unit.database.update(computers).set({ kind: "local" }).where(eq(computers.id, context.computerId));
    }
    if (mismatch === "deletion") {
      await unit.database.update(computers).set({ deletedAt: new Date() }).where(eq(computers.id, context.computerId));
    }
    const service = new ComputerService(unit.database, {} as never, {
      ...(mismatch === "hook" ? {} : { assertCloudControlCredential: hook }),
    });
    await expect(service.assertActiveCredential(context)).rejects.toMatchObject({ code: "COMPUTER_NOT_REGISTERED" });
    expect(hook).not.toHaveBeenCalled();
  });
});
