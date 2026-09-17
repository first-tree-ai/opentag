import { FEISHU_REQUIRED_TENANT_SCOPES, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import { computers, imBindings, slackInstallations } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { feishuSetupAttemptContext } from "../services/im-bindings/credential-material.js";
import type { FeishuRegistrationGateway } from "../services/im-bindings/feishu/index.js";
import { FeishuSetupService } from "../services/im-bindings/feishu/index.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/*
 * Service-level coverage for the staged v2 credential envelope: IM writes opt into the
 * authenticated envelope through configuration, every read path presents the matching
 * purpose/owner/record context, row swaps fail closed, and pre-rollout v1 rows keep reading.
 */

let unitDatabase: UnitDatabase;
const fixedNow = new Date("2026-08-19T00:00:00.000Z");

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);
afterAll(async () => unitDatabase?.close());
beforeEach(async () => unitDatabase?.reset());

const legacyKey = new Uint8Array(32).fill(7);

function writeV2Cipher() {
  return new ApplicationCipher({
    legacyKey,
    keys: { "im-2026-09": new Uint8Array(32).fill(23) },
    activeKeyId: "im-2026-09",
    writeVersion: 2,
  });
}

async function fixture(cipher: ApplicationCipher = writeV2Cipher()) {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Admin",
    email: `aad-${crypto.randomUUID()}@example.com`,
  });
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "aad-computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agents = new AgentService(unitDatabase.database);
  const logger = { warn: vi.fn() };
  const service = new ImBindingService(unitDatabase.database, cipher, { now: () => fixedNow, logger });
  const createAgent = (name: string) =>
    agents.createForAccount(bootstrap.userId, {
      name,
      displayName: name,
      runtimeProvider: "codex",
      computerId: computer.id,
    });
  return { bootstrap, cipher, computer, createAgent, logger, service };
}

function feishuInput(agentId: string, appId: string) {
  return {
    agentId,
    appId,
    teamId: `tenant_${appId}`,
    botOpenId: `ou_${appId}`,
    appSecret: `secret-${appId}`,
    grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
  };
}

function slackInput(agentId: string, appId: string) {
  return {
    intent: "create" as const,
    agentId,
    appId,
    teamId: `T_${appId}`,
    botUserId: `U_${appId}`,
    grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    botAccessToken: `xoxb-${appId}`,
    signingSecret: `signing-${appId}`,
    installedAt: fixedNow,
  };
}

describe("IM credential v2 envelope at the service layer", () => {
  it("writes v2 for Feishu bindings, re-encrypts on reauthorization, and denies row swaps", async () => {
    const value = await fixture();
    const firstAgent = await value.createAgent("first-agent");
    const secondAgent = await value.createAgent("second-agent");
    const first = await value.service.activateFeishu(feishuInput(firstAgent.id, "cli_first"));
    const second = await value.service.activateFeishu(feishuInput(secondAgent.id, "cli_second"));

    const [firstRow] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, first));
    expect(firstRow?.encryptedCredential).toMatch(/^v2\.im-2026-09\./);
    expect(firstRow?.encryptedCredential).not.toContain("secret-cli_first");
    expect((await value.service.getFeishuConnectionMaterial(first))?.appSecret).toBe("secret-cli_first");

    // Reauthorization re-encrypts onto the same row ID: the same AAD keeps reading.
    await value.service.activateFeishu(feishuInput(firstAgent.id, "cli_first"));
    expect((await value.service.getFeishuConnectionMaterial(first))?.appSecret).toBe("secret-cli_first");

    // A ciphertext copied onto another binding's row cannot be opened there.
    await unitDatabase.database
      .update(imBindings)
      .set({ encryptedCredential: firstRow?.encryptedCredential })
      .where(eq(imBindings.id, second));
    await expect(value.service.getFeishuConnectionMaterial(second)).resolves.toBeUndefined();
    expect(
      (await value.service.getConfigForAgent(value.bootstrap.userId, secondAgent.id))?.reauthorizationRequired,
    ).toBe(true);
    expect(value.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "IM_BINDING_CREDENTIAL_DECRYPT_FAILED", bindingId: second }),
      expect.any(String),
    );
  });

  it("writes v2 for Slack installations and denies installation swaps", async () => {
    const value = await fixture();
    const firstAgent = await value.createAgent("first-slack-agent");
    const secondAgent = await value.createAgent("second-slack-agent");
    await value.service.activateSlack(slackInput(firstAgent.id, "A_FIRST"), "B_FIRST");
    await value.service.activateSlack(slackInput(secondAgent.id, "A_SECOND"), "B_SECOND");
    const installations = await unitDatabase.database.select().from(slackInstallations);
    const firstInstallation = installations.find((row) => row.externalAppId === "A_FIRST");
    const secondInstallation = installations.find((row) => row.externalAppId === "A_SECOND");
    if (!firstInstallation || !secondInstallation) throw new Error("Installations were not created");
    expect(firstInstallation.encryptedCredential).toMatch(/^v2\.im-2026-09\./);
    expect(firstInstallation.encryptedCredential).not.toContain("xoxb-A_FIRST");

    expect(await value.service.findSlackInstallationIngress("A_FIRST", "T_A_FIRST")).toMatchObject({
      installationId: firstInstallation.id,
      botAccessToken: "xoxb-A_FIRST",
    });

    await unitDatabase.database
      .update(slackInstallations)
      .set({ encryptedCredential: firstInstallation.encryptedCredential })
      .where(eq(slackInstallations.id, secondInstallation.id));
    await expect(value.service.findSlackInstallationIngress("A_SECOND", "T_A_SECOND")).resolves.toBeUndefined();
    expect(value.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "IM_BINDING_CREDENTIAL_DECRYPT_FAILED",
        slackInstallationId: secondInstallation.id,
      }),
      expect.any(String),
    );
  });

  it("dual-reads pre-rollout v1 rows under the v2 write configuration", async () => {
    // A row written before the rollout carries a v1 envelope under the legacy key.
    const value = await fixture();
    const agent = await value.createAgent("legacy-agent");
    const bindingId = await value.service.activateFeishu(feishuInput(agent.id, "cli_legacy"));
    const legacyCipher = new ApplicationCipher(legacyKey);
    const v1 = legacyCipher.encrypt(
      JSON.stringify({
        appId: "cli_legacy",
        appSecret: "secret-cli_legacy",
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES].sort(),
      }),
    );
    expect(v1).toMatch(/^v1\./);
    await unitDatabase.database.update(imBindings).set({ encryptedCredential: v1 }).where(eq(imBindings.id, bindingId));

    // Reads present the context but v1 values still open, so the rollout can dual-read.
    expect((await value.service.getFeishuConnectionMaterial(bindingId))?.appSecret).toBe("secret-cli_legacy");
    expect(value.logger.warn).not.toHaveBeenCalled();
    // The next reauthorization writes v2 under the same row ID.
    await value.service.activateFeishu(feishuInput(agent.id, "cli_legacy"));
    const [row] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
    expect(row?.encryptedCredential).toMatch(/^v2\.im-2026-09\./);
  });

  it("binds Feishu setup attempt secrets to the owning binding and attempt", async () => {
    const value = await fixture();
    const firstAgent = await value.createAgent("setup-first");
    const secondAgent = await value.createAgent("setup-second");
    const pending = new Promise<{ appId: string; appSecret: string }>(() => undefined);
    void pending.catch(() => undefined);
    const gateway: FeishuRegistrationGateway = {
      start: vi.fn(() => ({
        qrReady: Promise.resolve({
          url: "https://feishu.example/qr/aad",
          expiresAt: new Date(Date.now() + 60_000),
        }),
        result: pending,
        abort: vi.fn(),
      })),
    };
    const setup = new FeishuSetupService({
      database: unitDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.service,
      registrations: gateway,
      activation: { activateAtomicAttempt: vi.fn() },
    });
    try {
      const first = await setup.createOrReuse(value.bootstrap.userId, firstAgent.id, "create");
      await setup.createOrReuse(value.bootstrap.userId, secondAgent.id, "create");
      expect(first.qrUrl).toBe("https://feishu.example/qr/aad");
      expect((await setup.get(value.bootstrap.userId, first.id)).qrUrl).toBe("https://feishu.example/qr/aad");

      const [firstRow] = await unitDatabase.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.agentId, firstAgent.id));
      const [secondRow] = await unitDatabase.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.agentId, secondAgent.id));
      expect(firstRow?.encryptedSetupContext).toMatch(/^v2\.im-2026-09\./);
      expect(firstRow?.encryptedSetupContext).not.toContain("feishu.example");
      // The stored envelope authenticates the exact binding and attempt identities.
      expect(
        value.cipher.decrypt(
          firstRow?.encryptedSetupContext ?? "",
          feishuSetupAttemptContext(firstRow?.id ?? "", first.id),
        ),
      ).toContain("feishu.example");

      // Copying another attempt's secret onto this row fails closed.
      await unitDatabase.database
        .update(imBindings)
        .set({ encryptedSetupContext: secondRow?.encryptedSetupContext })
        .where(eq(imBindings.id, firstRow?.id ?? ""));
      await expect(setup.get(value.bootstrap.userId, first.id)).rejects.toThrow(/authenticated/);
    } finally {
      await setup.stop();
    }
  });
});
