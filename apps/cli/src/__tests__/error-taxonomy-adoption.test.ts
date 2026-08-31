import { StructuredErrorSchema } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { CommandError } from "../core/command/policy.js";

describe("CLI error taxonomy adoption", () => {
  it("exposes a schema-valid diagnostic for command failures", () => {
    const error = new CommandError(
      { code: "COMMAND_FAILED", category: "internal", retryability: "never", phase: "request" },
      "The command failed",
    );
    expect(StructuredErrorSchema.parse(error.structuredError)).toMatchObject({
      code: "COMMAND_FAILED",
      category: "internal",
      retryability: "never",
      phase: "request",
      message: "The command failed",
    });
  });
});
