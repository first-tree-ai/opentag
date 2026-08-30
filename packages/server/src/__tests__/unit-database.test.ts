import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../db/schema/index.js";
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

  it("clears application data between tests without losing the schema", async () => {
    await unitDatabase.database.insert(users).values({ displayName: "Transient", email: "transient@example.com" });
    await unitDatabase.reset();

    expect(await unitDatabase.database.select().from(users)).toHaveLength(0);
  });
});
