import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { CloudCallStore } from "../../services/cloud-call-store.js";
import { CloudModelService } from "../../services/cloud-model-service.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
let c: ReturnType<typeof createDatabaseClient>, admin: ReturnType<typeof createDatabaseClient>;
const services: CloudModelService[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
  c = createDatabaseClient(pg.databaseUrl, { max: 2, statementTimeoutMs: 250, queryTimeoutMs: 1500 });
  admin = createDatabaseClient(pg.databaseUrl, { max: 1 });
}, 120000);
const accountId = randomUUID();
beforeEach(async () => {
  await c.sql`truncate billing.attempts`;
  await c.sql`insert into users(id,email,display_name) values (${accountId},${`${accountId}@example.test`},'Cloud audit') on conflict do nothing`;
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});
afterAll(async () => {
  await c?.sql.end({ timeout: 1 });
  await admin?.sql.end({ timeout: 1 });
  await pg?.stop();
});
const config = {
  enabled: true as const,
  gatewayId: "llm-router",
  upstreamBaseUrl: "https://fixture.test/v1",
  masterKey: "test-only",
  tokenTtlSeconds: 60,
  maxStreamsPerToken: 2,
  requestTimeoutMs: 2000,
  maxRequestBytes: 65536,
  maxResponseBytes: 65536,
};
const usage = { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2 };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
function fixture(
  options: { usageGate?: ReturnType<typeof gate>; entered?: ReturnType<typeof gate>; pending?: Set<string> } = {},
) {
  const calls = new CloudCallStore({ query: async (q, p = []) => ({ rows: await c.sql.unsafe(q, p as never[]) }) });
  let posts = 0;
  const looked: string[] = [];
  const events: string[] = [];
  const service = new CloudModelService(config, {
    calls,
    onError: (e) => events.push(e),
    fetchImpl: async (input) => {
      if (!String(input).includes("/requests/usage")) {
        posts++;
        return Response.json({ choices: [] });
      }
      const key = new URL(String(input)).searchParams.get("idempotency_key");
      assert(key);
      looked.push(key);
      options.entered?.release();
      await options.usageGate?.promise;
      return Response.json({
        status: options.pending?.has(key) ? "pending" : "complete",
        idempotencyKey: key,
        requestId: randomUUID(),
        model: "model-a",
        ...(options.pending?.has(key) ? {} : { usage }),
      });
    },
  });
  services.push(service);
  const create = () =>
    calls.create(
      { accountId, agentId: randomUUID(), sessionId: null, source: "execution" },
      { gateway: "llm-router", model: "model-a" },
      null,
    );
  return { calls, service, create, posts: () => posts, looked, events };
}
async function lock(id: string) {
  const held = gate(),
    release = gate();
  const task = admin.sql.begin(async (tx) => {
    await tx`select id from billing.attempts where id=${id} for update`;
    held.release();
    await release.promise;
  });
  await held.promise;
  return async () => {
    release.release();
    await task;
  };
}
it("recovers a failed final/fallback SQL write without a second completion POST", async () => {
  const entered = gate(),
    resume = gate(),
    f = fixture({ usageGate: resume, entered });
  const response = await f.service.request(
    { model: "model-a", messages: [{ role: "user", content: "hello" }] },
    new AbortController().signal,
    config,
    { accountId, agentId: randomUUID(), sessionId: null, source: "execution" },
  );
  const body = response.text();
  await entered.promise;
  const id = f.looked[0];
  assert(id);
  const unlock = await lock(id);
  try {
    resume.release();
    await body;
    expect((await f.calls.get(id)).state).toBe("in_flight");
    expect(f.events).toContain("cloud_usage_settlement_failed");
    expect((await c.sql`select 1 as n`)[0]?.n).toBe(1);
  } finally {
    await unlock();
  }
  await c.sql`update billing.attempts set created_at=now()-interval '10 minutes' where id=${id}`;
  await f.service.reconcile();
  expect((await f.calls.get(id)).state).toBe("finalized");
  expect(f.posts()).toBe(1);
  expect(f.looked).toHaveLength(2);
});
it("skips a locked expired call and recovers unrelated usage in the same pass", async () => {
  const f = fixture(),
    expired = await f.create(),
    pending = await f.create();
  await c.sql`update billing.attempts set created_at=now()-interval '10 minutes' where id=${expired}`;
  await f.calls.markPending(pending);
  const unlock = await lock(expired);
  try {
    await f.service.reconcile();
    expect(f.looked).toEqual([pending]);
    expect((await f.calls.get(pending)).state).toBe("finalized");
    expect((await f.calls.get(expired)).state).toBe("in_flight");
    expect((await c.sql`select 1 as n`)[0]?.n).toBe(1);
  } finally {
    await unlock();
  }
  await f.service.reconcile();
  expect((await f.calls.get(pending)).state).toBe("finalized");
  expect((await f.calls.get(expired)).state).toBe("finalized");
});
it("isolates a locked defer row from an unrelated complete usage result", async () => {
  const pendingSet = new Set<string>(),
    f = fixture({ pending: pendingSet }),
    first = await f.create(),
    second = await f.create();
  pendingSet.add(first);
  await f.calls.markPending(first);
  await f.calls.markPending(second);
  await c.sql`update billing.attempts set reconcile_after=now()-interval '1 minute' where id=${first}`;
  const unlock = await lock(first);
  try {
    await f.service.reconcile();
    expect(f.looked).toEqual([first, second]);
    expect((await f.calls.get(second)).state).toBe("finalized");
    expect(f.events).toContain("cloud_usage_recovery_failed");
    expect((await c.sql`select 1 as n`)[0]?.n).toBe(1);
  } finally {
    await unlock();
  }
  await f.service.reconcile();
  expect((await f.calls.get(second)).state).toBe("finalized");
});

it("attempts pending fallback SQL only once when that write fails", async () => {
  const entered = gate(),
    resume = gate(),
    pending = new Set<string>(),
    f = fixture({ usageGate: resume, entered, pending });
  const response = await f.service.request(
    { model: "model-a", messages: [{ role: "user", content: "hello" }] },
    new AbortController().signal,
    config,
    { accountId, agentId: randomUUID(), sessionId: null, source: "execution" },
  );
  const body = response.text();
  await entered.promise;
  const id = f.looked[0];
  assert(id);
  pending.add(id);
  const unlock = await lock(id);
  let writes = 0;
  const original = c.sql.options.debug;
  c.sql.options.debug = (_id, q) => {
    if (q.includes("SET state='pending_usage'")) writes++;
  };
  try {
    resume.release();
    await body;
    expect(writes).toBe(1);
    expect((await f.calls.get(id)).state).toBe("in_flight");
  } finally {
    c.sql.options.debug = original;
    await unlock();
  }
});

it("expires at most 100 calls per pass without changing startup abandonment", async () => {
  const f = fixture();
  await admin.sql`insert into billing.attempts(id,account,agent_id,source,gateway,model,created_at) select gen_random_uuid()::text,${accountId},${randomUUID()},'execution','llm-router','model-a',now()-interval '10 minutes' from generate_series(1,105)`;
  await f.calls.expire(new Date());
  expect(await c.sql`select count(*)::int as n from billing.attempts where state='pending_usage'`).toEqual([
    { n: 100 },
  ]);
  expect(await c.sql`select count(*)::int as n from billing.attempts where state='in_flight'`).toEqual([{ n: 5 }]);
  await f.calls.abandon();
  expect(await c.sql`select count(*)::int as n from billing.attempts where state='pending_usage'`).toEqual([
    { n: 105 },
  ]);
});

it("joins a stopped usage lookup and admits no later row or fallback write", async () => {
  const entered = gate(),
    resume = gate(),
    f = fixture({ usageGate: resume, entered });
  const first = await f.create(),
    second = await f.create();
  await f.calls.markPending(first);
  await f.calls.markPending(second);
  f.service.startRecovery();
  await entered.promise;
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((done) => setImmediate(done));
    expect(closed).toBe(false);
  } finally {
    resume.release();
    await closing;
  }
  expect(f.looked).toHaveLength(1);
  expect((await f.calls.get(first)).state).toBe("pending_usage");
  expect((await f.calls.get(second)).state).toBe("pending_usage");
  expect(await c.sql`select sum(reconcile_failures)::int as n from billing.attempts`).toEqual([{ n: 0 }]);
});

it("records the representative expiry query plan over finalized history", async () => {
  await admin.sql`insert into billing.attempts(id,account,agent_id,source,gateway,model,created_at,state,resolution) select gen_random_uuid()::text,${accountId},${randomUUID()},'execution','llm-router','model-a',now()-interval '1 day','finalized','unbilled' from generate_series(1,50000)`;
  await admin.sql`insert into billing.attempts(id,account,agent_id,source,gateway,model,created_at) select gen_random_uuid()::text,${accountId},${randomUUID()},'execution','llm-router','model-a',now()-interval '10 minutes' from generate_series(1,150)`;
  await admin.sql`analyze billing.attempts`;
  let statement = "",
    parameters: unknown[] = [];
  await new CloudCallStore({
    query: async (sql, params) => {
      statement = sql;
      parameters = params ?? [];
      return { rows: [] };
    },
  }).expire(new Date());
  const result = await admin.sql.unsafe(`explain (analyze, buffers, format json) ${statement}`, parameters as never[]);
  const plan = result[0]?.["QUERY PLAN"] as { Plan: Record<string, unknown>; "Execution Time": number }[];
  const nodes: Record<string, unknown>[] = [];
  const visit = (node: Record<string, unknown>) => {
    if (node["Relation Name"] === "attempts")
      nodes.push({
        "Node Type": node["Node Type"],
        "Actual Rows": node["Actual Rows"],
        "Rows Removed by Filter": node["Rows Removed by Filter"],
        "Index Name": node["Index Name"],
      });
    for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
  };
  const sample = plan[0];
  assert(sample);
  visit(sample.Plan);
  console.log("expiry-plan", JSON.stringify({ executionMs: sample["Execution Time"], scans: nodes }));
  expect(await c.sql`select count(*)::int as n from billing.attempts where state='pending_usage'`).toEqual([
    { n: 100 },
  ]);
});
