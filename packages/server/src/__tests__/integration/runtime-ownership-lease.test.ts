import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { acquireRuntimeOwnershipLease } from "../../runtime/runtime-ownership-lease.js";

describe("runtime ownership advisory lease", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("fails a second instance closed and releases the lease for a restart", async () => {
    const databaseUrl = container.getConnectionUri();
    const first = createDatabaseClient(databaseUrl, { max: 1 });
    const second = createDatabaseClient(databaseUrl, { max: 1 });
    const firstInstanceId = "11111111-1111-4111-8111-111111111111";
    const secondInstanceId = "22222222-2222-4222-8222-222222222222";

    try {
      const firstLease = await acquireRuntimeOwnershipLease(first.sql, firstInstanceId);
      await expect(acquireRuntimeOwnershipLease(second.sql, secondInstanceId)).rejects.toMatchObject({
        code: "RUNTIME_OWNER_LEASE_HELD",
        message: expect.stringContaining("one Server replica"),
      });

      await firstLease.release();
      const restartedLease = await acquireRuntimeOwnershipLease(second.sql, secondInstanceId);
      await restartedLease.release();
    } finally {
      await Promise.all([first.sql.end(), second.sql.end()]);
    }
  }, 120_000);
});
