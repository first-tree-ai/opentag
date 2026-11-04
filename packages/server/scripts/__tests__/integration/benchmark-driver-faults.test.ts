import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startPostgresTestContainer } from "../../../src/__tests__/integration/postgres-test-container.js";
import { startDatabaseFaultProxy } from "../../../src/__tests__/integration/support/postgres-fault-proxy.js";
import { DatabaseQueryTimeoutError } from "../../../src/db/query-deadline.js";
import { openAdmin } from "../../cancel-benchmark-runtime.js";

let container: StartedPostgreSqlContainer;
beforeAll(async () => {
  container = await startPostgresTestContainer();
}, 120000);
afterAll(async () => container?.stop());

it("bounds a lost admin reply and recovers through a new connection with shared defaults", async () => {
  const proxy = await startDatabaseFaultProxy(container.getConnectionUri());
  const admin = await openAdmin(proxy.url);
  try {
    expect(
      await admin.query(
        "select current_setting('statement_timeout') as statement, current_setting('idle_in_transaction_session_timeout') as idle",
      ),
    ).toMatchObject([{ statement: "30s", idle: "1min" }]);
    const connections = proxy.freeze();
    const started = performance.now();
    await expect(admin.query("select 1")).rejects.toBeInstanceOf(DatabaseQueryTimeoutError);
    expect(performance.now() - started).toBeLessThan(40000);
    await expect.poll(() => connections.every(({ clientEnded }) => clientEnded)).toBe(true);
    expect(await admin.query("select 42 as answer")).toMatchObject([{ answer: 42 }]);
  } finally {
    await admin.end();
    await proxy.close();
  }
}, 45000);

it("native five-second admin end releases a hung query before the query deadline", async () => {
  const proxy = await startDatabaseFaultProxy(container.getConnectionUri());
  const admin = await openAdmin(proxy.url);
  try {
    proxy.freeze();
    const result = admin.query("select 1").then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = performance.now();
    await admin.end();
    expect(performance.now() - started).toBeLessThan(8000);
    expect(await result).toMatchObject({ code: "CONNECTION_DESTROYED" });
    const fresh = await openAdmin(container.getConnectionUri());
    try {
      expect(await fresh.query("select 7 as answer")).toMatchObject([{ answer: 7 }]);
    } finally {
      await fresh.end();
    }
  } finally {
    await admin.end();
    await proxy.close();
  }
}, 12000);
