import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import postgres, { type TransactionSql } from "postgres";
import { createDatabaseClient } from "../../../db/client.js";
import { createDedicatedDatabaseReadinessProbe } from "../../../db/readiness-probe.js";

const [mode, continuation] = process.argv.slice(2);
const url = process.env.OPENTAG_DISCONNECT_TEST_URL;
assert.ok(url);
const emit = (event: string) => console.log(JSON.stringify({ event, mode, continuation }));
const overall = setTimeout(() => {
  emit("overall-deadline");
  process.exit(2);
}, 15_000);
overall.unref();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(pending: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Operation did not settle within 4s")), 4_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const { sql } = createDatabaseClient(url, {
  max: 1,
  ...(mode === "idle-timeout" ? { idleInTransactionTimeoutMs: 600 } : {}),
});
const admin = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => undefined });
const probe = createDedicatedDatabaseReadinessProbe(url, { deadlineMs: 1_000 });
const backend = deferred<number>();
const resume = deferred<void>();
const callbackFinished = deferred<void>();
const connectionClosed = deferred<void>();
sql.options.onclose = () => connectionClosed.resolve();
const table = `disconnect_${process.pid}`;
const callbackRollback = new Error("Old callback failed after disconnect");
let queuedSettled = 0;
let callbackFailure: unknown;

async function continueOldScope(tx: TransactionSql) {
  await resume.promise;
  if (continuation === "query" || continuation === "query-before-reuse") {
    await assert.rejects(tx.unsafe(`insert into ${table} values ('escaped')`), { code: "CONNECTION_CLOSED" });
    await assert.rejects(tx`select 1`, { code: "CONNECTION_CLOSED" });
  } else if (continuation === "savepoint") {
    let entered = false;
    await assert.rejects(
      tx.savepoint(async (nested) => {
        entered = true;
        await nested.unsafe(`insert into ${table} values ('escaped')`);
      }),
      { code: "CONNECTION_CLOSED" },
    );
    assert.equal(entered, false);
  } else if (continuation === "rollback") {
    throw callbackRollback;
  }
}

try {
  await admin.unsafe(`create table ${table} (value text)`);
  const transaction = sql.begin(async (tx) => {
    try {
      const [row] = await tx`select pg_backend_pid() as pid`;
      assert.ok(row);
      await tx.unsafe(`insert into ${table} values ('rolled-back')`);
      backend.resolve(row.pid);
      if (mode === "active-kill") {
        // More than max_pipeline, with a describe-first query, also fills the transaction's local queue.
        const results = await Promise.allSettled(
          Array.from({ length: 120 }, (_, i) => tx.unsafe("select pg_sleep(10), $1::int", [i])),
        );
        queuedSettled = results.length;
        assert.equal(
          results.every((result) => result.status === "rejected"),
          true,
        );
      }
      await continueOldScope(tx);
    } catch (error) {
      if (error !== callbackRollback) callbackFailure = error;
      throw error;
    } finally {
      callbackFinished.resolve();
    }
  });
  const outcome = transaction.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  const pid = await bounded(backend.promise);
  let precondition = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await admin`select state, wait_event from pg_stat_activity where pid = ${pid}`;
    if (mode === "active-kill" ? row?.wait_event === "PgSleep" : row?.state === "idle in transaction") {
      precondition = true;
      break;
    }
    await sleep(10);
  }
  assert.equal(precondition, true);
  if (mode !== "idle-timeout") {
    const [row] = await admin`select pg_terminate_backend(${pid}) as killed`;
    assert.equal(row?.killed, true);
  }
  for (let attempt = 0; ; attempt += 1) {
    const [row] = await admin`select count(*)::int as count from pg_stat_activity where pid = ${pid}`;
    if (row?.count === 0) break;
    assert.ok(attempt < 150, "Idle backend was not closed");
    await sleep(10);
  }
  const result = await bounded(outcome);
  await bounded(connectionClosed.promise);
  assert.ok(result.error instanceof Error, "Disconnected transaction must reject");
  emit("transaction-rejected");
  if (continuation === "query-before-reuse") {
    resume.resolve();
    await bounded(callbackFinished.promise);
    assert.equal(callbackFailure, undefined);
  }

  // Reuse the only pool connection before the old callback continues. Its commit/rollback must
  // neither finish this new transaction nor send its old writes outside a transaction.
  const freshRollback = new Error("Roll back fresh transaction");
  await assert.rejects(
    sql.begin(async (fresh) => {
      const [before] = await fresh`select txid_current()::text as id, pg_backend_pid() as pid`;
      assert.notEqual(before?.pid, pid);
      await fresh.unsafe(`insert into ${table} values ('fresh-rollback')`);
      resume.resolve();
      await bounded(callbackFinished.promise);
      assert.equal(callbackFailure, undefined);
      if (mode === "active-kill") assert.equal(queuedSettled, 120);
      await sleep(80);
      const [after] = await fresh`select txid_current()::text as id`;
      assert.equal(after?.id, before?.id, "Old callback committed or rolled back the new transaction");
      throw freshRollback;
    }),
    (error: unknown) => error === freshRollback,
  );
  emit("callback-and-new-transaction-settled");
  const [count] = await admin.unsafe(`select count(*)::int as count from ${table}`);
  assert.equal(count?.count, 0, "Disconnected transaction wrote outside its original transaction");
  await bounded(sql`select 1 as recovered`);
  await bounded(probe.run());
  emit("pool-and-readiness-recovered");
} finally {
  resume.resolve();
  await probe.close();
  await bounded(sql.end());
  await admin.unsafe(`drop table if exists ${table}`);
  await admin.end({ timeout: 1 });
  clearTimeout(overall);
}
emit("passed");
