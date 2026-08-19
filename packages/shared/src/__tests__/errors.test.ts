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

  it.each([
    "AGENT_FORBIDDEN",
    "AGENT_NAME_CONFLICT",
    "AGENT_REVISION_CONFLICT",
    "COMPUTER_NOT_FOUND",
    "RESOURCE_NOT_FOUND",
  ])("accepts Agent control-plane error code %s", (code) => {
    expect(
      ErrorEnvelopeSchema.parse({ error: { code, category: "deterministic", message: "Agent request failed" } }),
    ).toMatchObject({ error: { code } });
  });
});
