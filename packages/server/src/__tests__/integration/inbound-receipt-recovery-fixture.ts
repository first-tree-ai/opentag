import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
export async function createInboundFixture(databaseUrl: string) {
  const client = createDatabaseClient(databaseUrl);
  const clock = { now: new Date() };
  const account = await bootstrapInitialAdmin(client.database, {
    email: "inbound@example.test",
    displayName: "Inbound",
  });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: account.userId,
      currentInstallationId: randomUUID(),
      currentInstanceId: randomUUID(),
      displayName: "Local",
      platform: "linux",
      arch: "x64",
      clientVersion: "test",
    })
    .returning();
  assert(computer);
  const agent = await new AgentService(client.database).createForAccount(account.userId, {
    name: "inbound",
    displayName: "Inbound",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const service = new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
    now: () => clock.now,
  });
  return { client, clock, account, computer, agent, service, close: () => client.sql.end() };
}
