import { afterAll, beforeAll, beforeEach } from "vitest";
import { cloudOverviewContract } from "./support/cloud-overview-contract.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());
cloudOverviewContract(() => unit.database);
