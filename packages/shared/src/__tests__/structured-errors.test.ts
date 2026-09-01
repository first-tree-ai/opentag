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

  it("uses relative indentation for folded headers and preserves equal-indent siblings", () => {
    const indented = redactForLog("headers:\n  Cookie: session=first-secret; admin=second-secret\nX-Safe: ok");
    expect(indented).toBe("headers:\n  Cookie: [REDACTED]\nX-Safe: ok");
    expect(indented).not.toContain("first-secret");
    expect(indented).not.toContain("second-secret");

    const folded = redactForLog("headers:\n  Cookie: session=first-secret\n    continuation-secret\nX-Safe: ok");
    expect(folded).toBe("headers:\n  Cookie: [REDACTED]\nX-Safe: ok");
    expect(folded).not.toContain("continuation-secret");

    const colonContinuation = redactForLog(
      "Cookie: session=first-secret\n  Looks-Like: continuation-secret\nX-Safe: ok",
    );
    expect(colonContinuation).toBe("Cookie: [REDACTED]\nX-Safe: ok");
    expect(colonContinuation).not.toContain("continuation-secret");

    const siblings = redactForLog("headers:\n  Cookie: x\n  Set-Cookie: y");
    expect(siblings).toBe("headers:\n  Cookie: [REDACTED]\n  Set-Cookie: [REDACTED]");
  });

  it("consumes structured credential values and enclosing quoted headers", () => {
    const array = redactForLog('{"set-cookie":["session=first-secret","admin=second-secret"]}');
    expect(array).toBe('{"set-cookie":"[REDACTED]"}');
    expect(() => JSON.parse(array)).not.toThrow();
    expect(array).not.toContain("first-secret");
    expect(array).not.toContain("second-secret");

    const nestedHeader = redactForLog('{"headers":"Cookie: session=first-secret; admin=second-secret"}');
    expect(nestedHeader).toBe('{"headers":"Cookie: [REDACTED]"}');
    expect(() => JSON.parse(nestedHeader)).not.toThrow();
    expect(nestedHeader).not.toContain("first-secret");
    expect(nestedHeader).not.toContain("second-secret");

    const indentedDigest = redactForLog('req:\n\tAuthorization: Digest u="x", nonce="deadbeef"\nX-Safe: ok');
    expect(indentedDigest).toBe("req:\n\tAuthorization: [REDACTED]\nX-Safe: ok");
    expect(indentedDigest).not.toContain("deadbeef");
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

    const escaped = String.raw`{\"cookie\":\"session=first-secret; admin=second-secret\",\"other\":\"keep\"}`;
    const escapedRedacted = redactForLog(escaped);
    expect(escapedRedacted).toBe(String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`);
    expect(escapedRedacted).not.toContain("first-secret");
    expect(escapedRedacted).not.toContain("second-secret");
    expect(escapedRedacted).toContain(String.raw`\"other\":\"keep\"`);
  });

  it("decodes exactly one serialized layer before redacting credential structures", () => {
    const digest = String.raw`{\"authorization\":\"Digest username=\\\"u\\\", realm=\\\"tenant\\\", nonce=\\\"deep-secret\\\"\",\"other\":\"keep\"}`;
    const digestRedacted = redactForLog(digest);
    expect(digestRedacted).toBe(String.raw`{\"authorization\":\"[REDACTED]\",\"other\":\"keep\"}`);
    expect(digestRedacted).not.toContain("deep-secret");
    expect(digestRedacted).toContain(String.raw`\"other\":\"keep\"`);

    const array = String.raw`{\"set-cookie\":[\"session=first-secret\",\"admin=second-secret\"],\"other\":\"keep\"}`;
    const arrayRedacted = redactForLog(array);
    expect(arrayRedacted).toBe(String.raw`{\"set-cookie\":\"[REDACTED]\",\"other\":\"keep\"}`);
    expect(arrayRedacted).not.toContain("first-secret");
    expect(arrayRedacted).not.toContain("second-secret");
    expect(arrayRedacted).toContain(String.raw`\"other\":\"keep\"`);

    const doubleSerialized = String.raw`\\\"cookie\\\":\\\"nested-secret\\\"`;
    const doubleSerializedRedacted = redactForLog(doubleSerialized);
    expect(doubleSerializedRedacted).toBe(String.raw`\\\"cookie\\\":\"[REDACTED]\"`);
    expect(doubleSerializedRedacted).toContain(String.raw`\\\"cookie\\\":`);
    expect(doubleSerializedRedacted).not.toContain("nested-secret");

    const unterminatedArray = String.raw`{\"set-cookie\":[\"session=first-secret\",\"admin=second-secret\"`;
    const unterminatedRedacted = redactForLog(unterminatedArray);
    expect(unterminatedRedacted).not.toContain("first-secret");
    expect(unterminatedRedacted).not.toContain("second-secret");
  });

  it.each([
    [
      String.raw`{\"cookie\":\"a=1\r\nb=deep-secret\",\"other\":\"keep\"}`,
      String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
    ],
    [
      String.raw`{\"cookie\":\"a=1\nb=deep-secret\",\"other\":\"keep\"}`,
      String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
    ],
    [
      String.raw`{\"cookie\":\"a=1\n  b=deep-secret\",\"other\":\"keep\"}`,
      String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
    ],
    [
      String.raw`{\"authorization\":\"Bearer x\nnonce=deep-secret\",\"other\":\"keep\"}`,
      String.raw`{\"authorization\":\"[REDACTED]\",\"other\":\"keep\"}`,
    ],
    [
      String.raw`{\"set-cookie\":[\"a=1\nb=deep-secret\"],\"other\":\"keep\"}`,
      String.raw`{\"set-cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
    ],
  ])("redacts encoded line breaks as content of one serialized credential value", (input, expected) => {
    const redacted = redactForLog(input);
    expect(redacted).toBe(expected);
    expect(redacted).not.toContain("deep-secret");
    expect(redacted).toContain(String.raw`\"other\":\"keep\"`);
  });

  it.each([
    [
      String.raw`spawn failed at C:\Users\me\bin: {\"cookie\":\"session=first-secret\",\"other\":\"keep\"}`,
      String.raw`spawn failed at C:\Users\me\bin: {\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      String.raw`C:\Users\me\bin`,
    ],
    [
      String.raw`{\"cookie\":\"session=first-secret\",\"url\":\"https:\/\/api.example.com\/v1\"}`,
      String.raw`{\"cookie\":\"[REDACTED]\",\"url\":\"https:\/\/api.example.com\/v1\"}`,
      String.raw`https:\/\/api.example.com\/v1`,
    ],
    [
      String.raw`line one
{\"cookie\":\"session=first-secret\",\"other\":\"keep\"}`,
      String.raw`line one
{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      "line one\n",
    ],
    [
      String.raw`col1${"\t"}col2 {\"cookie\":\"session=first-secret\",\"other\":\"keep\"}`,
      String.raw`col1${"\t"}col2 {\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      "col1\tcol2",
    ],
  ])("scopes serialized credential redaction without changing surrounding context", (input, expected, context) => {
    const redacted = redactForLog(input);
    expect(redacted).toBe(expected);
    expect(redacted).toContain(context);
    expect(redacted).not.toContain("first-secret");
    expect(redacted).not.toBe("[REDACTED]");
  });

  it.each([
    [
      String.raw`prefix {\"cookie\":\"session=first-secret\/tail\",\"other\":\"keep\"} suffix`,
      String.raw`prefix {\"cookie\":\"[REDACTED]\",\"other\":\"keep\"} suffix`,
    ],
    [
      String.raw`prefix {\\\"cookie\\\":\\\"nested-secret\\\",\\\"other\\\":\\\"keep\\\"} suffix`,
      String.raw`prefix {\\\"cookie\\\":\"[REDACTED]\",\\\"other\\\":\\\"keep\\\"} suffix`,
    ],
    [
      String.raw`prefix {\"cookie\":\"invalid\q-secret\",\"other\":\"keep\"} suffix`,
      String.raw`prefix {\"cookie\":\"[REDACTED]\",\"other\":\"keep\"} suffix`,
    ],
    [
      String.raw`prefix {\"cookie\":\"invalid\q-first-secret
second-secret\",\"other\":\"keep\"} suffix`,
      String.raw`prefix {\"cookie\":\"[REDACTED]\",\"other\":\"keep\"} suffix`,
    ],
  ])("fails closed within a rejected serialized value span", (input, expected) => {
    const redacted = redactForLog(input);
    expect(redacted).toBe(expected);
    expect(redacted).toContain("other");
    expect(redacted).toContain("keep");
    expect(redacted).toContain("prefix");
    expect(redacted).toContain("suffix");
    expect(redacted).not.toContain("secret");
  });

  it("redacts list-prefixed headers as complete physical fields", () => {
    for (const prefix of ["- Cookie", "* Cookie", "+ Cookie", "1. Cookie", "2) Cookie"]) {
      const input = `headers:\n  ${prefix}: session=first-secret; admin=second-secret\n  X-Safe: ok`;
      expect(redactForLog(input)).toBe(`headers:\n  ${prefix}: [REDACTED]\n  X-Safe: ok`);
    }

    const unclear = redactForLog("headers:\n  -- Cookie: session=first-secret; admin=second-secret\n  X-Safe: ok");
    expect(unclear).toBe("headers:\n  -- Cookie: [REDACTED]\n  X-Safe: ok");
  });

  it.each([
    ["Cookie: a=first-secret\r\n  b: second-secret\r\nX-Safe: ok", "Cookie: [REDACTED]\r\nX-Safe: ok"],
    [
      String.raw`{\"cookie\":\"session=first-secret; admin=second-secret\",\"other\":\"keep\"}`,
      String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
    ],
    [
      "headers:\n  Cookie: x-one-secret\n  Set-Cookie: y-two-secret",
      "headers:\n  Cookie: [REDACTED]\n  Set-Cookie: [REDACTED]",
    ],
    [
      "headers:\n  Cookie: session=first-secret; admin=second-secret\nX-Safe: ok",
      "headers:\n  Cookie: [REDACTED]\nX-Safe: ok",
    ],
    ['{"set-cookie":["session=first-secret","admin=second-secret"]}', '{"set-cookie":"[REDACTED]"}'],
    ['{"headers":"Cookie: session=first-secret; admin=second-secret"}', '{"headers":"Cookie: [REDACTED]"}'],
    [
      'req:\n\tAuthorization: Digest u="x", nonce="deadbeef"\nX-Safe: ok',
      "req:\n\tAuthorization: [REDACTED]\nX-Safe: ok",
    ],
    ["{cookie: session=abc123secret, other: keepme}", "{cookie: [REDACTED], other: keepme}"],
    ['{"cookie":"session=abc123secret","other":"keepme"}', '{"cookie":"[REDACTED]","other":"keepme"}'],
    ["ctx: a=1; authorization=tok_live_SECRET; b=2", "ctx: a=1; authorization=[REDACTED]; b=2"],
    ["Cookie: session=first-secret; admin=second-secret", "Cookie: [REDACTED]"],
    ["Authorization: Bearer a\r\n\tfolded\r\nX-Safe: ok", "Authorization: [REDACTED]\r\nX-Safe: ok"],
  ])("keeps the twelve established redaction outputs stable", (input, expected) => {
    expect(redactForLog(input)).toBe(expected);
  });

  it("scrubs and caps a bare string, which is how log messages cross the boundary", () => {
    expect(redactForLog("Authorization: Bearer message-secret")).not.toContain("message-secret");
    expect(new TextEncoder().encode(redactForLog("x".repeat(20_000))).byteLength).toBeLessThanOrEqual(
      STRUCTURED_ERROR_LOG_FIELD_MAX_BYTES,
    );
  });
});
