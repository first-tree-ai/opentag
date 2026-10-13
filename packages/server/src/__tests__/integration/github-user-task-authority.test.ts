import { afterAll, beforeAll, beforeEach } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { githubUserTaskContract } from "../support/github-user-task-contract.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let database: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  database = await startMigratedTestDatabase();
  client = createDatabaseClient(database.databaseUrl);
}, 120000);
beforeEach(async () => {
  await database.reset();
});
afterAll(async () => {
  await client?.sql.end();
  await database?.stop();
});
githubUserTaskContract(() => client.database);
