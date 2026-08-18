import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "../errors.js";

describe("error contracts", () => {
  it("accepts a typed error envelope", () => {
    expect(
      ErrorEnvelopeSchema.parse({
        error: {
          code: "AUTH_INVALID_TOKEN",
          category: "credential",
          message: "Authentication is required",
          requestId: "request-1",
        },
      }),
    ).toEqual({
      error: {
        code: "AUTH_INVALID_TOKEN",
        category: "credential",
        message: "Authentication is required",
        requestId: "request-1",
      },
    });
  });

  it("rejects untyped and unexpected error fields", () => {
    expect(() =>
      ErrorEnvelopeSchema.parse({
        error: { code: "UNKNOWN", category: "credential", message: "No" },
      }),
    ).toThrow();
    expect(() =>
      ErrorEnvelopeSchema.parse({
        error: { code: "RATE_LIMITED", category: "rate_limit", message: "Slow down", rawToken: "secret" },
      }),
    ).toThrow();
  });
});
