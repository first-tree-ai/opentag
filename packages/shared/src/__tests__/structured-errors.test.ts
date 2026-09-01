import { describe, expect, it } from "vitest";
import {
  BOUNDED_DIAGNOSTIC_SERIALIZATION_BYTES,
  boundedSerialize,
  DiagnosticEventSchema,
  redactForLog,
  redactSensitive,
  STRUCTURED_ERROR_LOG_FIELD_MAX_BYTES,
  StructuredErrorSchema,
} from "../structured-errors.js";

describe("structured error taxonomy", () => {
  it("accepts a structured error with a bounded cause chain", () => {
    const error = {
      code: "RUNTIME_PROVIDER_TIMEOUT",
      category: "timeout",
      retryability: "backoff",
      phase: "provider",
      requestId: "request-123",
      message: "The provider did not respond before the deadline",
      cause: {
        code: "UPSTREAM_TIMEOUT",
        category: "timeout",
        retryability: "backoff",
        phase: "transport",
        message: "The upstream request timed out",
      },
    };

    expect(StructuredErrorSchema.parse(error)).toEqual(error);
  });

  it("requires the taxonomy fields and rejects unknown fields", () => {
    expect(() =>
      StructuredErrorSchema.parse({
        code: "INVALID",
        category: "unknown",
        retryability: "never",
        phase: "request",
        message: "invalid",
      }),
    ).toThrow();
    expect(() =>
      StructuredErrorSchema.parse({
        code: "INVALID",
        category: "internal",
        retryability: "never",
        phase: "request",
        message: "invalid",
        rawToken: "do-not-accept",
      }),
    ).toThrow();
  });

  it("accepts a diagnostic event envelope", () => {
    const event = {
      type: "diagnostic.error",
      occurredAt: "2026-08-31T00:00:00.000Z",
      error: {
        code: "WORKER_FAILURE",
        category: "internal",
        retryability: "never",
        phase: "worker",
        message: "The background worker failed",
      },
    };
    expect(DiagnosticEventSchema.parse(event)).toEqual(event);
  });
});

describe("structured error redaction", () => {
  it("redacts sensitive keys, headers, request bodies, and credential strings", () => {
    const input = {
      authorization: "Bearer top-secret-token",
      headers: { Cookie: "session=private", "X-Trace": "safe" },
      requestBody: { password: "password-value", prompt: "private prompt" },
      nested: [{ api_key: "key-value", safe: "keep me" }],
      message: "Authorization: Bearer embedded-token; cookie=session-cookie",
      standaloneHeaderText: "authorization=header-secret cookie=cookie-secret",
    };

    const serialized = boundedSerialize(input);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("keep me");
    for (const secret of [
      "top-secret-token",
      "private",
      "password-value",
      "private prompt",
      "key-value",
      "embedded-token",
      "session-cookie",
      "header-secret",
      "cookie-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("bounds output and handles cycles without throwing", () => {
    const cyclic: Record<string, unknown> = { safe: "value", payload: "secret" };
    cyclic.self = cyclic;
    const serialized = boundedSerialize(cyclic);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(BOUNDED_DIAGNOSTIC_SERIALIZATION_BYTES);
    expect(serialized).not.toContain("secret");
    expect(() => redactSensitive(cyclic)).not.toThrow();
  });

  it("redacts Error causes and preserves safe primitive representations", () => {
    const nested = new Error("nested password=nested-secret");
    Object.assign(nested, { code: "NESTED_FAILURE" });
    const error = new Error("provider Authorization: Bearer error-secret", { cause: nested });
    Object.assign(error, { code: "PROVIDER_FAILURE" });

    const redacted = redactSensitive({
      error,
      nullValue: null,
      undefinedValue: undefined,
      booleanValue: true,
      numberValue: 42,
      bigintValue: 42n,
      functionValue: () => "ignored",
      symbolValue: Symbol("ignored"),
    }) as Record<string, unknown>;

    expect(redacted.error).toMatchObject({
      name: "Error",
      message: "provider Authorization: [REDACTED]",
      code: "PROVIDER_FAILURE",
      cause: {
        name: "Error",
        message: "nested password=[REDACTED]",
        code: "NESTED_FAILURE",
      },
    });
    expect(redacted).toMatchObject({
      nullValue: null,
      booleanValue: true,
      numberValue: 42,
      bigintValue: "42",
      functionValue: "[function]",
      symbolValue: "[symbol]",
    });
    expect(redacted).toHaveProperty("undefinedValue", undefined);
    expect(JSON.stringify(redacted)).not.toContain("error-secret");
    expect(JSON.stringify(redacted)).not.toContain("nested-secret");
  });

  it("bounds nested arrays and objects and truncates deep values", () => {
    const values = Array.from({ length: 40 }, (_, index) => index);
    const entries = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`safe${index}`, index]));
    let nested: Record<string, unknown> = { value: "deep" };
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };

    const redacted = redactSensitive({ values, entries, nested }) as Record<string, unknown>;
    expect(redacted.values).toHaveLength(32);
    expect(Object.keys(redacted.entries as object)).toHaveLength(64);
    expect(JSON.stringify(redacted)).toContain("[TRUNCATED]");
  });

  it("handles unserializable values and very small serialization budgets", () => {
    const unserializable = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("cannot enumerate");
        },
      },
    );
    expect(boundedSerialize(unserializable)).toBe('"[UNSERIALIZABLE]"');
    expect(boundedSerialize({ safe: "value" }, 0)).toContain("safe");

    const truncated = boundedSerialize({ safe: "x".repeat(20_000) }, 128);
    expect(JSON.parse(truncated)).toMatchObject({ truncated: true });
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(128);

    const minimal = boundedSerialize("x".repeat(20_000), 1);
    expect(new TextEncoder().encode(minimal).byteLength).toBeLessThanOrEqual(1);
  });

  it("caps every string value by UTF-8 bytes for log payloads", () => {
    const redacted = redactForLog({ nested: { value: "界".repeat(10_000) } }) as {
      nested: { value: string };
    };
    expect(new TextEncoder().encode(redacted.nested.value).byteLength).toBeLessThanOrEqual(
      STRUCTURED_ERROR_LOG_FIELD_MAX_BYTES,
    );
    expect(redacted.nested.value).toContain("[TRUNCATED]");
  });

  it("redacts folded header continuations while preserving the next header", () => {
    const folded = "Authorization: Bearer first\r\n\tsecond-secret\r\nX-Safe: ok";
    const redacted = redactForLog({ message: folded }) as { message: string };

    expect(redacted.message).not.toContain("second-secret");
    expect(redacted.message).not.toContain("first");
    expect(redacted.message).toContain("X-Safe: ok");

    const cookie = redactForLog({ message: "Set-Cookie: a=1\r\n  b=leaked\r\nContent-Type: text/plain" }) as {
      message: string;
    };
    expect(cookie.message).not.toContain("b=leaked");
    expect(cookie.message).toContain("Content-Type: text/plain");

    const empty = redactForLog("Authorization:\r\nX-Safe: ok");
    expect(empty).toContain("X-Safe: ok");
  });

  it("redacts compound credential headers without swallowing JSON-ish fragments", () => {
    const cookie = redactForLog("Cookie: session=first-secret; admin=second-secret");
    expect(cookie).toBe("Cookie: [REDACTED]");
    expect(cookie).not.toContain("second-secret");

    const authorization = redactForLog('Authorization: Digest username="u", realm="r", nonce="deadbeef"');
    expect(authorization).toBe("Authorization: [REDACTED]");
    expect(authorization).not.toContain("realm");
    expect(authorization).not.toContain("deadbeef");

    expect(redactForLog("{authorization: x, other: y}")).toBe("{authorization: [REDACTED], other: y}");
  });

  it("redacts inline credential values while preserving JSON and list siblings", () => {
    const unquoted = redactForLog("{cookie: session=abc123secret, other: keepme}");
    expect(unquoted).toBe("{cookie: [REDACTED], other: keepme}");
    expect(unquoted).not.toContain("abc123secret");

    const quoted = redactForLog('{"cookie":"session=abc123secret","other":"keepme"}');
    expect(quoted).toBe('{"cookie":"[REDACTED]","other":"keepme"}');
    expect(quoted).not.toContain("abc123secret");
    expect(quoted).toContain("keepme");

    const semicolonList = redactForLog("ctx: a=1; authorization=tok_live_SECRET; b=2");
    expect(semicolonList).toBe("ctx: a=1; authorization=[REDACTED]; b=2");
    expect(semicolonList).not.toContain("tok_live_SECRET");
    expect(semicolonList).toContain("b=2");
  });

  it("scrubs and caps a bare string, which is how log messages cross the boundary", () => {
    expect(redactForLog("Authorization: Bearer message-secret")).not.toContain("message-secret");
    expect(new TextEncoder().encode(redactForLog("x".repeat(20_000))).byteLength).toBeLessThanOrEqual(
      STRUCTURED_ERROR_LOG_FIELD_MAX_BYTES,
    );
  });
});
