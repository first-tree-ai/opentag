import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import { computers, imBindings } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unitDatabase: UnitDatabase;
const fixedNow = new Date("2026-11-14T00:00:00.000Z");

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);
afterAll(async () => unitDatabase?.close());
beforeEach(async () => unitDatabase?.reset());

async function fixture() {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Owner",
    email: `owner-${crypto.randomUUID()}@example.com`,
  });
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "owner-computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(unitDatabase.database).createForAccount(bootstrap.userId, {
    name: "owner-agent",
    displayName: "Owner Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const service = new ImBindingService(unitDatabase.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
    now: () => fixedNow,
  });
  return { agent, service };
}

function feishuInput(agentId: string, ownerExternalUserId?: string) {
  return {
    agentId,
    appId: "cli_owner",
    teamId: "tenant_owner",
    botOpenId: "ou_bot",
    appSecret: "secret",
    grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    ...(ownerExternalUserId ? { ownerExternalUserId } : {}),
  };
}

async function ownerOf(bindingId: string) {
  const [row] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
  return row?.ownerExternalUserId;
}

describe("IM binding owner identity", () => {
  it("leaves the owner unknown when the provider reported none", async () => {
    const value = await fixture();
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id));
    expect(await ownerOf(bindingId)).toBeNull();
  });

  it("records the Feishu owner on activation and only replaces it with a reported one", async () => {
    const value = await fixture();
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id, "ou_owner"));
    expect(await ownerOf(bindingId)).toBe("ou_owner");

    await value.service.activateFeishu(feishuInput(value.agent.id));
    expect(await ownerOf(bindingId)).toBe("ou_owner");

    await value.service.activateFeishu(feishuInput(value.agent.id, "ou_new_owner"));
    expect(await ownerOf(bindingId)).toBe("ou_new_owner");
  });
});
