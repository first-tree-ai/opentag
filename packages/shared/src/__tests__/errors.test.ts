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

  it("accepts strict validation issues", () => {
    const envelope = {
      error: {
        code: "VALIDATION_ERROR",
        category: "validation",
        message: "The request payload is invalid",
        issues: [{ path: ["name", 0], code: "invalid_format", message: "Agent name is invalid" }],
      },
    };
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
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
    expect(() =>
      ErrorEnvelopeSchema.parse({
        error: {
          code: "VALIDATION_ERROR",
          category: "validation",
          message: "Invalid",
          issues: [{ path: ["name"], code: "invalid_format", message: "Invalid", input: "secret" }],
        },
      }),
    ).toThrow();
  });

  it.each([
    "AGENT_FORBIDDEN",
    "AGENT_NAME_CONFLICT",
    "AGENT_REVISION_CONFLICT",
    "AGENT_REBIND_BLOCKED",
    "COMPUTER_NOT_FOUND",
    "RESOURCE_NOT_FOUND",
  ])("accepts Agent control-plane error code %s", (code) => {
    expect(
      ErrorEnvelopeSchema.parse({ error: { code, category: "deterministic", message: "Agent request failed" } }),
    ).toMatchObject({ error: { code } });
  });

  it.each([
    ["FEISHU_APP_ALREADY_BOUND", "deterministic"],
    ["FEISHU_BINDING_IDENTITY_MISMATCH", "deterministic"],
    ["IM_BINDING_GENERATION_STALE", "deterministic"],
    ["IM_BINDING_TEMPORARILY_UNAVAILABLE", "transient"],
  ])("accepts public IM error code %s", (code, category) => {
    expect(ErrorEnvelopeSchema.parse({ error: { code, category, message: "Messaging request failed" } })).toMatchObject(
      { error: { code, category } },
    );
  });

  it.each([
    ["SKILL_NOT_FOUND", "deterministic"],
    ["SKILL_ALREADY_EXISTS", "deterministic"],
    ["SKILL_ARCHIVE_INVALID", "validation"],
    ["SKILL_ARCHIVE_TOO_LARGE", "validation"],
    ["SKILL_ARCHIVE_TOO_MANY_FILES", "validation"],
    ["SKILL_ARCHIVE_INVALID_PATH", "validation"],
    ["SKILL_ARCHIVE_UNSUPPORTED_MEDIA_TYPE", "validation"],
    ["SKILL_MANIFEST_INVALID", "validation"],
    ["SKILL_QUOTA_EXCEEDED", "deterministic"],
    ["SKILL_STORAGE_UNAVAILABLE", "transient"],
  ])("accepts skill library error code %s", (code, category) => {
    expect(ErrorEnvelopeSchema.parse({ error: { code, category, message: "Skill request failed" } })).toMatchObject({
      error: { code, category },
    });
  });

  it("carries skill details only on skill codes", () => {
    const envelope = {
      error: {
        code: "SKILL_NOT_FOUND",
        category: "deterministic",
        message: "Unknown skills",
        details: { missing: ["alpha", "beta"] },
      },
    };
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      ErrorEnvelopeSchema.parse({
        error: { code: "SKILL_MANIFEST_INVALID", category: "validation", message: "Bad", details: { field: "name" } },
      }).error.details,
    ).toEqual({ field: "name" });
    expect(() =>
      ErrorEnvelopeSchema.parse({
        error: { code: "RESOURCE_NOT_FOUND", category: "deterministic", message: "No", details: { field: "x" } },
      }),
    ).toThrow();
    expect(() =>
      ErrorEnvelopeSchema.parse({
        error: { code: "SKILL_NOT_FOUND", category: "deterministic", message: "No", details: { other: 1 } },
      }),
    ).toThrow();
  });

  it("carries the structured unbind-required identity only on its own code", () => {
    const unbindRequired = {
      currentProvider: "feishu" as const,
      currentBindingId: crypto.randomUUID(),
      requestedProvider: "slack" as const,
    };
    const envelope = {
      error: {
        code: "IM_BINDING_UNBIND_REQUIRED",
        category: "deterministic",
        message: "Unbind the current messaging connection before starting a different Provider",
        unbindRequired,
      },
    };
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() =>
      ErrorEnvelopeSchema.parse({ error: { ...envelope.error, code: "IM_BINDING_CONFIGURATION_CONFLICT" } }),
    ).toThrow();
    expect(() =>
      ErrorEnvelopeSchema.parse({
        error: { ...envelope.error, unbindRequired: { ...unbindRequired, requestedProvider: "feishu" } },
      }),
    ).toThrow();
    expect(() =>
      ErrorEnvelopeSchema.parse({
        error: { ...envelope.error, unbindRequired: { ...unbindRequired, callbackUrl: "https://evil.example.com" } },
      }),
    ).toThrow();
  });
});
