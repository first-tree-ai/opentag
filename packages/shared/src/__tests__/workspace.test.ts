import { describe, expect, it } from "vitest";
import {
  CompleteWorkspaceSetupRequestSchema,
  ListWorkspaceComputersResponseSchema,
  WorkspaceSetupCompletionSchema,
} from "../index.js";

describe("Workspace contracts", () => {
  it("validates the explicit Workspace setup completion boundary", () => {
    const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
    expect(CompleteWorkspaceSetupRequestSchema.parse({ agentId })).toEqual({ agentId });
    expect(() => CompleteWorkspaceSetupRequestSchema.parse({ agentId, ready: true })).toThrow();
    expect(WorkspaceSetupCompletionSchema.parse({ setupCompletedAt: "2026-08-20T00:00:00.000Z" })).toEqual({
      setupCompletedAt: "2026-08-20T00:00:00.000Z",
    });
  });

  it("requires explicit observation time for Computer connection snapshots", () => {
    expect(() => ListWorkspaceComputersResponseSchema.parse({ computers: [{ id: crypto.randomUUID() }] })).toThrow();
  });
});
