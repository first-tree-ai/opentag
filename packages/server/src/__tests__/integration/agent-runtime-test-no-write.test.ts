import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { AgentRuntimeTestOwner } from "../../runtime/agent-runtime-test-owner.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import type { RuntimeBusinessContext } from "../../runtime/runtime-session.js";
import { AgentRuntimeTestService, AgentService } from "../../services/agents/index.js";
import type { UserAuthService } from "../../services/auth/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * Product/runtime history that a runtime-test must not write.
 *
 * Covered public tables:
 * - Session: sessions, session_placements, session_descendants, session_messages, session_cli_proofs
 * - Turn / Delivery / Usage (usage is derived from turn reports): im_messages, im_message_deliveries
 * - Agent / config: agents, agent_runtime_configs
 *
 * No dedicated public tables exist for Trace, Agent Runtime binding, or Provider-readiness.
 * Those live in daemon/client memory and ConnectionRegistry; the full public-table snapshot
 * still proves they were not persisted.
 *
 * Other public tables (auth, computers, IM bindings, Slack, invitations) are also snapshotted
 * so an accidental write cannot hide outside the named history set.
 */
const HISTORY_TABLES = [
  "agents",
  "agent_runtime_configs",
  "im_message_deliveries",
  "im_messages",
  "session_cli_proofs",
  "session_descendants",
  "session_messages",
  "session_placements",
  "sessions",
] as const;

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

describe("Agent Runtime test Postgres no-write", () => {
  it("dispatches a sanitized result without creating or updating product/runtime history", async () => {
    const client = createDatabaseClient(databaseUrl);
    const appHolders: Array<ReturnType<typeof createApp>> = [];
    try {
      const bootstrap = await bootstrapInitialAdmin(client.database, {
        displayName: "Admin",
        email: "admin@example.com",
      });
      const computer = await createComputer(client.database, bootstrap.userId);
      const agents = new AgentService(client.database);
      const created = await agents.createForAccount(bootstrap.userId, {
        computerId: computer.id,
        displayName: "Code Reviewer",
        name: "code-reviewer",
        runtimeProvider: "codex",
      });

      const before = await snapshotPublicData(client.sql);
      expect(Object.keys(before.tables).sort()).toEqual(expect.arrayContaining([...HISTORY_TABLES]));

      const registry = new ConnectionRegistry();
      const instanceId = randomUUID();
      const frames: unknown[] = [];
      await registry.register(
        {
          computerId: computer.id,
          installationId: computer.installationId,
          instanceId,
          lastHeartbeatAt: Date.now(),
          negotiatedCapabilities: { [RUNTIME_CAPABILITY.agentRuntimeTest]: 1 },
          socket: {
            readyState: WebSocket.OPEN,
            close: vi.fn(),
            terminate: vi.fn(),
            send: vi.fn((serialized: string, callback: (error?: Error) => void) => {
              frames.push(JSON.parse(serialized));
              callback();
            }),
          } as unknown as WebSocket,
        },
        async () => undefined,
      );
      const owner = new AgentRuntimeTestOwner(registry);
      const runtimeTest = new AgentRuntimeTestService(agents, owner);
      const app = createApp({
        authService: authService(bootstrap.userId),
        agentService: agents,
        agentRuntimeTestService: runtimeTest,
      });
      appHolders.push(app);

      const pending = app.inject({
        method: "POST",
        url: `/api/v1/agents/${created.id}/runtime-test`,
        headers: { authorization: "Bearer access" },
        payload: {
          expectedRevision: created.revision,
          expectedRuntimeConfigRevision: created.runtimeConfig.revision,
        },
      });
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]).toMatchObject({
        type: "agent-runtime:test",
        provider: "codex",
        computerId: computer.id,
      });
      expect(frames[0]).not.toHaveProperty("prompt");
      const requestId = (frames[0] as { requestId: string }).requestId;
      const context: RuntimeBusinessContext = {
        computerId: computer.id,
        installationId: computer.installationId,
        instanceId,
        signal: new AbortController().signal,
      };
      await owner.businessOptions().handle({ type: "agent-runtime:test:result", requestId, status: "passed" }, context);
      const response = await pending;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "passed" });
      expect(owner.pendingCount()).toBe(0);

      const after = await snapshotPublicData(client.sql);
      expect(after).toEqual(before);
      for (const table of HISTORY_TABLES) {
        expect(after.tables[table]).toEqual(before.tables[table]);
      }
    } finally {
      await Promise.all(appHolders.map((app) => app.close()));
      await client.sql.end();
    }
  });
});

async function createComputer(database: ReturnType<typeof createDatabaseClient>["database"], ownerUserId: string) {
  const profile = {
    displayName: "workstation",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.2",
  };
  const [computer] = await database
    .insert(computers)
    .values({
      ownerAccountId: ownerUserId,
      currentInstallationId: randomUUID(),
      ...profile,
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  return {
    id: computer.id,
    installationId: computer.currentInstallationId,
  };
}

function authService(userId: string): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: "admin@example.com", displayName: "Admin" },
        setupCompletedAt: null,
      },
    }),
  };
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Refusing to snapshot unsafe identifier: ${name}`);
  return `"${name}"`;
}

async function snapshotPublicData(sql: ReturnType<typeof createDatabaseClient>["sql"]) {
  const tables = await sql<{ tablename: string }[]>`
    select tablename
    from pg_tables
    where schemaname = 'public'
    order by tablename
  `;
  const sequences = await sql<{ lastValue: string; sequencename: string }[]>`
    select sequencename, last_value::text as "lastValue"
    from pg_sequences
    where schemaname = 'public'
    order by sequencename
  `;
  const snapshots: Record<string, { count: number; digest: string }> = {};
  for (const { tablename } of tables) {
    const ident = quoteIdent(tablename);
    const [countRow] = await sql.unsafe(`select count(*)::int as count from ${ident}`);
    const [digestRow] = await sql.unsafe(`
      select md5(coalesce(string_agg(row_data, E'\\n' order by row_data), '')) as digest
      from (select t::text as row_data from ${ident} t) rows
    `);
    snapshots[tablename] = {
      count: Number(countRow?.count ?? 0),
      digest: String(digestRow?.digest ?? ""),
    };
  }
  return {
    tables: snapshots,
    sequences: Object.fromEntries(sequences.map((row) => [row.sequencename, row.lastValue])),
  };
}
