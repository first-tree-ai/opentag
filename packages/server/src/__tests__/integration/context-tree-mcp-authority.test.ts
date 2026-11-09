import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { mcpServerAuthorizations } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { deferred } from "../support/deferred.js";
import { githubMcpFixture } from "../support/github-mcp.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let fixture: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let writer: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  fixture = await startMigratedTestDatabase();
  client = createDatabaseClient(fixture.databaseUrl);
  writer = createDatabaseClient(fixture.databaseUrl);
}, 120_000);
afterAll(async () => {
  await client?.sql.end();
  await writer?.sql.end();
  await fixture?.stop();
});
beforeEach(async () => fixture.reset());

async function prepared() {
  const f = await githubMcpFixture(client.database);
  const agentId = f.ids[0] as string;
  const service = new AgentService(client.database, { mcpCredentialCipher: f.cipher });
  const config = await service.getConfigById(f.accountId, agentId);
  const authority = (await f.github.getOverview(f.accountId, agentId)).connection?.fence;
  if (!authority) throw new Error("Missing authority fence");
  const save = () =>
    service.updateContextTreeSelection(
      f.accountId,
      agentId,
      { ...config, runtimeConfigRevision: config.runtimeConfig.revision },
      [{ kind: "git", repository: "acme/memory", path: ".", ref: "main" }],
      authority,
    );
  return { ...f, agentId, service, save };
}

async function waitForLock(queryPart: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows =
      await writer.sql`select pid from pg_stat_activity where pid <> pg_backend_pid() and state='active' and wait_event_type='Lock' and query like ${`%${queryPart}%`}`;
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No blocked query for ${queryPart}`);
}

describe("final Context selection and MCP authority on PostgreSQL", () => {
  it("waits for an in-progress raw invalidation, then rejects the selection", async () => {
    const f = await prepared();
    const locked = deferred(),
      release = deferred();
    const invalidating = writer.database.transaction(async (tx) => {
      await tx
        .update(mcpServerAuthorizations)
        .set({ status: "expired" })
        .where(eq(mcpServerAuthorizations.id, f.root.id));
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const saving = f.save();
    const observed = saving.then(
      () => "saved",
      (error) => error.code,
    );
    try {
      await waitForLock("mcp_server_authorizations");
    } finally {
      release.resolve();
      await invalidating;
    }
    expect(await observed).toBe("AGENT_REVISION_CONFLICT");
    expect((await f.service.getConfigById(f.accountId, f.agentId)).runtimeConfig.contextTrees).toEqual([]);
  });

  it("holds the exact authentication row until selection commit, then permits invalidation", async () => {
    const f = await prepared();
    const held = deferred(),
      release = deferred();
    const barrier = writer.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(10681069)`;
      held.resolve();
      await release.promise;
    });
    await held.promise;
    await client.sql.unsafe(
      `create function context_selection_gate() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(10681069); return new; end $$`,
    );
    await client.sql.unsafe(
      `create trigger context_selection_gate before update on agent_runtime_configs for each row execute function context_selection_gate()`,
    );
    const saving = f.save();
    let invalidating: Promise<unknown> | undefined;
    try {
      await waitForLock("agent_runtime_configs");
      invalidating = writer.database
        .update(mcpServerAuthorizations)
        .set({ status: "expired" })
        .where(eq(mcpServerAuthorizations.id, f.root.id))
        .then(() => undefined);
      await waitForLock("mcp_server_authorizations");
    } finally {
      release.resolve();
      await barrier;
    }
    try {
      expect((await saving).runtimeConfig.contextTrees).toHaveLength(1);
      await invalidating;
      expect((await f.github.getOverview(f.accountId, f.agentId)).connection).toBeNull();
    } finally {
      await client.sql.unsafe("drop trigger if exists context_selection_gate on agent_runtime_configs");
      await client.sql.unsafe("drop function if exists context_selection_gate()");
    }
  });
});
