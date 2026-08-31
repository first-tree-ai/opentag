import { describe, expect, it } from "vitest";
import {
  BOUNDED_DIAGNOSTIC_SERIALIZATION_BYTES,
  boundedSerialize,
  DiagnosticEventSchema,
  redactSensitive,
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
});
