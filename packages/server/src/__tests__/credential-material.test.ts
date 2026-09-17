import { SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { slackInstallations } from "../db/schema/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import {
  type CredentialDecodeOptions,
  decodeFeishuCredential,
  decodeSlackCredential,
  feishuBindingCredentialContext,
  feishuSetupAttemptContext,
  inspectCredentialMaterial,
  slackInstallationCredentialContext,
  slackInstallationInspectionInput,
} from "../services/im-bindings/credential-material.js";

const bindingId = "binding-1";
const ciphertext = "ciphertext-secret";
const credentialSecret = "app-secret-value";

const decoders = [
  {
    name: "Feishu",
    decode: decodeFeishuCredential,
    validPayload: JSON.stringify({ appId: "app-id", appSecret: credentialSecret, grantedScopes: ["scope-a"] }),
  },
  {
    name: "Slack",
    decode: decodeSlackCredential,
    validPayload: JSON.stringify({
      botAccessToken: "xoxb-token-value",
      botId: "bot-id",
      grantedScopes: ["scope-a"],
      signingSecret: "signing-secret-value",
    }),
  },
] as const;

describe("credential material decoding", () => {
  it.each(decoders)("classifies $name decrypt, parse, and schema failures from logs", ({ decode, validPayload }) => {
    const logger = { warn: vi.fn() };
    const options: CredentialDecodeOptions = { bindingId, logger };

    expect(
      decode(
        {
          decrypt: () => {
            throw new Error("wrong key");
          },
        } as never,
        ciphertext,
        options,
      ),
    ).toBeUndefined();
    expect(decode({ decrypt: () => "not-json" } as never, ciphertext, options)).toBeUndefined();
    expect(
      decode({ decrypt: () => validPayload.replace('["scope-a"]', '"not-an-array"') } as never, ciphertext, options),
    ).toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls.map(([payload]) => payload.code)).toEqual([
      "IM_BINDING_CREDENTIAL_DECRYPT_FAILED",
      "IM_BINDING_CREDENTIAL_PAYLOAD_INVALID",
      "IM_BINDING_CREDENTIAL_SCHEMA_INVALID",
    ]);
    for (const [payload, message] of logger.warn.mock.calls) {
      expect(payload).toMatchObject({ bindingId });
      expect(JSON.stringify({ payload, message })).not.toContain(ciphertext);
      expect(JSON.stringify({ payload, message })).not.toContain(credentialSecret);
      expect(JSON.stringify({ payload, message })).not.toContain("not-an-array");
    }
  });

  it("returns decoded credentials when all stages succeed", () => {
    const logger = { warn: vi.fn() };
    const result = decodeFeishuCredential(
      {
        decrypt: () => JSON.stringify({ appId: "app-id", appSecret: credentialSecret, grantedScopes: ["scope-a"] }),
      } as never,
      ciphertext,
      { bindingId, logger },
    );

    expect(result).toEqual({ appId: "app-id", appSecret: credentialSecret, grantedScopes: ["scope-a"] });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps the Slack installation id out of bindingId on installation decrypt failure", () => {
    const installation = {
      id: "slack-installation-1",
      encryptedCredential: ciphertext,
      externalAppId: "app-id",
      externalBotId: "bot-id",
      externalTeamId: "team-id",
      credentialGeneration: 1,
      credentialSchemaVersion: 1,
      grantedCapabilities: ["scope-a"],
    } as typeof slackInstallations.$inferSelect;
    const logger = { warn: vi.fn() };
    const input = slackInstallationInspectionInput(installation);

    expect(input).toMatchObject({ slackInstallationId: installation.id });
    expect(input).not.toHaveProperty("bindingId");
    expect(
      inspectCredentialMaterial(
        {
          decrypt: () => {
            throw new Error("wrong key");
          },
        } as never,
        input,
        { logger },
      ),
    ).toMatchObject({ status: "invalid" });

    const payload = logger.warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      code: "IM_BINDING_CREDENTIAL_DECRYPT_FAILED",
      slackInstallationId: installation.id,
    });
    expect(payload.bindingId).toBeUndefined();
  });
});

describe("credential material AAD binding", () => {
  const feishuPayload = JSON.stringify({ appId: "app-id", appSecret: credentialSecret, grantedScopes: ["scope-a"] });
  const slackPayload = JSON.stringify({
    botAccessToken: "xoxb-token-value",
    botId: "bot-id",
    grantedScopes: ["scope-a"],
    signingSecret: "signing-secret-value",
  });
  // Opted into v2 writes: every stored value is bound to its purpose and record.
  const cipher = new ApplicationCipher({
    legacyKey: new Uint8Array(32).fill(7),
    keys: { "im-2026-09": new Uint8Array(32).fill(23) },
    activeKeyId: "im-2026-09",
    writeVersion: 2,
  });

  it("opens v2 values only under the exact owning record, purpose, and context", () => {
    const logger = { warn: vi.fn() };
    const stored = cipher.encryptCredential(feishuPayload, feishuBindingCredentialContext("binding-1"));
    expect(stored).toMatch(/^v2\./);
    expect(decodeFeishuCredential(cipher, stored, { bindingId: "binding-1", logger })).toMatchObject({
      appId: "app-id",
    });
    // Row swap: another binding's identity cannot open this value.
    expect(decodeFeishuCredential(cipher, stored, { bindingId: "binding-2", logger })).toBeUndefined();
    // Owner-less reads fail closed instead of weakening to unauthenticated decryption.
    expect(decodeFeishuCredential(cipher, stored, { logger })).toBeUndefined();
    // Purpose swap: a Slack read of a Feishu-bound value fails identically.
    expect(decodeSlackCredential(cipher, stored, { slackInstallationId: "installation-1", logger })).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(3);
    for (const [payload] of logger.warn.mock.calls) {
      expect(payload.code).toBe("IM_BINDING_CREDENTIAL_DECRYPT_FAILED");
      expect(JSON.stringify(payload)).not.toContain(credentialSecret);
    }
  });

  it("binds Slack installation material to the installation record, not the route", () => {
    const logger = { warn: vi.fn() };
    const stored = cipher.encryptCredential(slackPayload, slackInstallationCredentialContext("installation-1"));
    expect(
      decodeSlackCredential(cipher, stored, { bindingId: "binding-1", slackInstallationId: "installation-1", logger }),
    ).toMatchObject({ botId: "bot-id" });
    expect(
      decodeSlackCredential(cipher, stored, { bindingId: "binding-1", slackInstallationId: "installation-2", logger }),
    ).toBeUndefined();
    expect(decodeSlackCredential(cipher, stored, { bindingId: "binding-1", logger })).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("binds setup attempt secrets to the owning binding and attempt", () => {
    const secret = JSON.stringify({ qrUrl: "https://open.feishu.cn/qr/example" });
    const stored = cipher.encryptCredential(secret, feishuSetupAttemptContext("binding-1", "attempt-1"));
    expect(cipher.decrypt(stored, feishuSetupAttemptContext("binding-1", "attempt-1"))).toBe(secret);
    // Another attempt on the same binding and the same attempt on another binding both fail.
    expect(() => cipher.decrypt(stored, feishuSetupAttemptContext("binding-1", "attempt-2"))).toThrow(/authenticated/);
    expect(() => cipher.decrypt(stored, feishuSetupAttemptContext("binding-2", "attempt-1"))).toThrow(/authenticated/);
  });

  it("dual-reads legacy v1 values under context-aware callsites", () => {
    const logger = { warn: vi.fn() };
    const v1 = new ApplicationCipher(new Uint8Array(32).fill(7)).encrypt(feishuPayload);
    expect(decodeFeishuCredential(cipher, v1, { bindingId: "binding-1", logger })).toMatchObject({ appId: "app-id" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("inspects v2 installation material through the record identity", () => {
    const grantedScopes = [...SLACK_REQUIRED_BOT_SCOPES].sort();
    const inspectablePayload = JSON.stringify({
      botAccessToken: "xoxb-token-value",
      botId: "bot-id",
      grantedScopes,
      signingSecret: "signing-secret-value",
    });
    const installation = {
      id: "installation-1",
      encryptedCredential: cipher.encryptCredential(
        inspectablePayload,
        slackInstallationCredentialContext("installation-1"),
      ),
      externalAppId: "app-id",
      externalBotId: "bot-id",
      externalTeamId: "team-id",
      credentialGeneration: 1,
      credentialSchemaVersion: 1,
      grantedCapabilities: grantedScopes,
    } as typeof slackInstallations.$inferSelect;
    expect(inspectCredentialMaterial(cipher, slackInstallationInspectionInput(installation))).toMatchObject({
      status: "valid",
    });
    const swapped = { ...installation, id: "installation-2" } as typeof slackInstallations.$inferSelect;
    expect(inspectCredentialMaterial(cipher, slackInstallationInspectionInput(swapped))).toMatchObject({
      status: "invalid",
    });
  });
});
