import { describe, expect, it } from "vitest";
import { redactAcceptanceRecord } from "../runner/redact.js";

describe("acceptance redaction", () => {
  it("redacts secrets without hiding failure names", () => {
    const redacted = redactAcceptanceRecord({
      name: "model",
      status: "failed",
      detail: "DEEPSEEK_API_KEY=sk-secretvalue bearer sk-abcdefghijklmnopqrstuvwxyz token=abc",
      auth: { apiKey: "secret", nested: { password: "p" } },
    });
    expect(redacted.status).toBe("failed");
    expect(redacted.name).toBe("model");
    expect(JSON.stringify(redacted)).not.toMatch(/sk-secretvalue|secretvalue|token=abc/);
    expect(redacted.auth.apiKey).toBe("[redacted]");
    expect(redacted.detail).toMatch(/\[redacted\]/);
  });

  it("redacts quoted JSON secret fields and full Authorization/Bearer values", () => {
    const jsonField = redactAcceptanceRecord('{"apiKey":"canary1234567890"}');
    expect(jsonField).not.toContain("canary1234567890");
    expect(jsonField).toContain("[redacted]");
    const jsonFieldSpaced = redactAcceptanceRecord('{"refresh_token": "canary1234567890"}');
    expect(jsonFieldSpaced).not.toContain("canary1234567890");
    const header = redactAcceptanceRecord("Authorization: Bearer canary1234567890");
    expect(header).not.toContain("canary1234567890");
    expect(header).toBe("Authorization: [redacted]");
    const lowerHeader = redactAcceptanceRecord("authorization=Bearer canary1234567890");
    expect(lowerHeader).not.toContain("canary1234567890");
    const jsonHeader = redactAcceptanceRecord('{"authorization":"Bearer canary1234567890"}');
    expect(jsonHeader).not.toContain("canary1234567890");
  });

  it("keeps ordinary diagnostics and harmless text untouched", () => {
    expect(redactAcceptanceRecord('{"name":"context-tree-read"}')).toBe('{"name":"context-tree-read"}');
    expect(redactAcceptanceRecord('{"defaultModel":"deepseek-v4.1-flash"}')).toBe(
      '{"defaultModel":"deepseek-v4.1-flash"}',
    );
    expect(redactAcceptanceRecord(JSON.stringify({ model: "deepseek-v4.1", ok: true }))).toBe(
      JSON.stringify({ model: "deepseek-v4.1", ok: true }),
    );
    expect(redactAcceptanceRecord("expected 42, got 41")).toBe("expected 42, got 41");
    expect(redactAcceptanceRecord("Authorization is required")).toBe("Authorization is required");
  });

  it("redacts escaped-quote JSON values, auth.json key fields, and standalone Bearer tokens", () => {
    // A valid JSON string with an escaped quote inside the secret value must be redacted whole.
    const escaped = JSON.stringify({ apiKey: 'prefix"canary1234567890' });
    const redactedEscaped = redactAcceptanceRecord(escaped);
    expect(redactedEscaped).toBe('{"apiKey":"[redacted]"}');
    expect(redactedEscaped).not.toMatch(/canary/i);
    expect(redactedEscaped).not.toContain("1234567890");
    for (let length = 4; length <= "canary1234567890".length; length += 1) {
      expect(redactedEscaped).not.toContain("canary1234567890".slice(0, length));
    }
    // The common auth.json field name "key" is redacted like object redaction treats it.
    const authDoc = JSON.stringify({ deepseek: { type: "api_key", key: "canary1234567890" } });
    const redactedAuth = redactAcceptanceRecord(authDoc);
    expect(redactedAuth).not.toContain("canary1234567890");
    expect(redactedAuth).toContain('"type":"api_key"');
    expect(redactedAuth).toContain('"key":"[redacted]"');
    // Standalone Bearer without an Authorization prefix is redacted as well.
    const standalone = redactAcceptanceRecord("Bearer canary1234567890");
    expect(standalone).toBe("Bearer [redacted]");
    expect(standalone).not.toContain("canary1234567890");
  });
});
