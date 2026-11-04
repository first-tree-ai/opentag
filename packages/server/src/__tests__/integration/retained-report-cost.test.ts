import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import { createDatabaseClient } from "../../db/client.js";
import * as schema from "../../db/schema/index.js";
import { imMessageDeliveries, imMessages } from "../../db/schema/index.js";
import { createPerformanceLogger } from "../../observability/performance-logger.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { createFixture } from "./im-recovery-locks-fixture.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

type Event = Record<string, unknown>;
type Claim = NonNullable<SessionReconcileResult["retainedReports"]>[number];
const scenarios = ["reported", "unchanged-unreported", "new-owner"] as const;
type Scenario = (typeof scenarios)[number];
let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 180_000);
afterAll(async () => pg?.stop());

it.each(scenarios.flatMap((scenario) => [0, 1, 32, 65].map((count) => ({ scenario, count }))))(
  "measures $count retained reports: $scenario",
  async ({ scenario, count }) => {
    await pg.reset();
    const events: Event[] = [];
    const capture = (event: Event) => events.push(event);
    const logger = { debug: capture, info: capture, warn: capture, error: capture } as unknown as FastifyBaseLogger;
    const performanceLogger = createPerformanceLogger(() => logger);
    const client = createDatabaseClient(pg.databaseUrl, { max: 1, performanceLogger });
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const database = process.env.RETAINED_REPORT_PLANS
      ? drizzle(client.sql, { schema, logger: { logQuery: (sql, params) => statements.push({ sql, params }) } })
      : client.database;
    const custody = new PostgresRuntimeCustodyStore(database);
    let owner: RuntimeDomainOwner | undefined;
    try {
      const { f, claims } = await seedClaims(client, custody, scenario, count);

      const registry = new ConnectionRegistry();
      const context = scenario === "new-owner" ? { ...f.context, instanceId: randomUUID() } : f.context;
      await registry.register(
        {
          clientVersion: "0.1.1",
          computerId: context.computerId,
          installationId: context.installationId,
          instanceId: context.instanceId,
          lastHeartbeatAt: Date.now(),
          negotiatedCapabilities: { "runtime.sessionReconcile": 1 },
          socket: {
            readyState: WebSocket.OPEN,
            send: (_serialized: string, callback: (error?: Error) => void) => callback(),
          } as unknown as WebSocket,
        },
        async () => undefined,
      );
      owner = new RuntimeDomainOwner(registry, custody, { requestTimeoutMs: 30_000 });
      const samples: Event[] = [];
      const runs = count === 32 && scenario !== "new-owner" && !process.env.RETAINED_REPORT_PLANS ? 11 : 1;
      for (let index = 0; index < runs; index++) {
        const request: SessionReconcileRequest = {
          type: "session:reconcile",
          requestId: randomUUID(),
          installationId: context.installationId,
          sessionId: f.sessionId,
          agentId: f.agentId,
          placementGeneration: 1,
          desired: "stopped",
        };
        const dispatched = owner.requestReconcile(context.computerId, context.instanceId, request);
        const before = await readVersions(client, claims);
        events.length = 0;
        statements.length = 0;
        const started = performance.now();
        await owner.handle(
          {
            type: "session:reconcile:result",
            requestId: request.requestId,
            sessionId: f.sessionId,
            placementGeneration: 1,
            status: "stopped",
            retainedReports: claims,
          },
          context,
        );
        const handlerMs = performance.now() - started;
        await expect(dispatched).resolves.toMatchObject({ status: "stopped" });
        const completed = events.filter((event) => event.outcome === "completed");
        const queries = completed.filter((event) => event.operation === "db.query");
        const transaction = completed.find((event) => event.operation === "db.transaction");
        const after = await readVersions(client, claims);
        const oldVersions = new Map(before.map((row) => [row.id, row.version]));
        const rowVersionsChanged = after.filter((row) => oldVersions.get(row.id) !== row.version).length;
        const counts: Record<string, number> = {};
        for (const query of queries) {
          const key = `${query.sqlCommand}:${query.dbTarget ?? "none"}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        const deliveryUpdates = queries.filter(
          (query) => query.sqlCommand === "UPDATE" && query.dbTarget === "im_message_deliveries",
        );
        const sample = {
          scenario,
          count,
          index,
          handlerMs,
          transactionMs: transaction?.durationMs ?? 0,
          queryCount: queries.length,
          queryMaxMs: Math.max(0, ...queries.map((query) => Number(query.durationMs))),
          queryTotalMs: queries.reduce((sum, query) => sum + Number(query.durationMs), 0),
          deliveryUpdateStatements: deliveryUpdates.length,
          deliveryUpdatedRows: deliveryUpdates.reduce((sum, query) => sum + Number(query.rowCount), 0),
          rowVersionsChanged,
          counts,
        };
        expect(Boolean(transaction)).toBe(count > 0);
        const writes = scenario === "new-owner" ? count : 0;
        expect(deliveryUpdates).toHaveLength(writes);
        expect(sample.deliveryUpdatedRows).toBe(writes);
        expect(rowVersionsChanged).toBe(writes);
        expect(queries).toHaveLength(expectedQueryCount(scenario, count));
        samples.push(sample);
      }
      await writeQueryPlans(client, statements, scenario, process.env.RETAINED_REPORT_PLANS);
      const rows = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(
          inArray(
            imMessageDeliveries.id,
            claims.map((claim) => claim.deliveryId),
          ),
        );
      expect(rows).toHaveLength(count);
      expect(rows.every((row) => row.reportOwnerInstanceId === context.instanceId)).toBe(true);
      console.log(JSON.stringify({ scenario, count, samples }));
      if (process.env.RETAINED_REPORT_MEASUREMENTS) {
        await appendFile(process.env.RETAINED_REPORT_MEASUREMENTS, `${JSON.stringify({ scenario, count, samples })}\n`);
      }
    } finally {
      await owner?.close();
      await client.sql.end({ timeout: 5 });
    }
  },
  60_000,
);

async function seedClaims(
  client: ReturnType<typeof createDatabaseClient>,
  custody: PostgresRuntimeCustodyStore,
  scenario: Scenario,
  count: number,
) {
  const f = await createFixture(client.database);
  const claims: Claim[] = [];
  const [message] = await client.database.select().from(imMessages).where(eq(imMessages.id, f.rootRequest.imMessageId));
  assert(message);
  for (let index = 0; index < count; index++) {
    const messageId = index === 0 ? message.id : randomUUID();
    const deliveryId = index === 0 ? f.rootDeliveryId : randomUUID();
    if (index !== 0) {
      await client.database.insert(imMessages).values({ ...message, id: messageId, externalMessageId: randomUUID() });
      await client.database.insert(imMessageDeliveries).values({
        id: deliveryId,
        messageId,
        sessionId: f.sessionId,
        attention: "direct",
        placementGeneration: 1,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    }
    const direct = { ...f.rootRequest, requestId: randomUUID(), deliveryId, imMessageId: messageId };
    const inputHash = computeDirectInputHash(direct);
    const turnId = randomUUID();
    expect(await custody.beginDeliveryDispatch(direct, inputHash, f.dispatchContext)).toBe("dispatched");
    expect(await custody.acceptDelivery(direct, inputHash, turnId, f.context)).toBe("accepted");
    const body = {
      deliveryId,
      turnId,
      sessionId: f.sessionId,
      agentId: f.agentId,
      placementGeneration: 1,
      outcome: "completed" as const,
      executionEffects: "completed" as const,
      traceSummary: { lastSequence: 0, droppedEvents: 0 },
    };
    const report: TurnReportRequest = {
      type: "turn:report",
      requestId: randomUUID(),
      ...body,
      resultHash: computeTurnResultHash(body),
    };
    if (scenario === "reported") expect(await custody.recordTurn(report, f.context)).toBe("recorded");
    else {
      await client.database
        .update(imMessageDeliveries)
        .set({ resultHash: report.resultHash })
        .where(eq(imMessageDeliveries.id, deliveryId));
    }
    claims.push({
      deliveryId,
      dispatchRequestId: direct.requestId,
      turnId,
      inputHash,
      placementGeneration: 1,
      resultHash: report.resultHash,
    });
  }
  return { f, claims };
}

function expectedQueryCount(scenario: Scenario, count: number) {
  if (count === 0) return 0;
  if (scenario === "reported") return 3;
  return 3 + count * (scenario === "new-owner" ? 5 : 4);
}

async function readVersions(client: ReturnType<typeof createDatabaseClient>, claims: Claim[]) {
  if (claims.length === 0) return [];
  return client.sql<{ id: string; version: string }[]>`
    select id, xmin::text as version from im_message_deliveries where id in ${client.sql(claims.map((c) => c.deliveryId))}
  `;
}

async function writeQueryPlans(
  client: ReturnType<typeof createDatabaseClient>,
  statements: Array<{ sql: string; params: unknown[] }>,
  scenario: Scenario,
  outputPath: string | undefined,
) {
  if (!outputPath) return;
  const selects = new Map(
    statements.filter((statement) => statement.sql.startsWith("select")).map((statement) => [statement.sql, statement]),
  );
  for (const statement of selects.values()) {
    const plan = await client.sql.unsafe(
      `explain (analyze, buffers, format json) ${statement.sql}`,
      statement.params as NonNullable<Parameters<typeof client.sql.unsafe>[1]>,
    );
    await appendFile(outputPath, `${JSON.stringify({ scenario, sql: statement.sql, plan })}\n`);
  }
}
