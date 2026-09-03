import { describe, expect, it } from "vitest";
import {
  AccountSetupCompletionSchema,
  CompleteAccountSetupRequestSchema,
  ListAccountComputersResponseSchema,
} from "../index.js";

describe("Account contracts", () => {
  it("validates the explicit Account setup completion boundary", () => {
    const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
    expect(CompleteAccountSetupRequestSchema.parse({ agentId })).toEqual({ agentId });
    expect(() => CompleteAccountSetupRequestSchema.parse({ agentId, ready: true })).toThrow();
    expect(AccountSetupCompletionSchema.parse({ setupCompletedAt: "2026-08-20T00:00:00.000Z" })).toEqual({
      setupCompletedAt: "2026-08-20T00:00:00.000Z",
    });
  });

  it("requires explicit observation time for Computer connection snapshots", () => {
    expect(() => ListAccountComputersResponseSchema.parse({ computers: [{ id: crypto.randomUUID() }] })).toThrow();
  });
});
