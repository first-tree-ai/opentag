import { afterAll, beforeAll, beforeEach } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { cloudOverviewContract } from "../support/cloud-overview-contract.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let sql: ReturnType<typeof createDatabaseClient>["sql"];
let database: DatabaseClient;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  const client = createDatabaseClient(testDatabase.databaseUrl);
  sql = client.sql;
  database = client.database;
}, 180_000);
afterAll(async () => {
  await sql?.end();
  await testDatabase?.stop();
});
beforeEach(async () => testDatabase.reset());
cloudOverviewContract(() => database);
