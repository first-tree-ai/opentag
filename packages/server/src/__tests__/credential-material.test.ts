import { describe, expect, it, vi } from "vitest";
import {
  type CredentialDecodeOptions,
  decodeFeishuCredential,
  decodeSlackCredential,
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
});
