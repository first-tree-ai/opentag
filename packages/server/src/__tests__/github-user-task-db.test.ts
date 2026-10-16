import { afterAll, beforeAll, beforeEach } from "vitest";
import { githubUserTaskContract } from "./support/github-user-task-contract.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
});
beforeEach(async () => {
  await unit.reset();
});
afterAll(async () => {
  await unit.close();
});
githubUserTaskContract(() => unit.database);
