import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { AgentStatusService } from "../../services/agents/agent-status-service.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let database: MigratedTestDatabase;
beforeAll(async () => {
  database = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => database?.stop());

describe("batch Agent status against PostgreSQL", () => {
  it("reads an owner-scoped batch within the query budget among unrelated Agents", async () => {
    const client = createDatabaseClient(database.databaseUrl, { max: 1 });
    try {
      const owner = randomUUID(),
        other = randomUUID(),
        computer = randomUUID();
      await client.sql`insert into users (id, email, display_name) values (${owner}, 'status-owner@example.test', 'Owner'), (${other}, 'status-other@example.test', 'Other')`;
      await client.sql`insert into computers (id, owner_account_id, current_installation_id, display_name, platform, arch, client_version) values (${computer}, ${owner}, ${randomUUID()}, 'Computer', 'linux', 'x64', '0.1.1')`;
      const owned =
        await client.sql`insert into agents (created_by_user_id, computer_id, name, display_name, runtime_provider) select ${owner}, ${computer}, 'owned-' || i, 'Owned', 'codex' from generate_series(1,100) i returning id`;
      await client.sql`insert into agents (created_by_user_id, name, display_name, runtime_provider) select ${other}, 'other-' || i, 'Other', 'codex' from generate_series(1,5000) i`;
      const service = new AgentStatusService(
        client.database,
        new ConnectionRegistry(),
        new ApplicationCipher(Buffer.alloc(32, 7)),
      );
      const ids = owned.map((row) => String(row.id));
      const durations: number[] = [];
      for (let sample = 0; sample < 5; sample++) {
        const started = performance.now();
        const result = await service.read(owner, ids);
        durations.push(performance.now() - started);
        expect(result.statuses).toHaveLength(100);
        expect(result.statuses.every((status) => status.state === "computer_offline")).toBe(true);
      }
      expect(Math.max(...durations)).toBeLessThan(500);
      await expect(service.read(other, ids)).rejects.toMatchObject({ statusCode: 404 });
      const [column] =
        await client.sql`select is_nullable, column_default from information_schema.columns where table_name = 'im_feedback_targets' and column_name = 'message_format'`;
      expect(column).toMatchObject({ is_nullable: "NO", column_default: "'interactive_v1'::text" });
    } finally {
      await client.sql.end();
    }
  }, 30_000);
});
