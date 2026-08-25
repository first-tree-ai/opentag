import { describe, expect, it } from "vitest";
import {
  CompleteWorkspaceSetupRequestSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  ListWorkspaceComputersResponseSchema,
  UpdateWorkspaceProfileRequestSchema,
  WorkspaceAdminConfigSchema,
  WorkspaceAdminSummarySchema,
  WorkspaceProfileSchema,
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

  it("exposes roleless append-only Admin grants", () => {
    expect(
      WorkspaceAdminConfigSchema.parse({
        workspaceId: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
        userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        email: "admin@example.com",
        displayName: "Admin",
        grantedByUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        grantedAt: "2026-08-19T00:00:00.000Z",
      }),
    ).toMatchObject({ displayName: "Admin" });
  });

  it("requires explicit observation time for Computer connection snapshots", () => {
    expect(() => ListWorkspaceComputersResponseSchema.parse({ computers: [{ id: crypto.randomUUID() }] })).toThrow();
  });

  it("rejects account-private fields from the Admin summary", () => {
    expect(() =>
      WorkspaceAdminSummarySchema.parse({
        userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        displayName: "Admin",
        grantedAt: "2026-08-19T00:00:00.000Z",
        email: "admin@example.com",
      }),
    ).toThrow();
  });

  it("normalizes partial Workspace profile updates and requires at least one field", () => {
    expect(UpdateWorkspaceProfileRequestSchema.parse({ name: "  First-Tree  " })).toEqual({ name: "first-tree" });
    expect(UpdateWorkspaceProfileRequestSchema.parse({ displayName: "  First Tree AI  " })).toEqual({
      displayName: "First Tree AI",
    });
    expect(() => UpdateWorkspaceProfileRequestSchema.parse({})).toThrow();
    expect(() => UpdateWorkspaceProfileRequestSchema.parse({ name: "not url safe" })).toThrow();
    expect(() => UpdateWorkspaceProfileRequestSchema.parse({ displayName: "   " })).toThrow();
  });

  it("normalizes a Workspace creation request into a canonical slug and trimmed display name", () => {
    expect(CreateWorkspaceRequestSchema.parse({ name: "  First-Tree  ", displayName: "  First Tree AI  " })).toEqual({
      name: "first-tree",
      displayName: "First Tree AI",
    });
  });

  it("rejects Workspace creation names that are not URL-safe slugs", () => {
    for (const name of ["not url safe", "-leading-hyphen", "trailing_underscore", "", "a".repeat(65)]) {
      expect(() => CreateWorkspaceRequestSchema.parse({ name, displayName: "Example" })).toThrow();
    }
  });

  it("requires both Workspace creation fields and rejects unknown ones", () => {
    expect(() => CreateWorkspaceRequestSchema.parse({ name: "example" })).toThrow();
    expect(() => CreateWorkspaceRequestSchema.parse({ displayName: "Example" })).toThrow();
    expect(() => CreateWorkspaceRequestSchema.parse({ name: "example", displayName: "   " })).toThrow();
    expect(() =>
      CreateWorkspaceRequestSchema.parse({ name: "example", displayName: "Example", role: "admin" }),
    ).toThrow();
  });

  it("applies the same field limits to Workspace updates that creation enforces", () => {
    const overlongName = "a".repeat(65);
    const overlongDisplayName = "a".repeat(121);
    expect(() => CreateWorkspaceRequestSchema.parse({ name: overlongName, displayName: "Example" })).toThrow();
    expect(() => UpdateWorkspaceProfileRequestSchema.parse({ name: overlongName })).toThrow();
    expect(() => CreateWorkspaceRequestSchema.parse({ name: "example", displayName: overlongDisplayName })).toThrow();
    expect(() => UpdateWorkspaceProfileRequestSchema.parse({ displayName: overlongDisplayName })).toThrow();
    // A Workspace that creation accepts at the boundary must stay renameable to the same boundary.
    expect(UpdateWorkspaceProfileRequestSchema.parse({ name: "a".repeat(64) })).toEqual({ name: "a".repeat(64) });
    expect(UpdateWorkspaceProfileRequestSchema.parse({ displayName: "a".repeat(120) })).toEqual({
      displayName: "a".repeat(120),
    });
  });

  it("keeps reading Workspace rows that predate the writer limits", () => {
    // Older writers validly stored longer values in an unbounded text column. Bounds belong on the writers;
    // rejecting such a row here would only make /me unrecoverable for a Workspace nobody can still create.
    const legacy = {
      id: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
      name: "a".repeat(200),
      displayName: "a".repeat(300),
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    expect(WorkspaceProfileSchema.parse(legacy)).toMatchObject({ name: legacy.name, displayName: legacy.displayName });
    expect(() => UpdateWorkspaceProfileRequestSchema.parse({ displayName: legacy.displayName })).toThrow();
    expect(() => UpdateWorkspaceProfileRequestSchema.parse({ name: legacy.name })).toThrow();
  });

  it("returns the created Workspace with its self grant audit time", () => {
    const created = {
      id: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
      name: "first-tree",
      displayName: "First Tree AI",
      setupCompletedAt: null,
      grantedAt: "2026-08-20T00:00:00.000Z",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    expect(CreateWorkspaceResponseSchema.parse(created)).toEqual(created);
    expect(() => CreateWorkspaceResponseSchema.parse({ ...created, role: "admin" })).toThrow();
  });
});
