import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { createDatabaseClient } from "../../../db/client.js";
import { createDedicatedDatabaseReadinessProbe } from "../../../db/readiness-probe.js";

const url = process.env.OPENTAG_DISCONNECT_TEST_URL;
assert.ok(url);
const overall = setTimeout(() => process.exit(2), 12_000);
overall.unref();
const { sql } = createDatabaseClient(url, { max: 3, idleInTransactionTimeoutMs: 1_500 });
const admin = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => undefined });
const probe = createDedicatedDatabaseReadinessProbe(url, { deadlineMs: 1_000 });
const table = `lock_release_${process.pid}`;
let release!: () => void;
const held = new Promise<void>((resolve) => {
  release = resolve;
});
let ready!: (pid: number) => void;
const backend = new Promise<number>((resolve) => {
  ready = resolve;
});
let finished!: () => void;
const callbackFinished = new Promise<void>((resolve) => {
  finished = resolve;
});

try {
  await admin.unsafe(`create table ${table} (value int)`);
  const root = sql
    .begin(async (tx) => {
      try {
        await tx.unsafe(`lock table ${table} in access exclusive mode`);
        const [row] = await tx`select pg_backend_pid() as pid`;
        ready(row?.pid);
        await held;
      } finally {
        finished();
      }
    })
    .then(
      () => false,
      () => true,
    );
  const pid = await backend;
  const waiters = [1, 2].map((value) => sql.unsafe(`insert into ${table} values ($1)`, [value]).execute());
  const settled = Promise.all(waiters);
  let observed = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] =
      await admin`select count(*)::int as count from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`;
    if (row?.count === 2) {
      observed = true;
      break;
    }
    await sleep(10);
  }
  assert.equal(observed, true, "Both application connections must be waiting on the root lock");
  await probe.run();
  assert.equal(await root, true, "Idle root transaction must fail");
  await settled;
  release();
  await callbackFinished;
  await sleep(80);
  const [count] = await sql.unsafe(`select count(*)::int as count from ${table}`);
  assert.equal(count?.count, 2);
  const [blocked] =
    await admin`select count(*)::int as count from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`;
  assert.equal(blocked?.count, 0);
  await probe.run();
} finally {
  release();
  await probe.close();
  await sql.end({ timeout: 1 });
  await admin.unsafe(`drop table if exists ${table}`);
  await admin.end({ timeout: 1 });
  clearTimeout(overall);
}
console.log(JSON.stringify({ event: "lock-released-pool-and-readiness-recovered" }));
